/* eslint-disable no-await-in-loop */
import { NumericDictionary, unionWith } from 'lodash';
import { Filter, ObjectId } from 'mongodb';
import Schema from 'schemastery';
import { Counter } from '@hydrooj/utils';
import { Tdoc, Udoc } from '../interface';
import difficultyAlgorithm from '../lib/difficulty';
import rating from '../lib/rating';
import type { RatingRow } from '../lib/rating-publication-store';
import { LEVELS, PRIV, STATUS } from '../model/builtin';
import * as contest from '../model/contest';
import * as document from '../model/document';
import domain from '../model/domain';
import problem from '../model/problem';
import UserModel from '../model/user';
import { rankRatingRows, refreshRating } from '../model/rating-publication';
import db from '../service/db';

export const description = 'Calculate rp of a domain, or all domains';

type ND = NumericDictionary<number>;
type Report = (data: any) => void;

interface RpDef {
    run(domainIds: string[], udict: ND, report: Report): Promise<void>;
    hidden: boolean;
    base: number;
}

const { log, max, min } = Math;

export const RpTypes: Record<string, RpDef> = {
    problem: {
        async run(domainIds, udict, report) {
            const teamContestCache = new Map<string, Promise<boolean>>();
            const reportedTeamMismatch = new Set<string>();
            const canCountContestRecord = async (tdoc: Tdoc, uid: number) => {
                const key = `${tdoc.domainId}/${tdoc.docId}`;
                if (!teamContestCache.has(key)) {
                    teamContestCache.set(
                        key,
                        tdoc.allowTeam
                            ? Promise.resolve(true)
                            : contest.hasTeamParticipation(tdoc.domainId, tdoc.docId),
                    );
                }
                if (await teamContestCache.get(key)) {
                    if (!tdoc.allowTeam && !reportedTeamMismatch.has(key)) {
                        reportedTeamMismatch.add(key);
                        await report({ message: `Excluded contest ${tdoc.docId}: team status exists while allowTeam is false` });
                    }
                    return false;
                }
                return contest.canShowProblemStatus(null, uid, tdoc, false);
            };
            // const problems = await problem.getMulti('', { domainId: { $in: domainIds }, nAccept: { $gt: 0 }, hidden: false }).toArray();
            const problems = await problem.getMulti('', { domainId: { $in: domainIds }, nAccept: { $gt: 0 } }).toArray();
            if (problems.length) await report({ message: `Found ${problems.length} problems in ${domainIds[0]}` });
            for (const pdoc of problems) {
                const rawStatuses = await problem.getMultiStatus(
                    pdoc.domainId,
                    {
                        docId: pdoc.docId,
                        rid: { $ne: null },
                        uid: { $ne: pdoc.owner },
                    },
                ).toArray();
                const psdocs = await problem.resolveVisibleStatuses(
                    pdoc.domainId,
                    rawStatuses.map((psdoc) => psdoc.uid),
                    [pdoc.docId],
                    canCountContestRecord,
                );
                // pdoc.difficulty is free user input; clamp the RP weight to the auto-calibrated [1,10] scale.
                const rawDifficulty = +pdoc.difficulty || difficultyAlgorithm(pdoc.nSubmit, pdoc.nAccept) || 5;
                const difficulty = Math.max(1, Math.min(10, rawDifficulty));
                const p = difficulty / 100;
                for (const psdoc of psdocs) {
                    if (!psdoc.rid || psdoc.uid === pdoc.owner || !psdoc.score) continue;
                    udict[psdoc.uid] += min(psdoc.score, 100) * p;
                }
            }
            for (const key in udict) udict[key] = max(0, min(udict[key], log(udict[key]) / log(1.03)));
        },
        hidden: false,
        base: 0,
    },
    contest: {
        async run(domainIds, udict, report) {
            const contests: Tdoc[] = [];
            const cursor = contest.getMulti('', {
                domainId: { $in: domainIds }, rated: true, allowTeam: { $ne: true },
            });
            for await (const tdoc of cursor) {
                if (await contest.hasTeamParticipation(tdoc.domainId, tdoc.docId)) {
                    await report({ message: `Excluded contest ${tdoc.docId}: team status exists while allowTeam is false` });
                    continue;
                }
                contests.push(tdoc);
                if (contests.length === 10) break;
            }
            if (contests.length) await report({ message: `Found ${contests.length} contests in ${domainIds[0]}` });
            for (const tdoc of contests.reverse()) {
                const start = Date.now();
                const query = {
                    docId: tdoc.docId,
                    journal: { $ne: null },
                };
                if (!await contest.countStatus(tdoc.domainId, query)) continue;
                const statusCursor = contest.getMultiStatus(tdoc.domainId, query).sort(contest.RULES[tdoc.rule].statusSort);
                const rankedTsdocs = await contest.RULES[tdoc.rule].ranked(tdoc, statusCursor);
                const users = rankedTsdocs.map((i) => ({ uid: i[1].uid, rank: i[0], old: udict[i[1].uid] }));
                // FIXME sum(rating.new) always less than sum(rating.old)
                for (const udoc of rating(users)) udict[udoc.uid] = udoc.new;
                await report({
                    case: {
                        status: STATUS.STATUS_ACCEPTED,
                        message: `Contest ${tdoc.title} finished`,
                        time: Date.now() - start,
                        memory: 0,
                        score: 0,
                    },
                });
            }
            for (const key in udict) udict[key] = max(1, udict[key] / 4 - 375);
        },
        hidden: false,
        base: 1500,
    },
    solution: {
        async run(domainIds, udict) {
            const pinned = await document.coll.aggregate<any>([
                {
                    $match: {
                        domainId: { $in: domainIds },
                        docType: document.TYPE_PROBLEM_SOLUTION,
                        pin: { $exists: true },
                    },
                },
                {
                    $group: {
                        _id: '$owner',
                        count: { $sum: 1 },
                    },
                },
            ]).toArray();
            for (const doc of pinned) udict[doc._id] += min(doc.count, 30);
        },
        hidden: false,
        base: 0,
    },
    delta: {
        async run(domainIds, udict) {
            const dudocs = unionWith(
                await domain.getMultiUserInDomain(
                    '', { domainId: { $in: domainIds }, rpdelta: { $exists: true } },
                ).toArray(),
                (a, b) => a.uid === b.uid,
            );
            for (const dudoc of dudocs) udict[dudoc.uid] = dudoc.rpdelta;
        },
        hidden: true,
        base: 0,
    },
};
global.Hydro.model.rp = RpTypes;

export async function calcLevel(domainId: string, report: Report) {
    await domain.setMultiUserInDomain(domainId, {}, { level: 0, rank: null });
    let last = { rp: null };
    let rank = 0;
    let count = 0;
    const coll = db.collection('domain.user');
    const filter = { rp: { $gt: 0 }, uid: { $nin: [0, 1], $gt: -1000 } };
    const ducur = domain.getMultiUserInDomain(domainId, filter)
        .project<{ _id: ObjectId, rp: number }>({ rp: 1 })
        .sort({ rp: -1 });
    let bulk = coll.initializeUnorderedBulkOp();
    for await (const dudoc of ducur) {
        count++;
        dudoc.rp ||= null;
        if (dudoc.rp !== last.rp) rank = count;
        bulk.find({ _id: dudoc._id }).updateOne({ $set: { rank } });
        last = dudoc;
        if (count % 100 === 0) report({ message: `#${count}: Rank ${rank}` });
    }
    if (!count) return;
    await bulk.execute();
    const levels = global.Hydro.model.builtin.LEVELS;
    bulk = coll.initializeUnorderedBulkOp();
    for (let i = 0; i < levels.length; i++) {
        const query: Filter<Udoc> = {
            domainId,
            $and: [{ rank: { $lte: (levels[i] * count) / 100 } }],
        };
        if (i < levels.length - 1) query.$and.push({ rank: { $gt: (levels[i + 1] * count) / 100 } });
        bulk.find(query).update({ $set: { level: i } });
    }
    await bulk.execute();
}

export async function calculateLegacyInDomain(domainId: string, report: Report = () => {}) {
    const results: Record<keyof typeof RpTypes, ND> = {};
    const udict = Counter();
    const info: Record<number, Record<string, number>> = {};
    for (const type in RpTypes) {
        results[type] = new Proxy({}, { get: (self, key) => self[key] || RpTypes[type].base });
        await RpTypes[type].run([domainId], results[type], report);
        for (const uid in results[type]) {
            if (+uid <= 1 || !Number.isSafeInteger(+uid)) continue;
            info[+uid] ||= {};
            info[+uid][type] = results[type][uid];
            udict[+uid] += results[type][uid];
        }
    }
    const members = await db.collection('domain.user').find({ domainId }).toArray();
    const byUid = new Map(members.map((member) => [member.uid, member]));
    const uids = [...new Set([...members.map((member) => member.uid), ...Object.keys(udict).map(Number)])]
        .filter((uid) => Number.isSafeInteger(uid) && uid > 1);
    const users = await UserModel.coll.find({ _id: { $in: uids } }, { projection: { _id: 1, priv: 1 } }).toArray();
    const rows: RatingRow[] = users.map((user) => {
        const visible = !!(user.priv & PRIV.PRIV_USER_PROFILE);
        return { uid: user._id, join: byUid.get(user._id)?.join === true, visible,
            rp: visible ? Math.max(0, udict[user._id] || 0) : 0,
            rpInfo: visible ? info[user._id] || {} : {}, rank: null, level: 0 };
    });
    rankRatingRows(rows);
    const ranked = rows.filter((row) => row.rank !== null);
    for (const row of ranked) {
        for (let i = 0; i < LEVELS.length; i++) {
            if (row.rank <= LEVELS[i] * ranked.length / 100
                && (i === LEVELS.length - 1 || row.rank > LEVELS[i + 1] * ranked.length / 100)) row.level = i;
        }
    }
    return { rows, summary: { domainId, users: rows.length, ranked: ranked.length }, parameters: {} };
}

export async function run({ domainId }, report: Report) {
    if (!domainId) {
        const domains = await domain.getMulti().toArray();
        await report({ message: `Found ${domains.length} domains` });
        for (const i in domains) {
            const start = Date.now();
            try {
                await refreshRating(domains[i]._id, report);
            } catch (error) {
                await report({ message: `Domain ${domains[i]._id} rating update failed; previous scores preserved: ${error.message}` });
                continue;
            }
            await report({
                case: {
                    status: STATUS.STATUS_ACCEPTED,
                    message: `Domain ${domains[i]._id} finished`,
                    time: Date.now() - start,
                    memory: 0,
                    score: 0,
                },
                progress: Math.floor(((+i + 1) / domains.length) * 100),
            });
        }
    } else await refreshRating(domainId, report);
    return true;
}

export const apply = (ctx) => ctx.addScript(
    'rp', 'Calculate rp of a domain, or all domains',
    Schema.object({ domainId: Schema.string() }), run,
);
