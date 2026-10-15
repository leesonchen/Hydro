import { get as getPath, pick, sumBy } from 'lodash';
import { Collection, Filter, ObjectId } from 'mongodb';
import {
    Counter, formatSeconds, getAlphabeticId, sleep, Time,
} from '@hydrooj/utils/lib/utils';
import { Context } from '../context';
import {
    BadRequestError, ContestAlreadyAttendedError, ContestNotFoundError,
    ContestScoreboardHiddenError, NotAssignedError, PermissionError, UserNotFoundError, ValidationError,
} from '../error';
import {
    BaseUserDict, ContestJournalEntry, ContestPrintDoc, ContestRule, ContestRules,
    ContestStatusDoc, ProblemDict, RecordDoc, ScoreboardConfig, ScoreboardNode,
    ScoreboardRow, SubtaskResult, Tdoc,
} from '../interface';
import avatar from '../lib/avatar';
import { hasTeamParticipation } from '../lib/contest-participation';
import bus from '../service/bus';
import db from '../service/db';
import type { Handler } from '../service/server';
import { Optional } from '../typeutils';
import { PERM, STATUS, STATUS_SHORT_TEXTS } from './builtin';
import * as document from './document';
import MessageModel from './message';
import problem, { ProblemModel } from './problem';
import RecordModel from './record';
import UserModel, { User } from './user';

export { hasTeamParticipation };

export enum PrintTaskStatus {
    pending = 'pending',
    printing = 'printing',
    printed = 'printed',
    failed = 'failed',
}

interface AcmJournal {
    rid: ObjectId;
    pid: number;
    score: number;
    status: number;
    time: number;
}
interface AcmDetail extends AcmJournal {
    naccept?: number;
    npending?: number;
    penalty: number;
    real: number;
}

export function isNew(tdoc: Tdoc, days = 1) {
    const readyAt = tdoc.beginAt.getTime();
    return Date.now() < readyAt - days * Time.day;
}

export function isUpcoming(tdoc: Tdoc, days = 7) {
    const now = Date.now();
    const readyAt = tdoc.beginAt.getTime();
    return (now > readyAt - days * Time.day && now < readyAt);
}

export function isNotStarted(tdoc: Tdoc) {
    return (new Date()) < tdoc.beginAt;
}

export function isOngoing(tdoc: Tdoc, tsdoc?: ContestStatusDoc): boolean {
    const now = new Date();
    if (tsdoc?.endAt && tsdoc.endAt <= now) return false;
    if (tsdoc && tdoc.duration && tsdoc.startAt <= new Date(Date.now() - Math.floor(tdoc.duration * Time.hour))) return false;
    return (tdoc.beginAt <= now && now < tdoc.endAt);
}

export function isDone(tdoc: Tdoc, tsdoc?: ContestStatusDoc): boolean {
    if (tdoc.endAt <= new Date()) return true;
    if (tsdoc?.endAt && tsdoc.endAt <= new Date()) return true;
    if (tsdoc && tdoc.duration && tsdoc.startAt <= new Date(Date.now() - Math.floor(tdoc.duration * Time.hour))) return true;
    return false;
}

export function isLocked(tdoc: Tdoc, time = new Date()) {
    if (!tdoc.lockAt) return false;
    return tdoc.lockAt < time && !tdoc.unlocked;
}

export function isExtended(tdoc: Tdoc) {
    const now = Date.now();
    return tdoc.penaltySince.getTime() <= now && now < tdoc.endAt.getTime();
}

async function getScoreboardUdict(
    tdoc: Tdoc, rankedTsdocs: [number, ContestStatusDoc][], uids: number[], showDisplayName: boolean,
) {
    const memberUids = tdoc.allowTeam
        ? rankedTsdocs.flatMap(([, tsdoc]) => tsdoc.members || [])
        : [];
    const udict = await UserModel.getListForRender(tdoc.domainId, [...uids, ...memberUids], showDisplayName ? ['displayName'] : []);
    if (tdoc.allowTeam) {
        for (const [, tsdoc] of rankedTsdocs) {
            if (tsdoc.members?.length && udict[tsdoc.uid]) {
                (udict[tsdoc.uid] as any).teamMembers = tsdoc.members.filter((uid) => udict[uid]);
            }
        }
    }
    return udict;
}

export function buildContestRule<T>(def: Optional<ContestRule<T>, 'applyProjection'>): ContestRule<T>;
export function buildContestRule<T>(def: Partial<ContestRule<T>>, baseRule: ContestRule<T>): ContestRule<T>;
export function buildContestRule<T>(def: Partial<ContestRule<T>>, baseRule: ContestRule<T> = {} as any) {
    const base = baseRule._originalRule || { applyProjection: (_, rdoc) => rdoc };
    const funcs = ['scoreboard', 'scoreboardRow', 'scoreboardHeader', 'stat', 'applyProjection'];
    const f = {};
    const rule = { ...baseRule, ...def };
    for (const key of funcs) {
        f[key] = def[key] || base[key];
        rule[key] = f[key].bind(rule);
    }
    rule._originalRule = f;
    return rule;
}

const acm = buildContestRule({
    TEXT: 'XCPC',
    check: () => { },
    statusSort: { accept: -1, time: 1 },
    submitAfterAccept: false,
    showScoreboard: (tdoc, now) => now > tdoc.beginAt,
    showSelfRecord: () => true,
    showRecord: (tdoc, now) => now > tdoc.endAt && !isLocked(tdoc),
    stat(tdoc, journal: AcmJournal[]) {
        const naccept = Counter<number>();
        const npending = Counter<number>();
        const display: Record<number, AcmDetail> = {};
        const detail: Record<number, AcmDetail> = {};
        let accept = 0;
        let time = 0;
        const lockAt = isLocked(tdoc) ? tdoc.lockAt : null;
        for (const j of journal) {
            if (!tdoc.pids.includes(j.pid)) continue;
            if (!this.submitAfterAccept && display[j.pid]?.status === STATUS.STATUS_ACCEPTED) continue;
            if (![STATUS.STATUS_ACCEPTED, STATUS.STATUS_COMPILE_ERROR, STATUS.STATUS_FORMAT_ERROR, STATUS.STATUS_CANCELED].includes(j.status)) {
                naccept[j.pid]++;
            }
            const real = Math.floor((j.rid.getTimestamp().getTime() - tdoc.beginAt.getTime()) / 1000);
            const penalty = 20 * 60 * naccept[j.pid];
            detail[j.pid] = {
                ...j, naccept: naccept[j.pid], time: real + penalty, real, penalty,
            };
            if (lockAt && j.rid.getTimestamp() > lockAt) {
                npending[j.pid]++;
                // FIXME this is tricky
                // @ts-ignore
                display[j.pid] ||= {};
                display[j.pid].npending = npending[j.pid];
                continue;
            }
            display[j.pid] = detail[j.pid];
        }
        for (const d of Object.values(display).filter((i) => i.status === STATUS.STATUS_ACCEPTED)) {
            accept++;
            time += d.time;
        }
        return {
            accept, time, detail, display,
        };
    },
    async scoreboardHeader(config, _, tdoc, pdict) {
        const columns: ScoreboardRow = [
            { type: 'rank', value: '#' },
            { type: 'user', value: _('User') },
        ];
        if (config.isExport && config.showDisplayName) {
            columns.push({ type: 'email', value: _('Email') });
            columns.push({ type: 'string', value: _('School') });
            columns.push({ type: 'string', value: _('Name') });
            columns.push({ type: 'string', value: _('Student ID') });
        }
        columns.push({ type: 'solved', value: `${_('Solved')}\n${_('Total Time')}` });
        for (let i = 1; i <= tdoc.pids.length; i++) {
            const pid = tdoc.pids[i - 1];
            pdict[pid].nAccept = pdict[pid].nSubmit = 0;
            if (config.isExport) {
                columns.push(
                    {
                        type: 'string',
                        value: '#{0} {1}'.format(i, pdict[pid].title),
                    },
                    {
                        type: 'time',
                        value: '#{0} {1}'.format(i, _('Penalty (Minutes)')),
                    },
                );
            } else {
                columns.push({
                    type: 'problem',
                    value: getAlphabeticId(i - 1),
                    raw: pid,
                });
            }
        }
        return columns;
    },
    async scoreboardRow(config, _, tdoc, pdict, udoc, rank, tsdoc, meta) {
        const row: ScoreboardRow = [
            { type: 'rank', value: rank.toString() },
            { type: 'user', value: udoc.uname, raw: tsdoc.uid },
        ];
        if (config.isExport && config.showDisplayName) {
            row.push({ type: 'email', value: udoc.mail });
            row.push({ type: 'string', value: udoc.school || '' });
            row.push({ type: 'string', value: udoc.displayName || '' });
            row.push({ type: 'string', value: udoc.studentId || '' });
        }
        row.push({
            type: 'time',
            value: `${tsdoc.accept || 0}\n${formatSeconds(tsdoc.time || 0.0, false)}`,
            hover: formatSeconds(tsdoc.time || 0.0),
        });
        const accepted = {};
        for (const s of tsdoc.journal || []) {
            if (!pdict[s.pid]) continue;
            if (config.lockAt && s.rid.getTimestamp() > config.lockAt) continue;
            pdict[s.pid].nSubmit++;
            if (s.status === STATUS.STATUS_ACCEPTED && !accepted[s.pid]) {
                pdict[s.pid].nAccept++;
                accepted[s.pid] = true;
            }
        }
        const tsddict = (config.lockAt ? tsdoc.display : tsdoc.detail) || {};
        for (const pid of tdoc.pids) {
            const doc = tsddict[pid] || {} as Partial<AcmDetail>;
            const accept = doc.status === STATUS.STATUS_ACCEPTED;
            const colTime = accept ? formatSeconds(doc.real, false).toString() : '';
            const colPenalty = doc.rid ? Math.ceil(doc.penalty / 60).toString() : '';
            if (config.isExport) {
                row.push(
                    { type: 'string', value: colTime },
                    { type: 'string', value: colPenalty },
                );
            } else {
                let value = '';
                if (doc.rid) value = `-${doc.naccept}`;
                if (accept) value = `${doc.naccept ? `+${doc.naccept}` : '<span class="icon icon-check"></span>'}\n${colTime}`;
                else if (doc.npending) value += `${value ? ' ' : ''}<span style="color:orange">+${doc.npending}</span>`;
                row.push({
                    type: 'record',
                    score: accept ? 100 : 0,
                    value,
                    hover: accept ? formatSeconds(doc.time) : '',
                    raw: doc.rid,
                    style: accept && doc.rid.getTimestamp().getTime() === meta?.first?.[pid]
                        ? 'background-color: rgb(217, 240, 199);'
                        : undefined,
                });
            }
        }
        return row;
    },
    async scoreboard(config, _, tdoc, pdict, cursor) {
        const rankedTsdocs = await db.ranked(cursor, (a, b) => (a.score || 0) === (b.score || 0) && (a.time || 0) === (b.time || 0));
        const uids = rankedTsdocs.map(([, tsdoc]) => tsdoc.uid);
        const udict = await getScoreboardUdict(tdoc, rankedTsdocs, uids, config.showDisplayName);
        // Find first accept
        const first = {};
        const data = await document.collStatus.aggregate([
            {
                $match: {
                    domainId: tdoc.domainId,
                    docType: document.TYPE_CONTEST,
                    docId: tdoc.docId,
                    accept: { $gte: 1 },
                    ...(tdoc.sourceType === 'course_assessment' ? { attend: { $gt: 0 } } : {}),
                },
            },
            { $project: { r: { $objectToArray: '$detail' } } },
            { $unwind: '$r' },
            { $match: { 'r.v.status': STATUS.STATUS_ACCEPTED } },
            { $group: { _id: '$r.v.pid', first: { $min: '$r.v.rid' } } },
        ]).toArray() as any[];
        for (const t of data) first[t._id] = t.first.getTimestamp().getTime();

        const columns = await this.scoreboardHeader(config, _, tdoc, pdict);
        const rows: ScoreboardRow[] = [
            columns,
            ...await Promise.all(rankedTsdocs.map(
                ([rank, tsdoc]) => this.scoreboardRow(
                    config, _, tdoc, pdict, udict[tsdoc.uid], rank, tsdoc, { first },
                ),
            )),
        ];
        return [rows, udict];
    },
    async ranked(tdoc, cursor) {
        return await db.ranked(cursor, (a, b) => a.accept === b.accept && a.time === b.time);
    },
    applyProjection(tdoc, rdoc) {
        if (isDone(tdoc)) return rdoc;
        delete rdoc.time;
        delete rdoc.memory;
        rdoc.testCases = [];
        rdoc.judgeTexts = [];
        delete rdoc.progress;
        delete rdoc.subtasks;
        delete rdoc.score;
        return rdoc;
    },
});

const oi = buildContestRule({
    TEXT: 'OI',
    check: () => { },
    submitAfterAccept: true,
    statusSort: { score: -1 },
    stat(tdoc, journal) {
        const npending = Counter();
        const detail = {};
        const display = {};
        let score = 0;

        const lockAt = isLocked(tdoc) ? tdoc.lockAt : null;
        for (const j of journal.filter((i) => tdoc.pids.includes(i.pid))) {
            if (lockAt && j.rid.getTimestamp() > lockAt) {
                npending[j.pid]++;
                display[j.pid] ||= {};
                display[j.pid].npending = npending[j.pid];
                continue;
            }
            if (!detail[j.pid] || detail[j.pid].score < j.score || this.submitAfterAccept) {
                detail[j.pid] = { ...j };
                display[j.pid] = { ...j };
            }
        }
        for (const i in display) {
            score += ((tdoc.score?.[i] || 100) * (display[i].score || 0)) / 100;
        }
        return { score, detail, display };
    },
    showScoreboard: (tdoc, now) => now > tdoc.endAt && !tdoc.keepScoreboardHidden,
    showSelfRecord: (tdoc, now) => now > tdoc.endAt && !tdoc.keepScoreboardHidden,
    showRecord: (tdoc, now) => now > tdoc.endAt && !tdoc.keepScoreboardHidden,
    async scoreboardHeader(config, _, tdoc, pdict) {
        const columns: ScoreboardNode[] = [
            { type: 'rank', value: '#' },
            { type: 'user', value: _('User') },
        ];
        if (config.isExport && config.showDisplayName) {
            columns.push({ type: 'email', value: _('Email') });
            columns.push({ type: 'string', value: _('School') });
            columns.push({ type: 'string', value: _('Name') });
            columns.push({ type: 'string', value: _('Student ID') });
        }
        columns.push({ type: 'total_score', value: _('Total Score') });
        for (let i = 1; i <= tdoc.pids.length; i++) {
            const pid = tdoc.pids[i - 1];
            pdict[pid].nAccept = pdict[pid].nSubmit = 0;
            if (config.isExport) {
                columns.push({
                    type: 'string',
                    value: '#{0} {1}'.format(i, pdict[tdoc.pids[i - 1]].title),
                });
            } else {
                columns.push({
                    type: 'problem',
                    value: getAlphabeticId(i - 1),
                    raw: tdoc.pids[i - 1],
                });
            }
        }
        return columns;
    },
    async scoreboardRow(config, _, tdoc, pdict, udoc, rank, tsdoc, meta) {
        const row: ScoreboardNode[] = [
            { type: 'rank', value: rank.toString() },
            { type: 'user', value: udoc.uname, raw: tsdoc.uid },
        ];
        const displayScore = (pid: number, score?: number) => {
            if (typeof score !== 'number') return '-';
            return score * ((tdoc.score?.[pid] || 100) / 100);
        };
        if (config.isExport && config.showDisplayName) {
            row.push({ type: 'email', value: udoc.mail });
            row.push({ type: 'string', value: udoc.school || '' });
            row.push({ type: 'string', value: udoc.displayName || '' });
            row.push({ type: 'string', value: udoc.studentId || '' });
        }
        row.push({ type: 'total_score', value: (tsdoc.score || 0).toString() });
        const accepted = {};
        for (const s of tsdoc.journal || []) {
            if (!pdict[s.pid]) continue;
            if (config.lockAt && s.rid.getTimestamp() > config.lockAt) continue;
            pdict[s.pid].nSubmit++;
            if (s.status === STATUS.STATUS_ACCEPTED && !accepted[s.pid]) {
                pdict[s.pid].nAccept++;
                accepted[s.pid] = true;
            }
        }
        const tsddict = ((config.lockAt && isLocked(tdoc, new Date())) ? tsdoc.display : tsdoc.detail) || {};
        const useRelativeTime = !!tdoc.duration;
        for (const pid of tdoc.pids) {
            const index = `${tsdoc.uid}/${tdoc.domainId}/${pid}`;

            const node: ScoreboardNode = (!config.isExport && !config.lockAt && isDone(tdoc)
                && meta?.psdict?.[index]?.rid
                && tsddict[pid]?.rid?.toHexString() !== meta?.psdict?.[index]?.rid?.toHexString()
                && meta?.psdict?.[index]?.rid?.getTimestamp() > tdoc.endAt)
                ? {
                    type: 'records',
                    value: '',
                    raw: [{
                        value: displayScore(pid, tsddict[pid]?.score),
                        raw: tsddict[pid]?.rid || null,
                        score: tsddict[pid]?.score,
                    }, {
                        value: displayScore(pid, meta?.psdict?.[index]?.score),
                        raw: meta?.psdict?.[index]?.rid ?? null,
                        score: meta?.psdict?.[index]?.score,
                    }],
                } : {
                    type: 'record',
                    value: `${displayScore(pid, tsddict[pid]?.score)}${tsddict[pid]?.npending
                        ? `<span style="color:orange">+${tsddict[pid]?.npending}</span>` : ''}`,
                    raw: tsddict[pid]?.rid || null,
                    score: tsddict[pid]?.score,
                };
            if (tsddict[pid]?.status === STATUS.STATUS_ACCEPTED) {
                const startAt = (useRelativeTime ? tsdoc.startAt || tdoc.beginAt : tdoc.beginAt).getTime();
                if (tsddict[pid].rid.getTimestamp().getTime() - startAt === meta?.first?.[pid]) {
                    node.style = 'background-color: rgb(217, 240, 199);';
                }
            }
            row.push(node);
        }
        return row;
    },
    async scoreboard(config, _, tdoc, pdict, cursor) {
        const rankedTsdocs = await db.ranked(cursor, (a, b) => (a.score || 0) === (b.score || 0));
        const uids = rankedTsdocs.map(([, tsdoc]) => tsdoc.uid);
        const udict = await getScoreboardUdict(tdoc, rankedTsdocs, uids, config.showDisplayName);
        const psdict = {};
        const first = {};
        const useRelativeTime = !!tdoc.duration;
        for (const [, tsdoc] of rankedTsdocs) {
            for (const [pid, detail] of Object.entries(tsdoc.detail || {})) {
                if (detail.status !== STATUS.STATUS_ACCEPTED) continue;
                const time = detail.rid.getTimestamp().getTime() - (useRelativeTime ? tsdoc.startAt || tdoc.beginAt : tdoc.beginAt).getTime();
                if (!first[pid] || first[pid] > time) first[pid] = time;
            }
        }

        if (isDone(tdoc)) {
            const psdocs = await problem.resolveVisibleStatuses(
                tdoc.domainId, uids, tdoc.pids,
                // The shared policy helper is declared after RULES is initialized.
                // eslint-disable-next-line ts/no-use-before-define
                (source, uid) => canShowProblemStatus(config.viewer || null, uid, source),
            );
            for (const psdoc of psdocs) {
                psdict[`${psdoc.uid}/${psdoc.domainId}/${psdoc.docId}`] = psdoc;
            }
        }
        const columns = await this.scoreboardHeader(config, _, tdoc, pdict);
        const rows: ScoreboardRow[] = [
            columns,
            ...await Promise.all(rankedTsdocs.map(
                ([rank, tsdoc]) => this.scoreboardRow(
                    config, _, tdoc, pdict, udict[tsdoc.uid], rank, tsdoc, { psdict, first },
                ),
            )),
        ];
        return [rows, udict];
    },
    async ranked(tdoc, cursor) {
        return await db.ranked(cursor, (a, b) => a.score === b.score);
    },
    applyProjection(tdoc, rdoc, udoc) {
        // The shared policy helper is declared after RULES is initialized.
        // eslint-disable-next-line ts/no-use-before-define
        if (canShowProblemStatus(udoc, rdoc.uid, tdoc)) return rdoc;
        delete rdoc.status;
        rdoc.compilerTexts = [];
        rdoc.judgeTexts = [];
        delete rdoc.memory;
        delete rdoc.time;
        delete rdoc.score;
        rdoc.testCases = [];
        delete rdoc.subtasks;
        return rdoc;
    },
});

const ioi = buildContestRule({
    TEXT: 'IOI',
    submitAfterAccept: false,

    showRecord: (tdoc, now) => now > tdoc.endAt && !isLocked(tdoc),
    showSelfRecord: () => true,
    showScoreboard: (tdoc, now) => now > tdoc.beginAt,
    applyProjection(_, rdoc) {
        return rdoc;
    },
}, oi);

const strictioi = buildContestRule({
    TEXT: 'IOI(Strict)',
    submitAfterAccept: false,
    showRecord: (tdoc, now) => now > tdoc.endAt && !tdoc.keepScoreboardHidden,
    showSelfRecord: (tdoc) => !tdoc.keepScoreboardHidden || !isDone(tdoc),
    showScoreboard: (tdoc, now) => now > tdoc.endAt && !tdoc.keepScoreboardHidden,
    stat(tdoc, journal) {
        const detail = {};
        let score = 0;
        const subtasks: Record<number, Record<number, SubtaskResult>> = {};
        for (const j of journal.filter((i) => tdoc.pids.includes(i.pid))) {
            subtasks[j.pid] ||= {};
            for (const i in j.subtasks) {
                if (!subtasks[j.pid][i] || subtasks[j.pid][i].score < j.subtasks[i].score) subtasks[j.pid][i] = j.subtasks[i];
            }
            j.score = sumBy(Object.values(subtasks[j.pid]), 'score');
            j.status = Math.max(...Object.values(subtasks[j.pid]).map((i) => i.status));
            if (!detail[j.pid] || detail[j.pid].score < j.score) detail[j.pid] = { ...j, subtasks: subtasks[j.pid] };
        }
        for (const i in detail) score += ((tdoc.score?.[i] || 100) * (detail[i].score || 0)) / 100;
        return { score, detail };
    },
    async scoreboardRow(config, _, tdoc, pdict, udoc, rank, tsdoc, meta) {
        const tsddict = tsdoc.detail || {};
        const row: ScoreboardNode[] = [
            { type: 'rank', value: rank.toString() },
            { type: 'user', value: udoc.uname, raw: tsdoc.uid },
        ];
        if (config.isExport && config.showDisplayName) {
            row.push({ type: 'email', value: udoc.mail });
            row.push({ type: 'string', value: udoc.school || '' });
            row.push({ type: 'string', value: udoc.displayName || '' });
            row.push({ type: 'string', value: udoc.studentId || '' });
        }
        row.push({ type: 'total_score', value: (tsdoc.score || 0).toString() });
        const accepted = {};
        for (const s of tsdoc.journal || []) {
            if (!pdict[s.pid]) continue;
            pdict[s.pid].nSubmit++;
            if (s.status === STATUS.STATUS_ACCEPTED && !accepted[s.pid]) {
                pdict[s.pid].nAccept++;
                accepted[s.pid] = true;
            }
        }
        for (const pid of tdoc.pids) {
            const index = `${tsdoc.uid}/${tdoc.domainId}/${pid}`;
            const n: ScoreboardNode = (!config.isExport && !config.lockAt && isDone(tdoc)
                && meta?.psdict?.[index]?.rid
                && tsddict[pid]?.rid?.toHexString() !== meta?.psdict?.[index]?.rid?.toHexString()
                && meta?.psdict?.[index]?.rid?.getTimestamp() > tdoc.endAt)
                ? {
                    type: 'records',
                    value: '',
                    raw: [{
                        value: ((tsddict[pid]?.score || 0) * ((tdoc.score?.[pid] || 100) / 100)).toString() || '',
                        raw: tsddict[pid]?.rid || null,
                        score: tsddict[pid]?.score,
                    }, {
                        value: ((meta?.psdict?.[index]?.score || 0) * ((tdoc.score?.[pid] || 100) / 100)).toString() || '',
                        raw: meta?.psdict?.[index]?.rid ?? null,
                        score: meta?.psdict?.[index]?.score,
                    }],
                } : {
                    type: 'record',
                    value: ((tsddict[pid]?.score || 0) * ((tdoc.score?.[pid] || 100) / 100)).toString() || '',
                    raw: tsddict[pid]?.rid,
                    score: tsddict[pid]?.score,
                };
            n.hover = Object.values(tsddict[pid]?.subtasks || {}).map((i: SubtaskResult) => `${STATUS_SHORT_TEXTS[i.status]} ${i.score}`).join(',');
            if (tsddict[pid]?.status === STATUS.STATUS_ACCEPTED
                && tsddict[pid].rid.getTimestamp().getTime() - (tsdoc.startAt || tdoc.beginAt).getTime() === meta?.first?.[pid]) {
                n.style = 'background-color: rgb(217, 240, 199);';
            }
            row.push(n);
        }
        return row;
    },
}, ioi);

const ledo = buildContestRule({
    TEXT: 'Ledo',
    check: () => { },
    submitAfterAccept: false,
    showScoreboard: (tdoc, now) => now > tdoc.beginAt,
    showSelfRecord: () => true,
    showRecord: (tdoc, now) => now > tdoc.endAt,
    stat(tdoc, journal) {
        const ntry = Counter<number>();
        const detail = {};
        for (const j of journal.filter((i) => tdoc.pids.includes(i.pid))) {
            const vaild = ![STATUS.STATUS_COMPILE_ERROR, STATUS.STATUS_FORMAT_ERROR].includes(j.status);
            if (vaild) ntry[j.pid]++;
            const penaltyScore = vaild ? Math.round(Math.max(0.7, 0.95 ** (ntry[j.pid] - 1)) * j.score) : 0;
            if (!detail[j.pid] || detail[j.pid].penaltyScore < penaltyScore) {
                detail[j.pid] = {
                    ...j,
                    penaltyScore,
                    ntry: Math.max(0, ntry[j.pid] - 1),
                };
            }
        }
        let score = 0;
        let originalScore = 0;
        for (const pid of tdoc.pids) {
            if (!detail[pid]) continue;
            const rate = (tdoc.score?.[pid] || 100) / 100;
            score += detail[pid].penaltyScore * rate;
            originalScore += detail[pid].score * rate;
        }
        return {
            score, originalScore, detail,
        };
    },
    async scoreboardRow(config, _, tdoc, pdict, udoc, rank, tsdoc, meta) {
        const tsddict = tsdoc.detail || {};
        const row: ScoreboardRow = [
            { type: 'rank', value: rank.toString() },
            { type: 'user', value: udoc.uname, raw: tsdoc.uid },
        ];
        if (config.isExport && config.showDisplayName) {
            row.push({ type: 'email', value: udoc.mail });
            row.push({ type: 'string', value: udoc.school || '' });
            row.push({ type: 'string', value: udoc.displayName || '' });
            row.push({ type: 'string', value: udoc.studentId || '' });
        }
        row.push({
            type: 'total_score',
            value: (tsdoc.score || 0).toString(),
            hover: tsdoc.score !== tsdoc.originalScore ? _('Original score: {0}').format(tsdoc.originalScore) : '',
        });
        const accepted = {};
        for (const s of tsdoc.journal || []) {
            if (!pdict[s.pid]) continue;
            pdict[s.pid].nSubmit++;
            if (s.status === STATUS.STATUS_ACCEPTED && !accepted[s.pid]) {
                pdict[s.pid].nAccept++;
                accepted[s.pid] = true;
            }
        }
        for (const pid of tdoc.pids) {
            row.push({
                type: 'record',
                value: ((tsddict[pid]?.penaltyScore || 0) * ((tdoc.score?.[pid] || 100) / 100)).toString(),
                hover: tsddict[pid]?.ntry ? `-${tsddict[pid].ntry} (${Math.round(Math.max(0.7, 0.95 ** tsddict[pid].ntry) * 100)}%)` : '',
                raw: tsddict[pid]?.rid,
                score: tsddict[pid]?.score,
                style: tsddict[pid]?.status === STATUS.STATUS_ACCEPTED
                    && tsddict[pid].rid.getTimestamp().getTime() - (tsdoc.startAt || tdoc.beginAt).getTime() === meta?.first?.[pid]
                    ? 'background-color: rgb(217, 240, 199);'
                    : undefined,
            });
        }
        return row;
    },
    applyProjection(_, rdoc) {
        return rdoc;
    },
}, oi);

const homework = buildContestRule({
    TEXT: 'Assignment',
    hidden: true,
    features: ['scoreboard', 'download'],
    check: () => { },
    submitAfterAccept: false,
    statusSort: { penaltyScore: -1, time: 1 },
    stat: (tdoc, journal) => {
        const effective = {};
        for (const j of journal) {
            if (tdoc.pids.includes(j.pid)) effective[j.pid] = j;
        }
        function time(jdoc) {
            const real = (jdoc.rid.getTimestamp().getTime() - tdoc.beginAt.getTime()) / 1000;
            return Math.floor(real);
        }

        function penaltyScore(jdoc) {
            const rate = (tdoc.score?.[jdoc.pid] || 100) / 100;
            const exceedSeconds = Math.floor(
                (jdoc.rid.getTimestamp().getTime() - tdoc.penaltySince.getTime()) / 1000,
            );
            if (exceedSeconds < 0) return rate * jdoc.score;
            let coefficient = 1;
            const keys = Object.keys(tdoc.penaltyRules).map(Number.parseFloat).sort((a, b) => a - b);
            for (const i of keys) {
                if (i * 3600 <= exceedSeconds) coefficient = tdoc.penaltyRules[i];
                else break;
            }
            return rate * jdoc.score * coefficient;
        }
        const detail = [];
        for (const j in effective) {
            effective[j].penaltyScore = penaltyScore(effective[j]);
            effective[j].time = time(effective[j]);
            detail.push(effective[j]);
        }
        return {
            score: sumBy(detail, 'score'),
            penaltyScore: sumBy(detail, 'penaltyScore'),
            time: Math.sum(detail.map((d) => d.time)),
            detail: effective,
        };
    },
    showScoreboard: () => true,
    showSelfRecord: () => true,
    showRecord: (tdoc, now) => now > tdoc.endAt,
    async scoreboardHeader(config, _, tdoc, pdict) {
        const columns: ScoreboardNode[] = [
            { type: 'rank', value: _('Rank') },
            { type: 'user', value: _('User') },
        ];
        if (config.isExport && config.showDisplayName) {
            columns.push({ type: 'email', value: _('Email') });
            columns.push({ type: 'string', value: _('School') });
            columns.push({ type: 'string', value: _('Name') });
            columns.push({ type: 'string', value: _('Student ID') });
        }
        columns.push({ type: 'total_score', value: _('Score') });
        if (config.isExport) {
            columns.push({ type: 'string', value: _('Original Score') });
        }
        columns.push({ type: 'time', value: _('Total Time') });
        for (let i = 1; i <= tdoc.pids.length; i++) {
            const pid = tdoc.pids[i - 1];
            pdict[pid].nAccept = pdict[pid].nSubmit = 0;
            if (config.isExport) {
                columns.push(
                    {
                        type: 'string',
                        value: '#{0} {1}'.format(i, pdict[pid].title),
                    },
                    {
                        type: 'string',
                        value: '#{0} {1}'.format(i, _('Original Score')),
                    },
                    {
                        type: 'time',
                        value: '#{0} {1}'.format(i, _('Time (Seconds)')),
                    },
                );
            } else {
                columns.push({
                    type: 'problem',
                    value: getAlphabeticId(i - 1),
                    raw: pid,
                });
            }
        }
        return columns;
    },
    async scoreboardRow(config, _, tdoc, pdict, udoc, rank, tsdoc) {
        const tsddict = tsdoc.detail || {};
        const row: ScoreboardRow = [
            { type: 'rank', value: rank.toString() },
            {
                type: 'user',
                value: udoc.uname,
                raw: tsdoc.uid,
            },
        ];
        if (config.isExport && config.showDisplayName) {
            row.push({ type: 'email', value: udoc.mail });
            row.push({ type: 'string', value: udoc.school || '' });
            row.push({ type: 'string', value: udoc.displayName || '' });
            row.push({ type: 'string', value: udoc.studentId || '' });
        }
        row.push({ type: 'string', value: (tsdoc.penaltyScore || 0).toString() });
        if (config.isExport) {
            row.push({ type: 'string', value: (tsdoc.score || 0).toString() });
        }
        row.push({ type: 'time', value: formatSeconds(tsdoc.time || 0, false), raw: tsdoc.time });
        const accepted = {};
        for (const s of tsdoc.journal || []) {
            if (!pdict[s.pid]) continue;
            pdict[s.pid].nSubmit++;
            if (s.status === STATUS.STATUS_ACCEPTED && !accepted[s.pid]) {
                pdict[s.pid].nAccept++;
                accepted[s.pid] = true;
            }
        }
        for (const pid of tdoc.pids) {
            const rid = tsddict[pid]?.rid;
            const colScore = (tsddict[pid]?.penaltyScore ?? '').toString();
            const colOriginalScore = (tsddict[pid]?.score ?? '').toString();
            const colTime = (tsddict[pid]?.time || '').toString();
            const colTimeStr = colTime ? formatSeconds(colTime, false) : '';
            if (config.isExport) {
                row.push(
                    { type: 'string', value: colScore },
                    { type: 'string', value: colOriginalScore },
                    { type: 'time', value: colTime },
                );
            } else {
                row.push({
                    type: 'record',
                    score: tsddict[pid]?.score,
                    value: colScore === colOriginalScore
                        ? '{0}\n{1}'.format(colScore, colTimeStr)
                        : '{0} / {1}\n{2}'.format(colScore, colOriginalScore, colTimeStr),
                    raw: rid,
                });
            }
        }
        return row;
    },
    async scoreboard(config, _, tdoc, pdict, cursor) {
        const rankedTsdocs = await db.ranked(cursor, (a, b) => a.score === b.score);
        const uids = rankedTsdocs.map(([, tsdoc]) => tsdoc.uid);
        const udict = await getScoreboardUdict(tdoc, rankedTsdocs, uids, config.showDisplayName);
        const columns = await this.scoreboardHeader(config, _, tdoc, pdict);
        const rows: ScoreboardRow[] = [
            columns,
            ...await Promise.all(rankedTsdocs.map(
                ([rank, tsdoc]) => this.scoreboardRow(config, _, tdoc, pdict, udict[tsdoc.uid], rank, tsdoc),
            )),
        ];
        return [rows, udict];
    },
    async ranked(tdoc, cursor) {
        return await db.ranked(cursor, (a, b) => a.score === b.score);
    },
});

export const RULES: ContestRules = {
    acm, oi, homework, ioi, ledo, strictioi,
};

export function validateContestConfiguration(tdoc: Pick<Tdoc, 'allowTeam' | 'allowPractice' | 'rated' | 'rule'>) {
    if (tdoc.allowPractice && (['course', 'homework'].includes(tdoc.rule) || RULES[tdoc.rule]?.hidden)) {
        throw new BadRequestError('Post-contest practice is not supported for courses or homework.');
    }
    if (!tdoc.allowTeam) return;
    if (tdoc.rated) throw new BadRequestError('Rated contests cannot allow team participation.');
    if (['course', 'homework'].includes(tdoc.rule)) {
        throw new BadRequestError('Team participation is not supported for courses or homework.');
    }
}

const collBalloon = db.collection('contest.balloon');

function _getStatusJournal(tsdoc: ContestStatusDoc): ContestJournalEntry[] {
    return (tsdoc.journal || []).sort((a, b) => (a.rid.getTimestamp().getTime() - b.rid.getTimestamp().getTime()));
}

export async function add(
    domainId: string, title: string, content: string, owner: number,
    rule: string, beginAt = new Date(), endAt = new Date(), pids: number[] = [],
    rated = false, data: Partial<Tdoc> = {},
) {
    if (!RULES[rule]) throw new ValidationError('rule');
    if (beginAt >= endAt) throw new ValidationError('beginAt', 'endAt');
    const payload = {
        assign: [], ...data, content, owner, title, rule, beginAt, endAt, pids, attend: 0, rated,
    } as Partial<Tdoc>;
    validateContestConfiguration(payload as Tdoc);
    RULES[rule].check(payload);
    await bus.parallel('contest/before-add', payload);
    const docId = await document.add(
        domainId, content, owner, document.TYPE_CONTEST, null, null, null, payload,
    );
    await bus.parallel('contest/add', payload, docId);
    return docId;
}

function timeChange(tdoc: Tdoc, next: Tdoc, uid = 0): NonNullable<Tdoc['timeChangeHistory']>[number] | undefined {
    if (tdoc.rule === 'course' || (tdoc.beginAt.getTime() === next.beginAt.getTime()
        && tdoc.endAt.getTime() === next.endAt.getTime() && (tdoc.duration ?? null) === (next.duration ?? null))) return undefined;
    const at = new Date();
    const window = (doc: Tdoc) => ({ beginAt: doc.beginAt, endAt: doc.endAt, duration: doc.duration ?? null });
    return {
        uid, at, before: window(tdoc), after: window(next),
        state: at < tdoc.beginAt ? 'upcoming' : at < tdoc.endAt ? 'ongoing' : 'ended',
        attend: tdoc.attend || 0, ratingEnabled: !!(tdoc.rated || tdoc.ratingPolicy?.enabled || next.rated || next.ratingPolicy?.enabled),
    };
}

const statsConfigurationKeys = [
    'beginAt', 'endAt', 'duration', 'rule', 'pids', 'score', 'lockAt', 'unlocked', 'penaltySince', 'penaltyRules',
] as const;

function statsConfigurationChanged(before: Tdoc, after: Tdoc) {
    return before.rule !== 'course' && statsConfigurationKeys.some((key) =>
        JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null));
}

function revisionCondition(tdoc: Tdoc): Filter<Tdoc> {
    return { statsRevision: tdoc.statsRevision === undefined ? { $exists: false } : tdoc.statsRevision };
}

async function invalidateAssessmentCourse(tdoc: Tdoc) {
    if (tdoc.sourceType !== 'course_assessment' || !tdoc.sourceCourseTid) return;
    await document.collStatus.updateMany({
        domainId: tdoc.domainId, docType: document.TYPE_CONTEST, docId: tdoc.sourceCourseTid,
    }, { $inc: { _assessmentRevision: 1 } });
}

/** Prepare the read fence before publishing changed settings; retain durable recovery state on failure. */
async function writeContestConfiguration(
    tdoc: Tdoc, next: Tdoc, condition: Filter<Tdoc>, $set: Partial<Tdoc>, change?: Tdoc['timeChangeHistory'][number],
) {
    const selector = { domainId: tdoc.domainId, docType: document.TYPE_CONTEST, docId: tdoc.docId };
    if (!statsConfigurationChanged(tdoc, next)) {
        return document.setIfCondition(
            tdoc.domainId, document.TYPE_CONTEST, tdoc.docId, condition, $set, undefined,
            change ? { timeChangeHistory: change } : undefined,
        );
    }
    const token = new ObjectId();
    const recalc: NonNullable<Tdoc['statsRecalc']> = {
        token, revision: (tdoc.statsRevision || 0) + 1, state: 'preparing',
        requestedAt: new Date(), settingsSaved: false,
    };
    const guarded = { $and: [condition, revisionCondition(tdoc)] };
    const prepared = await (document.coll as Collection<Tdoc>).findOneAndUpdate(
        { ...selector, ...guarded }, { $set: { statsRecalc: recalc } }, { returnDocument: 'after' },
    );
    if (!prepared) return null;
    try {
        // Every course reader that captured the old test must fail its conditional grant before the new time is visible.
        await invalidateAssessmentCourse(tdoc);
        const result = await document.setIfCondition(
            tdoc.domainId, document.TYPE_CONTEST, tdoc.docId, { ...guarded, 'statsRecalc.token': token },
            { ...$set, statsRevision: recalc.revision, statsRecalc: { ...recalc, state: 'pending', settingsSaved: true } },
            undefined, change ? { timeChangeHistory: change } : undefined,
        );
        if (!result) throw new BadRequestError('Contest changed. Please refresh and try again.');
        return result;
    } catch (error) {
        await (document.coll as Collection<Tdoc>).updateOne({ ...selector, 'statsRecalc.token': token }, {
            $set: { 'statsRecalc.state': 'failed' },
        });
        throw error;
    }
}

export function isStatsReady(tdoc: Tdoc, tsdoc?: ContestStatusDoc) {
    return !tdoc.statsRecalc && (!tsdoc?.journal?.length || (
        (tsdoc.statsRevision || 0) === (tdoc.statsRevision || 0)
        && (tsdoc.statsJournalRevision === undefined || tsdoc.statsJournalRevision === (tsdoc.rev || 0))
    ));
}

export async function edit(
    domainId: string, tid: ObjectId, $set: Partial<Tdoc>, expected?: Tdoc, expectedFields: (keyof Tdoc)[] = [],
    actorUid = 0,
) {
    if ($set.rule && !RULES[$set.rule]) throw new ValidationError('rule');
    const tdoc = await document.get(domainId, document.TYPE_CONTEST, tid);
    if (!tdoc) throw new ContestNotFoundError(domainId, tid);
    await bus.parallel('contest/before-edit', tdoc, $set);
    if (tdoc.allowTeam && $set.allowTeam === false) {
        throw new BadRequestError('Team participation cannot be disabled after it has been enabled.');
    }
    const next = { ...tdoc, ...$set };
    validateContestConfiguration(next);
    RULES[next.rule].check(next);
    const source = expected || tdoc;
    const condition: Filter<Tdoc> = {};
    const conditionKeys = new Set<keyof Tdoc>([
        ...(Object.keys($set) as (keyof Tdoc)[]),
        ...expectedFields,
        'rule', 'rated', 'allowTeam',
    ]);
    for (const key of conditionKeys) {
        const value = getPath(source, key);
        condition[key] = value === undefined ? { $exists: false } as any : value as any;
    }
    const change = timeChange(tdoc, next, actorUid);
    if (change) {
        for (const key of ['beginAt', 'endAt', 'duration'] as const) {
            if (!Object.hasOwn(condition, key)) condition[key] = source[key] === undefined ? { $exists: false } as any : source[key] as any;
        }
    }
    const res = await writeContestConfiguration(tdoc, next, condition, $set, change);
    if (!res) throw new BadRequestError('Contest changed. Please refresh and try again.');
    await bus.parallel('contest/edit', res, actorUid);
    return res;
}

export async function editIfAssigned(
    domainId: string,
    tid: ObjectId,
    assignGroup: string | string[],
    $set: Partial<Tdoc>,
    expected: Filter<Tdoc> = {},
    actorUid = 0,
) {
    if ($set.rule && !RULES[$set.rule]) throw new ValidationError('rule');
    const tdoc = await document.get(domainId, document.TYPE_CONTEST, tid);
    if (!tdoc) throw new ContestNotFoundError(domainId, tid);
    await bus.parallel('contest/before-edit', tdoc, $set);
    if (tdoc.allowTeam && $set.allowTeam === false) {
        throw new BadRequestError('Team participation cannot be disabled after it has been enabled.');
    }
    const next = { ...tdoc, ...$set };
    validateContestConfiguration(next);
    RULES[next.rule].check(next);
    const configurationCondition: Filter<Tdoc> = {};
    for (const key of ['rule', 'rated', 'allowTeam'] as const) {
        configurationCondition[key] = tdoc[key] === undefined ? { $exists: false } as any : tdoc[key] as any;
    }
    const change = timeChange(tdoc, next, actorUid);
    if (change) {
        Object.assign(configurationCondition, {
            beginAt: tdoc.beginAt, endAt: tdoc.endAt, duration: tdoc.duration === undefined ? { $exists: false } : tdoc.duration,
        });
    }
    const res = await writeContestConfiguration(tdoc, next, {
        $and: [expected, configurationCondition], assign: assignGroup,
    }, $set, change);
    if (res) await bus.parallel('contest/edit', res as Tdoc, actorUid);
    return res as Tdoc | null;
}

export async function replaceAssignGroup(
    domainId: string,
    tid: ObjectId,
    expectedGroup: string,
    assignGroup: string,
) {
    const tdoc = await document.get(domainId, document.TYPE_CONTEST, tid);
    if (!tdoc) throw new ContestNotFoundError(domainId, tid);
    if (!tdoc.assign?.includes(expectedGroup)) return null;
    const $set = {
        assign: tdoc.assign.map((item) => (item === expectedGroup ? assignGroup : item)),
    };
    await bus.parallel('contest/before-edit', tdoc, $set);
    const next = { ...tdoc, ...$set };
    validateContestConfiguration(next);
    RULES[next.rule].check(next);
    const res = await document.coll.findOneAndUpdate(
        {
            domainId,
            docType: document.TYPE_CONTEST,
            docId: tid,
            assign: expectedGroup,
        },
        { $set: { 'assign.$[item]': assignGroup } },
        {
            arrayFilters: [{ item: expectedGroup }],
            returnDocument: 'after',
        },
    );
    if (res) await bus.parallel('contest/edit', res as Tdoc);
    return res as Tdoc | null;
}

export async function del(domainId: string, tid: ObjectId) {
    await Promise.all([
        db.collection('contest.practiceAccess').deleteMany({ domainId, tid }),
        bus.parallel('contest/del', domainId, tid),
        document.deleteOne(domainId, document.TYPE_CONTEST, tid),
        document.deleteMultiStatus(domainId, document.TYPE_CONTEST, { docId: tid }),
    ]);
}

export async function delIfAssigned(domainId: string, tid: ObjectId, assignGroup: string) {
    const result = await document.coll.deleteOne({
        domainId,
        docType: document.TYPE_CONTEST,
        docId: tid,
        rule: 'course',
        assign: assignGroup,
    });
    if (!result.deletedCount) return false;
    await Promise.all([
        bus.parallel('contest/del', domainId, tid),
        document.deleteMultiStatus(domainId, document.TYPE_CONTEST, { docId: tid }),
    ]);
    return true;
}

export async function delIfAssignUnchanged(domainId: string, tid: ObjectId, expectedAssign: string[]) {
    const result = await document.coll.deleteOne({
        domainId,
        docType: document.TYPE_CONTEST,
        docId: tid,
        rule: 'course',
        assign: expectedAssign,
    });
    if (!result.deletedCount) return false;
    await Promise.all([
        bus.parallel('contest/del', domainId, tid),
        document.deleteMultiStatus(domainId, document.TYPE_CONTEST, { docId: tid }),
    ]);
    return true;
}

export async function get(domainId: string, tid: ObjectId): Promise<Tdoc> {
    const tdoc = await document.get(domainId, document.TYPE_CONTEST, tid);
    if (!tdoc) throw new ContestNotFoundError(domainId, tid);
    return tdoc;
}

export async function getRelated(domainId: string, pid: number, rule?: string) {
    const rules = Object.keys(RULES).filter((i) => !RULES[i].hidden);
    return await document.getMulti(domainId, document.TYPE_CONTEST, { pids: pid, rule: rule || { $in: rules } }).toArray();
}

export async function addBalloon(domainId: string, tid: ObjectId, uid: number, rid: ObjectId, pid: number) {
    const balloon = await collBalloon.find({ domainId, tid, pid }).project({ uid: 1 }).toArray();
    if (balloon.find((i) => i.uid === uid)) return null;
    let isFirst = !balloon.length;
    if (isFirst) {
        let pending: RecordDoc[] = [];
        do {
            if (pending.length) await sleep(500); // eslint-disable-line no-await-in-loop
            pending = await RecordModel.getMulti(domainId, { // eslint-disable-line no-await-in-loop
                pid, contest: tid, _id: { $lt: rid }, status: {
                    $in: [
                        STATUS.STATUS_WAITING, STATUS.STATUS_COMPILING,
                        STATUS.STATUS_JUDGING, STATUS.STATUS_FETCHED,
                        STATUS.STATUS_ACCEPTED,
                    ],
                },
            }).limit(1).toArray();
        } while (pending.length && !pending.some((i) => i.status === STATUS.STATUS_ACCEPTED));
        if (pending.some((i) => i.status === STATUS.STATUS_ACCEPTED)) isFirst = false;
    }
    const newBdoc = {
        _id: rid, domainId, tid, pid, uid, ...(isFirst ? { first: true } : {}),
    };
    await collBalloon.insertOne(newBdoc);
    bus.emit('contest/balloon', domainId, tid, newBdoc);
    return rid;
}

export async function getBalloon(domainId: string, tid: ObjectId, _id: ObjectId) {
    return await collBalloon.findOne({ domainId, tid, _id });
}

export function getMultiBalloon(domainId: string, tid: ObjectId, query: any = {}) {
    return collBalloon.find({ domainId, tid, ...query });
}

export async function updateBalloon(domainId: string, tid: ObjectId, _id: ObjectId, $set: any) {
    return await collBalloon.findOneAndUpdate({ domainId, tid, _id }, { $set });
}

export async function getStatus(domainId: string, tid: ObjectId, uid: number) {
    return await document.getStatus(domainId, document.TYPE_CONTEST, tid, uid);
}

export function getPublicStatus(tdoc: Tdoc, tsdoc?: ContestStatusDoc) {
    if (!tsdoc) return null;
    return pick(tsdoc, ['attend', 'subscribe', 'startAt', ...(tdoc.duration || tsdoc.endAt ? ['endAt'] : [])]);
}

export function getMultiStatus(domainId: string, query: any) {
    return document.getMultiStatus(domainId, document.TYPE_CONTEST, query);
}

export async function getTeamVid(domainId: string, tid: ObjectId, uid: number): Promise<number | null> {
    const s = await getMultiStatus(domainId, { docId: tid, members: uid }).project({ uid: 1 }).limit(1).next();
    return s?.uid ?? null;
}

export async function validateTeamParticipants(domainId: string, tdoc: Tdoc, members: number[]) {
    const participantUids = Array.from(new Set(members));
    if (!participantUids.length
        || participantUids.some((uid) => !Number.isSafeInteger(uid) || uid <= 0)) {
        throw new ValidationError('members');
    }
    const memberUdocs = await Promise.all(participantUids.map((uid) => UserModel.getById(domainId, uid)));
    for (let index = 0; index < participantUids.length; index++) {
        const uid = participantUids[index];
        const udoc = memberUdocs[index];
        if (!udoc) throw new UserNotFoundError(uid);
        if (!udoc.hasPerm(PERM.PERM_ATTEND_CONTEST)) throw new PermissionError(PERM.PERM_ATTEND_CONTEST, uid);
        // eslint-disable-next-line ts/no-use-before-define
        if (!canAccessAssignedContest(udoc, tdoc)) throw new NotAssignedError('contest', tdoc.docId, uid);
    }
    return participantUids.sort((a, b) => a - b);
}

/** Fence course grants around every classroom status mutation, without requiring MongoDB transactions. */
async function withAssessmentStatusUpdate<T>(tdoc: Tdoc | null, uid: number, update: () => Promise<T>): Promise<T> {
    if (tdoc?.sourceType !== 'course_assessment' || !tdoc.sourceCourseTid) return update();
    const exams = document.coll as Collection<Tdoc>;
    const examFilter = { domainId: tdoc.domainId, docType: document.TYPE_CONTEST, docId: tdoc.docId };
    const field = `_assessmentStatusUpdates.${uid}`;
    const token = new ObjectId();
    // The exam survives enrollment cancellation, including concurrent cancellation/rejoin.
    const marked = await exams.updateOne(examFilter, { $addToSet: { [field]: token } });
    if (!marked.matchedCount) throw new ContestNotFoundError(tdoc.domainId, tdoc.docId);
    const invalidate = () => document.collStatus.updateOne({
        domainId: tdoc.domainId, docType: document.TYPE_CONTEST, docId: tdoc.sourceCourseTid, uid,
    }, { $inc: { _assessmentRevision: 1 } });
    try {
        // Old readers must fail their conditional grant before any source state changes.
        await invalidate();
        return await update();
    } finally {
        // Also fence readers/enrollments that appeared during the write. Until this succeeds,
        // leave the marker in place so a failed cleanup cannot expose uncertain scores.
        await invalidate();
        await exams.updateOne(examFilter, { $pull: { [field]: { $eq: token } } });
        await exams.updateOne({ ...examFilter, [field]: [] }, { $unset: { [field]: '' } });
    }
}

/** Both configuration and journal versions are inputs to a statistics write. */
async function calculateStatus(domainId: string, tid: ObjectId, uid: number, expectedRevision?: number) {
    for (let attempt = 0; attempt < 5; attempt++) {
        // eslint-disable-next-line no-await-in-loop -- Refresh both inputs after a conditional write conflict.
        const [tdoc, tsdoc] = await Promise.all([get(domainId, tid), getStatus(domainId, tid, uid)]);
        if (!tsdoc) return null; // Enrollment was cancelled while the caller was running.
        if (tdoc.rule === 'course' && !tsdoc.journal) return tsdoc;
        const revision = tdoc.statsRevision || 0;
        if (expectedRevision !== undefined && revision !== expectedRevision) {
            throw new BadRequestError('比赛设置已更新，请刷新后重试成绩重算。');
        }
        const journal = _getStatusJournal(tsdoc);
        const stats = RULES[tdoc.rule].stat(tdoc, journal);
        // eslint-disable-next-line no-await-in-loop -- Writes must remain ordered with their input snapshots.
        const result = await document.revSetStatus(
            domainId, document.TYPE_CONTEST, tid, uid, tsdoc.rev,
            { journal, ...stats, statsRevision: revision, statsJournalRevision: (tsdoc.rev || 0) + 1 },
            { _id: tsdoc._id, $or: [{ statsRevision: { $exists: false } }, { statsRevision: { $lte: revision } }] },
        );
        if (!result) continue;
        // A configuration edit can span different documents. A stale result stays hidden and is recomputed from the latest inputs.
        // eslint-disable-next-line no-await-in-loop -- Verify that the accepted result still belongs to the current configuration.
        const current = await get(domainId, tid);
        if ((current.statsRevision || 0) === revision) return result;
    }
    throw new BadRequestError('成绩统计发生并发变更，请重试成绩重算。');
}

async function markStatsFailed(tdoc: Tdoc) {
    const selector = {
        domainId: tdoc.domainId, docType: document.TYPE_CONTEST, docId: tdoc.docId, ...revisionCondition(tdoc),
    };
    // A failed concurrent judge must prevent an in-progress bulk recalculation from claiming completion.
    await (document.coll as Collection<Tdoc>).updateOne({
        ...selector, 'statsRecalc.state': 'running', 'statsRecalc.revision': tdoc.statsRevision || 0,
    }, { $set: { 'statsRecalc.state': 'failed' } });
    await (document.coll as Collection<Tdoc>).updateOne({
        ...selector, statsRecalc: { $exists: false },
    }, { $set: { statsRecalc: {
        revision: tdoc.statsRevision || 0, token: new ObjectId(), state: 'failed',
        requestedAt: new Date(), settingsSaved: true,
    } } });
}

export async function updateStatus(
    domainId: string, tid: ObjectId, uid: number, rid: ObjectId, pid: number,
    {
        status = STATUS.STATUS_WAITING,
        score = 0,
        subtasks,
        lang,
    }: { status?: STATUS, score?: number, subtasks?: Record<number, SubtaskResult>, lang?: string } = {},
) {
    const tdoc = await get(domainId, tid);
    if (tdoc.balloon && status === STATUS.STATUS_ACCEPTED && !isLocked(tdoc)) await addBalloon(domainId, tid, uid, rid, pid);
    return withAssessmentStatusUpdate(tdoc, uid, async () => {
        await document.revPushStatus(tdoc.domainId, document.TYPE_CONTEST, tdoc.docId, uid, 'journal', {
            rid, pid, status, score, subtasks, lang,
        }, 'rid');
        try {
            return await calculateStatus(domainId, tid, uid);
        } catch (error) {
            await markStatsFailed(await get(domainId, tid));
            throw error;
        }
    });
}

export async function getListStatus(domainId: string, uid: number, tids: ObjectId[]) {
    const r = {};
    for (const tid of tids) {
        // eslint-disable-next-line no-await-in-loop
        const tsdoc = await getStatus(domainId, tid, uid);
        if (tsdoc?.attend) {
            r[tid.toHexString()] = tsdoc;
            continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const teamVid = await getTeamVid(domainId, tid, uid);
        // eslint-disable-next-line no-await-in-loop
        r[tid.toHexString()] = teamVid ? await getStatus(domainId, tid, teamVid) : tsdoc;
    }
    return r;
}

export async function attend(domainId: string, tid: ObjectId, uid: number, payload: any = {}) {
    const tdoc = await get(domainId, tid);
    validateContestConfiguration(tdoc);
    const statusPayload = payload && typeof payload === 'object' && !Array.isArray(payload) ? { ...payload } : {};
    if (Object.hasOwn(statusPayload, 'members')) {
        if (!tdoc.allowTeam || !Array.isArray(statusPayload.members)) throw new ValidationError('members');
        const participantUids = await validateTeamParticipants(domainId, tdoc, statusPayload.members);
        statusPayload.members = participantUids;
        statusPayload.participantUids = participantUids;
    } else if (uid > 0) statusPayload.participantUids = [uid];
    return withAssessmentStatusUpdate(tdoc, uid, async () => {
        try {
            await document.cappedIncStatus(
                domainId, document.TYPE_CONTEST, tid, uid, 'attend', 1, 0, 1, statusPayload,
            );
        } catch (e) {
            if (e?.code === 11000) throw new ContestAlreadyAttendedError(tid, uid);
            throw e;
        }
        await document.inc(domainId, document.TYPE_CONTEST, tid, 'attend', 1);
        return {};
    });
}

export async function cancelAttend(domainId: string, tid: ObjectId, uid: number) {
    const tdoc = await document.get(domainId, document.TYPE_CONTEST, tid);
    return withAssessmentStatusUpdate(tdoc, uid, async () => {
        const tsdoc = await document.collStatus.findOneAndDelete({
            domainId, docType: document.TYPE_CONTEST, docId: tid, uid,
        });
        if (tsdoc?.attend > 0) await document.inc(domainId, document.TYPE_CONTEST, tid, 'attend', -1);
        return {};
    });
}

export async function setStatus(domainId: string, tid: ObjectId, uid: number, $set?: any, $unset?: any) {
    const tdoc = await document.get(domainId, document.TYPE_CONTEST, tid);
    return withAssessmentStatusUpdate(tdoc, uid, () => document.setStatus(domainId, document.TYPE_CONTEST, tid, uid, $set, $unset));
}

export function count(domainId: string, query: any) {
    return document.count(domainId, document.TYPE_CONTEST, query);
}

export function countStatus(domainId: string, query: any) {
    return document.countStatus(domainId, document.TYPE_CONTEST, query);
}

export function getMulti(
    domainId: string, query: Filter<document.DocType['30']> = {},
) {
    return document.getMulti(domainId, document.TYPE_CONTEST, query).sort({ beginAt: -1 });
}

export async function getAndListStatus(domainId: string, tid: ObjectId): Promise<[Tdoc, any[]]> {
    // TODO(iceboy): projection, pagination.
    const tdoc = await get(domainId, tid);
    const tsdocs = await document.getMultiStatus(domainId, document.TYPE_CONTEST, { docId: tid })
        .sort(RULES[tdoc.rule].statusSort).toArray();
    return [tdoc, tsdocs];
}

export async function recalcStatus(domainId: string, tid: ObjectId, expectedRevision?: number) {
    const tdoc = await get(domainId, tid);
    const revision = tdoc.statsRevision || 0;
    if (expectedRevision !== undefined && revision !== expectedRevision) {
        throw new BadRequestError('比赛设置已更新，请刷新后重试成绩重算。');
    }
    const token = new ObjectId();
    const selector = { domainId, docType: document.TYPE_CONTEST, docId: tid };
    const claimed = await (document.coll as Collection<Tdoc>).findOneAndUpdate({ ...selector, ...revisionCondition(tdoc) }, {
        $set: { statsRecalc: {
            revision, token, state: 'running', requestedAt: tdoc.statsRecalc?.requestedAt || new Date(),
            settingsSaved: tdoc.statsRecalc?.settingsSaved ?? true,
        } },
    }, { returnDocument: 'after' });
    if (!claimed) throw new BadRequestError('比赛设置已更新，请刷新后重试成绩重算。');
    const ownAttempt = { ...selector, ...revisionCondition(claimed), 'statsRecalc.token': token };
    try {
        await invalidateAssessmentCourse(claimed);
        const tsdocs = await document.getMultiStatus(domainId, document.TYPE_CONTEST, { docId: tid }).toArray();
        // The durable attempt fences the entire test. Do not create per-user tokens that could be orphaned by a process crash.
        const tasks = tsdocs.map((tsdoc) => calculateStatus(domainId, tid, tsdoc.uid, revision));
        // Wait for every writer to finish even when one fails, before recording the attempt's outcome.
        const results = await Promise.allSettled(tasks);
        const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failure) throw failure.reason;
        await invalidateAssessmentCourse(claimed);
        const complete = await (document.coll as Collection<Tdoc>).updateOne({
            ...ownAttempt, 'statsRecalc.state': 'running',
        }, { $unset: { statsRecalc: '' } });
        if (!complete.matchedCount) throw new BadRequestError('另一请求已更新比赛设置或开始重算，请刷新查看。');
        return results.map((result) => (result as PromiseFulfilledResult<any>).value);
    } catch (error) {
        await (document.coll as Collection<Tdoc>).updateOne(ownAttempt, { $set: { 'statsRecalc.state': 'failed' } });
        throw error;
    }
}

export async function unlockScoreboard(domainId: string, tid: ObjectId) {
    const tdoc = await document.get(domainId, document.TYPE_CONTEST, tid);
    if (!tdoc.lockAt || tdoc.unlocked) return;
    await edit(domainId, tid, { unlocked: true });
    await recalcStatus(domainId, tid);
}

export async function isSameTeam(domainId: string, tid: ObjectId, a: number, b: number): Promise<boolean> {
    if (a === b) return true;
    const [va, vb] = await Promise.all([getTeamVid(domainId, tid, a), getTeamVid(domainId, tid, b)]);
    return !!va && va === vb;
}

export async function isOwnOrTeammateRecord(domainId: string, rdoc: RecordDoc, uid: number): Promise<boolean> {
    if (rdoc.uid === uid) return true;
    if (!rdoc.contest) return false;
    if (RecordModel.RECORD_PRETEST.equals(rdoc.contest) || RecordModel.RECORD_GENERATE.equals(rdoc.contest)) return false;
    return isSameTeam(domainId, rdoc.contest, rdoc.uid, uid);
}

export function canViewHiddenScoreboard(this: { user: User }, tdoc: Tdoc) {
    if (this.user.own(tdoc)) return true;
    if (tdoc.rule === 'homework') return this.user.hasPerm(PERM.PERM_VIEW_HOMEWORK_HIDDEN_SCOREBOARD);
    return this.user.hasPerm(PERM.PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD);
}

export function canAccessAssignedContest(user: User, tdoc: Tdoc) {
    if (!tdoc.assign?.length) return true;
    if (user.own(tdoc)
        || (tdoc.rule === 'course' && user.hasPerm(PERM.PERM_EDIT_HOMEWORK))
        || user.hasPerm(PERM.PERM_VIEW_HIDDEN_CONTEST)) return true;
    const uid = user._id.toString();
    return tdoc.assign.some((group) => group === uid || user.group?.includes(group));
}

function canAccessContestResults(user: User, tdoc: Tdoc, allowPermOverride = true) {
    if (!canAccessAssignedContest(user, tdoc)
        && (!allowPermOverride || !canViewHiddenScoreboard.call({ user }, tdoc))) return false;
    if (!RULES[tdoc.rule]?.hidden) return true;
    if (user.own(tdoc)
        || user.hasPerm(PERM.PERM_VIEW_HIDDEN_CONTEST)
        || user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK)
        || user.hasPerm(PERM.PERM_VIEW_HOMEWORK_HIDDEN_SCOREBOARD)
        || user.hasPerm(PERM.PERM_EDIT_HOMEWORK)
        || user.hasPerm(PERM.PERM_EDIT_HOMEWORK_SELF)) return true;
    return !!tdoc.assign?.length && canAccessAssignedContest(user, tdoc);
}

export function canShowRecord(this: { user: User }, tdoc: Tdoc, allowPermOverride = true) {
    if (!canAccessContestResults(this.user, tdoc, allowPermOverride)) return false;
    if (allowPermOverride && canViewHiddenScoreboard.call(this, tdoc)) return true;
    if (RULES[tdoc.rule]?.showRecord) return RULES[tdoc.rule].showRecord(tdoc, new Date());
    return !tdoc.keepScoreboardHidden && (!tdoc.beginAt || new Date() > tdoc.beginAt);
}

export function canShowSelfRecord(this: { user: User }, tdoc: Tdoc, allowPermOverride = true) {
    if (!canAccessContestResults(this.user, tdoc, allowPermOverride)) return false;
    if (allowPermOverride && canViewHiddenScoreboard.call(this, tdoc)) return true;
    if (RULES[tdoc.rule]?.showSelfRecord) return RULES[tdoc.rule].showSelfRecord(tdoc, new Date());
    return !tdoc.keepScoreboardHidden && (!tdoc.beginAt || new Date() > tdoc.beginAt);
}

export function canShowProblemStatus(user: User | null, targetUid: number, tdoc: Tdoc, allowPermOverride = true) {
    const isCourseOrHomework = tdoc.rule === 'course' || tdoc.rule === 'homework';
    if (!user) {
        if (tdoc.allowTeam) return false;
        if (isCourseOrHomework) {
            return !tdoc.keepScoreboardHidden;
        }
        if (!tdoc.rated) return false;
        return !tdoc.keepScoreboardHidden && (!RULES[tdoc.rule]?.showRecord || RULES[tdoc.rule].showRecord(tdoc, new Date()));
    }
    if (!canAccessContestResults(user, tdoc, allowPermOverride)) return false;
    return targetUid === user._id
        ? canShowSelfRecord.call({ user }, tdoc, allowPermOverride)
        : canShowRecord.call({ user }, tdoc, allowPermOverride);
}

export function canShowScoreboard(this: { user: User }, tdoc: Tdoc, allowPermOverride = true) {
    if (allowPermOverride && canViewHiddenScoreboard.call(this, tdoc)) return true;
    if (tdoc.keepScoreboardHidden) return false;
    if (RULES[tdoc.rule]?.showScoreboard) return RULES[tdoc.rule].showScoreboard(tdoc, new Date());
    return !tdoc.keepScoreboardHidden && (!tdoc.beginAt || new Date() > tdoc.beginAt);
}

export async function getScoreboard(
    this: Handler, domainId: string, tid: ObjectId, config: ScoreboardConfig,
): Promise<[Tdoc, ScoreboardRow[], BaseUserDict, ProblemDict]> {
    const tdoc = await get(domainId, tid);
    // Classroom scoreboards are authorized by the handler's live parent-course check.
    // Never require the separate contest scoreboard permission for a course teacher.
    const classroomManager = tdoc.sourceType === 'course_assessment'
        && (this as Handler & { classroomTeacher?: boolean }).classroomTeacher === true;
    if (!classroomManager && !canShowScoreboard.call(this, tdoc)) throw new ContestScoreboardHiddenError(tid);
    const pdict = await problem.getList(domainId, tdoc.pids, true, true, problem.PROJECTION_CONTEST_DETAIL);
    if (tdoc.statsRecalc) {
        if (config.isExport) throw new BadRequestError('成绩重算尚未完成，请完成重算后再导出。');
        return [tdoc, [], {}, pdict];
    }
    const revision = tdoc.statsRevision || 0;
    const tsdocsCursor = getMultiStatus(domainId, {
        docId: tid,
        // Staff preview submissions may have a journal but no genuine test attendance.
        // Only actual classroom test attendees belong on the classroom scoreboard.
        ...(tdoc.sourceType === 'course_assessment' ? { attend: { $gt: 0 } } : {}),
        $and: [
            revision ? { statsRevision: revision } : { $or: [{ statsRevision: 0 }, { statsRevision: { $exists: false } }] },
            { $or: [{ statsJournalRevision: { $exists: false } }, {
                $expr: { $eq: ['$statsJournalRevision', { $ifNull: ['$rev', 0] }] },
            }] },
        ],
    }).sort(RULES[tdoc.rule].statusSort);
    const [rows, udict] = await RULES[tdoc.rule].scoreboard(
        { ...config, viewer: this.user }, this.translate.bind(this),
        tdoc, pdict, tsdocsCursor,
    );
    await bus.parallel('contest/scoreboard', tdoc, rows, udict, pdict);
    const current = await get(domainId, tid);
    if (current.statsRecalc || (current.statsRevision || 0) !== revision) {
        if (config.isExport) throw new BadRequestError('成绩重算尚未完成，请完成重算后再导出。');
        return [current, [], {}, pdict];
    }
    return [tdoc, rows, udict, pdict];
}

export function addClarification(
    domainId: string, tid: ObjectId, owner: number, content: string,
    ip: string, subject = 0,
) {
    return document.add(
        domainId, content, owner, document.TYPE_CONTEST_CLARIFICATION,
        null, document.TYPE_CONTEST, tid, { ip, subject },
    );
}

export function addClarificationReply(
    domainId: string, did: ObjectId, owner: number,
    content: string, ip: string,
) {
    return document.push(
        domainId, document.TYPE_CONTEST_CLARIFICATION, did,
        'reply', { content, owner, ip },
    );
}

export function getClarification(domainId: string, did: ObjectId) {
    return document.get(domainId, document.TYPE_CONTEST_CLARIFICATION, did);
}

export function getMultiClarification(domainId: string, tid: ObjectId, owner?: number | number[]) {
    const ownerFilter = owner === undefined
        ? {}
        : { owner: { $in: [0, ...(Array.isArray(owner) ? owner : [owner])] } };
    return document.getMulti(
        domainId, document.TYPE_CONTEST_CLARIFICATION,
        { parentType: document.TYPE_CONTEST, parentId: tid, ...ownerFilter },
    ).sort('_id', -1).toArray();
}

export function applyProjection(tdoc: Tdoc, rdoc: RecordDoc, udoc: User) {
    if (!RULES[tdoc.rule]) return rdoc;
    return RULES[tdoc.rule].applyProjection(tdoc, rdoc, udoc);
}

export const statusText = (tdoc: Tdoc, tsdoc?: ContestStatusDoc): string => (
    isNew(tdoc)
        ? 'New'
        : isUpcoming(tdoc)
            ? 'Ready (☆▽☆)'
            : isOngoing(tdoc, tsdoc)
                ? 'Live...'
                : 'Done');

export function addPrintTask(domainId: string, tid: ObjectId, uid: number, name: string, content: string) {
    return document.add(domainId, content, uid, document.TYPE_CONTEST_PRINT, null, document.TYPE_CONTEST, tid, {
        title: name,
        status: PrintTaskStatus.pending,
    });
}

export async function updatePrintTask(domainId: string, tid: ObjectId, taskId: ObjectId, $set: Partial<ContestPrintDoc>) {
    const res = await document.coll.updateOne({
        domainId, docType: document.TYPE_CONTEST_PRINT,
        docId: taskId, parentType: document.TYPE_CONTEST, parentId: tid,
    }, { $set });
    return !!res.modifiedCount;
}

export function allocatePrintTask(domainId: string, tid: ObjectId) {
    return document.coll.findOneAndUpdate({
        domainId, docType: document.TYPE_CONTEST_PRINT,
        parentType: document.TYPE_CONTEST, parentId: tid,
        status: PrintTaskStatus.pending,
    }, {
        $set: {
            status: PrintTaskStatus.printing,
        },
    }, { returnDocument: 'after' });
}

export function getMultiPrintTask(domainId: string, tid: ObjectId, query = {}) {
    return document.getMulti(domainId, document.TYPE_CONTEST_PRINT, { parentType: document.TYPE_CONTEST, parentId: tid, ...query })
        .sort({ _id: 1 });
}

export async function apply(ctx: Context) {
    ctx.on('contest/balloon', (domainId, tid, bdoc) => {
        if (!bdoc.first) return;
        (async () => {
            const tsdocs = await getMultiStatus(domainId, { docId: tid, subscribe: 1 }).toArray();
            const uids = Array.from<number>(new Set(tsdocs.flatMap((tsdoc) => (tsdoc.members?.length ? tsdoc.members : [tsdoc.uid]))));
            const [team, tdoc, pdoc] = await Promise.all([
                UserModel.getById(domainId, bdoc.uid),
                get(domainId, tid),
                ProblemModel.get(domainId, bdoc.pid),
            ]);
            await MessageModel.send(1, uids, JSON.stringify({
                message: 'First Blood Notice\n{0} solved problem {1} ({2})',
                avatar: avatar(team.avatar),
                params: [team.uname, getAlphabeticId(tdoc.pids.indexOf(bdoc.pid)), pdoc.title],
            }), MessageModel.FLAG_I18N);
        })();
    });
    await ctx.db.ensureIndexes(
        collBalloon,
        { key: { domainId: 1, tid: 1, pid: 1, uid: 1 }, unique: true, name: 'basic' },
        { key: { domainId: 1, tid: 1, pid: 1 }, unique: true, name: 'first', partialFilterExpression: { first: true } },
    );
}

global.Hydro.model.contest = {
    apply,

    RULES,
    PrintTaskStatus,
    buildContestRule,
    add,
    getListStatus,
    getMultiStatus,
    getTeamVid,
    hasTeamParticipation,
    isSameTeam,
    isOwnOrTeammateRecord,
    validateContestConfiguration,
    validateTeamParticipants,
    attend,
    cancelAttend,
    edit,
    editIfAssigned,
    replaceAssignGroup,
    del,
    delIfAssigned,
    delIfAssignUnchanged,
    get,
    getRelated,
    updateStatus,
    getStatus,
    getPublicStatus,
    count,
    countStatus,
    getMulti,
    setStatus,
    getAndListStatus,
    recalcStatus,
    isStatsReady,
    unlockScoreboard,
    getBalloon,
    addBalloon,
    getMultiBalloon,
    updateBalloon,
    canShowRecord,
    canShowSelfRecord,
    canAccessAssignedContest,
    canShowProblemStatus,
    canShowScoreboard,
    canViewHiddenScoreboard,
    getScoreboard,
    addClarification,
    addClarificationReply,
    getClarification,
    getMultiClarification,
    isNew,
    isUpcoming,
    isNotStarted,
    isOngoing,
    isDone,
    isLocked,
    isExtended,
    applyProjection,
    statusText,
    addPrintTask,
    updatePrintTask,
    allocatePrintTask,
    getMultiPrintTask,
};
