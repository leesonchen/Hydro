// rp-policy-v2 composite scoring: pure computation, no database access.
// Weights are trial-run defaults approved in review/rating-v2-decisions-2026-09-19.md.

export const PROBLEM_MAX_CONTRIBUTION = 600;
export const ACHIEVEMENT_HALF_SATURATION = 200;
export const CONTEST_MAX_CONTRIBUTION = 400;
export const RATING_AT_MAX_CONTRIBUTION = 2800;
export const PLACEMENT_CONTRIBUTION_EVENTS = 5;

/** P(A) = 600 * A / (A + 200): starts at 0, monotonic, saturating at 600, no hard cap. */
export function problemContribution(a: number): number {
    if (!Number.isFinite(a) || a <= 0) return 0;
    return PROBLEM_MAX_CONTRIBUTION * a / (a + ACHIEVEMENT_HALF_SATURATION);
}

/** C(R, n) = 400 * min(1, n/5) * clip(R/2800, 0, 1); 0 when unrated (null), not "ability = 0". */
export function contestContribution(rating: number | null, ratedEvents: number): number {
    if (rating === null || rating === undefined || !Number.isFinite(rating)) return 0;
    const q = Math.min(1, Math.max(0, ratedEvents) / PLACEMENT_CONTRIBUTION_EVENTS);
    const scale = Math.min(1, Math.max(0, rating / RATING_AT_MAX_CONTRIBUTION));
    return CONTEST_MAX_CONTRIBUTION * q * scale;
}

/** Public integer rating; null/absent history stays null (never renders prior 1500). */
export function publicRating(mu: number | null | undefined): number | null {
    if (mu === null || mu === undefined || !Number.isFinite(mu)) return null;
    return Math.round(Math.max(0, mu));
}

export interface Tier {
    id: string;
    name: string;
}

export const TIERS: Tier[] = [
    { id: 'TIER_1', name: '青铜' },
    { id: 'TIER_2', name: '白银' },
    { id: 'TIER_3', name: '黄金' },
    { id: 'TIER_4', name: '铂金' },
    { id: 'TIER_5', name: '钻石' },
    { id: 'TIER_6', name: '大师' },
    { id: 'TIER_7', name: '宗师' },
    { id: 'TIER_8', name: '传奇宗师' },
];

const TIER_BOUNDS = [1200, 1400, 1600, 1900, 2100, 2400, 2800];

/** Decision D11: avoid the legacy "Lv" naming entirely. Returns null when unrated. */
export function tierForRating(rating: number | null): Tier | null {
    if (rating === null || rating === undefined || !Number.isFinite(rating)) return null;
    const r = Math.max(0, rating);
    for (let i = 0; i < TIER_BOUNDS.length; i++) {
        if (r < TIER_BOUNDS[i]) return TIERS[i];
    }
    return TIERS[TIERS.length - 1];
}

export function roundHalfUp(x: number): number {
    return Math.floor(x + 0.5);
}

export interface CompositeScore {
    p: number;
    c: number;
    problemCents: number;
    contestCents: number;
    rpCents: number;
}

/** Component cents are rounded first so displayed parts sum exactly to the total. */
export function compositeScore(achievement: number, rating: number | null, ratedEvents: number): CompositeScore {
    const p = problemContribution(achievement);
    const c = contestContribution(rating, ratedEvents);
    const problemCents = roundHalfUp(p * 100);
    const contestCents = roundHalfUp(c * 100);
    return { p, c, problemCents, contestCents, rpCents: problemCents + contestCents };
}
