import {
    ContestModel, Counter, moment, STATUS, UserModel,
} from 'hydrooj';
import type { ContestRule, ScoreboardRow, Tdoc } from 'hydrooj';

export interface DagNode {
    _id: number;
    title: string;
    lecture?: string | boolean;
    pids: number[];
    requireNids?: number[];
    completeCondition?: {
        type: 'all' | 'problem' | 'score';
        value?: number;
    };
    content?: string;
}

export interface CourseTdoc extends Tdoc {
    rule: 'course';
    dag: DagNode[];
    assign?: string[];
    lecture?: Record<number, string>;
    editor?: number;
    updateAt?: Date;
    extraStudents?: number[];
}

export interface CourseStatus {
    allow: Record<number, boolean>;
    lectureAllow: Record<number, boolean>;
    attend: boolean;
    startAt: Date;
    progress: number;
    score: Record<number, number>;
    accept: Record<number, number>;
    detail: Record<number, any>;
    journal?: any[];
}

interface CourseJournal {
    rid: import('mongodb').ObjectId;
    pid: number;
    score: number;
    status: number;
}

interface CourseDetail extends CourseJournal {
    naccept?: number;
}

async function ranked<T extends { score?: Record<number, number>; accept?: Record<number, number> }>(
    tsdocs: T[],
    comparator: (a: T, b: T) => boolean,
) {
    let lastDoc: T | null = null;
    let rank = 0;
    let count = 0;
    const result: [number, T][] = [];

    for (const doc of tsdocs) {
        if ((doc as any).unrank) {
            result.push([0, doc]);
            continue;
        }
        count++;
        if (!lastDoc || !comparator(lastDoc, doc)) {
            rank = count;
        }
        lastDoc = doc;
        result.push([rank, doc]);
    }

    return result;
}

export const courseRule: ContestRule<CourseStatus> = ContestModel.buildContestRule({
    TEXT: '课程',
    hidden: true,
    check: () => { },
    submitAfterAccept: false,
    statusSort: { score: -1, accept: -1, time: 1 },

    stat(tdoc: CourseTdoc, journal: CourseJournal[]) {
        const naccept = Counter<number>();
        const detail: Record<number, CourseDetail> = {};

        // 建立题目到章节的映射
        const pidToNode: Record<number, number> = {};
        for (const node of tdoc.dag) {
            for (const pid of node.pids) {
                pidToNode[pid] = node._id;
            }
        }

        const score: Record<number, number> = { 0: 0 };
        const accept: Record<number, number> = { 0: 0 };

        // 统计每道题的提交情况
        for (const j of journal.filter((j) => tdoc.pids.includes(j.pid))) {
            if (![STATUS.STATUS_ACCEPTED, STATUS.STATUS_COMPILE_ERROR, STATUS.STATUS_FORMAT_ERROR].includes(j.status)) {
                naccept[j.pid]++;
            }
            detail[j.pid] = { ...j, naccept: naccept[j.pid] };
        }

        // 按章节统计分数和完成数
        for (const d of Object.values(detail)) {
            const nodeId = pidToNode[d.pid];
            score[nodeId] ||= 0;
            accept[nodeId] ||= 0;

            if (d.status === STATUS.STATUS_ACCEPTED) {
                accept[0] += 1;
                accept[nodeId] += 1;
            }
            score[nodeId] += d.score;
            score[0] += d.score;
        }

        return {
            score,
            accept,
            detail,
            progress: Math.floor((accept[0] / tdoc.pids.length) * 100),
        };
    },

    showScoreboard: () => true,
    showSelfRecord: () => true,
    showRecord: (tdoc, now) => now > tdoc.endAt,

    async scoreboardHeader(config, _, tdoc, pdict) {
        const columns: ScoreboardRow = [
            { type: 'rank', value: '#' },
            { type: 'user', value: _('User') },
        ];

        if (config.isExport) {
            columns.push({ type: 'email', value: _('Email') });
            columns.push({ type: 'string', value: _('School') });
            columns.push({ type: 'string', value: _('Name') });
            columns.push({ type: 'string', value: _('Student ID') });
        }

        columns.push({ type: 'total_score', value: _('Total Score') });
        columns.push({ type: 'solved', value: `${_('Solved')}` });

        for (let i = 1; i <= tdoc.pids.length; i++) {
            const pid = tdoc.pids[i - 1];
            pdict[pid].nAccept = pdict[pid].nSubmit = 0;
            if (config.isExport) {
                columns.push(
                    { type: 'string', value: '#{0} {1}'.format(i, pdict[pid].title) },
                    { type: 'string', value: '#{0} {1}'.format(i, _('Tries')) },
                    { type: 'string', value: '#{0} {1}'.format(i, _('Time')) },
                );
            } else {
                columns.push({
                    type: 'problem',
                    value: i.toString(),
                    hover: pdict[pid].title,
                    raw: pid,
                });
            }
        }

        return columns;
    },

    async scoreboardRow(config, _, tdoc, pdict, udoc, rank, tsdoc, meta) {
        const detail = tsdoc.detail || {};
        const row: ScoreboardRow = [
            { type: 'rank', value: rank.toString() },
            { type: 'user', value: udoc.uname, raw: tsdoc.uid },
        ];

        if (config.isExport) {
            row.push({ type: 'email', value: udoc.mail });
            row.push({ type: 'string', value: udoc.school || '' });
            row.push({ type: 'string', value: udoc.displayName || '' });
            row.push({ type: 'string', value: udoc.studentId || '' });
        }

        row.push({ type: 'total_score', value: tsdoc.score?.[config.id] || 0 });
        row.push({ type: 'string', value: `${tsdoc.accept?.[config.id] || 0}` });

        // 统计题目提交数和通过数
        for (const j of tsdoc.journal || []) {
            if (pdict[j.pid]) {
                pdict[j.pid].nSubmit++;
                if (j.status === STATUS.STATUS_ACCEPTED) {
                    pdict[j.pid].nAccept++;
                }
            }
        }

        // 渲染每道题的状态
        for (const pid of tdoc.pids) {
            const score = detail[pid]?.score ?? '';
            const isAccepted = detail[pid]?.status === STATUS.STATUS_ACCEPTED;
            const submitTime = detail[pid]?.rid
                ? moment(detail[pid]?.rid.getTimestamp().getTime())
                    .tz('Asia/Shanghai')
                    .format('YYYY-MM-DD HH:mm:ss')
                    .replace(' ', '\n')
                : '';

            if (config.isExport) {
                row.push(
                    { type: 'string', value: score },
                    {
                        type: 'string',
                        value: (!isAccepted && detail[pid]?.rid ? `(-${detail[pid]?.naccept})` : '')
                            || (isAccepted && detail[pid]?.naccept ? `(+${detail[pid]?.naccept})` : ''),
                    },
                    { type: 'string', value: submitTime },
                );
            } else {
                let display = score;
                if (!isAccepted && detail[pid]?.rid) {
                    display += `(-${detail[pid]?.naccept})`;
                }
                if (isAccepted) {
                    display += `${detail[pid].naccept ? `(+${detail[pid]?.naccept})` : ''}\n${submitTime}`;
                }

                row.push({
                    type: 'record',
                    score: isAccepted ? 100 : 0,
                    value: display,
                    raw: detail[pid]?.rid,
                    hover: submitTime || undefined,
                    style: isAccepted && detail[pid]?.rid.getTimestamp().getTime() === meta?.first?.[pid]
                        ? 'background-color: rgb(217, 240, 199);'
                        : undefined,
                });
            }
        }

        return row;
    },

    async scoreboard(config, _, tdoc, pdict, cursor) {
        const tsdocs = (await cursor.toArray()).sort(
            (a, b) => (b.score?.[config.id] || 0) - (a.score?.[config.id] || 0)
                || (a.accept?.[config.id] || 0) - (b.accept?.[config.id] || 0)
                || a._id.getTimestamp().getTime() - b._id.getTimestamp().getTime(),
        );

        const rankedDocs = await ranked(tsdocs, (a, b) => a.score === b.score);
        const uids = rankedDocs.map(([, doc]) => doc.uid);
        const udict = await UserModel.getListForRender(tdoc.domainId, uids, ['displayName']);

        return [
            [
                await this.scoreboardHeader(config, _, tdoc, pdict),
                ...await Promise.all(
                    rankedDocs.map(([rank, doc]) => this.scoreboardRow(config, _, tdoc, pdict, udict[doc.uid], rank, doc)),
                ),
            ],
            udict,
        ];
    },

    async ranked(config, tsdocs) {
        return await ranked(tsdocs, (a, b) => a.score === b.score);
    },
}, ContestModel.RULES.ioi);

// 注册课程规则
ContestModel.RULES.course = courseRule;
