/* eslint-disable no-await-in-loop */
import Schema from 'schemastery';
import { Time } from '@hydrooj/utils';
import { coll as documentColl, collStatus as documentStatusColl, TYPE_CONTEST, TYPE_PROBLEM } from '../model/document';
import RecordModel from '../model/record';

export const description = 'Read-only P0 inventory audit for rating-v2 planning (never mutates data)';

type Report = (data: any) => void;

export interface AuditOptions {
    minParticipants: number;
    rules: string[];
    includeDuration: boolean;
    includeAssign: boolean;
    windowMonths: number;
    startSpreadSample: number;
}

const hr = (n: number) => `${Math.round(n * 100) / 100}h`;

function median(sorted: number[]): number {
    if (!sorted.length) return 0;
    return sorted[Math.floor((sorted.length - 1) / 2)];
}

function percentile(sorted: number[], p: number): number {
    if (!sorted.length) return 0;
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function bucketize(values: number[], bounds: number[]): Record<string, number> {
    const res: Record<string, number> = { [`0-${bounds[0] - 1}`]: 0 };
    for (let i = 0; i < bounds.length - 1; i++) res[`${bounds[i]}-${bounds[i + 1] - 1}`] = 0;
    res[`${bounds[bounds.length - 1]}+`] = 0;
    for (const v of values) {
        if (v < bounds[0]) res[`0-${bounds[0] - 1}`]++;
        else if (v >= bounds[bounds.length - 1]) res[`${bounds[bounds.length - 1]}+`]++;
        else {
            for (let i = 0; i < bounds.length - 1; i++) {
                if (v >= bounds[i] && v < bounds[i + 1]) res[`${bounds[i]}-${bounds[i + 1] - 1}`]++;
            }
        }
    }
    return res;
}

export async function run(options: AuditOptions, report: Report) {
    const {
        minParticipants, rules, includeDuration, includeAssign, windowMonths, startSpreadSample,
    } = options;
    const now = new Date();
    const windowStart = new Date(now.getTime() - windowMonths * 30 * 24 * 3600 * 1000);

    // -- 1. census -------------------------------------------------------------
    const census = await documentColl.aggregate([
        { $match: { docType: TYPE_CONTEST } },
        {
            $group: {
                _id: {
                    rule: '$rule',
                    rated: '$rated',
                    assigned: { $gt: [{ $size: { $ifNull: ['$assign', []] } }, 0] },
                },
                count: { $sum: 1 },
            },
        },
        { $sort: { count: -1 } },
    ]).toArray();
    report({ message: `[1] Contest census: ${census.map((c) => `${JSON.stringify(c._id)}=${c.count}`).join(', ')}` });

    // -- 2. per-contest evidence scan -----------------------------------------
    const tdocs = await documentColl.find(
        { docType: TYPE_CONTEST, rated: true, rule: { $in: rules } },
        { projection: { beginAt: 1, endAt: 1, duration: 1, assign: 1, domainId: 1, rule: 1 } },
    ).toArray() as any[];
    report({ message: `[2] Scanning ${tdocs.length} rated contests (rules: ${rules.join('/')})` });

    interface Candidate {
        _id: any;
        domainId: string;
        rule: string;
        beginAt: Date;
        endAt: Date;
        duration: number;
        hasAssign: boolean;
        totalRecords: number;
        inWindowRecords: number;
        inWindowParticipants: number;
    }
    const candidates: Candidate[] = [];
    let noTime = 0;
    let totalRecords = 0;
    let totalInWindow = 0;
    for (const tdoc of tdocs) {
        if (!(tdoc.beginAt instanceof Date) || !(tdoc.endAt instanceof Date)) {
            noTime++;
            continue;
        }
        const total = await RecordModel.coll.countDocuments({ contest: tdoc._id });
        totalRecords += total;
        const windowId = {
            _id: { $gte: Time.getObjectID(tdoc.beginAt), $lt: Time.getObjectID(tdoc.endAt) },
        };
        const inWindow = await RecordModel.coll.countDocuments({ contest: tdoc._id, ...windowId });
        totalInWindow += inWindow;
        const inWindowUids = await RecordModel.coll.distinct('uid', {
            contest: tdoc._id, uid: { $gt: 0 }, ...windowId,
        });
        candidates.push({
            _id: tdoc._id,
            domainId: tdoc.domainId,
            rule: tdoc.rule,
            beginAt: tdoc.beginAt,
            endAt: tdoc.endAt,
            duration: tdoc.duration || 0,
            hasAssign: !!(tdoc.assign && tdoc.assign.length),
            totalRecords: total,
            inWindowRecords: inWindow,
            inWindowParticipants: inWindowUids.length,
        });
    }
    report({ message: `[2] Scanned: ${candidates.length} with valid time, ${noTime} skipped (missing begin/end)` });
    report({ message: `[2] Time evidence: ${totalRecords - totalInWindow}/${totalRecords} in-contest records fall outside [beginAt,endAt)` });

    const passes = (c: Candidate) => c.inWindowParticipants >= minParticipants
        && (includeDuration || !c.duration)
        && (includeAssign || !c.hasAssign);
    const strictPasses = (c: Candidate) => c.inWindowParticipants >= 10
        && !c.duration && !c.hasAssign
        && ['acm', 'oi'].includes(c.rule)
        && c.inWindowRecords > 0;

    const qualifying = candidates.filter(passes);
    const qualifyingTrailing = qualifying.filter((c) => c.endAt >= windowStart);
    const strict = candidates.filter(strictPasses);
    const strictTrailing = strict.filter((c) => c.endAt >= windowStart);
    report({
        message: `[3] Qualifying (minParticipants=${minParticipants}, duration=${includeDuration ? 'included' : 'excluded'},`
            + ` assign=${includeAssign ? 'included' : 'excluded'}): all-time ${qualifying.length},`
            + ` trailing ${windowMonths}mo ${qualifyingTrailing.length}`,
    });
    report({
        message: `[3] Strict-plan comparator (sync acm/oi, no-assign, >=10 participants): all-time ${strict.length},`
            + ` trailing ${windowMonths}mo ${strictTrailing.length}`,
    });
    const byDomain: Record<string, number> = {};
    for (const c of qualifying) byDomain[c.domainId] = (byDomain[c.domainId] || 0) + 1;
    report({ message: `[3] Qualifying by domain: ${JSON.stringify(byDomain)}` });

    // -- 3. mature players over qualifying set --------------------------------
    // Participation is derived from in-window records, not contest journals:
    // journal is a mixed-type field (absent / object / array) whose $ne:{}
    // predicate has shown unstable plans on this dataset.
    const qids = qualifying.map((c) => c._id);
    const qidsTrailing = qualifyingTrailing.map((c) => c._id);
    const matureQuery = async (ids: any[]) => {
        const res = await RecordModel.coll.aggregate([
            { $match: { contest: { $in: ids }, uid: { $gt: 0 } } },
            { $group: { _id: { contest: '$contest', uid: '$uid' } } },
            { $group: { _id: '$_id.uid', contests: { $sum: 1 } } },
        ]).toArray();
        return {
            participants: res.length,
            ge3: res.filter((x) => x.contests >= 3).length,
            ge5: res.filter((x) => x.contests >= 5).length,
            ge8: res.filter((x) => x.contests >= 8).length,
        };
    };
    report({ message: `[4] Mature players over qualifying set (all-time): ${JSON.stringify(await matureQuery(qids))}` });
    report({ message: `[4] Mature players over qualifying set (trailing ${windowMonths}mo): ${JSON.stringify(await matureQuery(qidsTrailing))}` });

    // -- 4. problem exposure over qualifying set ------------------------------
    const exposure = await RecordModel.coll.aggregate([
        { $match: { contest: { $in: qids }, pid: { $ne: null } } },
        { $group: { _id: '$pid', uids: { $addToSet: '$uid' } } },
        { $project: { n: { $size: '$uids' } } },
    ]).toArray();
    const exposureSizes = exposure.map((e) => e.n);
    report({ message: `[5] Problems with qualifying-contest records: ${exposureSizes.length}` });
    report({ message: `[5] Distinct-student exposure buckets: ${JSON.stringify(bucketize(exposureSizes, [5, 10, 20, 50]))}` });
    report({ message: `[5] Problems with >=20 distinct students: ${exposureSizes.filter((n) => n >= 20).length}` });

    // -- 5. difficulty field sanity -------------------------------------------
    const diffDist = await documentColl.aggregate([
        { $match: { docType: TYPE_PROBLEM } },
        { $group: { _id: '$difficulty', count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
    ]).toArray();
    const totalProblems = diffDist.reduce((s, d) => s + d.count, 0);
    const inflated = diffDist.filter((d) => d._id !== null && d._id > 10).reduce((s, d) => s + d.count, 0);
    report({ message: `[6] Difficulty distribution: ${diffDist.map((d) => `${d._id === null ? 'null' : d._id}=${d.count}`).join(', ')}` });
    report({ message: `[6] Problems with difficulty > 10: ${inflated}/${totalProblems}` });

    // -- 6. personal-duration start-time spread (sampling) ---------------------
    const durationContests = candidates.filter((c) => c.duration > 0 && c.inWindowParticipants >= 5);
    const sample = durationContests.slice(0, startSpreadSample);
    const spreads: number[] = [];
    for (const c of sample) {
        const starts = await documentStatusColl.find(
            { docType: TYPE_CONTEST, docId: c._id, startAt: { $ne: null }, uid: { $gt: 0 } },
            { projection: { startAt: 1 } },
        ).toArray() as any[];
        if (starts.length < 5) continue;
        const offsets = starts.map((s) => (s.startAt.getTime() - c.beginAt.getTime()) / 3600000);
        spreads.push(Math.max(...offsets) - Math.min(...offsets));
    }
    if (spreads.length) {
        spreads.sort((a, b) => a - b);
        report({
            message: `[7] Personal-duration start spread (sampled ${spreads.length}/${durationContests.length}):`
                + ` min=${hr(spreads[0])}, median=${hr(median(spreads))},`
                + ` p90=${hr(percentile(spreads, 0.9))}, max=${hr(spreads[spreads.length - 1])}`,
        });
        report({ message: `[7] De-facto synchronized contests (spread <= 1h): ${spreads.filter((s) => s <= 1).length}/${spreads.length}` });
    } else {
        report({ message: '[7] No personal-duration contests sampled' });
    }

    // -- 7. achievement proxy --------------------------------------------------
    const achievement = await documentStatusColl.aggregate([
        { $match: { docType: TYPE_PROBLEM, score: 100, rid: { $ne: null } } },
        { $group: { _id: '$uid', problems: { $addToSet: '$docId' } } },
        { $project: { n: { $size: '$problems' } } },
        { $sort: { n: -1 } },
    ]).toArray();
    const aSizes = achievement.map((a) => a.n);
    report({ message: `[8] Users with >=1 full-score problem status: ${aSizes.length}` });
    report({ message: `[8] Full-score (A proxy) buckets: ${JSON.stringify(bucketize(aSizes, [10, 50, 100, 200, 400]))}` });
    report({
        message: `[8] Top10 A proxy: ${aSizes.slice(0, 10).join(',')} -> P values: `
            + `${aSizes.slice(0, 10).map((a) => (600 * a / (a + 200)).toFixed(1)).join(',')}`,
    });

    // -- 8. record split -------------------------------------------------------
    const [inContest, practice] = await Promise.all([
        RecordModel.coll.countDocuments({ contest: { $ne: null } }),
        RecordModel.coll.countDocuments({ contest: null }),
    ]);
    report({
        message: `[9] Records: in-contest/homework ${inContest} vs practice ${practice}`
            + ` (${(100 * inContest / (inContest + practice)).toFixed(1)}% in-contest)`,
    });

    report({
        message: `Audit finished. Summary: ${
            JSON.stringify({
                generatedAt: now.toISOString(),
                options,
                qualifying: { allTime: qualifying.length, trailing: qualifyingTrailing.length },
                strictComparator: { allTime: strict.length, trailing: strictTrailing.length },
                problemsExposed: exposureSizes.length,
                problemsExposureGe20: exposureSizes.filter((n) => n >= 20).length,
                difficultyOver10: inflated,
                recordsOutsideWindow: totalRecords - totalInWindow,
                usersWithAchievement: aSizes.length,
            })}`,
    });
    return true;
}

const numberOpt = (desc: string, def: number) => Schema.number().min(0).description(desc).default(def);

export const apply = (ctx) => ctx.addScript(
    'rating-v2-audit',
    'Read-only P0 inventory audit for rating-v2 planning',
    Schema.object({
        minParticipants: numberOpt('Minimum distinct in-window participants for a qualifying contest', 1),
        rules: Schema.array(String).description('Contest rules considered').default(['acm', 'oi', 'ioi', 'strictioi']),
        includeDuration: Schema.boolean().description('Include personal-duration contests').default(true),
        includeAssign: Schema.boolean().description('Include contests assigned to courses').default(true),
        windowMonths: numberOpt('Trailing window in months', 12),
        startSpreadSample: numberOpt('Max personal-duration contests sampled for start-time spread', 50),
    }),
    run,
);
