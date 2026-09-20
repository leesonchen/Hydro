// achievement-v2: cumulative learning achievement units. Pure computation.

export const PARTIAL_MULTIPLIER = 0.5;

export interface ProblemOutcome {
    accepted: boolean;
    score: number;
    /** Full score of this problem revision; defaults to 100 when unknown. */
    fullScore?: number;
}

/**
 * a(u,p) = 1 for an accepted problem, otherwise 0.5 * clip(score / fullScore, 0, 1).
 * A full-score record without AC status stays at 0.5 (plan §9.3: never infer acceptance).
 * Non-finite or negative scores contribute 0 and should be diagnosed by the caller.
 */
export function achievementUnits(outcome: ProblemOutcome): number {
    if (outcome.accepted) return 1;
    if (!Number.isFinite(outcome.score) || outcome.score <= 0) return 0;
    const full = outcome.fullScore && Number.isFinite(outcome.fullScore) && outcome.fullScore > 0
        ? outcome.fullScore
        : 100;
    const q = Math.min(1, outcome.score / full);
    return PARTIAL_MULTIPLIER * q;
}

export interface AchievementSummary {
    /** Total units A_u. */
    a: number;
    /** Distinct problems with at least one counted outcome. */
    problems: number;
    fullAccepted: number;
    partialUnits: number;
    anomalies: number;
}

/** Aggregate best-outcome entries keyed per canonical problem; duplicate keys keep the max. */
export function sumAchievement(
    entries: { key: string | number, outcome: ProblemOutcome }[],
): AchievementSummary {
    const best = new Map<string | number, number>();
    let fullAccepted = 0;
    let anomalies = 0;
    for (const e of entries) {
        const units = achievementUnits(e.outcome);
        if (!Number.isFinite(e.outcome.score) || e.outcome.score < 0) anomalies++;
        if (!best.has(e.key) || best.get(e.key) < units) best.set(e.key, units);
        if (e.outcome.accepted) fullAccepted++;
    }
    let a = 0;
    let partialUnits = 0;
    for (const u of best.values()) {
        a += u;
        if (u < 1) partialUnits += u;
    }
    return { a, problems: best.size, fullAccepted, partialUnits, anomalies };
}
