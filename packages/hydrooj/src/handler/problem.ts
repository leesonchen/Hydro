import { createReadStream } from 'fs';
import { PassThrough, Readable, Writable } from 'stream';
import { Entry, ZipReader } from '@zip.js/zip.js';
import { readFile } from 'fs-extra';
import {
    escapeRegExp, flattenDeep, intersection, pick,
} from 'lodash';
import { Filter, ObjectId } from 'mongodb';
import { nanoid } from 'nanoid';
import sanitize from 'sanitize-filename';
import Schema from 'schemastery';
import parser from '@hydrooj/utils/lib/search';
import { randomstring, sortFiles, streamToBuffer } from '@hydrooj/utils/lib/utils';
import { problemAccessNodeIds } from '../builtin/course-management/model/structure';
import type { Context } from '../context';
import {
    BadRequestError, ContestNotAttendedError, ContestNotEndedError, ContestNotFoundError, ContestNotLiveError,
    FileLimitExceededError, FileTooLargeError, ForbiddenError, HackFailedError, NoProblemError, NotFoundError,
    PermissionError, ProblemAlreadyExistError, ProblemAlreadyUsedByContestError, ProblemConfigError,
    ProblemIsReferencedError, ProblemNotAllowCopyError, ProblemNotAllowLanguageError, ProblemNotAllowPretestError,
    ProblemNotFoundError, ProblemReferencedByDomainError, RecordNotFoundError, SolutionNotFoundError, ValidationError,
} from '../error';
import {
    ProblemDoc, ProblemSearchOptions, ProblemStatusDoc, RecordDoc, Tdoc, User,
} from '../interface';
import { canSubmitPractice, isPracticeOpen } from '../lib/contest-practice';
import { assertCourseAssessmentAccess } from '../lib/course-assessment-access';
import { REFERENCE_CODE_TITLE } from '../lib/referenceCode';
import { Logger } from '../logger';
import { PERM, PRIV, STATUS } from '../model/builtin';
import * as contest from '../model/contest';
import * as discussion from '../model/discussion';
import * as document from '../model/document';
import domain from '../model/domain';
import feedback from '../model/feedback';
import * as oplog from '../model/oplog';
import problem from '../model/problem';
import record from '../model/record';
import { getV2ProblemDifficulties } from '../model/rating-publication';
import * as setting from '../model/setting';
import solution from '../model/solution';
import storage from '../model/storage';
import system from '../model/system';
import user from '../model/user';
import {
    Handler, param, post, Query, query, route, Types,
} from '../service/server';
import { ContestDetailBaseHandler } from './contest';

const logger = new Logger('problem');

function canBypassCourseTimeLimit(tdoc: any, udoc: User) {
    if (tdoc?.rule !== 'course') return false;
    return udoc.own(tdoc)
        || udoc.hasPerm(PERM.PERM_EDIT_HOMEWORK)
        || udoc.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK);
}

function canBypassCourseDagLimit(tdoc: any, udoc: User) {
    if (tdoc?.rule !== 'course') return false;
    return udoc.hasPerm(PERM.PERM_EDIT_HOMEWORK)
        || udoc.own(tdoc, PERM.PERM_EDIT_HOMEWORK_SELF)
        || udoc.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK);
}

function submissionParticipationMode(handler: {
    user: User; team?: number; pdoc?: ProblemDoc;
    tdoc?: Pick<Tdoc, 'owner' | 'maintainer' | 'sourceType' | 'ratingPolicy'>;
    problemFileUser?: User | null; problemFilePdoc?: ProblemDoc;
}, practice = false, pretest = false, classroomTeacher = false) {
    if (practice || pretest) return 'practice' as const;
    if (handler.team !== undefined || handler.user._id < 0) return 'team' as const;
    if (classroomTeacher || (handler.pdoc && handler.user.own(handler.pdoc))
        || (handler.tdoc && (handler.user.own(handler.tdoc) || handler.user.hasPerm(PERM.PERM_EDIT_CONTEST)))
        || handler.user.hasPerm(PERM.PERM_EDIT_PROBLEM)
        || (handler.pdoc?.reference && handler.problemFileUser && handler.problemFilePdoc
            && (handler.problemFileUser.own(handler.problemFilePdoc)
                || handler.problemFileUser.hasPerm(PERM.PERM_EDIT_PROBLEM)))) return 'staff' as const;
    if (handler.tdoc?.sourceType === 'course_assessment' && handler.tdoc.ratingPolicy?.enabled
        && !handler.tdoc.ratingPolicy.classroom?.participantUids?.includes(handler.user._id)) return 'unknown' as const;
    return 'official' as const;
}

function getCourseNodeIdByPid(tdoc: any, pid: number) {
    return problemAccessNodeIds(tdoc)[pid] ?? null;
}

type ExtendedProblemSearchOptions = ProblemSearchOptions & {
    scope?: 'all' | 'title';
    global?: boolean;
};

export const parseCategory = (value: string) => value.replace(/，/g, ',').split(',').map((e) => e.trim());

interface ProblemFileSource {
    domainId: string;
    pdoc: ProblemDoc;
    user: User | null;
    canRead: boolean;
}

async function getProblemFileSource(pdoc: ProblemDoc, udoc: User): Promise<ProblemFileSource | null> {
    if (!pdoc.reference) {
        return {
            domainId: pdoc.domainId,
            pdoc,
            user: udoc,
            canRead: udoc.own(pdoc) || udoc.hasPriv(PRIV.PRIV_READ_PROBLEM_DATA)
                || udoc.hasPerm(PERM.PERM_READ_PROBLEM_DATA),
        };
    }
    const { domainId, pid } = pdoc.reference;
    const sourcePdoc = await problem.get(domainId, pid);
    if (!sourcePdoc) return null;
    const sourceUser = await user.getById(domainId, udoc._id, udoc.scope);
    const canView = !!sourceUser && problem.canViewBy(sourcePdoc, sourceUser);
    return {
        domainId,
        pdoc: sourcePdoc,
        user: sourceUser,
        canRead: canView && !!sourceUser && (sourceUser.own(sourcePdoc)
            || sourceUser.hasPriv(PRIV.PRIV_READ_PROBLEM_DATA)
            || sourceUser.hasPerm(PERM.PERM_READ_PROBLEM_DATA)),
    };
}

function buildQuery(udoc: User) {
    const q: Filter<ProblemDoc> = {};
    if (!udoc.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN)) {
        q.$or = [
            { hidden: false },
            { owner: udoc._id },
            { maintainer: udoc._id },
        ];
    }
    return q;
}

const defaultSearch = async (domainId: string, q: string, options?: ExtendedProblemSearchOptions) => {
    const projection: (keyof ProblemDoc)[] = ['domainId', 'docId', 'pid'];
    const terms = q.split(/[\s,]+/).map((term) => term.trim()).filter(Boolean);
    const termFilters = terms.map((term) => {
        const escaped = escapeRegExp(term.toLowerCase());
        const $regex = new RegExp(term.length >= 2 ? escaped : `\\A${escaped}`, 'gim');
        const orFilters: Filter<ProblemDoc>[] = [{ pid: { $regex } }, { title: { $regex } }, { tag: { $regex } }];
        if (options?.scope !== 'title') orFilters.push({ content: { $regex } });
        return { $or: orFilters };
    });
    const filter: Filter<ProblemDoc> = termFilters.length === 1
        ? termFilters[0]
        : termFilters.length
            ? { $and: termFilters }
            : {};
    if (options?.global) filter.domainId = { $exists: true };
    const pdocs = await problem.getMulti(domainId, filter, projection)
        .skip(options?.skip || 0).limit(options?.limit || system.get('pagination.problem')).toArray();
    if (!options?.skip) {
        let pdoc = await problem.get(domainId, Number.isSafeInteger(+q) ? +q : q, projection);
        if (pdoc) pdocs.unshift(pdoc);
        else if (/^P\d+$/.test(q)) {
            pdoc = await problem.get(domainId, +q.substring(1), projection);
            if (pdoc) pdocs.unshift(pdoc);
        }
        if (pdocs.length > (options.limit || system.get('pagination.problem'))) pdocs.pop();
    }
    return {
        hits: Array.from(new Set(pdocs.map((i) => `${i.domainId}/${i.docId}`))),
        total: Math.max(pdocs.length, options?.global
            ? await document.coll.countDocuments({ docType: document.TYPE_PROBLEM, ...filter })
            : await problem.count(domainId, filter)),
        countRelation: 'eq',
    };
};

async function assertProblemNotReferencedByOtherDomain(domainId: string, pid: number) {
    const referenced = await problem.getMulti('', {
        domainId: { $ne: domainId },
        'reference.domainId': domainId,
        'reference.pid': pid,
    }, ['domainId', 'docId', 'reference']).limit(1).next();
    if (referenced) throw new ProblemReferencedByDomainError(pid);
}

export interface QueryContext {
    query: Filter<ProblemDoc>;
    sort: string[];
    pcountRelation: string;
    parsed: ReturnType<typeof parser.parse>;
    category: string[];
    text: string;
    total: number;
    fail: boolean;
    hint: string;
}

export class ProblemMainHandler extends Handler {
    queryContext: QueryContext = {
        query: {},
        sort: [],
        pcountRelation: 'eq',
        parsed: null,
        category: [],
        text: '',
        total: 0,
        fail: false,
        hint: 'sort',
    };

    @param('page', Types.PositiveInt, true)
    @param('q', Types.Content, true)
    @param('tag', Types.Content, true)
    @param('limit', Types.PositiveInt, true)
    @param('global', Types.Boolean, true)
    @param('scope', Types.Range(['all', 'title']), true)
    @param('mode', Types.Range(['sonic', 'regex']), true)
    @param('pjax', Types.Boolean)
    @param('quick', Types.Boolean)
    @param('sort', Types.Range(['default', 'recent']), true)
    async get(
        domainId: string, page = 1, q = '', tag = '', limit: number, global = false, scope: 'all' | 'title' = 'title',
        mode: 'sonic' | 'regex' = 'regex', pjax = false, quick = false, sortStrategy = 'default',
    ) {
        this.response.template = 'problem_main.html';
        const paginationDefault = this.ctx.setting.get('pagination.problem') ?? system.get('pagination.problem') ?? 50;
        if (!Number.isSafeInteger(limit) || limit <= 0 || limit > paginationDefault || page > 1) limit = paginationDefault;
        this.queryContext.query = buildQuery(this.user);
        if (sortStrategy === 'recent') this.queryContext.hint = 'basic';
        // eslint-disable-next-line ts/no-shadow
        const query = this.queryContext.query;
        const psdict = {};
        const useRegex = true;
        const search = defaultSearch;
        const parsed = parser.parse(q, {
            keywords: ['category', 'difficulty', 'namespace'],
            offsets: false,
            alwaysArray: true,
            tokenize: true,
        });
        const category = parsed.category || [];
        const tagFilters = tag
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean);
        const text = (parsed.text || []).join(' ');
        if (parsed.difficulty?.every((i) => Number.isSafeInteger(+i))) {
            query.difficulty = { $in: parsed.difficulty.flatMap((i) => +i === 0 ? [0, undefined] : [+i]) };
        }
        const queryTags = [...category, ...tagFilters];
        if (queryTags.length) query.$and = queryTags.map((tagItem) => ({ tag: new RegExp(escapeRegExp(tagItem), 'i') }));
        if (parsed.namespace?.length) {
            const mappedPrefix = this.domain.namespaces?.[parsed.namespace[0]];
            query.$and ||= [];
            if (mappedPrefix) query.$and.push({ sort: new RegExp(`^${mappedPrefix}-`) });
            else query.$and.push({ tag: new RegExp(escapeRegExp(parsed.namespace[0]), 'i') });
        }
        const displayTags = [...queryTags];
        if (text) displayTags.push(text);
        if (displayTags.length) this.UiContext.extraTitleContent = displayTags.join(',');
        let total = 0;
        const canGlobalSearch = domainId === 'system' && this.user.hasPriv(PRIV.PRIV_VIEW_ALL_DOMAIN);
        const isGlobalSearch = canGlobalSearch && global;
        if (text) {
            const effectiveDomainId = isGlobalSearch && !useRegex ? '*' : domainId;
            logger.debug('problem list search: domain=%s global=%s mode=%s scope=%s query=%s text=%s',
                domainId,
                global,
                mode,
                scope,
                q,
                text,
            );
            const searchOptions: ExtendedProblemSearchOptions = {
                skip: (page - 1) * limit,
                limit,
                scope,
            };
            if (isGlobalSearch && useRegex) searchOptions.global = true;
            const result = await search(effectiveDomainId, text, searchOptions);
            total = result.total;
            this.queryContext.pcountRelation = result.countRelation;
            if (!result.hits.length) this.queryContext.fail = true;
            if (isGlobalSearch) {
                const pairs = result.hits
                    .map((t) => t.split('/'))
                    .filter((t) => t.length === 2)
                    .map((t) => ({ domainId: t[0], docId: +t[1] }));
                if (pairs.length) {
                    query.$and ||= [];
                    query.$and.push({ $or: pairs });
                }
                const domainIds = Array.from(new Set(pairs.map((pair) => pair.domainId)));
                if (domainIds.length) query.domainId = { $in: domainIds };
            } else {
                query.docId = { $in: result.hits.map((t) => +t.split('/')[1]) };
            }
            this.queryContext.hint = 'basic';
            this.queryContext.sort = result.hits;
        } else if (isGlobalSearch) {
            query.domainId = { $exists: true };
        }
        const sort = this.queryContext.sort;
        await this.ctx.parallel('problem/list', query, this, sort);
        const sortKey = ({
            default: { sort: 1, docId: 1 },
            recent: { docId: -1 },
        } as const)[sortStrategy];
        let [pdocs, ppcount, pcount] = this.queryContext.fail
            ? [[], 0, 0]
            : await this.paginate(
                problem.getMulti(domainId, query, quick ? ['title', 'pid', 'domainId', 'docId'] : undefined)
                    .sort(sortKey).hint(this.queryContext.hint),
                sort.length ? 1 : page, limit,
            );
        if (total) {
            pcount = total;
            ppcount = Math.ceil(total / limit);
        }
        if (sort.length) pdocs = pdocs.sort((a, b) => sort.indexOf(`${a.domainId}/${a.docId}`) - sort.indexOf(`${b.domainId}/${b.docId}`));
        let showV2Difficulty = false;
        if (this.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM) && domainId !== 'system') {
            const { active, rows: difficulties } = await getV2ProblemDifficulties(domainId, pdocs.map((pdoc) => pdoc.docId));
            showV2Difficulty = active;
            const byPid = new Map(difficulties.map((difficulty) => [difficulty.pid, difficulty]));
            pdocs = pdocs.map((pdoc) => ({ ...pdoc, ratingV2Difficulty: byPid.get(pdoc.docId) || null }));
        }
        if (text && pcount > pdocs.length) pcount = pdocs.length;
        if (this.user.hasPriv(PRIV.PRIV_USER_PROFILE)) {
            Object.assign(psdict, await problem.getVisibleListStatus(
                domainId, this.user._id,
                pdocs.map((i) => i.docId),
                (tdoc, uid) => contest.canShowProblemStatus(this.user, uid, tdoc),
            ));
        }
        if (pjax) {
            this.response.body = {
                title: this.renderTitle(this.translate('problem_main')),
                fragments: (await Promise.all([
                    this.renderHTML('partials/problem_list.html', {
                        page, ppcount, pcount, pdocs, psdict, qs: q, scope, globalSearch: isGlobalSearch, sort: sortStrategy,
                        showV2Difficulty,
                    }),
                    this.renderHTML('partials/problem_stat.html', { pcount, pcountRelation: this.queryContext.pcountRelation }),
                    this.renderHTML('partials/problem_lucky.html', { qs: q }),
                ])).map((i) => ({ html: i })),
            };
        } else {
            this.response.body = {
                page,
                pcount,
                ppcount,
                pcountRelation: this.queryContext.pcountRelation,
                pdocs,
                psdict,
                qs: q,
                scope,
                globalSearch: isGlobalSearch,
                canGlobalSearch,
                sort: sortStrategy,
                showV2Difficulty,
            };
        }
    }

    @param('pids', Types.NumericArray)
    @param('target', Types.String)
    @param('hidden', Types.Boolean)
    @param('redirect', Types.Boolean)
    async postCopy(domainId: string, pids: number[], target: string, hidden?: boolean, redirect = false) {
        let t = `,${this.domain.share || ''},`;
        if (t !== ',*,' && !t.includes(`,${target},`)) throw new ProblemNotAllowCopyError(this.domain._id, target);
        const ddoc = await domain.get(target);
        if (!ddoc) throw new NotFoundError(target);
        const dudoc = await user.getById(target, this.user._id);
        if (!dudoc.hasPerm(PERM.PERM_CREATE_PROBLEM)) throw new PermissionError(PERM.PERM_CREATE_PROBLEM);
        if (!pids.length) throw new ValidationError('pids');
        // Check if user can access all those problems
        const pdict = await problem.getList(
            domainId, pids, this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN) || this.user._id,
            true, ['domainId', 'docId', 'reference'], true,
        );
        const ids = [];
        for (const pid of pids) {
            let pdoc = pdict[pid];
            if (pdoc.reference) {
                // eslint-disable-next-line no-await-in-loop
                const [sourcePdoc, sourceDdoc] = await Promise.all([
                    problem.get(pdoc.reference.domainId, pdoc.reference.pid),
                    domain.get(pdoc.reference.domainId),
                ]);
                if (!sourcePdoc) throw new ProblemNotFoundError(pdoc.reference.domainId, pdoc.reference.pid);
                else pdoc = sourcePdoc;
                t = `,${sourceDdoc.share || ''},`;
                if (t !== ',*,' && !t.includes(`,${target},`)) throw new ProblemNotAllowCopyError(sourceDdoc._id, target);
            }
            // eslint-disable-next-line no-await-in-loop
            ids.push(await problem.copy(pdoc.domainId, pdoc.docId, target, undefined, hidden));
        }
        if (redirect) this.response.redirect = this.url('problem_detail', { domainId: target, pid: ids[0] });
        else this.response.body = ids;
    }

    @param('pids', Types.NumericArray)
    async postDelete(domainId: string, pids: number[]) {
        const pdocs = [];
        for (const pid of pids) {
            // eslint-disable-next-line no-await-in-loop
            const pdoc = await problem.get(domainId, pid);
            if (!pdoc) continue;
            if (!this.user.own(pdoc, PERM.PERM_EDIT_PROBLEM_SELF)) this.checkPerm(PERM.PERM_EDIT_PROBLEM);
            pdocs.push(pdoc);
        }
        for (const pdoc of pdocs) {
            // eslint-disable-next-line no-await-in-loop
            await assertProblemNotReferencedByOtherDomain(pdoc.domainId, pdoc.docId);
        }
        let i = 0;
        for (const pdoc of pdocs) {
            // eslint-disable-next-line no-await-in-loop
            await problem.del(pdoc.domainId, pdoc.docId);
            i++;
            this.progress('Deleting: ({0}/{1})', [i, pids.length]);
        }
        this.back();
    }

    @param('pids', Types.NumericArray)
    async postHide(domainId: string, pids: number[]) {
        for (const pid of pids) {
            // eslint-disable-next-line no-await-in-loop
            const pdoc = await problem.get(domainId, pid);
            if (!pdoc) throw new ProblemNotFoundError(domainId, pid);
            if (!this.user.own(pdoc, PERM.PERM_EDIT_PROBLEM_SELF)) this.checkPerm(PERM.PERM_EDIT_PROBLEM);
            // eslint-disable-next-line no-await-in-loop
            await problem.edit(domainId, pid, { hidden: true });
        }
        this.back();
    }

    @param('pids', Types.NumericArray)
    async postUnhide(domainId: string, pids: number[]) {
        for (const pid of pids) {
            // eslint-disable-next-line no-await-in-loop
            const pdoc = await problem.get(domainId, pid);
            if (!pdoc) throw new ProblemNotFoundError(domainId, pid);
            if (!this.user.own(pdoc, PERM.PERM_EDIT_PROBLEM_SELF)) this.checkPerm(PERM.PERM_EDIT_PROBLEM);
            // eslint-disable-next-line no-await-in-loop
            await problem.edit(domainId, pid, { hidden: false });
        }
        this.back();
    }
}

export class ProblemRandomHandler extends Handler {
    @param('q', Types.Content, true)
    async get(domainId: string, qs = '') {
        const category = flattenDeep(qs.split(' ')
            .filter((i) => i.startsWith('category:'))
            .map((i) => i.split('category:')[1]?.split(',')));
        const q = buildQuery(this.user);
        if (category.length) q.$and = category.map((tag) => ({ tag }));
        await this.ctx.parallel('problem/list', q, this);
        const pid = await problem.random(domainId, q);
        if (!pid) throw new NoProblemError();
        this.response.body = { pid };
        this.response.redirect = this.url('problem_detail', { pid });
    }
}

export class ProblemDetailHandler extends ContestDetailBaseHandler {
    pdoc: ProblemDoc;
    udoc: User;
    psdoc: ProblemStatusDoc;
    problemFilePdoc: ProblemDoc;
    problemFileDomainId: string;
    problemFileUser: User | null;
    canReadProblemFiles = false;

    @route('pid', Types.ProblemId, true)
    @query('tid', Types.ObjectId, true)
    async _prepare(domainId: string, pid: number | string, tid?: ObjectId) {
        this.pdoc = await problem.get(domainId, pid);
        if (!this.pdoc) throw new ProblemNotFoundError(domainId, pid);
        if (tid) {
            if (!this.tdoc?.pids?.includes(this.pdoc.docId)) throw new ContestNotFoundError(domainId, tid);
            if (isPracticeOpen(this.tdoc) && !this.practiceReady && !problem.canViewBy(this.pdoc, this.user)) {
                throw new PermissionError(PERM.PERM_SUBMIT_PROBLEM);
            }
            const canBypassTimeLimit = this.classroomTeacher || canBypassCourseTimeLimit(this.tdoc, this.user);
            if (contest.isNotStarted(this.tdoc) && !canBypassTimeLimit) {
                if (this.tdoc.rule === 'course') throw new ForbiddenError((this as any).translate('This course is not live.'));
                throw new ContestNotLiveError(tid);
            }
            if (!canBypassTimeLimit && !contest.isDone(this.tdoc, this.tsdoc) && (!this.tsdoc?.attend || !this.tsdoc.startAt)) {
                if (this.tdoc.rule === 'course') throw new ForbiddenError((this as any).translate("You haven't joined this course yet."));
                throw new ContestNotAttendedError(tid);
            }
            if (this.tdoc.rule === 'course' && !canBypassCourseDagLimit(this.tdoc, this.user)) {
                const nodeId = getCourseNodeIdByPid(this.tdoc, this.pdoc.docId);
                if (nodeId === null || this.tsdoc?.allow?.[nodeId] !== true) {
                    throw new ForbiddenError((this as any).translate('This problem is not available yet.'));
                }
            }
            // Delete problem-related info in contest mode
            if (this.pdoc.tag) this.pdoc.tag.length = 0;
            delete this.pdoc.nAccept;
            delete this.pdoc.nSubmit;
            delete this.pdoc.difficulty;
            delete this.pdoc.stats;
        } else if (!problem.canViewBy(this.pdoc, this.user)) {
            throw new PermissionError(PERM.PERM_VIEW_PROBLEM_HIDDEN);
        }
        let showV2Difficulty = false;
        if (this.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM)) {
            const { active, rows: [difficulty] } = await getV2ProblemDifficulties(domainId, [this.pdoc.docId]);
            showV2Difficulty = active;
            this.pdoc = { ...this.pdoc, ratingV2Difficulty: difficulty || null };
        }
        this.problemFilePdoc = this.pdoc;
        this.problemFileDomainId = this.pdoc.domainId;
        this.problemFileUser = this.user;
        this.canReadProblemFiles = this.user.own(this.pdoc)
            || this.user.hasPriv(PRIV.PRIV_READ_PROBLEM_DATA)
            || this.user.hasPerm(PERM.PERM_READ_PROBLEM_DATA);
        let ddoc = this.domain;
        if (this.pdoc.reference) {
            ddoc = await domain.get(this.pdoc.reference.domainId);
            const source = await getProblemFileSource(this.pdoc, this.user);
            if (!ddoc || !source) throw new ProblemNotFoundError(this.pdoc.reference.domainId, this.pdoc.reference.pid);
            this.problemFilePdoc = source.pdoc;
            this.problemFileDomainId = source.domainId;
            this.problemFileUser = source.user;
            this.canReadProblemFiles = source.canRead;
            this.pdoc.config = source.pdoc.config;
            this.pdoc.data = source.canRead ? source.pdoc.data : [];
            // Public attachments inherit access from the target problem/contest.
            this.pdoc.additional_file = source.pdoc.additional_file;
        }
        if (typeof this.pdoc.config !== 'string') {
            let baseLangs;
            const t = [];
            if (this.pdoc.config.langs) t.push(this.pdoc.config.langs);
            if (ddoc.langs) t.push(ddoc.langs.split(',').map((i) => i.trim()).filter((i) => i));
            if (this.domain.langs) t.push(this.domain.langs.split(',').map((i) => i.trim()).filter((i) => i));
            if (this.tdoc?.langs?.length) t.push(this.tdoc.langs);
            if (this.pdoc.config.type === 'remote_judge') {
                const p = this.pdoc.config.subType;
                const dl = Object.keys(setting.langs).filter((i) => i.startsWith(`${p}.`) || setting.langs[i].validAs[p]);
                if (setting.langs[p]) dl.push(p);
                baseLangs = dl;
            } else {
                const needHiddenLangs = flattenDeep(t).length;
                baseLangs = Object.keys(setting.langs).filter((i) =>
                    (needHiddenLangs ? !setting.langs[i].remote : !setting.langs[i].remote && !setting.langs[i].hidden));
            }
            this.pdoc.config.langs = ['objective', 'submit_answer'].includes(this.pdoc.config.type) ? ['_'] : intersection(baseLangs, ...t);
        }
        await this.ctx.parallel('problem/get', this.pdoc, this);
        const editorId = this.pdoc.editor ?? this.pdoc.owner;
        [this.psdoc, this.udoc] = await Promise.all([
            problem.getVisibleStatus(
                domainId, this.pdoc.docId, this.user._id,
                (tdoc, uid) => contest.canShowProblemStatus(this.user, uid, tdoc),
            ),
            user.getById(domainId, this.pdoc.owner),
        ]);
        const editorUdoc = editorId === this.pdoc.owner
            ? this.udoc
            : await user.getById(domainId, editorId);
        const [scnt, dcnt] = await Promise.all([
            solution.count(domainId, { parentId: this.pdoc.docId, title: { $ne: REFERENCE_CODE_TITLE } }),
            discussion.count(domainId, { parentId: this.pdoc.docId }),
        ]);
        const basicEditorLangRange = typeof this.pdoc.config === 'object' && this.pdoc.config
            ? Object.fromEntries((this.pdoc.config.langs || []).map((lang) => [lang, setting.langs[lang]?.display || lang]))
            : {};
        this.response.body = {
            basicEditorLangRange,
            pdoc: this.pdoc,
            udoc: this.udoc,
            editor_udoc: editorUdoc,
            lastUpdateAt: this.pdoc.updateAt ?? this.pdoc._id.getTimestamp(),
            psdoc: tid ? null : this.psdoc,
            title: this.pdoc.title,
            solutionCount: scnt,
            discussionCount: dcnt,
            tdoc: this.tdoc,
            owner_udoc: (tid && this.tdoc.owner !== this.pdoc.owner) ? await user.getById(domainId, this.tdoc.owner) : null,
            mode: !tid ? 'normal'
                : this.practiceReady ? 'practice'
                    : !this.tsdoc?.attend ? 'view'
                        : !contest.isDone(this.tdoc) ? 'contest'
                            : problem.canViewBy(this.pdoc, this.user) ? 'correction' : 'none',
            showV2Difficulty,
        };
        if (this.tdoc && this.tsdoc) {
            const fields = ['attend', 'startAt', 'endAt'];
            if (contest.canShowSelfRecord.call(this, this.tdoc, true)) fields.push('detail');
            this.tsdoc = pick(this.tsdoc, fields) as typeof this.tsdoc;
            this.response.body.tsdoc = this.tsdoc;
        }
        this.response.template = 'problem_detail.html';
        this.UiContext.extraTitleContent = this.pdoc.title;
    }

    @query('tid', Types.ObjectId, true)
    @query('pjax', Types.Boolean)
    async get(...args: any[]) {
        // Navigate to current additional file download
        // e.g. ![img](file://a.jpg) will navigate to ![img](./pid/file/a.jpg)
        if (!this.request.json || args[2]) {
            this.response.body.pdoc.content = this.response.body.pdoc.content
                .replace(/file:\/\/([^ \n)\\"]+)/g, (str: string) => {
                    const info = str.match(/file:\/\/([^ \n)\\"]+)/);
                    const fileinfo = info[1];
                    let filename = fileinfo.split('?')[0]; // remove querystring
                    try {
                        filename = decodeURIComponent(filename);
                    } catch (e) { }
                    if (!this.pdoc.additional_file?.find((i) => i.name === filename)) return str;
                    if (!args[1]) return `./${this.pdoc.docId}/file/${fileinfo}`;
                    return `./${this.pdoc.docId}/file/${fileinfo}${fileinfo.includes('?') ? '&' : '?'}tid=${args[1]}`;
                });
        }
        this.response.body.page_name = this.tdoc
            ? this.tdoc.rule === 'homework'
                ? 'homework_detail_problem'
                : 'contest_detail_problem'
            : 'problem_detail';
        if (args[2]) {
            const data = { pdoc: this.pdoc, tdoc: this.tdoc };
            this.response.body = {
                title: this.renderTitle(this.response.body.page_name),
                fragments: [
                    { html: await this.renderHTML('partials/problem_description.html', data) },
                ],
                raw: data,
            };
        }
        if (!this.response.body.tdoc) {
            if (this.psdoc?.rid) {
                this.response.body.rdoc = await record.get(this.args.domainId, this.psdoc.rid);
            }
            [this.response.body.ctdocs, this.response.body.htdocs] = (await Promise.all([
                contest.getRelated(this.args.domainId, this.pdoc.docId),
                contest.getRelated(this.args.domainId, this.pdoc.docId, 'homework'),
            ])).map((tdocs) => tdocs.filter((tdoc) =>
                this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_CONTEST) || !tdoc.assign?.length
                || new Set(tdoc.assign).intersection(new Set(this.user.group)).size,
            ));
        }
    }

    @param('content', Types.Content)
    @param('quote', Types.String, true)
    async postFeedback(domainId: string, content: string, quote = '') {
        // _prepare already enforces the same problem/contest/course access as GET.
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        feedback.validateText(content);
        feedback.validateText(quote, 'quote', true);
        await this.limitRate('feedback_create_minute', 60, 3, '{{user}}');
        await this.limitRate('feedback_create_hour', 3600, 20, '{{user}}');
        this.back(await feedback.create(domainId, this.user._id, {
            type: 'problem', pid: this.pdoc.docId,
            ...(this.tdoc ? { tid: this.tdoc.docId } : {}),
            title: `${this.pdoc.pid || this.pdoc.docId}. ${this.pdoc.title}`,
        }, content, quote));
    }

    @param('pid', Types.UnsignedInt)
    async postRejudge(domainId: string, pid: number) {
        this.checkPerm(PERM.PERM_REJUDGE_PROBLEM);
        if (!this.pdoc.config || typeof this.pdoc.config === 'string') throw new ProblemConfigError();
        const rdocs = await record.getMulti(domainId, {
            pid,
            contest: { $nin: [record.RECORD_GENERATE, record.RECORD_PRETEST] },
            status: { $ne: STATUS.STATUS_CANCELED },
            'files.hack': { $exists: false },
        }).project({ _id: 1, contest: 1 }).toArray();
        if (rdocs.length) {
            const priority = await record.submissionPriority(this.user._id, -10000 - rdocs.length * 5 - 50);
            await record.reset(domainId, rdocs.map((rdoc) => rdoc._id), true);
            await Promise.all([
                record.judge(domainId, rdocs.filter((i) => i.contest).map((i) => i._id), priority, { detail: false }, { rejudge: true }),
                record.judge(domainId, rdocs.filter((i) => !i.contest).map((i) => i._id), priority, {}, { rejudge: true }),
            ]);
        }
        this.back();
    }

    async postDelete() {
        if (!this.user.own(this.pdoc, PERM.PERM_EDIT_PROBLEM_SELF)) this.checkPerm(PERM.PERM_EDIT_PROBLEM);
        const tdocs = await contest.getRelated(this.args.domainId, this.pdoc.docId);
        if (tdocs.length) throw new ProblemAlreadyUsedByContestError(this.pdoc.docId, tdocs[0]._id);
        await assertProblemNotReferencedByOtherDomain(this.pdoc.domainId, this.pdoc.docId);
        await problem.del(this.pdoc.domainId, this.pdoc.docId);
        this.response.redirect = this.url('problem_main');
    }

    @param('star', Types.Boolean)
    async postStar(domainId: string, star: boolean) {
        await problem.setStar(domainId, this.pdoc.docId, this.user._id, star);
        this.back({ star });
    }
}

export class ProblemSubmitHandler extends ProblemDetailHandler {
    @param('tid', Types.ObjectId, true)
    async prepare(domainId: string, tid?: ObjectId) {
        if (tid && !contest.isOngoing(this.tdoc, this.tsdoc)) {
            if (!this.practiceReady && !canBypassCourseTimeLimit(this.tdoc, this.user)) {
                if (this.tdoc?.rule === 'course') throw new ForbiddenError((this as any).translate('This course is not live.'));
                throw new ContestNotLiveError(this.tdoc.docId);
            }
        }
        if (typeof this.pdoc.config === 'string') throw new ProblemConfigError();
        if (this.pdoc.config.langs && !this.pdoc.config.langs.length) throw new ProblemConfigError();
    }

    async get() {
        // The legacy submit form is not an entry point for a monitored coding test.
        // Redirect direct bookmarks as well as sidebar links into online programming.
        if (this.tdoc?.monitorMode === 'browser' && this.tsdoc?.attend && !this.practiceReady
            && contest.isOngoing(this.tdoc, this.tsdoc)
            && typeof this.pdoc.config === 'object' && this.pdoc.config
            && this.pdoc.config.type !== 'objective') {
            this.response.redirect = this.url('problem_detail', {
                pid: this.pdoc.docId, query: { tid: this.tdoc.docId, editor: 'online' },
            });
            return;
        }
        this.response.template = 'problem_submit.html';
        const langRange = (typeof this.pdoc.config === 'object' && this.pdoc.config.langs)
            ? Object.fromEntries(this.pdoc.config.langs.map((i) => [i, setting.langs[i]?.display || i]))
            : setting.SETTINGS_BY_KEY.codeLang.range;
        this.response.body.langRange = langRange;
        this.response.body.page_name = this.tdoc
            ? this.tdoc.rule === 'homework'
                ? 'homework_detail_problem_submit'
                : 'contest_detail_problem_submit'
            : 'problem_submit';
    }

    @param('lang', Types.Name)
    @param('code', Types.String, true)
    @param('pretest', Types.Boolean)
    @param('input', Types.ArrayOf(Types.String, true), true)
    @param('tid', Types.ObjectId, true)
    async post(domainId: string, lang: string, code: string, pretest = false, input: string[] = [], tid?: ObjectId) {
        const config = this.pdoc.config;
        if (typeof config === 'string' || config === null) throw new ProblemConfigError();
        if (['submit_answer', 'objective'].includes(config.type)) {
            lang = '_';
        } else if ((config.langs && !config.langs.includes(lang)) || !setting.langs[lang] || setting.langs[lang].disabled) {
            throw new ProblemNotAllowLanguageError();
        }
        if (pretest) {
            if (setting.langs[lang]?.pretest) lang = setting.langs[lang].pretest as string;
            if (!['default', 'remote_judge'].includes(this.response.body.pdoc.config?.type)) {
                throw new ProblemNotAllowPretestError('type');
            }
            if (!input.length) throw new ValidationError('input');
            input = input.map((i) => i || '');
        }
        await this.limitRate('add_record', 60, system.get('limit.submission_user'), '{{user}}');
        await this.limitRate('add_record', 60, pretest ? system.get('limit.pretest') : system.get('limit.submission'));
        // A crafted form cannot upload a source file to a monitored coding test.
        // This check precedes any storage.put side effect and covers pretests too.
        if (tid && this.request.files?.file?.size > 0) {
            const monitored = await contest.get(domainId, tid);
            if (monitored?.monitorMode === 'browser') {
                const uid = monitored.allowTeam
                    ? (await contest.getTeamVid(domainId, tid, this.user._id)) ?? this.user._id
                    : this.user._id;
                const monitoredStatus = await contest.getStatus(domainId, tid, uid);
                if (monitoredStatus?.attend && contest.isOngoing(monitored, monitoredStatus)) {
                    throw new ForbiddenError('测试监控模式下不允许提交本地文件，请使用在线编程模式。');
                }
            }
        }
        const files: Record<string, string> = {};
        const lengthLimit = system.get('limit.codelength') || 128 * 1024;
        if (!code) {
            const file = this.request.files?.file;
            if (!file || file.size === 0) throw new ValidationError('code');
            const sizeLimit = config.type === 'submit_answer' ? 128 * 1024 * 1024 : lengthLimit;
            if (file.size > sizeLimit) throw new FileTooLargeError('file');
            const shouldReadFile = () => {
                if (config.type === 'objective') return true;
                if (lang === '_') return false;
                return file.size < lengthLimit && !file.filepath.endsWith('.zip') && !setting.langs[lang].isBinary;
            };
            if (shouldReadFile()) code = await readFile(file.filepath, 'utf-8');
            else {
                const id = nanoid();
                await storage.put(`submission/${this.user._id}/${id}`, file.filepath, this.user._id);
                files.code = `${this.user._id}/${id}#${file.originalFilename}`;
            }
        } else {
            code = code.replace(/\r\n/g, '\n');
            if (code.length > lengthLimit) throw new ValidationError('code');
        }
        let practice = false;
        let classroomTeacher = false;
        if (tid) {
            const tdoc = await contest.get(domainId, tid);
            if (!tdoc) throw new ContestNotFoundError(domainId, tid);
            classroomTeacher = await assertCourseAssessmentAccess(this.user, tdoc);
            if (!tdoc.pids.includes(this.pdoc.docId)
                || (tdoc.sourceType !== 'course_assessment'
                    && !contest.canAccessAssignedContest(this.user, tdoc))) {
                throw new ContestNotFoundError(domainId, tid);
            }
            this.tdoc = tdoc;
            practice = await canSubmitPractice(this.user, tdoc);
            // A student may join post-test practice without having attended the timed assessment.
            // Practice is isolated from the official contest journal and classroom pass criteria.
            if (tdoc.sourceType === 'course_assessment' && !classroomTeacher && !practice
                && !(await contest.getStatus(domainId, tid, this.user._id))?.attend) throw new ContestNotAttendedError(tid);
            if (!practice && !contest.isOngoing(tdoc, this.tsdoc) && !canBypassCourseTimeLimit(tdoc, this.user)) {
                throw new ContestNotLiveError(tid);
            }
        }
        const rid = await record.add(
            domainId, this.pdoc.docId, this.user._id, lang, code, true,
            pretest ? { input, type: 'pretest', participationMode: submissionParticipationMode(this, false, true) }
                : practice
                    ? { practiceContest: tid, files, type: 'judge', participationMode: submissionParticipationMode(this, true) }
                    : {
                        contest: tid, files, type: 'judge',
                        participationMode: submissionParticipationMode(this, false, false, classroomTeacher),
                        ...(this.tdoc?.sourceType === 'course_assessment' && this.tdoc.ratingPolicy?.enabled
                            && this.tdoc.ratingPolicy.classroom ? { classroomSession: {
                                courseId: this.tdoc.ratingPolicy.classroom.courseId,
                                nodeId: this.tdoc.ratingPolicy.classroom.nodeId,
                                sessionId: this.tdoc.ratingPolicy.classroom.sessionId,
                            } } : {}),
                    },
        );
        if (!pretest && !practice) {
            if (tid) await contest.updateStatus(domainId, tid, this.team ?? this.user._id, rid, this.pdoc.docId);
            else {
                await Promise.all([
                    problem.inc(domainId, this.pdoc.docId, 'nSubmit', 1),
                    domain.incUserInDomain(domainId, this.user._id, 'nSubmit'),
                ]);
            }
        }
        if (tid && !practice && !pretest && !contest.canShowSelfRecord.call(this, this.tdoc)) {
            this.response.body = { tid };
            this.response.redirect = this.url(this.tdoc.sourceType === 'course_assessment'
                ? 'classroom_test_problemlist' : this.tdoc.rule === 'homework' ? 'homework_detail' : 'contest_problemlist', { tid });
        } else {
            this.response.body = { rid };
            this.response.redirect = this.url('record_detail', { rid });
        }
    }
}

export class ProblemHackHandler extends ProblemDetailHandler {
    rdoc: RecordDoc;

    @param('rid', Types.ObjectId)
    @param('tid', Types.ObjectId, true)
    async prepare(domainId: string, rid: ObjectId, tid?: ObjectId) {
        if (typeof this.pdoc.config !== 'object' || !this.pdoc.config.hackable) throw new HackFailedError('This problem is not hackable.');
        this.rdoc = await record.get(domainId, rid);
        if (this.rdoc?.practiceContest) throw new RecordNotFoundError(domainId, rid);
        if (!this.rdoc || this.rdoc.pid !== this.pdoc.docId
            || this.rdoc.contest?.toString() !== tid?.toString()) throw new RecordNotFoundError(domainId, rid);
        if (tid) {
            if (this.tdoc.rule !== 'codeforces') throw new HackFailedError('This contest is not hackable.');
            if (!contest.isOngoing(this.tdoc, this.tsdoc)) throw new ContestNotLiveError(this.tdoc.docId);
        }
        if (this.rdoc.uid === this.user._id
            || (tid && await contest.isSameTeam(domainId, tid, this.rdoc.uid, this.user._id))) {
            throw new HackFailedError('You cannot hack your own submission');
        }
        const accepted = this.psdoc?.status === STATUS.STATUS_ACCEPTED
            || this.tsdoc?.detail?.[this.pdoc.docId]?.status === STATUS.STATUS_ACCEPTED;
        if (!accepted) throw new HackFailedError('You must accept this problem before hacking.');
        if (this.rdoc.status !== STATUS.STATUS_ACCEPTED) throw new HackFailedError('You cannot hack a unsuccessful submission.');
    }

    async get() {
        this.response.template = 'problem_hack.html';
        this.response.body = {
            pdoc: this.pdoc,
            udoc: this.udoc,
            rid: this.rdoc._id,
            title: this.pdoc.title,
            page_name: this.tdoc ? 'contest_detail_problem_hack' : 'problem_hack',
        };
    }

    @param('input', Types.String, true)
    @param('autoOrganizeInput', Types.Boolean, true)
    @param('tid', Types.ObjectId, true)
    async post(domainId: string, input = '', autoOrganizeInput = false, tid?: ObjectId) {
        await this.limitRate('add_record', 60, system.get('limit.submission_user'), '{{user}}');
        await this.limitRate('add_record', 60, system.get('limit.submission'));
        const id = `${this.user._id}/${nanoid()}`;
        if (this.request.files?.file?.size > 0) {
            const file = this.request.files.file;
            if (!file || file.size > 2 * 1024 * 1024) throw new ValidationError('input');
            await storage.put(`submission/${id}`, file.filepath, this.user._id);
        } else if (input) {
            if (autoOrganizeInput) input = input.replace(/\s+\n/g, '\n').replace(/\s+ /g, ' ');
            await storage.put(`submission/${id}`, Buffer.from(input), this.user._id);
        }
        const rid = await record.add(
            domainId, this.pdoc.docId, this.user._id,
            this.rdoc.lang, this.rdoc.code, true,
            {
                contest: tid,
                type: 'hack',
                participationMode: submissionParticipationMode(this),
                hackTarget: this.rdoc._id,
                files: { hack: `${id}#input.txt` },
            },
        );
        this.response.body = { rid };
        this.response.redirect = this.url('record_detail', { rid });
    }
}

export class ProblemManageHandler extends ProblemDetailHandler {
    async prepare() {
        if (!this.user.own(this.pdoc, PERM.PERM_EDIT_PROBLEM_SELF)) this.checkPerm(PERM.PERM_EDIT_PROBLEM);
    }
}

export class ProblemEditHandler extends ProblemManageHandler {
    async get() {
        this.response.body.additional_file = sortFiles(this.pdoc.additional_file || []);
        this.response.body.statementLangs = this.ctx.i18n.langs(false);
        this.response.template = 'problem_edit.html';
    }

    @route('pid', Types.ProblemId)
    @post('title', Types.Title)
    @post('content', Types.Content)
    @post('pid', Types.ProblemId, true, (i) => /^(?:[a-z0-9]{1,10}-)?[a-z][a-z0-9]*$/i.test(i))
    @post('hidden', Types.Boolean)
    @post('tag', Types.Content, true, null, parseCategory)
    @post('difficulty', Types.PositiveInt, (i) => +i <= 10, true)
    async post(
        domainId: string, pid: string | number, title: string, content: string,
        newPid: string | number = '', hidden = false, tag: string[] = [], difficulty = 0,
    ) {
        if (typeof newPid !== 'string') newPid = `P${newPid}`;
        if (newPid !== this.pdoc.pid && await problem.get(domainId, newPid)) throw new ProblemAlreadyExistError(newPid);
        const $update: Partial<ProblemDoc> = {
            title, content, pid: newPid, hidden, tag: tag ?? [], difficulty, html: false,
            editor: this.user._id,
            updateAt: new Date(),
        };
        const pdoc = await problem.edit(domainId, this.pdoc.docId, $update);
        this.response.redirect = this.url('problem_detail', { pid: newPid || pdoc.docId });
    }
}

export class ProblemConfigHandler extends ProblemManageHandler {
    async get() {
        if (this.pdoc.reference) throw new ProblemIsReferencedError('edit config');
        this.response.body.testdata = sortFiles(this.pdoc.data || []);
        const configFile = (this.pdoc.data || []).filter((i) => i.name.toLowerCase() === 'config.yaml');
        this.response.body.config = '';
        if (configFile.length > 0) {
            try {
                this.response.body.config = (await streamToBuffer(
                    await storage.get(`problem/${this.pdoc.domainId}/${this.pdoc.docId}/testdata/${configFile[0].name}`),
                )).toString();
            } catch (e) { /* ignore */ }
        }
        this.response.template = 'problem_config.html';
    }
}

export class ProblemFilesHandler extends ProblemDetailHandler {
    notUsage = true;

    @param('d', Types.CommaSeperatedArray, true)
    @param('sidebar', Types.Boolean)
    async get({ }, d = ['testdata', 'additional_file'], sidebar = false) {
        if (this.tdoc) throw new ContestNotEndedError();
        this.response.body.testdata = sortFiles(this.pdoc.data || []);
        this.response.body.additional_file = sortFiles(this.pdoc.additional_file || []);
        this.response.body.reference = this.pdoc.reference;
        const canEdit = !this.pdoc.reference
            && (this.user.own(this.pdoc, PERM.PERM_EDIT_PROBLEM_SELF) || this.user.hasPerm(PERM.PERM_EDIT_PROBLEM));
        if (!this.pdoc.reference && canEdit) {
            this.response.body.copiedCount = await problem.countCopies(this.pdoc.domainId, this.pdoc.docId);
        } else {
            this.response.body.copiedCount = 0;
        }
        this.response.pjax = d.map((i) => ['partials/problem_files.html', { filetype: i, sidebar, can_edit: canEdit }]);
        if (!sidebar) this.response.pjax.push(['partials/problem-sidebar-information.html', {}]);
        this.response.template = 'problem_files.html';
    }

    async post() {
        if (this.args.operation === 'get_links') return;
        if (this.args.operation === 'get_copied_problems' || this.args.operation === 'sync_copied_problems') {
            if (this.pdoc.reference) throw new ProblemIsReferencedError('get/sync copied problems');
            if (!this.user.own(this.pdoc, PERM.PERM_EDIT_PROBLEM_SELF)) this.checkPerm(PERM.PERM_EDIT_PROBLEM);
            return;
        }
        if (this.pdoc.reference) throw new ProblemIsReferencedError('edit files');
        if (!this.user.own(this.pdoc, PERM.PERM_EDIT_PROBLEM_SELF)) this.checkPerm(PERM.PERM_EDIT_PROBLEM);
    }

    @post('files', Types.Set)
    @post('type', Types.Range(['testdata', 'additional_file']), true)
    async postGetLinks(domainId: string, files: Set<string>, type = 'testdata') {
        if (this.pdoc.reference) {
            if (type === 'testdata' && files.size && !this.canReadProblemFiles) throw new PermissionError(PERM.PERM_READ_PROBLEM_DATA);
            if (type === 'testdata' && files.size && !this.problemFileUser?.own(this.problemFilePdoc)
                && this.tdoc && !contest.isDone(this.tdoc)) {
                throw new ContestNotEndedError(this.tdoc.domainId, this.tdoc.docId);
            }
        } else if (type === 'testdata' && !this.user.own(this.pdoc)) {
            if (!this.user.hasPriv(PRIV.PRIV_READ_PROBLEM_DATA)) this.checkPerm(PERM.PERM_READ_PROBLEM_DATA);
            if (this.tdoc && !contest.isDone(this.tdoc)) throw new ContestNotEndedError(this.tdoc.domainId, this.tdoc.docId);
        }
        const links = {};
        const filePdoc = this.problemFilePdoc;
        const fileDomainId = this.problemFileDomainId;
        const size = Math.sum(
            filePdoc[type === 'testdata' ? 'data' : 'additional_file']
                ?.filter((i) => files.has(i.name))
                ?.map((i) => i.size),
        ) || 0;
        await oplog.log(this, 'download.problem.bulk', {
            target: Array.from(files).map((file) => `problem/${fileDomainId}/${filePdoc.docId}/${type}/${file}`),
            size,
        });
        for (const file of files) {
            // eslint-disable-next-line no-await-in-loop
            links[file] = await storage.signDownloadLink(
                `problem/${fileDomainId}/${filePdoc.docId}/${type}/${file}`,
                file, false, 'user',
            );
        }
        this.response.body.links = links;
    }

    @post('filename', Types.Filename, true)
    @post('type', Types.Range(['testdata', 'additional_file']), true)
    async postUploadFile(domainId: string, filename: string, type = 'testdata') {
        const file = this.request.files.file;
        if (!file) throw new ValidationError('file');
        filename ||= file.originalFilename || randomstring(16);
        const files = [];
        if (filename.endsWith('.zip') && type === 'testdata') {
            const zip = new ZipReader(Readable.toWeb(createReadStream(file.filepath)));
            let entries: Entry[];
            try {
                entries = await zip.getEntries();
            } catch (e) {
                throw new ValidationError('zip', null, e.message);
            }
            for (const entry of entries) {
                if (!entry.filename || entry.directory === true) continue;
                files.push({
                    type,
                    name: sanitize(entry.filename),
                    size: entry.uncompressedSize,
                    data: () => {
                        const pass = new PassThrough();
                        entry.getData(Writable.toWeb(pass));
                        return pass;
                    },
                });
            }
        } else {
            files.push({
                type,
                name: filename,
                size: file.size,
                data: () => file.filepath,
            });
        }
        if (!this.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM)) {
            if ((this.pdoc.data?.length || 0)
                + (this.pdoc.additional_file?.length || 0)
                + files.length
                >= this.ctx.setting.get('limit.problem_files_max')) {
                throw new FileLimitExceededError('count');
            }
            const size = Math.sum(
                (this.pdoc.data || []).map((i) => i.size),
                (this.pdoc.additional_file || []).map((i) => i.size),
                files.map((i) => i.size),
            );
            if (size >= this.ctx.setting.get('limit.problem_files_max_size')) {
                throw new FileLimitExceededError('size');
            }
        }
        for (const entry of files) {
            const method = entry.type === 'testdata' ? 'addTestdata' : 'addAdditionalFile';
            // eslint-disable-next-line no-await-in-loop
            await problem[method](domainId, this.pdoc.docId, entry.name, entry.data(), this.user._id);
            // eslint-disable-next-line no-await-in-loop
            await problem.setEditMetadata(domainId, this.pdoc.docId, this.user._id);
        }
        this.back();
    }

    @post('files', Types.ArrayOf(Types.Filename))
    @post('newNames', Types.ArrayOf(Types.Filename))
    @post('type', Types.Range(['testdata', 'additional_file']), true)
    async postRenameFiles(domainId: string, files: string[], newNames: string[], type = 'testdata') {
        if (files.length !== newNames.length) throw new ValidationError('files', 'newNames');
        await Promise.all(files.map(async (file, index) => {
            const newName = newNames[index];
            if (type === 'testdata') await problem.renameTestdata(domainId, this.pdoc.docId, file, newName, this.user._id);
            else await problem.renameAdditionalFile(domainId, this.pdoc.docId, file, newName, this.user._id);
            if (file !== newName) await problem.setEditMetadata(domainId, this.pdoc.docId, this.user._id);
        }));
        this.back();
    }

    @post('files', Types.ArrayOf(Types.Filename))
    @post('type', Types.Range(['testdata', 'additional_file']), true)
    async postDeleteFiles(domainId: string, files: string[], type = 'testdata') {
        if (type === 'testdata') await problem.delTestdata(domainId, this.pdoc.docId, files, this.user._id);
        else await problem.delAdditionalFile(domainId, this.pdoc.docId, files, this.user._id);
        if (files.length) await problem.setEditMetadata(domainId, this.pdoc.docId, this.user._id);
        this.back();
    }

    @post('std', Types.Filename)
    @post('gen', Types.Filename)
    async postGenerateTestdata(domainId: string, std: string, gen: string) {
        if (!this.pdoc.data?.find((i) => i.name === std)) throw new BadRequestError();
        if (!this.pdoc.data?.find((i) => i.name === gen)) throw new BadRequestError();
        const rid = await record.add(domainId, this.pdoc.docId, this.user._id, '_', `${gen}\n${std}`, true, {
            type: 'generate',
            participationMode: submissionParticipationMode(this),
        });
        this.response.redirect = this.url('record_detail', { rid });
    }

    async postGetCopiedProblems() {
        const domainId = this.pdoc.domainId;
        const copies = await problem.getCopies(domainId, this.pdoc.docId);
        const list = [];
        let unauthorizedCount = 0;

        for (const copy of copies) {
            // A copied problem is visible only when the user could enter its domain
            // and view the problem through the normal target-domain permissions.
            // eslint-disable-next-line no-await-in-loop
            const targetUser = await user.getById(copy.domainId, this.user._id, this.user.scope);
            const canViewDomain = this.user.hasPriv(PRIV.PRIV_VIEW_ALL_DOMAIN)
                || !!targetUser?.hasPerm(PERM.PERM_VIEW);
            const canView = canViewDomain && !!targetUser && problem.canViewBy(copy, targetUser);
            if (!canView) {
                unauthorizedCount++;
                continue;
            }

            // eslint-disable-next-line no-await-in-loop
            const targetDomain = await domain.get(copy.domainId);
            const hasLocalModifications = problem.isModifiedLocally(copy, this.pdoc);

            list.push({
                domainId: copy.domainId,
                domainTitle: targetDomain ? (targetDomain.name || targetDomain._id) : copy.domainId,
                docId: copy.docId,
                pid: copy.pid || copy.docId,
                title: copy.title,
                hasModified: hasLocalModifications,
                updateAt: copy.updateAt || null,
                lastSyncAt: copy.reference?.lastSyncAt || null,
            });
        }

        this.response.body = {
            total: copies.length,
            copies: list,
            unauthorizedCount,
        };
    }

    async postSyncCopiedProblems() {
        const domainId = this.pdoc.domainId;
        const copies = await problem.getCopies(domainId, this.pdoc.docId);
        const synced = [];
        const conflicts = [];
        const upToDate = [];
        let unauthorizedCount = 0;
        const now = new Date();
        const force = !!this.args.force;
        const rawTargets = this.args.targets;
        const targets = Array.isArray(rawTargets)
            ? rawTargets.slice(0, 100).filter((t) => t && (typeof t === 'string' || (typeof t === 'object' && !Array.isArray(t))))
            : null;

        for (const copy of copies) {
            if (targets) {
                const isTargeted = targets.some((t) => {
                    if (!t) return false;
                    if (typeof t === 'string') {
                        return t === `${copy.domainId}/${copy.docId}`
                            || t === `${copy.domainId}/${copy.pid}`
                            || t === `${copy.domainId}#${copy.docId}`
                            || t === `${copy.domainId}#${copy.pid}`;
                    }
                    if (typeof t === 'object') {
                        const targetDomain = t.domainId;
                        const targetDocId = t.docId !== undefined ? String(t.docId) : undefined;
                        const targetPid = t.pid !== undefined ? String(t.pid) : undefined;
                        return targetDomain === copy.domainId && (
                            (targetDocId !== undefined && targetDocId === String(copy.docId))
                            || (targetPid !== undefined && targetPid === String(copy.pid))
                        );
                    }
                    return false;
                });
                if (!isTargeted) continue;
            }
            // Synchronization uses the same target-domain permissions as a normal edit.
            // eslint-disable-next-line no-await-in-loop
            const targetUser = await user.getById(copy.domainId, this.user._id, this.user.scope);
            const canViewDomain = this.user.hasPriv(PRIV.PRIV_VIEW_ALL_DOMAIN)
                || !!targetUser?.hasPerm(PERM.PERM_VIEW);
            const canView = canViewDomain && !!targetUser && problem.canViewBy(copy, targetUser);
            const canEdit = (this.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM) || canView)
                && (this.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM)
                    || (targetUser && (targetUser.own(copy, PERM.PERM_EDIT_PROBLEM_SELF)
                        || targetUser.hasPerm(PERM.PERM_EDIT_PROBLEM))));
            if (!canEdit) {
                unauthorizedCount++;
                continue;
            }

            // eslint-disable-next-line no-await-in-loop
            const targetDomain = await domain.get(copy.domainId);
            const domainTitle = targetDomain ? (targetDomain.name || targetDomain._id) : copy.domainId;
            const item = {
                domainId: copy.domainId,
                domainTitle,
                docId: copy.docId,
                pid: copy.pid || copy.docId,
                title: copy.title,
            };

            const isModified = problem.isModifiedLocally(copy, this.pdoc);
            if (isModified && !force) {
                conflicts.push({
                    ...item,
                    reason: '已在目标域被单独编辑修改',
                    updateAt: copy.updateAt,
                });
                continue;
            }

            const copyTags = (copy.tag || []).slice().sort();
            const sourceTags = (this.pdoc.tag || []).slice().sort();
            const isSame = (copy.title || '') === (this.pdoc.title || '')
                && (copy.content || '') === (this.pdoc.content || '')
                && (copy.difficulty || 0) === (this.pdoc.difficulty || 0)
                && JSON.stringify(copyTags) === JSON.stringify(sourceTags);

            const sourceUpdateAt = this.pdoc.updateAt
                ? new Date(this.pdoc.updateAt).getTime()
                : (typeof this.pdoc._id?.getTimestamp === 'function' ? this.pdoc._id.getTimestamp().getTime() : 0);
            const copyLastSyncAt = copy.reference?.lastSyncAt ? new Date(copy.reference.lastSyncAt).getTime() : 0;

            if (isSame && copyLastSyncAt && (!sourceUpdateAt || copyLastSyncAt >= sourceUpdateAt) && !force) {
                upToDate.push(item);
                continue;
            }

            const $update: Partial<ProblemDoc> = {
                title: this.pdoc.title,
                content: this.pdoc.content,
                tag: this.pdoc.tag || [],
                difficulty: this.pdoc.difficulty || 0,
                reference: {
                    ...copy.reference,
                    domainId,
                    pid: this.pdoc.docId,
                    sourceUpdateAt: this.pdoc.updateAt || now,
                    lastSyncAt: now,
                },
                editor: this.user._id,
                updateAt: now,
            };

            try {
                const condition: Filter<ProblemDoc> = {
                    _id: copy._id,
                    'reference.domainId': domainId,
                    'reference.pid': this.pdoc.docId,
                };
                if (!force) {
                    condition.title = copy.title;
                    condition.content = copy.content;
                    const matchSnapshot = (key: keyof ProblemDoc) => {
                        (condition as any)[key] = copy[key] !== undefined ? copy[key] : { $exists: false };
                    };
                    for (const key of [
                        'tag', 'difficulty', 'html', 'hidden', 'owner', 'maintainer', 'editor', 'updateAt',
                    ] as const) matchSnapshot(key);
                    for (const key of ['sourceUpdateAt', 'lastSyncAt'] as const) {
                        condition[`reference.${key}`] = copy.reference?.[key] !== undefined
                            ? copy.reference[key]
                            : { $exists: false };
                    }
                }
                // eslint-disable-next-line no-await-in-loop
                const result = await problem.editIfCondition(copy.domainId, copy.docId, condition, $update);
                if (!result) throw new Error('目标题目已被修改或删除');
                synced.push(item);
            } catch (err) {
                conflicts.push({
                    ...item,
                    reason: `同步失败: ${err.message || '未知错误'}`,
                });
            }
        }

        await oplog.log(this, 'problem.sync_copies', {
            domainId,
            pid: this.pdoc.docId,
            force,
            syncedCount: synced.length,
            conflictCount: conflicts.length,
            unauthorizedCount,
        });

        this.response.body = {
            total: copies.length,
            synced,
            conflicts,
            upToDate,
            unauthorizedCount,
            force,
        };
    }
}

export class ProblemFileDownloadHandler extends ProblemDetailHandler {
    @query('type', Types.Range(['additional_file', 'testdata']), true)
    @param('filename', Types.Filename)
    @param('noDisposition', Types.Boolean)
    @query('tid', Types.ObjectId, true)
    async get({ }, type = 'additional_file', filename: string, noDisposition = false, tid: ObjectId) {
        if (!tid) this.checkPerm(PERM.PERM_VIEW_PROBLEM);
        if (type === 'testdata' && this.pdoc.reference && !this.canReadProblemFiles) {
            throw new PermissionError(PERM.PERM_READ_PROBLEM_DATA);
        }
        if (type === 'testdata' && !this.canReadProblemFiles) {
            if (!this.user.hasPriv(PRIV.PRIV_READ_PROBLEM_DATA)) this.checkPerm(PERM.PERM_READ_PROBLEM_DATA);
        }
        if (type === 'testdata' && !this.problemFileUser?.own(this.problemFilePdoc)) {
            if (this.tdoc && !contest.isDone(this.tdoc)) throw new ContestNotEndedError(this.tdoc.domainId, this.tdoc.docId);
        }
        const target = `problem/${this.problemFileDomainId}/${this.problemFilePdoc.docId}/${type}/${filename}`;
        const file = await storage.getMeta(target);
        await oplog.log(this, 'download.problem.single', {
            target,
            size: file?.size || 0,
        });
        this.response.redirect = await storage.signDownloadLink(
            target, noDisposition ? undefined : filename, false, 'user',
        );
    }
}

export class ProblemSolutionHandler extends ProblemDetailHandler {
    @param('page', Types.PositiveInt, true)
    @param('tid', Types.ObjectId, true)
    @param('sid', Types.ObjectId, true)
    async get(domainId: string, page = 1, tid?: ObjectId, sid?: ObjectId) {
        this.response.template = 'problem_solution.html';
        const accepted = tid
            ? this.tsdoc?.detail?.[String(this.pdoc.docId)]?.status === STATUS.STATUS_ACCEPTED
            : this.psdoc?.status === STATUS.STATUS_ACCEPTED;
        if (!accepted || !this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_SOLUTION_ACCEPT)) {
            this.checkPerm(PERM.PERM_VIEW_PROBLEM_SOLUTION);
        }

        let [psdocs, pcount, pscount] = await this.paginate(
            solution.getMulti(domainId, this.pdoc.docId, { title: { $ne: REFERENCE_CODE_TITLE } }),
            page,
            'solution',
        );
        if (sid) {
            psdocs = [await solution.get(domainId, sid)];
            if (!psdocs[0]) throw new SolutionNotFoundError(domainId, sid);
        }
        const uids = [this.pdoc.owner];
        const docids = [];
        for (const psdoc of psdocs) {
            docids.push(psdoc.docId);
            uids.push(psdoc.owner);
            if (psdoc.reply.length) {
                for (const psrdoc of psdoc.reply) uids.push(psrdoc.owner);
            }
        }
        const udict = await user.getList(domainId, uids);
        const pssdict = await solution.getListStatus(domainId, docids, this.user._id);
        this.response.body = {
            psdocs, page, pcount, pscount, udict, pssdict, pdoc: this.pdoc, sid,
        };
    }

    @param('content', Types.Content)
    async postSubmit(domainId: string, content: string) {
        this.checkPerm(PERM.PERM_CREATE_PROBLEM_SOLUTION);
        const psid = await solution.add(domainId, this.pdoc.docId, this.user._id, content);
        this.back({ psid });
    }

    @param('content', Types.Content)
    @param('psid', Types.ObjectId)
    async postEditSolution(domainId: string, content: string, psid: ObjectId) {
        let psdoc = await solution.get(domainId, psid);
        if (!this.user.own(psdoc)) this.checkPerm(PERM.PERM_EDIT_PROBLEM_SOLUTION);
        else this.checkPerm(PERM.PERM_EDIT_PROBLEM_SOLUTION_SELF);
        psdoc = await solution.edit(domainId, psdoc.docId, content);
        this.back({ psdoc });
    }

    @param('psid', Types.ObjectId)
    async postDeleteSolution(domainId: string, psid: ObjectId) {
        const psdoc = await solution.get(domainId, psid);
        if (!this.user.own(psdoc)) this.checkPerm(PERM.PERM_DELETE_PROBLEM_SOLUTION);
        else this.checkPerm(PERM.PERM_DELETE_PROBLEM_SOLUTION_SELF);
        await solution.del(domainId, psdoc.docId);
        this.back();
    }

    @param('psid', Types.ObjectId)
    async postPinSolution(domainId: string, psid: ObjectId) {
        this.checkPerm(PERM.PERM_DELETE_PROBLEM_SOLUTION);
        const psdoc = await solution.get(domainId, psid);
        if (psdoc.parentId !== this.pdoc.docId) throw new SolutionNotFoundError(domainId, psid);
        await solution.pin(domainId, psdoc.docId);
        this.back();
    }

    @param('psid', Types.ObjectId)
    async postUnpinSolution(domainId: string, psid: ObjectId) {
        this.checkPerm(PERM.PERM_DELETE_PROBLEM_SOLUTION);
        const psdoc = await solution.get(domainId, psid);
        if (psdoc.parentId !== this.pdoc.docId) throw new SolutionNotFoundError(domainId, psid);
        await solution.unpin(domainId, psdoc.docId);
        this.back();
    }

    @param('psid', Types.ObjectId)
    @param('content', Types.Content)
    async postReply(domainId: string, psid: ObjectId, content: string) {
        this.checkPerm(PERM.PERM_REPLY_PROBLEM_SOLUTION);
        const psdoc = await solution.get(domainId, psid);
        await solution.reply(domainId, psdoc.docId, this.user._id, content);
        this.back();
    }

    @param('psid', Types.ObjectId)
    @param('psrid', Types.ObjectId)
    @param('content', Types.Content)
    async postEditReply(domainId: string, psid: ObjectId, psrid: ObjectId, content: string) {
        const [psdoc, psrdoc] = await solution.getReply(domainId, psid, psrid);
        if (!psdoc || psdoc.parentId !== this.pdoc.docId) throw new SolutionNotFoundError(domainId, psid);
        if (!this.user.own(psrdoc) || !this.user.hasPerm(PERM.PERM_EDIT_PROBLEM_SOLUTION_REPLY_SELF)) {
            throw new PermissionError(PERM.PERM_EDIT_PROBLEM_SOLUTION_REPLY_SELF);
        }
        await solution.editReply(domainId, psid, psrid, content);
        this.back();
    }

    @param('psid', Types.ObjectId)
    @param('psrid', Types.ObjectId)
    async postDeleteReply(domainId: string, psid: ObjectId, psrid: ObjectId) {
        const [psdoc, psrdoc] = await solution.getReply(domainId, psid, psrid);
        if (!psdoc || psdoc.parentId !== this.pdoc.docId) throw new SolutionNotFoundError(domainId, psid);
        if (!this.user.own(psrdoc) || !this.user.hasPerm(PERM.PERM_DELETE_PROBLEM_SOLUTION_REPLY_SELF)) {
            this.checkPerm(PERM.PERM_DELETE_PROBLEM_SOLUTION_REPLY);
        }
        await solution.delReply(domainId, psid, psrid);
        this.back();
    }

    @param('psid', Types.ObjectId)
    async postUpvote(domainId: string, psid: ObjectId) {
        this.checkPerm(PERM.PERM_VOTE_PROBLEM_SOLUTION);
        const psdoc = await solution.vote(domainId, psid, this.user._id, 1);
        this.back({ vote: psdoc.vote, user_vote: 1 });
    }

    @param('psid', Types.ObjectId)
    async postDownvote(domainId: string, psid: ObjectId) {
        this.checkPerm(PERM.PERM_VOTE_PROBLEM_SOLUTION);
        const psdoc = await solution.vote(domainId, psid, this.user._id, -1);
        this.back({ vote: psdoc.vote, user_vote: -1 });
    }
}

export class ProblemSolutionRawHandler extends ProblemDetailHandler {
    @param('psid', Types.ObjectId)
    @route('psrid', Types.ObjectId, true)
    @param('tid', Types.ObjectId, true)
    async get(domainId: string, psid: ObjectId, psrid?: ObjectId, tid?: ObjectId) {
        if (tid) throw new PermissionError(PERM.PERM_VIEW_PROBLEM_SOLUTION);
        const accepted = this.psdoc?.status === STATUS.STATUS_ACCEPTED;
        if (!accepted || !this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_SOLUTION_ACCEPT)) {
            this.checkPerm(PERM.PERM_VIEW_PROBLEM_SOLUTION);
        }
        if (psrid) {
            const [psdoc, psrdoc] = await solution.getReply(domainId, psid, psrid);
            if ((!psdoc) || psdoc.parentId !== this.pdoc.docId) throw new SolutionNotFoundError(psid, psrid);
            this.response.body = psrdoc.content;
        } else {
            const psdoc = await solution.get(domainId, psid);
            this.response.body = psdoc.content;
        }
        this.response.type = 'text/markdown';
    }
}

export class ProblemStatisticsHandler extends ProblemDetailHandler {
    @param('sort', Types.Range(Object.keys(record.STAT_QUERY)), true)
    @param('direction', Types.Range([-1, 1]), true)
    @param('lang', Types.String, true)
    @param('page', Types.PositiveInt, true)
    async get(domainId: string, sort = 'time', direction: 1 | -1 = 1, lang?: string, page = 1) {
        if (this.tdoc) throw new ContestNotEndedError();
        const tdocs = await contest.getMulti(domainId, { pids: this.pdoc.docId }).toArray();
        const visibleContestIds: ObjectId[] = [];
        const selfVisibleContestIds: ObjectId[] = [];
        for (const tdoc of tdocs) {
            if (contest.canShowRecord.call(this, tdoc)) visibleContestIds.push(tdoc.docId);
            else if (contest.canShowSelfRecord.call(this, tdoc)) selfVisibleContestIds.push(tdoc.docId);
        }
        const sourceFilter: any[] = [{ contest: { $exists: false } }];
        if (visibleContestIds.length) sourceFilter.push({ contest: { $in: visibleContestIds } });
        if (selfVisibleContestIds.length) {
            sourceFilter.push({ uid: this.user._id, contest: { $in: selfVisibleContestIds } });
        }
        const [rsdocs, pcount, rscount] = await record.listStat(
            domainId, {
                pid: this.pdoc.docId,
                ...lang ? { lang } : {},
                $or: sourceFilter,
            },
            record.STAT_QUERY[sort][Math.max(direction, 0)],
            page,
            this.ctx.setting.get('pagination.record') || 20,
            system.get('record.statMode') === 'unique',
        );
        const [udict, udoc] = await Promise.all([
            user.getListForRender(domainId, rsdocs.map((i) => i.uid), this.user.hasPerm(PERM.PERM_VIEW_USER_PRIVATE_INFO)),
            user.getById(domainId, this.pdoc.owner),
        ]);
        this.response.template = 'problem_statistics.html';
        this.response.body = {
            rsdocs, page, pcount, rscount, sort, direction, pdoc: this.pdoc, udict, types: Object.keys(record.STAT_QUERY), udoc,
        };
    }
}

export class ProblemCreateHandler extends Handler {
    async get() {
        this.response.body.statementLangs = this.ctx.i18n.langs(false);
        this.response.template = 'problem_edit.html';
        this.response.body = {
            page_name: 'problem_create',
            additional_file: [],
        };
    }

    @post('title', Types.Title)
    @post('content', Types.Content)
    @post('pid', Types.ProblemId, true, (i) => /^(?:[a-z0-9]{1,10}-)?[a-z][a-z0-9]*$/i.test(i))
    @post('hidden', Types.Boolean)
    @post('difficulty', Types.PositiveInt, (i) => +i <= 10, true)
    @post('tag', Types.Content, true, null, parseCategory)
    async post(
        domainId: string, title: string, content: string, pid: string | number = '',
        hidden = false, difficulty = 0, tag: string[] = [],
    ) {
        if (typeof pid !== 'string') pid = `P${pid}`;
        if (pid && await problem.get(domainId, pid)) throw new ProblemAlreadyExistError(pid);
        const docId = await problem.add(domainId, pid, title, content, this.user._id, tag ?? [], { hidden, difficulty });
        const files = new Set(Array.from(content.matchAll(/file:\/\/([\w-]+\.[a-zA-Z0-9]+)/g)).map((i) => i[1]));
        const tasks = [];
        for (const file of files) {
            if (this.user._files.find((i) => i.name === file)) {
                tasks.push(
                    storage.rename(`user/${this.user._id}/${file}`, `problem/${domainId}/${docId}/additional_file/${file}`, this.user._id)
                        .then(() => problem.addAdditionalFile(domainId, docId, file, '', this.user._id, true)),
                    user.setById(this.user._id, { _files: this.user._files.filter((i) => i.name !== file) }),
                );
            }
        }
        await Promise.all(tasks);
        this.response.body = { pid: pid || docId };
        this.response.redirect = this.url('problem_files', { pid: pid || docId });
    }
}

export const ProblemApi = {
    problem: Query(
        Schema.object({
            id: Schema.union([Schema.number().step(1), Schema.string()]).required(),
            domainId: Schema.string().required(),
        }),
        async (ctx, args) => {
            const pdoc = await problem.get(args.domainId, args.id);
            if (!pdoc) return null;
            if (pdoc.hidden) ctx.checkPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN);
            if (pdoc.reference) {
                const source = await getProblemFileSource(pdoc, ctx.user);
                pdoc.data = source?.canRead ? source.pdoc.data : [];
                pdoc.additional_file = source?.pdoc.additional_file || [];
            }
            return pdoc;
        },
    ),
    problems: Query(
        Schema.object({
            ids: Schema.array(Schema.number().step(1)).required(),
            domainId: Schema.string().required(),
        }),
        async (ctx, args) => {
            const pdocs = await problem.getList(args.domainId, args.ids, ctx.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN) || ctx.user._id,
                undefined, undefined, true);
            return args.ids.map((id) => pdocs[+id]).filter((i) => i);
        },
    ),
} as const;

declare module '@hydrooj/framework' {
    interface Apis {
        problem: typeof ProblemApi;
    }
}

export async function apply(ctx: Context) {
    ctx.Route('problem_main', '/p', ProblemMainHandler, PERM.PERM_VIEW_PROBLEM);
    ctx.Route('problem_random', '/problem/random', ProblemRandomHandler, PERM.PERM_VIEW_PROBLEM);
    ctx.Route('problem_detail', '/p/:pid', ProblemDetailHandler);
    ctx.Route('problem_submit', '/p/:pid/submit', ProblemSubmitHandler, PERM.PERM_SUBMIT_PROBLEM);
    ctx.Route('problem_hack', '/p/:pid/hack/:rid', ProblemHackHandler, PERM.PERM_SUBMIT_PROBLEM);
    ctx.Route('problem_edit', '/p/:pid/edit', ProblemEditHandler);
    ctx.Route('problem_config', '/p/:pid/config', ProblemConfigHandler);
    ctx.Route('problem_files', '/p/:pid/files', ProblemFilesHandler, PERM.PERM_VIEW_PROBLEM);
    ctx.Route('problem_file_download', '/p/:pid/file/:filename', ProblemFileDownloadHandler);
    ctx.Route('problem_solution', '/p/:pid/solution', ProblemSolutionHandler, PERM.PERM_VIEW_PROBLEM);
    ctx.Route('problem_solution_detail', '/p/:pid/solution/:sid', ProblemSolutionHandler, PERM.PERM_VIEW_PROBLEM);
    ctx.Route('problem_solution_raw', '/p/:pid/solution/:psid/raw', ProblemSolutionRawHandler, PERM.PERM_VIEW_PROBLEM);
    ctx.Route('problem_solution_reply_raw', '/p/:pid/solution/:psid/:psrid/raw', ProblemSolutionRawHandler, PERM.PERM_VIEW_PROBLEM);
    ctx.Route('problem_statistics', '/p/:pid/stat', ProblemStatisticsHandler, PERM.PERM_VIEW_PROBLEM);
    ctx.Route('problem_create', '/problem/create', ProblemCreateHandler, PERM.PERM_CREATE_PROBLEM);
    await ctx.inject(['api'], ({ api }) => {
        api.provide(ProblemApi);
    });
}
