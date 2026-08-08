import { ObjectId } from 'mongodb';
import type { Context } from '../context';
import {
    ForbiddenError, ProblemConfigError, ProblemNotAllowLanguageError, ProblemNotFoundError, ValidationError,
} from '../error';
import type { ProblemDoc, Tdoc } from '../interface';
import { STATUS } from '../model/builtin';
import * as contest from '../model/contest';
import problem from '../model/problem';
import record from '../model/record';
import * as setting from '../model/setting';
import system from '../model/system';
import { Handler } from '../service/server';

const AI_EDU_DOMAIN_ID = 'aiedu';
const AI_EDU_TOKEN_SETTING = 'aiedu.internalSubmitToken';

function firstHeaderValue(value: string | string[] | undefined) {
    return Array.isArray(value) ? value[0] : value;
}

function normalizeString(value: unknown) {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizePositiveInteger(value: unknown, field: string) {
    const n = typeof value === 'number' ? value : Number.parseInt(`${value ?? ''}`, 10);
    if (!Number.isSafeInteger(n) || n <= 0) throw new ValidationError(field);
    return n;
}

async function getEffectiveProblem(domainId: string, pid: number): Promise<{ pdoc: ProblemDoc, sourcePdoc: ProblemDoc }> {
    const pdoc = await problem.get(domainId, pid);
    if (!pdoc) throw new ProblemNotFoundError(domainId, pid);
    if (!pdoc.reference) return { pdoc, sourcePdoc: pdoc };
    const sourcePdoc = await problem.get(pdoc.reference.domainId, pdoc.reference.pid);
    if (!sourcePdoc) throw new ProblemNotFoundError(pdoc.reference.domainId, pdoc.reference.pid);
    return { pdoc, sourcePdoc };
}

function validateLanguage(pdoc: ProblemDoc, lang: string) {
    const config = pdoc.config;
    if (typeof config === 'string' || config === null) throw new ProblemConfigError();
    if (['submit_answer', 'objective'].includes(config.type)) return '_';
    if ((config.langs && !config.langs.includes(lang)) || !setting.langs[lang] || setting.langs[lang].disabled) {
        throw new ProblemNotAllowLanguageError();
    }
    return lang;
}

async function ensureContestIncludesProblem(domainId: string, tid: ObjectId, tdoc: Tdoc, pid: number) {
    if (tdoc.pids?.includes(pid)) return tdoc;
    return await contest.edit(domainId, tid, { pids: [...(tdoc.pids || []), pid] });
}

class AiEduInternalSubmitHandler extends Handler {
    noCheckPermView = true;

    async post(args: any) {
        const routeDomainId = this.domain?._id || this.context?.domainId;
        const bodyDomainId = normalizeString(this.request.body?.domainId || args.domainId);
        if (routeDomainId !== AI_EDU_DOMAIN_ID || bodyDomainId !== AI_EDU_DOMAIN_ID) throw new ForbiddenError('Invalid domain');

        const secret = normalizeString(system.get(AI_EDU_TOKEN_SETTING));
        const token = normalizeString(firstHeaderValue(this.request.headers['x-ai-edu-token']));
        if (!secret || !token || token !== secret) throw new ForbiddenError('Invalid token');

        const pid = normalizePositiveInteger(this.request.body?.pid, 'pid');
        const uid = normalizePositiveInteger(this.request.body?.uid, 'uid');
        const tidText = normalizeString(this.request.body?.tid);
        if (!ObjectId.isValid(tidText)) throw new ValidationError('tid');
        const tid = new ObjectId(tidText);

        const code = typeof this.request.body?.code === 'string' ? this.request.body.code.replace(/\r\n/g, '\n') : '';
        if (!code) throw new ValidationError('code');
        const lengthLimit = system.get('limit.codelength') || 128 * 1024;
        if (code.length > lengthLimit) throw new ValidationError('code');

        const lang = normalizeString(this.request.body?.lang);
        if (!lang) throw new ValidationError('lang');

        const { pdoc, sourcePdoc } = await getEffectiveProblem(AI_EDU_DOMAIN_ID, pid);
        const submitLang = validateLanguage(sourcePdoc, lang);
        await ensureContestIncludesProblem(
            AI_EDU_DOMAIN_ID,
            tid,
            await contest.get(AI_EDU_DOMAIN_ID, tid),
            pdoc.docId,
        );

        const rid = await record.add(AI_EDU_DOMAIN_ID, pdoc.docId, uid, submitLang, code, true, {
            contest: tid,
            files: {},
            type: 'judge',
        });
        await contest.updateStatus(AI_EDU_DOMAIN_ID, tid, uid, rid, pdoc.docId, {
            status: STATUS.STATUS_WAITING,
            score: 0,
            lang: submitLang,
        });
        this.response.body = { rid: rid.toHexString() };
    }
}

export async function apply(ctx: Context) {
    ctx.Route('aiedu_internal_submit', '/internal/submit', AiEduInternalSubmitHandler);
}
