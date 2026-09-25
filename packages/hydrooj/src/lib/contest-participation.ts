import { ObjectId } from 'mongodb';
import type { ContestStatusDoc, Tdoc } from '../interface';
import * as document from '../model/document';
import UserModel from '../model/user';

export const CONTEST_PARTICIPANT_INDEX = 'contestParticipant';

export interface ContestParticipationFinding {
    type: string;
    domainId: string;
    tid?: string;
    tids?: string[];
    uids?: number[];
    statusUids?: number[];
    expected?: number;
    actual?: number;
    detail?: string;
}

type Report = (finding: ContestParticipationFinding) => void;

function hasMembersField(tsdoc: ContestStatusDoc) {
    return Object.hasOwn(tsdoc, 'members');
}

function sameUidSet(left: number[], right: number[]) {
    if (left.length !== right.length) return false;
    const a = [...left].sort((x, y) => x - y);
    const b = [...right].sort((x, y) => x - y);
    return a.every((uid, index) => uid === b[index]);
}

export function deriveParticipantUids(tsdoc: Pick<ContestStatusDoc, 'uid' | 'members'>) {
    if (Object.hasOwn(tsdoc, 'members')) {
        if (!Array.isArray(tsdoc.members) || !tsdoc.members.length) return [];
        return Array.from(new Set(tsdoc.members)).sort((a, b) => a - b);
    }
    return Number.isSafeInteger(tsdoc.uid) && tsdoc.uid > 0 ? [tsdoc.uid] : [];
}

export async function hasTeamParticipation(domainId: string, tid: ObjectId) {
    return !!await document.collStatus.findOne({
        domainId,
        docType: document.TYPE_CONTEST,
        docId: tid,
        attend: { $gt: 0 },
        'members.0': { $exists: true },
    }, { projection: { _id: 1 } });
}

export async function auditContestParticipation(report: Report = () => {}) {
    const findings: ContestParticipationFinding[] = [];
    const affectedRatingDomains = new Map<string, Set<string>>();
    const add = (finding: ContestParticipationFinding) => {
        findings.push(finding);
        report(finding);
    };
    const cursor = document.coll.find(
        { docType: document.TYPE_CONTEST },
        {
            projection: {
                domainId: 1, docId: 1, rule: 1, rated: 1, allowTeam: 1, attend: 1,
            },
        },
    ).sort({ domainId: 1, docId: 1 });

    for await (const raw of cursor) {
        const tdoc = raw as Tdoc;
        const tid = tdoc.docId.toString();
        const statuses = await document.collStatus.find({
            domainId: tdoc.domainId,
            docType: document.TYPE_CONTEST,
            docId: tdoc.docId,
            attend: { $exists: true },
        }).toArray() as ContestStatusDoc[];
        const attended = statuses.filter((tsdoc) => !!tsdoc.attend);
        const teamStatuses = attended.filter(hasMembersField);

        if (tdoc.rated && tdoc.allowTeam) {
            add({ type: 'rated-team-config', domainId: tdoc.domainId, tid });
        }
        if (tdoc.allowTeam && ['course', 'homework'].includes(tdoc.rule)) {
            add({ type: 'unsupported-team-config', domainId: tdoc.domainId, tid, detail: tdoc.rule });
        }
        if (teamStatuses.length && !tdoc.allowTeam) {
            add({
                type: 'team-status-without-config',
                domainId: tdoc.domainId,
                tid,
                statusUids: teamStatuses.map((tsdoc) => tsdoc.uid),
            });
        }
        if (teamStatuses.length && ['course', 'homework'].includes(tdoc.rule)) {
            add({
                type: 'unsupported-team-status',
                domainId: tdoc.domainId,
                tid,
                statusUids: teamStatuses.map((tsdoc) => tsdoc.uid),
                detail: tdoc.rule,
            });
        }
        if (tdoc.rated && (tdoc.allowTeam || teamStatuses.length)) {
            if (!affectedRatingDomains.has(tdoc.domainId)) affectedRatingDomains.set(tdoc.domainId, new Set());
            affectedRatingDomains.get(tdoc.domainId)!.add(tid);
        }

        const validMemberUids = new Set<number>();
        const participants = new Map<number, Array<{ statusUid: number, team: boolean }>>();
        for (const tsdoc of attended) {
            const team = hasMembersField(tsdoc);
            if (team) {
                if (!Array.isArray(tsdoc.members)) {
                    add({ type: 'invalid-team-members', domainId: tdoc.domainId, tid, statusUids: [tsdoc.uid] });
                    continue;
                }
                if (!tsdoc.members.length) {
                    add({ type: 'empty-team-members', domainId: tdoc.domainId, tid, statusUids: [tsdoc.uid] });
                    continue;
                }
                const uniqueMembers = new Set(tsdoc.members);
                if (uniqueMembers.size !== tsdoc.members.length) {
                    add({
                        type: 'duplicate-team-members',
                        domainId: tdoc.domainId,
                        tid,
                        statusUids: [tsdoc.uid],
                        uids: tsdoc.members,
                    });
                }
                const invalid = tsdoc.members.filter((uid) => !Number.isSafeInteger(uid) || uid <= 0);
                if (invalid.length) {
                    add({
                        type: 'invalid-team-member-uid',
                        domainId: tdoc.domainId,
                        tid,
                        statusUids: [tsdoc.uid],
                        uids: invalid,
                    });
                }
                for (const uid of uniqueMembers) {
                    if (Number.isSafeInteger(uid) && uid > 0) validMemberUids.add(uid);
                }
            }

            const expected = deriveParticipantUids(tsdoc);
            if (Object.hasOwn(tsdoc, 'participantUids')) {
                const actual = (tsdoc as ContestStatusDoc).participantUids;
                if (!Array.isArray(actual)
                    || new Set(actual).size !== actual.length
                    || !sameUidSet(actual, expected)) {
                    add({
                        type: 'participant-uids-mismatch',
                        domainId: tdoc.domainId,
                        tid,
                        statusUids: [tsdoc.uid],
                        uids: Array.isArray(actual) ? actual : [],
                    });
                }
            }
            for (const uid of expected) {
                if (!participants.has(uid)) participants.set(uid, []);
                participants.get(uid)!.push({ statusUid: tsdoc.uid, team });
            }
        }

        if (validMemberUids.size) {
            const existing = await UserModel.coll.find(
                { _id: { $in: [...validMemberUids] } },
                { projection: { _id: 1 } },
            ).toArray();
            const existingUids = new Set(existing.map((udoc) => udoc._id));
            const missing = [...validMemberUids].filter((uid) => !existingUids.has(uid));
            if (missing.length) add({ type: 'missing-team-member', domainId: tdoc.domainId, tid, uids: missing });
        }

        for (const [uid, owners] of participants) {
            if (owners.length <= 1) continue;
            const teams = owners.filter((owner) => owner.team).length;
            add({
                type: teams === owners.length ? 'member-in-multiple-teams' : 'personal-team-duplicate',
                domainId: tdoc.domainId,
                tid,
                uids: [uid],
                statusUids: owners.map((owner) => owner.statusUid),
            });
        }

        if ((tdoc.attend || 0) !== attended.length) {
            add({
                type: 'attend-count-mismatch',
                domainId: tdoc.domainId,
                tid,
                expected: attended.length,
                actual: tdoc.attend || 0,
            });
        }
    }

    for (const [domainId, tids] of affectedRatingDomains) {
        add({ type: 'rating-domain-affected', domainId, tids: [...tids] });
    }
    return findings;
}

export async function backfillContestParticipantUids() {
    let updated = 0;
    const cursor = document.collStatus.find({
        docType: document.TYPE_CONTEST,
        $or: [{ attend: { $gt: 0 } }, { attend: true }],
        participantUids: { $exists: false },
    });
    for await (const raw of cursor) {
        const participantUids = deriveParticipantUids(raw as ContestStatusDoc);
        if (!participantUids.length) continue;
        const result = await document.collStatus.updateOne(
            { _id: raw._id, participantUids: { $exists: false } },
            { $set: { participantUids } },
        );
        updated += result.modifiedCount;
    }
    return updated;
}

export async function countPendingContestParticipantUids() {
    let pending = 0;
    const cursor = document.collStatus.find({
        docType: document.TYPE_CONTEST,
        $or: [{ attend: { $gt: 0 } }, { attend: true }],
        participantUids: { $exists: false },
    });
    for await (const raw of cursor) {
        if (deriveParticipantUids(raw as ContestStatusDoc).length) pending++;
    }
    return pending;
}

export function ensureContestParticipantIndex() {
    return document.collStatus.createIndex(
        { domainId: 1, docType: 1, docId: 1, participantUids: 1 },
        {
            name: CONTEST_PARTICIPANT_INDEX,
            unique: true,
            partialFilterExpression: { participantUids: { $exists: true } },
        },
    );
}

export async function migrateContestParticipantUids(report: Report = () => {}) {
    let findings = await auditContestParticipation(report);
    if (findings.length) throw new Error(`Contest team audit failed with ${findings.length} finding(s).`);
    const updated = await backfillContestParticipantUids();
    const pending = await countPendingContestParticipantUids();
    if (pending) throw new Error(`Contest participant backfill left ${pending} pending status document(s).`);
    findings = await auditContestParticipation(report);
    if (findings.length) throw new Error(`Contest team audit failed after backfill with ${findings.length} finding(s).`);
    await ensureContestParticipantIndex();
    return updated;
}
