import assert from 'assert';
import { describe, it } from 'node:test';
import { averageRanks, expectedRank, updateContest, winProbability } from '../packages/hydrooj/src/lib/rating-v2/cf-local';
import {
    compositeScore, contestContribution, problemContribution, publicRating, roundHalfUp, tierForRating,
} from '../packages/hydrooj/src/lib/rating-v2/composite';
import { achievementUnits, sumAchievement } from '../packages/hydrooj/src/lib/rating-v2/achievement';
import { fitDifficulty } from '../packages/hydrooj/src/lib/rating-v2/difficulty';
import { evaluateCalibration, fitSolveCalibration } from '../packages/hydrooj/src/lib/rating-v2/calibration';

const entry = (uid: number, mu: number, ratedEvents = 99) => ({ uid, mu, ratedEvents });

describe('rating-v2 cf-local (hydro-local-cf-v1)', () => {
    it('M01: 400-point advantage wins ~90.9%', () => {
        assert.ok(Math.abs(winProbability(1900, 1500) - 0.909) < 0.001);
        assert.ok(winProbability(1500, 1900) < 0.1);
    });

    it('expectedRank equals 1 + sum of loss probabilities', () => {
        const entries = [entry(1, 1500), entry(2, 1600), entry(3, 1700)];
        const e = entries[0];
        assert.ok(Math.abs(expectedRank(e, entries) - (1 + winProbability(1600, 1500) + winProbability(1700, 1500))) < 1e-12);
    });

    it('M02: equal ability and equal rank produce equal deltas', () => {
        const entries = [entry(1, 1500), entry(2, 1500), entry(3, 1600)];
        const res = updateContest(entries, [1.5, 1.5, 3]);
        assert.ok(res.ok);
        if (res.ok) {
            const d1 = res.results.find((r) => r.uid === 1).delta;
            const d2 = res.results.find((r) => r.uid === 2).delta;
            assert.equal(d1, d2);
        }
    });

    it('M03: tied group at positions 2-4 gets average rank 3', () => {
        const distinct = averageRanks(
            [{ uid: 0 }, { uid: 1 }, { uid: 2 }, { uid: 3 }], () => false,
        );
        assert.deepEqual(distinct, [1, 2, 3, 4]);
        const tied = averageRanks(
            [{ uid: 0 }, { uid: 1 }, { uid: 2 }, { uid: 3 }],
            (a, b) => a.uid !== 0 && b.uid !== 0,
        );
        assert.deepEqual(tied, [1, 3, 3, 3]);
    });

    it('M04: a fully tied field freezes the contest', () => {
        const entries = [entry(1, 1500), entry(2, 1700), entry(3, 1300)];
        const res = updateContest(entries, [2, 2, 2]);
        assert.ok(res.ok);
        if (res.ok) {
            assert.equal(res.frozen, true);
            assert.ok(res.results.every((r) => r.delta === 0));
        }
    });

    it('M05: single player and duplicate uid are rejected', () => {
        assert.equal(updateContest([entry(1, 1500)], [1]).ok, false);
        assert.equal(updateContest([entry(1, 1500), entry(1, 1600)], [1, 2]).ok, false);
        assert.equal(updateContest([entry(1, 1500), entry(2, 1500)], [1]).ok, false);
    });

    it('M08: established deltas are zero-sum and individually bounded', () => {
        const entries = [100, 200, 300, 400, 500].map((mu, i) => entry(i + 1, mu + 1500));
        const res = updateContest(entries, [1, 2, 3, 4, 5]);
        assert.ok(res.ok);
        if (res.ok) {
            const est = res.results.filter((r) => r.kind === 'established');
            assert.ok(est.length > 0);
            const sum = est.reduce((s, r) => s + r.delta, 0);
            assert.ok(Math.abs(sum) < 1e-6);
            for (const r of res.results) {
                assert.ok(Math.abs(r.delta) <= 200 + 1, `delta ${r.delta} out of bound`);
            }
        }
    });

    it('D5: provisional deltas do not flow into established players', () => {
        const established = [entry(1, 1800, 10), entry(2, 1700, 10), entry(3, 1600, 8)];
        const newcomer = entry(9, 1500, 0);
        const res = updateContest([...established, newcomer], [1, 2, 3, 4]);
        assert.ok(res.ok);
        if (res.ok) {
            const estSum = res.results.filter((r) => r.kind === 'established').reduce((s, r) => s + r.delta, 0);
            assert.ok(Math.abs(estSum) < 1e-6);
            const newcomerDelta = res.results.find((r) => r.uid === 9).delta;
            assert.ok(newcomerDelta < 0);
        }
    });

    it('D5 edge: an all-provisional contest still updates without centering', () => {
        const entries = [entry(1, 1500, 0), entry(2, 1500, 0), entry(3, 1500, 0), entry(4, 1500, 0)];
        const res = updateContest(entries, [1, 2, 3, 4]);
        assert.ok(res.ok);
        if (res.ok) {
            assert.ok(res.results[0].delta > 0);
            assert.ok(res.results[3].delta < 0);
        }
    });
});

describe('rating-v2 composite (rp-policy-v2)', () => {
    it('P curve matches the approved examples', () => {
        assert.ok(Math.abs(problemContribution(442) - 413.08) < 0.01);
        assert.equal(problemContribution(200), 300);
        assert.equal(problemContribution(0), 0);
    });

    it('C01: unrated users contribute 0, not ability 0', () => {
        assert.equal(contestContribution(null, 10), 0);
        assert.equal(publicRating(null), null);
        assert.equal(tierForRating(null), null);
    });

    it('C02: rating above 2800 caps the contest contribution', () => {
        assert.ok(Math.abs(contestContribution(3000, 5) - 400) < 1e-9);
    });

    it('C03: placement ramp stops after 5 events', () => {
        assert.ok(Math.abs(contestContribution(1700, 1) - 48.57) < 0.01);
        assert.ok(Math.abs(contestContribution(1700, 5) - contestContribution(1700, 50)) < 1e-12);
    });

    it('C04: component cents sum exactly to the total', () => {
        const s = compositeScore(112.5, 1642, 3);
        assert.equal(s.rpCents, s.problemCents + s.contestCents);
    });

    it('public rating floors at 0 and rounds half up', () => {
        assert.equal(publicRating(-50), 0);
        assert.equal(publicRating(1499.5), 1500);
        assert.equal(roundHalfUp(0.5), 1);
    });

    it('D11: tiers avoid the legacy Lv naming', () => {
        assert.equal(tierForRating(0).id, 'TIER_1');
        assert.equal(tierForRating(1199).id, 'TIER_1');
        assert.equal(tierForRating(1200).id, 'TIER_2');
        assert.equal(tierForRating(1642).id, 'TIER_4');
        assert.equal(tierForRating(2800).id, 'TIER_8');
        assert.equal(tierForRating(3500).id, 'TIER_8');
    });
});

describe('rating-v2 achievement (achievement-v2)', () => {
    it('A02: 100 problems at 60% with no AC equal 30 units', () => {
        let a = 0;
        for (let i = 0; i < 100; i++) a += achievementUnits({ accepted: false, score: 60 });
        assert.ok(Math.abs(a - 30) < 1e-9);
    });

    it('A03: partial score followed by AC caps at 1 unit', () => {
        const s = sumAchievement([
            { key: 'p', outcome: { accepted: false, score: 60 } },
            { key: 'p', outcome: { accepted: true, score: 100 } },
        ]);
        assert.ok(Math.abs(s.a - 1) < 1e-9);
    });

    it('full score without AC stays at 0.5 (never inferred acceptance)', () => {
        assert.equal(achievementUnits({ accepted: false, score: 100 }), 0.5);
    });

    it('A04: anomalous scores contribute 0 and are flagged', () => {
        const s = sumAchievement([
            { key: 1, outcome: { accepted: false, score: NaN } },
            { key: 2, outcome: { accepted: false, score: -5 } },
            { key: 3, outcome: { accepted: true, score: 100 } },
        ]);
        assert.equal(s.anomalies, 2);
        assert.equal(s.a, 1);
    });
});

describe('rating-v2 difficulty (hydro-fixed-1pl-v1)', () => {
    it('M12: all-solved and all-unsolved are degenerate', () => {
        assert.equal(fitDifficulty([{ mu: 1500, solved: true }, { mu: 1600, solved: true }]).status, 'degenerate');
        assert.equal(fitDifficulty([{ mu: 1500, solved: false }]).status, 'degenerate');
        assert.equal(fitDifficulty([]).status, 'degenerate');
    });

    it('spot-check regression: an unconverged fit is marked nonconverged with no SE', () => {
        // Force non-convergence by capping iterations on well-mixed data.
        const obs = Array.from({ length: 40 }, (_, i) => ({ mu: 1400 + (i % 7) * 120, solved: i % 3 !== 0 }));
        const fit = fitDifficulty(obs, { maxIterations: 2 });
        assert.equal(fit.converged, false);
        assert.equal(fit.status, 'nonconverged');
        assert.equal(fit.se, null);
        // The same data converges normally with the default budget.
        assert.equal(fitDifficulty(obs).status, 'ok');
    });

    it('spot-check regression: the pid-239 shape now converges instead of diverging to -10934', () => {
        // Real shape from production: 6 solvers at ~2037, 15 non-solvers at ~1869.
        const obs = [
            ...Array.from({ length: 6 }, () => ({ mu: 2037, solved: true })),
            ...Array.from({ length: 15 }, () => ({ mu: 1869, solved: false })),
        ];
        const fit = fitDifficulty(obs);
        assert.equal(fit.status, 'ok');
        assert.ok(fit.converged);
        // The 50% point must sit between the two groups (prior tilts it a little).
        assert.ok(fit.d > 1850 && fit.d < 2300, `d=${fit.d}`);
        assert.ok(fit.se !== null && fit.se > 0);
    });

    it('synthetic ground-truth recovery: abilities and difficulties are jointly self-consistent', () => {
        // Deterministic PRNG (LCG + Box-Muller).
        let seed = 20260919;
        const rand = () => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed / 2147483648;
        };
        const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
        const A = Math.log(10) / 400;
        const solveProb = (mu: number, d: number) => 1 / (1 + Math.exp(-A * (mu - d)));

        const N_USERS = 200;
        const N_PROBLEMS = 60;
        const ROUNDS = 25;
        const trueMu = Array.from({ length: N_USERS }, () => 1500 + gauss() * 250);
        const trueD = Array.from({ length: N_PROBLEMS }, () => 1650 + gauss() * 350);

        const states = new Map<number, { mu: number, events: number }>();
        const muOf = (u: number) => {
            let st = states.get(u);
            if (!st) {
                st = { mu: 1500, events: 0 };
                states.set(u, st);
            }
            return st;
        };
        const seen = new Set<string>();
        const observations: { uid: number, pid: number, mu: number, solved: boolean }[] = [];

        for (let round = 0; round < ROUNDS; round++) {
            const pool = Array.from({ length: N_USERS }, (_, i) => i)
                .map((v) => ({ v, k: rand() }))
                .sort((x, y) => x.k - y.k)
                .slice(0, 30)
                .map((x) => x.v);
            const standings = pool.map((u) => {
                let solvedCount = 0;
                const outcomes: boolean[] = [];
                for (let pid = 0; pid < N_PROBLEMS; pid++) {
                    // Outcomes are generated from TRUE ability — the simulation's
                    // ground truth — never from the currently fitted rating.
                    const y = rand() < solveProb(trueMu[u], trueD[pid]);
                    outcomes.push(y);
                    if (y) solvedCount++;
                    const key = `${u}:${pid}`;
                    if (round >= 5 && !seen.has(key)) {
                        seen.add(key);
                        observations.push({ uid: u, pid, mu: muOf(u).mu, solved: y });
                    }
                }
                void outcomes;
                return { u, solvedCount };
            });
            standings.sort((x, y) => y.solvedCount - x.solvedCount || x.u - y.u);
            const ranks = averageRanks(standings, (p, q) => p.solvedCount === q.solvedCount);
            const entries = standings.map((t) => ({ uid: t.u, mu: muOf(t.u).mu, ratedEvents: muOf(t.u).events }));
            const res = updateContest(entries, ranks);
            assert.ok(res.ok, `round ${round}: ${res.ok ? '' : res.reason}`);
            if (res.ok && !res.frozen) {
                for (const r of res.results) {
                    const st = muOf(r.uid);
                    st.mu += r.delta;
                    st.events++;
                }
            } else if (res.ok) {
                for (const r of res.results) muOf(r.uid).events++;
            }
        }

        const pearson = (xs: number[], ys: number[]) => {
            const n = xs.length;
            const mx = xs.reduce((s, x) => s + x, 0) / n;
            const my = ys.reduce((s, y) => s + y, 0) / n;
            let cov = 0;
            let vx = 0;
            let vy = 0;
            for (let i = 0; i < n; i++) {
                cov += (xs[i] - mx) * (ys[i] - my);
                vx += (xs[i] - mx) ** 2;
                vy += (ys[i] - my) ** 2;
            }
            return cov / Math.sqrt(vx * vy);
        };

        // difficulty recovery (fits are reused for the calibration check below)
        const dByPid = new Map<number, number>();
        const fitD: number[] = [];
        const truthD: number[] = [];
        for (let pid = 0; pid < N_PROBLEMS; pid++) {
            const o = observations.filter((x) => x.pid === pid).map((x) => ({ mu: x.mu, solved: x.solved }));
            if (o.length < 20) continue;
            const fit = fitDifficulty(o);
            if (fit.status !== 'ok') continue;
            dByPid.set(pid, fit.d);
            fitD.push(fit.d);
            truthD.push(trueD[pid]);
        }
        assert.ok(fitD.length >= N_PROBLEMS * 0.8, `only ${fitD.length} problems recovered`);
        assert.ok(pearson(truthD, fitD) > 0.85, `difficulty correlation ${pearson(truthD, fitD)}`);

        // ability recovery
        const fittedMu: number[] = [];
        const truthMu: number[] = [];
        for (const [u, st] of states) {
            if (st.events < 5) continue;
            fittedMu.push(st.mu);
            truthMu.push(trueMu[u]);
        }
        // Random 30-of-200 participation leaves only part of the field at >=5 events.
        assert.ok(fittedMu.length >= 50, `only ${fittedMu.length} rated users`);
        assert.ok(pearson(truthMu, fittedMu) > 0.75, `ability correlation ${pearson(truthMu, fittedMu)}`);

        // calibration layer: with the recovered values, held-out log-loss must not
        // degrade and the slope stays in a sane band around 1
        const calData = observations
            .filter((o) => dByPid.has(o.pid))
            .map((o) => ({ mu: o.mu, d: dByPid.get(o.pid) as number, solved: o.solved }));
        const halfA = calData.filter((_, i) => i % 2 === 0);
        const halfB = calData.filter((_, i) => i % 2 === 1);
        const cal = fitSolveCalibration(halfA);
        assert.ok(cal.slope > 0.5 && cal.slope < 1.8, `slope ${cal.slope}`);
        const evalRaw = evaluateCalibration(halfB, 1);
        const evalCal = evaluateCalibration(halfB, cal.slope);
        assert.ok(evalCal.logLoss <= evalRaw.logLoss + 0.005,
            `calibrated logLoss ${evalCal.logLoss} vs raw ${evalRaw.logLoss}`);
    });

    it('calibration: recovers a true slope below 1 and flattens overconfident tails', () => {
        let seed = 777;
        const rand = () => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed / 2147483648;
        };
        const A = Math.log(10) / 400;
        const data = [];
        for (let i = 0; i < 3000; i++) {
            const mu = 1500 + (rand() - 0.5) * 1200;
            const d = 1600 + (rand() - 0.5) * 800;
            const z = 0.6 * A * (mu - d); // true slope 0.6: flatter than the model assumes
            const p = 1 / (1 + Math.exp(-z));
            data.push({ mu, d, solved: rand() < p });
        }
        const cal = fitSolveCalibration(data);
        assert.ok(cal.slope > 0.4 && cal.slope < 0.85, `slope ${cal.slope}`);
        const raw = evaluateCalibration(data, 1);
        const calked = evaluateCalibration(data, cal.slope);
        assert.ok(calked.logLoss < raw.logLoss, 'calibration must reduce log-loss on misspecified slope');
        assert.ok(calked.meanAbsDeviation < raw.meanAbsDeviation);
    });

    it('estimates a finite difficulty with shrinking standard error as samples grow', () => {
        const obs = [];
        for (let i = 0; i < 20; i++) obs.push({ mu: 1500 + (i % 5) * 100, solved: i < 8 });
        const fit = fitDifficulty(obs);
        assert.equal(fit.status, 'ok');
        assert.ok(fit.converged);
        assert.ok(Number.isFinite(fit.d));
        assert.ok(fit.se > 0);
        const big = [...obs, ...obs.map((o) => ({ mu: o.mu + 30, solved: o.solved }))];
        const fit2 = fitDifficulty(big);
        assert.ok(fit2.se < fit.se);
    });

    it('harder problems get higher difficulty when solve rates match', () => {
        const weak = Array.from({ length: 30 }, (_, i) => ({ mu: 1300 + i, solved: i < 6 }));
        const strong = Array.from({ length: 30 }, (_, i) => ({ mu: 1700 + i, solved: i < 6 }));
        assert.ok(fitDifficulty(strong).d > fitDifficulty(weak).d);
    });
});
