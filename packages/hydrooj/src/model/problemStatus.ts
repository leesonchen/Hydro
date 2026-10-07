/* eslint-disable no-await-in-loop */
import { ObjectId } from 'mongodb';
import type { ProblemStatusDoc, RecordDoc, Tdoc } from '../interface';
import db from '../service/db';
import { STATUS } from './builtin';
import * as document from './document';

export type ContestRecordVisibility = (tdoc: Tdoc, targetUid: number) => boolean | Promise<boolean>;

const resultFields: (keyof ProblemStatusDoc)[] = ['rid', 'status', 'score'];

function pairKey(uid: number, pid: number) {
    return `${uid}/${pid}`;
}

function contestKey(contest: ObjectId) {
    return contest.toHexString();
}

function stripResult(psdoc: ProblemStatusDoc) {
    const result = { ...psdoc };
    for (const field of resultFields) delete result[field];
    return result;
}

function isNewer(left: RecordDoc, right?: RecordDoc) {
    if (!right) return true;
    const leftJudgeAt = left.judgeAt?.getTime() || left._id.getTimestamp().getTime();
    const rightJudgeAt = right.judgeAt?.getTime() || right._id.getTimestamp().getTime();
    if (leftJudgeAt !== rightJudgeAt) return leftJudgeAt > rightJudgeAt;
    return left._id.toHexString() > right._id.toHexString();
}

/**
 * Resolve the problem status that a viewer may observe without trusting the
 * global ProblemStatusDoc cache. The cache may currently point at a result
 * from a contest whose records are hidden from this viewer.
 */
export async function resolveVisibleProblemStatuses(
    domainId: string,
    uids: number[],
    pids: number[],
    canShowContestRecord: ContestRecordVisibility,
): Promise<ProblemStatusDoc[]> {
    const uniqueUids = Array.from(new Set(uids));
    const uniquePids = Array.from(new Set(pids));
    if (!uniqueUids.length || !uniquePids.length) return [];

    const rawStatuses = await document.getMultiStatus(domainId, document.TYPE_PROBLEM, {
        uid: { $in: uniqueUids },
        docId: { $in: uniquePids },
    }).toArray();
    const statuses = rawStatuses.map((psdoc) => ({ ...psdoc }));
    const statusByPair = new Map(statuses.map((psdoc) => [pairKey(psdoc.uid, psdoc.docId), psdoc]));
    const sourceRids = statuses.map((psdoc) => psdoc.rid).filter((rid): rid is ObjectId => !!rid);
    if (!sourceRids.length) return statuses;

    const sourceRecords = await db.collection('record').find({
        domainId,
        _id: { $in: sourceRids },
    }).project<Pick<RecordDoc, '_id' | 'uid' | 'pid' | 'contest' | 'status' | 'score' | 'judgeAt'>>({
        _id: 1, uid: 1, pid: 1, contest: 1, status: 1, score: 1, judgeAt: 1,
    }).toArray();
    const sourceByRid = new Map(sourceRecords.map((rdoc) => [rdoc._id.toHexString(), rdoc]));
    const sourceContestIds = sourceRecords
        .map((rdoc) => rdoc.contest)
        .filter((tid): tid is ObjectId => !!tid);
    const sourceTdocs = sourceContestIds.length
        ? await document.getMulti(
            domainId, document.TYPE_CONTEST, { docId: { $in: sourceContestIds } },
        ).toArray() as Tdoc[]
        : [];
    const contestById = new Map(sourceTdocs.map((tdoc) => [contestKey(tdoc.docId), tdoc]));
    const visibility = new Map<string, boolean>();
    const canShow = async (tdoc: Tdoc, uid: number) => {
        const key = `${contestKey(tdoc.docId)}/${uid}`;
        if (!visibility.has(key)) visibility.set(key, await canShowContestRecord(tdoc, uid));
        return visibility.get(key)!;
    };

    const hiddenPairs = new Set<string>();
    for (const psdoc of statuses) {
        if (!psdoc.rid) continue;
        const source = sourceByRid.get(psdoc.rid.toHexString());
        if (!source || source.uid !== psdoc.uid || source.pid !== psdoc.docId) {
            hiddenPairs.add(pairKey(psdoc.uid, psdoc.docId));
            continue;
        }
        if (!source.contest) continue;
        const tdoc = contestById.get(contestKey(source.contest));
        if (!tdoc || !await canShow(tdoc, psdoc.uid)) hiddenPairs.add(pairKey(psdoc.uid, psdoc.docId));
    }
    if (!hiddenPairs.size) return statuses;

    const hiddenUids = Array.from(new Set(Array.from(hiddenPairs, (key) => +key.split('/')[0])));
    const hiddenPids = Array.from(new Set(Array.from(hiddenPairs, (key) => +key.split('/')[1])));
    const tdocs = await document.getMulti(
        domainId, document.TYPE_CONTEST, { pids: { $in: hiddenPids } },
    ).toArray() as Tdoc[];
    const visibleContestIdsByUid = new Map<number, Set<string>>();
    const visibleContestIds = new Map<string, ObjectId>();
    for (const tdoc of tdocs) {
        if (!tdoc.pids?.some((pid) => hiddenPids.includes(pid))) continue;
        for (const uid of hiddenUids) {
            if (!await canShow(tdoc, uid)) continue;
            const tid = contestKey(tdoc.docId);
            if (!visibleContestIdsByUid.has(uid)) visibleContestIdsByUid.set(uid, new Set());
            visibleContestIdsByUid.get(uid)!.add(tid);
            visibleContestIds.set(tid, tdoc.docId);
        }
    }

    const sourceFilters: any[] = [{ contest: null }];
    if (visibleContestIds.size) sourceFilters.push({ contest: { $in: Array.from(visibleContestIds.values()) } });
    const candidates = await db.collection('record').find({
        domainId,
        practiceContest: { $exists: false },
        uid: { $in: hiddenUids },
        pid: { $in: hiddenPids },
        status: {
            $nin: [
                STATUS.STATUS_WAITING,
                STATUS.STATUS_FETCHED,
                STATUS.STATUS_COMPILING,
                STATUS.STATUS_JUDGING,
            ],
        },
        $or: sourceFilters,
    }).project<Pick<RecordDoc, '_id' | 'uid' | 'pid' | 'contest' | 'status' | 'score' | 'judgeAt'>>({
        _id: 1, uid: 1, pid: 1, contest: 1, status: 1, score: 1, judgeAt: 1,
    }).toArray();

    const accepted = new Map<string, RecordDoc>();
    const judged = new Map<string, RecordDoc>();
    for (const candidate of candidates as RecordDoc[]) {
        const key = pairKey(candidate.uid, candidate.pid);
        if (!hiddenPairs.has(key)) continue;
        if (candidate.contest
            && !visibleContestIdsByUid.get(candidate.uid)?.has(contestKey(candidate.contest))) continue;
        if (candidate.status === STATUS.STATUS_ACCEPTED) {
            if (isNewer(candidate, accepted.get(key))) accepted.set(key, candidate);
        } else if (isNewer(candidate, judged.get(key))) judged.set(key, candidate);
    }

    for (const key of hiddenPairs) {
        const raw = statusByPair.get(key);
        if (!raw) continue;
        const visible = stripResult(raw);
        const fallback = accepted.get(key) || judged.get(key);
        if (fallback) {
            visible.rid = fallback._id;
            visible.status = fallback.status;
            visible.score = fallback.score;
        }
        statusByPair.set(key, visible);
    }
    return statuses.map((psdoc) => statusByPair.get(pairKey(psdoc.uid, psdoc.docId))!);
}
