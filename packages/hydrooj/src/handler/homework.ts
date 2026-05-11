import yaml from 'js-yaml';
import { escapeRegExp, pick } from 'lodash';
import moment from 'moment-timezone';
import { ObjectId } from 'mongodb';
import { sortFiles, Time } from '@hydrooj/utils/lib/utils';
import {
    ContestNotFoundError, FileLimitExceededError, FileUploadError, ForbiddenError, HomeworkNotLiveError, NotAssignedError, ValidationError,
} from '../error';
import { PenaltyRules, Tdoc } from '../interface';
import { PERM, STATUS } from '../model/builtin';
import * as contest from '../model/contest';
import * as discussion from '../model/discussion';
import problem from '../model/problem';
import record from '../model/record';
import solution from '../model/solution';
import storage from '../model/storage';
import system from '../model/system';
import user from '../model/user';
import * as document from '../model/document';
import {
    Handler, param, post, Types,
} from '../service/server';
import { ContestCodeHandler, ContestFileDownloadHandler, ContestScoreboardHandler } from './contest';

const REFERENCE_CODE_TITLE = '【参考代码】';

function isReferenceCodeSolutionByContent(content = '') {
    const firstLine = content.split(/\r?\n/).find((line) => line.trim());
    if (!firstLine) return false;
    const title = firstLine.trim().replace(/^#+\s*/, '');
    return title.startsWith(REFERENCE_CODE_TITLE);
}

function isReferenceCodeSolution(doc: any) {
    return doc?.title === REFERENCE_CODE_TITLE || isReferenceCodeSolutionByContent(doc?.content || '');
}

const validatePenaltyRules = (input: string) => {
    try {
        const res = yaml.load(input);
        return typeof res === 'object' && res !== null && Object.keys(res).every((key) => typeof res[key] === 'number');
    } catch (e) {
        return false;
    }
};
const convertPenaltyRules = (input: string) => yaml.load(input);

class HomeworkMainHandler extends Handler {
    @param('group', Types.Name, true)
    @param('page', Types.PositiveInt, true)
    @param('q', Types.String, true)
    async get(domainId: string, group = '', page = 1, q = '') {
        const groups = (await user.listGroup(domainId, this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK) ? undefined : this.user._id))
            .map((i) => i.name);
        if (group && !groups.includes(group)) throw new NotAssignedError(group);
        const escaped = escapeRegExp(q.toLowerCase());
        const cursor = contest.getMulti(domainId, {
            rule: 'homework',
            ...this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK) && !group
                ? {}
                : {
                    $or: [
                        { maintainer: this.user._id },
                        { owner: this.user._id },
                        { assign: { $in: groups } },
                        { assign: { $size: 0 } },
                    ],
                },
            ...group ? { assign: { $in: [group] } } : {},
            ...q ? { title: { $regex: new RegExp(q.length >= 2 ? escaped : `\\A${escaped}`, 'gim') } } : {},
        }).sort({
            penaltySince: -1, endAt: -1, beginAt: -1, _id: -1,
        });
        const [tdocs, tpcount] = await this.paginate(cursor, page, 'contest');
        const calendar = [];
        for (const tdoc of tdocs) {
            const cal = { ...tdoc, url: this.url('homework_detail', { tid: tdoc.docId }) };
            if (contest.isExtended(tdoc) || contest.isDone(tdoc)) {
                cal.endAt = tdoc.endAt;
                cal.penaltySince = tdoc.penaltySince;
            } else cal.endAt = tdoc.penaltySince;
            calendar.push(cal);
        }
        let qs = group ? `group=${group}` : '';
        if (q) qs += `${qs ? '&' : ''}q=${encodeURIComponent(q)}`;
        const groupsFilter = groups.filter((i) => !Number.isSafeInteger(+i));
        this.response.body = {
            tdocs, calendar, tpcount, page, qs, groups: groupsFilter, group, q,
        };
        this.response.template = 'homework_main.html';
    }
}

class HomeworkDetailHandler extends Handler {
    tdoc: Tdoc;

    @param('tid', Types.ObjectId)
    async prepare(domainId: string, tid: ObjectId) {
        this.tdoc = await contest.get(domainId, tid);
        if (this.tdoc.rule !== 'homework') throw new ContestNotFoundError(domainId, tid);
        if (this.tdoc.assign?.length && !this.user.own(this.tdoc) && !this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK)) {
            if (!new Set(this.tdoc.assign).intersection(new Set(this.user.group)).size) {
                throw new NotAssignedError('homework', this.tdoc.docId);
            }
        }
    }

    @param('tid', Types.ObjectId)
    @param('page', Types.PositiveInt, true)
    async get(domainId: string, tid: ObjectId, page = 1) {
        const tsdoc = await contest.getStatus(domainId, tid, this.user._id);
        if (this.tdoc.rule !== 'homework') throw new ContestNotFoundError(domainId, tid);
        // discussion
        const [ddocs, dpcount, dcount] = await this.paginate(
            discussion.getMulti(domainId, { parentType: this.tdoc.docType, parentId: this.tdoc.docId }),
            page,
            'discussion',
        );
        const uids = ddocs.map((ddoc) => ddoc.owner);
        uids.push(this.tdoc.owner);
        const udict = await user.getList(domainId, uids);
        this.response.template = 'homework_detail.html';
        this.response.body = {
            tdoc: this.tdoc, tsdoc, udict, ddocs, page, dpcount, dcount,
        };
        this.response.body.tdoc.content = this.response.body.tdoc.content
            .replace(/\(file:\/\//g, `(./${this.tdoc.docId}/file/public/`)
            .replace(/="file:\/\//g, `="./${this.tdoc.docId}/file/public/`);
        if (
            (contest.isNotStarted(this.tdoc) || (!tsdoc?.attend && !contest.isDone(this.tdoc)))
            && !this.user.own(this.tdoc)
            && !this.user.hasPerm(PERM.PERM_VIEW_HOMEWORK_HIDDEN_SCOREBOARD)
        ) return;
        const pdict = await problem.getList(domainId, this.tdoc.pids, true, true, problem.PROJECTION_CONTEST_LIST);
        const psdict = {};
        let rdict = {};
        if (tsdoc) {
            if (tsdoc.attend && !tsdoc.startAt && contest.isOngoing(this.tdoc)) {
                await contest.setStatus(domainId, tid, this.user._id, { startAt: new Date() });
                tsdoc.startAt = new Date();
            }
            const valid = (tsdoc.journal || []).filter((p) => this.tdoc.pids.includes(p.pid));
            for (const pdetail of valid) {
                psdict[pdetail.pid] = pdetail;
                rdict[pdetail.rid] = { _id: pdetail.rid };
            }
            if (contest.canShowSelfRecord.call(this, this.tdoc) && valid.length) {
                rdict = await record.getList(domainId, valid.map((pdetail) => pdetail.rid));
            }
        }
        Object.assign(this.response.body, { pdict, psdict, rdict });
    }

    async postAttend({ domainId }) {
        this.checkPerm(PERM.PERM_ATTEND_HOMEWORK);
        if (contest.isDone(this.tdoc)) throw new HomeworkNotLiveError(this.tdoc.docId);
        await contest.attend(domainId, this.tdoc.docId, this.user._id);
        this.back();
    }
}

class HomeworkEditHandler extends Handler {
    @param('tid', Types.ObjectId, true)
    async get(domainId: string, tid: ObjectId) {
        const tdoc = tid ? await contest.get(domainId, tid) : null;
        if (!tid) this.checkPerm(PERM.PERM_CREATE_HOMEWORK);
        else if (!this.user.own(tdoc)) this.checkPerm(PERM.PERM_EDIT_HOMEWORK);
        else this.checkPerm(PERM.PERM_EDIT_HOMEWORK_SELF);
        const extensionDays = tid
            ? Math.round(
                (tdoc.endAt.getTime() - tdoc.penaltySince.getTime()) / (Time.day / 100),
            ) / 100
            : 1;
        const beginAt = tid
            ? moment(tdoc.beginAt).tz(this.user.timeZone)
            : moment().add(1, 'day').tz(this.user.timeZone).hour(0).minute(0).millisecond(0);
        const penaltySince = tid
            ? moment(tdoc.penaltySince).tz(this.user.timeZone)
            : beginAt.clone().add(7, 'days').tz(this.user.timeZone).hour(23).minute(59).millisecond(0);
        this.response.template = 'homework_edit.html';
        this.response.body = {
            tdoc,
            dateBeginText: beginAt.format('YYYY-M-D'),
            timeBeginText: beginAt.format('H:mm'),
            datePenaltyText: penaltySince.format('YYYY-M-D'),
            timePenaltyText: penaltySince.format('H:mm'),
            extensionDays,
            penaltyRules: tid ? yaml.dump(tdoc.penaltyRules) : null,
            pids: tid ? tdoc.pids.join(',') : '',
            page_name: tid ? 'homework_edit' : 'homework_create',
        };
    }

    @param('tid', Types.ObjectId, true)
    @param('beginAtDate', Types.Date)
    @param('beginAtTime', Types.Time)
    @param('penaltySinceDate', Types.Date)
    @param('penaltySinceTime', Types.Time)
    @param('extensionDays', Types.Float)
    @param('penaltyRules', Types.Content, validatePenaltyRules, convertPenaltyRules)
    @param('title', Types.Title)
    @param('content', Types.Content)
    @param('pids', Types.Content)
    @param('rated', Types.Boolean)
    @param('maintainer', Types.NumericArray, true)
    @param('assign', Types.CommaSeperatedArray, true)
    @param('langs', Types.CommaSeperatedArray, true)
    async postUpdate(
        domainId: string, tid: ObjectId, beginAtDate: string, beginAtTime: string,
        penaltySinceDate: string, penaltySinceTime: string, extensionDays: number,
        penaltyRules: PenaltyRules, title: string, content: string, _pids: string, rated = false,
        maintainer: number[] = [], assign: string[] = [], langs: string[] = [],
    ) {
        const pids = _pids.replace(/，/g, ',').split(',').map((i) => +i).filter((i) => i);
        const tdoc = tid ? await contest.get(domainId, tid) : null;
        if (!tid) this.checkPerm(PERM.PERM_CREATE_HOMEWORK);
        else if (!this.user.own(tdoc)) this.checkPerm(PERM.PERM_EDIT_HOMEWORK);
        else this.checkPerm(PERM.PERM_EDIT_HOMEWORK_SELF);
        const beginAt = moment.tz(`${beginAtDate} ${beginAtTime}`, this.user.timeZone);
        if (!beginAt.isValid()) throw new ValidationError('beginAtDate', 'beginAtTime');
        const penaltySince = moment.tz(`${penaltySinceDate} ${penaltySinceTime}`, this.user.timeZone);
        if (!penaltySince.isValid()) throw new ValidationError('endAtDate', 'endAtTime');
        const endAt = penaltySince.clone().add(extensionDays, 'days');
        if (beginAt.isSameOrAfter(penaltySince)) throw new ValidationError('endAtDate', 'endAtTime');
        if (penaltySince.isAfter(endAt)) throw new ValidationError('extensionDays');
        await problem.getList(domainId, pids, this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN) || this.user._id, true);
        if (!tid) {
            tid = await contest.add(domainId, title, content, this.user._id,
                'homework', beginAt.toDate(), endAt.toDate(), pids, rated,
                { penaltySince: penaltySince.toDate(), penaltyRules, assign });
        } else {
            await contest.edit(domainId, tid, {
                title,
                content,
                beginAt: beginAt.toDate(),
                endAt: endAt.toDate(),
                pids,
                penaltySince: penaltySince.toDate(),
                penaltyRules,
                rated,
                maintainer,
                assign,
                langs,
            });
            if (tdoc.beginAt !== beginAt.toDate()
                || tdoc.endAt !== endAt.toDate()
                || tdoc.penaltySince !== penaltySince.toDate()
                || tdoc.pids.sort().join(' ') !== pids.sort().join(' ')) {
                await contest.recalcStatus(domainId, tdoc.docId);
            }
        }
        this.response.body = { tid };
        this.response.redirect = this.url('homework_detail', { tid });
    }

    @param('tid', Types.ObjectId)
    async postDelete(domainId: string, tid: ObjectId) {
        const tdoc = await contest.get(domainId, tid);
        if (!this.user.own(tdoc)) this.checkPerm(PERM.PERM_EDIT_HOMEWORK);
        await Promise.all([
            record.updateMulti(domainId, { domainId, contest: tid }, undefined, undefined, { contest: '' }),
            contest.del(domainId, tid),
            storage.del(tdoc.files?.map((i) => `contest/${domainId}/${tid}/public/${i.name}`) || [], this.user._id),
        ]);
        this.response.redirect = this.url('homework_main');
    }
}

export class HomeworkFilesHandler extends Handler {
    tdoc: Tdoc;

    @param('tid', Types.ObjectId)
    async prepare(domainId: string, tid: ObjectId) {
        this.tdoc = await contest.get(domainId, tid);
        if (!this.user.own(this.tdoc)) this.checkPerm(PERM.PERM_EDIT_HOMEWORK);
        else this.checkPerm(PERM.PERM_EDIT_HOMEWORK_SELF);
    }

    @param('tid', Types.ObjectId)
    async get(domainId: string, tid: ObjectId) {
        if (!this.user.own(this.tdoc)) this.checkPerm(PERM.PERM_EDIT_HOMEWORK);
        this.response.body = {
            tdoc: this.tdoc,
            tsdoc: await contest.getStatus(domainId, this.tdoc.docId, this.user._id),
            udoc: await user.getById(domainId, this.tdoc.owner),
            files: sortFiles(this.tdoc.files || []),
            urlForFile: (filename: string) => this.url('homework_file_download', { tid, filename, type: 'public' }),
        };
        this.response.pjax = 'partials/files.html';
        this.response.template = 'homework_files.html';
    }

    @param('tid', Types.ObjectId)
    @post('filename', Types.Filename, true)
    async postUploadFile(domainId: string, tid: ObjectId, filename: string) {
        if ((this.tdoc.files?.length || 0) >= system.get('limit.contest_files')) {
            throw new FileLimitExceededError('count');
        }
        const file = this.request.files?.file;
        if (!file) throw new ValidationError('file');
        const size = Math.sum((this.tdoc.files || []).map((i) => i.size)) + file.size;
        if (size >= system.get('limit.contest_files_size')) {
            throw new FileLimitExceededError('size');
        }
        await storage.put(`contest/${domainId}/${tid}/public/${filename}`, file.filepath, this.user._id);
        const meta = await storage.getMeta(`contest/${domainId}/${tid}/public/${filename}`);
        const payload = { _id: filename, name: filename, ...pick(meta, ['size', 'lastModified', 'etag']) };
        if (!meta) throw new FileUploadError();
        await contest.edit(domainId, tid, { files: [...(this.tdoc.files || []), payload] });
        this.back();
    }

    @param('tid', Types.ObjectId)
    @post('files', Types.ArrayOf(Types.Filename))
    async postDeleteFiles(domainId: string, tid: ObjectId, files: string[]) {
        await Promise.all([
            storage.del(files.map((t) => `contest/${domainId}/${tid}/public/${t}`), this.user._id),
            contest.edit(domainId, tid, { files: this.tdoc.files.filter((i) => !files.includes(i.name)) }),
        ]);
        this.back();
    }
}

class HomeworkProblemReferenceHandler extends Handler {
    tdoc: Tdoc;
    pdoc: any;
    tsdoc: any;
    canEdit: boolean;

    @param('tid', Types.ObjectId)
    @param('pid', Types.UnsignedInt)
    async prepare(domainId: string, tid: ObjectId, pid: number) {
        this.tdoc = await contest.get(domainId, tid);
        if (this.tdoc.rule !== 'homework') throw new ContestNotFoundError(domainId, tid);
        if (this.tdoc.assign?.length && !this.user.own(this.tdoc) && !this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK)) {
            if (!Set.intersection(this.tdoc.assign, this.user.group).size) {
                throw new NotAssignedError('homework', this.tdoc.docId);
            }
        }

        this.pdoc = await problem.get(domainId, pid);
        if (!this.pdoc) throw new NotAssignedError('homework', this.tdoc.docId);
        if (!this.tdoc.pids.includes(pid)) throw new NotAssignedError('homework', this.tdoc.docId);

        this.tsdoc = await contest.getStatus(domainId, tid, this.user._id);
        this.canEdit = this.user.own(this.tdoc)
            || this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK)
            || this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK_SELF);

        const accepted = this.tsdoc?.detail?.[pid]?.status === STATUS.STATUS_ACCEPTED;
        if (!this.canEdit && !accepted) throw new ForbiddenError('通过后才可查看参考代码。');
    }

    @param('tid', Types.ObjectId)
    @param('pid', Types.UnsignedInt)
    async get(domainId: string, tid: ObjectId, pid: number) {
        const refs = (await solution.getMulti(domainId, pid).toArray())
            .filter((doc: any) => isReferenceCodeSolution(doc))
            .sort((a: any, b: any) => a._id.getTimestamp().getTime() - b._id.getTimestamp().getTime());
        const uids = Array.from(new Set([
            this.pdoc.owner,
            this.tdoc.owner,
            ...refs.map((doc: any) => doc.owner),
        ].filter(Boolean)));
        const udict = uids.length ? await user.getList(domainId, uids) : {};
        this.response.template = 'homework_problem_reference.html';
        this.response.body = {
            page_name: 'homework_problem_reference',
            tdoc: this.tdoc,
            tsdoc: this.tsdoc,
            pdoc: this.pdoc,
            refs,
            udict,
            canEdit: this.canEdit,
            canViewHomeworkReference: true,
            canEditHomeworkReference: this.canEdit,
            hasHomeworkReferenceCode: refs.length > 0,
            tid,
            pid,
        };
    }

    @param('tid', Types.ObjectId)
    @param('pid', Types.UnsignedInt)
    @param('content', Types.Content)
    async postSubmit(domainId: string, tid: ObjectId, pid: number, content: string) {
        if (!this.canEdit) throw new ForbiddenError('仅教师可编辑参考代码。');
        await document.add(
            domainId,
            content,
            this.user._id,
            document.TYPE_PROBLEM_SOLUTION,
            null,
            document.TYPE_PROBLEM,
            pid,
            { reply: [], vote: 0, title: REFERENCE_CODE_TITLE },
        );
        this.back();
    }

    @param('tid', Types.ObjectId)
    @param('pid', Types.UnsignedInt)
    @param('psid', Types.ObjectId)
    @param('content', Types.Content)
    async postEditSolution(domainId: string, tid: ObjectId, pid: number, psid: ObjectId, content: string) {
        if (!this.canEdit) throw new ForbiddenError('仅教师可编辑参考代码。');
        const psdoc = await solution.get(domainId, psid);
        if (psdoc.parentId !== pid || !isReferenceCodeSolution(psdoc)) {
            throw new ForbiddenError('只能编辑参考代码。');
        }
        await solution.edit(domainId, psid, content);
        if (psdoc.title !== REFERENCE_CODE_TITLE) {
            await document.set(domainId, document.TYPE_PROBLEM_SOLUTION, psid, { title: REFERENCE_CODE_TITLE } as any);
        }
        this.back();
    }

    @param('tid', Types.ObjectId)
    @param('pid', Types.UnsignedInt)
    @param('psid', Types.ObjectId)
    async postDeleteSolution(domainId: string, tid: ObjectId, pid: number, psid: ObjectId) {
        if (!this.canEdit) throw new ForbiddenError('仅教师可编辑参考代码。');
        const psdoc = await solution.get(domainId, psid);
        if (psdoc.parentId !== pid || !isReferenceCodeSolution(psdoc)) {
            throw new ForbiddenError('只能删除参考代码。');
        }
        await solution.del(domainId, psid);
        this.back();
    }
}

export async function apply(ctx) {
    ctx.Route('homework_main', '/homework', HomeworkMainHandler, PERM.PERM_VIEW_HOMEWORK);
    ctx.Route('homework_create', '/homework/create', HomeworkEditHandler);
    ctx.Route('homework_detail', '/homework/:tid', HomeworkDetailHandler, PERM.PERM_VIEW_HOMEWORK);
    ctx.Route('homework_code', '/homework/:tid/code', ContestCodeHandler, PERM.PERM_VIEW_HOMEWORK);
    ctx.Route('homework_edit', '/homework/:tid/edit', HomeworkEditHandler);
    ctx.Route('homework_files', '/homework/:tid/file', HomeworkFilesHandler, PERM.PERM_VIEW_HOMEWORK);
    ctx.Route('homework_file_download', '/homework/:tid/file/:type/:filename', ContestFileDownloadHandler, PERM.PERM_VIEW_HOMEWORK);
    ctx.Route('homework_problem_reference', '/homework/:tid/problem/:pid/reference', HomeworkProblemReferenceHandler, PERM.PERM_VIEW_HOMEWORK);
    await ctx.inject(['scoreboard'], ({ Route }) => {
        Route('homework_scoreboard', '/homework/:tid/scoreboard', ContestScoreboardHandler, PERM.PERM_VIEW_HOMEWORK_SCOREBOARD);
        Route('homework_scoreboard_view', '/homework/:tid/scoreboard/:view', ContestScoreboardHandler, PERM.PERM_VIEW_HOMEWORK_SCOREBOARD);
    });
}
