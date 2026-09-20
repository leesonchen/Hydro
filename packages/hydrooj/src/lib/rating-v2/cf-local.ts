// hydro-local-cf-v1: local CF-style rating with Tanh soft saturation and
// provisional zero-sum exemption (decisions D5 in review/rating-v2-decisions-2026-09-19.md).
// Pure computation: no database access.

export interface RatingEntry {
    uid: number;
    mu: number;
    ratedEvents: number;
}

export interface RatingDelta {
    uid: number;
    rank: number;
    muBefore: number;
    delta: number;
    kind: 'established' | 'provisional' | 'frozen';
}

// Both variants carry the full property set: this repo compiles without
// strictNullChecks, where boolean-literal discriminants do not narrow reliably.
export type UpdateResult = {
    ok: true;
    results: RatingDelta[];
    frozen: boolean;
    reason?: undefined;
} | {
    ok: false;
    results?: undefined;
    frozen?: undefined;
    reason: string;
};

const MAX_DELTA = 200;
export const PROVISIONAL_EVENTS = 5;

function tanhDelta(d: number, maxDelta: number): number {
    return maxDelta * Math.tanh(d / maxDelta);
}

/** Probability that a player with rating `a` beats a player with rating `b`. */
export function winProbability(a: number, b: number): number {
    return 1 / (1 + 10 ** ((b - a) / 400));
}

/** Expected rank of `entry` against all other entries (1 = best). */
export function expectedRank(entry: RatingEntry, others: RatingEntry[]): number {
    let s = 1;
    for (const o of others) {
        if (o.uid === entry.uid) continue;
        s += winProbability(o.mu, entry.mu);
    }
    return s;
}

/**
 * Solve R* such that expectedRank(R*) equals `target`.
 * Dynamic bracket expansion; bisection with sign verification (plan §7.4).
 */
export function solveTargetRating(
    entry: RatingEntry, others: RatingEntry[], target: number, maxDelta: number,
): number {
    const g = (r: number) => {
        const e = expectedRank({ ...entry, mu: r }, others);
        return e - target;
    };
    let lo = entry.mu - maxDelta * 4;
    let hi = entry.mu + maxDelta * 4;
    let glo = g(lo);
    let ghi = g(hi);
    let expand = 0;
    while (glo <= 0 && expand < 8) {
        lo -= maxDelta * 4;
        glo = g(lo);
        expand++;
    }
    while (ghi >= 0 && expand < 16) {
        hi += maxDelta * 4;
        ghi = g(hi);
        expand++;
    }
    if (!(glo > 0) || !(ghi < 0) || !Number.isFinite(lo) || !Number.isFinite(hi)) {
        throw new Error(`rating-solve-no-bracket: target=${target} mu=${entry.mu}`);
    }
    for (let i = 0; i < 100; i++) {
        const mid = (lo + hi) / 2;
        const gm = g(mid);
        if (!Number.isFinite(gm)) throw new Error('rating-solve-nonfinite');
        if (gm > 0) lo = mid;
        else hi = mid;
        if (hi - lo < 1e-7) break;
    }
    const r = (lo + hi) / 2;
    if (!Number.isFinite(r)) throw new Error('rating-solve-nonfinite');
    return r;
}

/**
 * Update all participants of one contest from pre-contest states.
 * `ranks` are 1-based model ranks (average rank within tied groups), same order as `entries`.
 *
 * - Established players (ratedEvents >= provisionalEvents) are zero-sum among themselves,
 *   with Tanh soft saturation applied before centering.
 * - Provisional players are exempt from zero-sum (their delta is absorbed by pool capacity).
 * - If no established player is present, nobody is centered.
 * - A fully-tied field produces zero deltas and `frozen: true` (no rated-event increment).
 */
export function updateContest(
    entries: RatingEntry[], ranks: number[],
    options?: { maxDelta?: number, provisionalEvents?: number },
): UpdateResult {
    const maxDelta = options?.maxDelta ?? MAX_DELTA;
    const provisionalEvents = options?.provisionalEvents ?? PROVISIONAL_EVENTS;
    const n = entries.length;
    if (n < 2) return { ok: false, reason: 'INSUFFICIENT_PLAYERS' };
    if (ranks.length !== n) return { ok: false, reason: 'RANK_MISMATCH' };
    const seen = new Set<number>();
    for (let i = 0; i < n; i++) {
        const e = entries[i];
        if (!Number.isFinite(e.mu) || !Number.isFinite(ranks[i])) return { ok: false, reason: 'NONFINITE_INPUT' };
        if (ranks[i] < 1 || ranks[i] > n) return { ok: false, reason: 'RANK_OUT_OF_RANGE' };
        if (seen.has(e.uid)) return { ok: false, reason: 'DUPLICATE_UID' };
        seen.add(e.uid);
    }
    const allTied = ranks.every((r) => r === ranks[0]);
    if (allTied) {
        return {
            ok: true,
            frozen: true,
            results: entries.map((e, i) => ({ uid: e.uid, rank: ranks[i], muBefore: e.mu, delta: 0, kind: 'frozen' as const })),
        };
    }
    let estSum = 0;
    let estCount = 0;
    const raw: { entry: RatingEntry, rank: number, d: number | null, target: number }[] = [];
    try {
        for (let i = 0; i < n; i++) {
            const others = entries.filter((_, j) => j !== i);
            const target = Math.sqrt(ranks[i] * expectedRank(entries[i], others));
            if (!Number.isFinite(target) || target <= 1 || target >= n) {
                return { ok: false, reason: 'TARGET_OUT_OF_RANGE' };
            }
            const rStar = solveTargetRating(entries[i], others, target, maxDelta);
            const d = (rStar - entries[i].mu) / 2;
            raw.push({ entry: entries[i], rank: ranks[i], d, target });
            if (entries[i].ratedEvents >= provisionalEvents) {
                estSum += d;
                estCount++;
            }
        }
    } catch (e) {
        return { ok: false, reason: e?.message || 'RATING_SOLVE_FAILED' };
    }
    const estMean = estCount ? estSum / estCount : 0;
    const centered = raw.map((r) => (r.entry.ratedEvents >= provisionalEvents ? r.d - estMean : r.d));
    const tanhVals = centered.map((z) => tanhDelta(z ?? 0, maxDelta));
    const estTanhMean = estCount
        ? tanhVals.reduce((s, t, i) => (raw[i].entry.ratedEvents >= provisionalEvents ? s + t : s), 0) / estCount
        : 0;
    const results: RatingDelta[] = raw.map((r, i) => {
        const established = r.entry.ratedEvents >= provisionalEvents;
        const delta = established ? tanhVals[i] - estTanhMean : tanhVals[i];
        return {
            uid: r.entry.uid,
            rank: r.rank,
            muBefore: r.entry.mu,
            delta,
            kind: established ? 'established' as const : 'provisional' as const,
        };
    });
    return { ok: true, frozen: false, results };
}

/** Average rank for a standings array sorted best-first; `tied(a, b)` decides equality. */
export function averageRanks<T>(standings: T[], tied: (a: T, b: T) => boolean): number[] {
    const ranks: number[] = Array.from({ length: standings.length }, () => 0);
    let start = 0;
    while (start < standings.length) {
        let end = start + 1;
        while (end < standings.length && tied(standings[start], standings[end])) end++;
        const avg = (start + 1 + end) / 2;
        for (let i = start; i < end; i++) ranks[i] = avg;
        start = end;
    }
    return ranks;
}
