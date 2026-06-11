import { randomUUID } from 'crypto';
import {
    ContestModel, Context, DocumentModel, ForbiddenError, Handler,
    Logger, ObjectId, PERM, PRIV, ProblemModel, RecordModel, Schema, SettingModel, STATUS, TrainingModel, Types,
    db, moment, param,
} from 'hydrooj';
import type { Tdoc, TrainingDoc } from 'hydrooj';

export const name = 'ai-assistant';

const logger = new Logger('ai-assistant');
const DEFAULT_STUDENT_DAILY_QUOTA = 10;
const DEFAULT_TEACHER_DAILY_QUOTA = 1000;
const DEFAULT_COURSE_LESSON_DURATION_HOURS = 3;
const PROVIDER_TYPES = ['anthropic', 'openai-responses', 'openai-chat'] as const;
const CONTEXT_TYPES = ['problem', 'homework', 'contest', 'course', 'training'] as const;
const STUDENT_QUESTION_TYPES = {
    COMPILE_ERROR_EXPLANATION: '请解释这段编译错误，并指出怎么修改。',
    CODE_HINT: '请根据我的代码给一个提示，不要直接给完整答案。',
    THINKING_GUIDANCE: '这道题我没有思路，请给我一些解题方向？',
};
const SYSTEM_PROMPT = `你是一位信息学编程教师，正在为学生提供分层提示。
回答必须围绕当前题目、代码、编译错误或解题思路。
如果提问者是学生，不要直接给出完整可提交代码；优先提示观察方法、关键概念、下一步调试动作。
如果上下文不足，明确说明缺少什么信息。`;
const DEFAULT_PROVIDERS = JSON.stringify([
    {
        name: 'anthropic',
        type: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        apiKeyEnv: 'ANTHROPIC_API_KEY',
        model: 'claude-3-5-sonnet-latest',
        maxTokens: 2000,
    },
    {
        name: 'openai-responses',
        type: 'openai-responses',
        baseUrl: 'https://api.openai.com/v1',
        apiKeyEnv: 'OPENAI_API_KEY',
        model: 'gpt-4.1-mini',
        maxTokens: 2000,
    },
    {
        name: 'openai-chat',
        type: 'openai-chat',
        baseUrl: 'https://api.openai.com/v1',
        apiKeyEnv: 'OPENAI_API_KEY',
        model: 'gpt-4.1-mini',
        maxTokens: 2000,
    },
], null, 2);

type ProviderType = typeof PROVIDER_TYPES[number];
type ContextType = typeof CONTEXT_TYPES[number];

interface AiProviderConfig {
    name?: string;
    type: ProviderType;
    baseUrl?: string;
    apiKey?: string;
    apiKeyEnv?: string;
    model: string;
    maxTokens?: number;
    temperature?: number;
    reasoningEffort?: string;
    anthropicVersion?: string;
}

interface RuntimeConfig {
    providers: AiProviderConfig[];
    providerApiKeys: Record<string, string>;
    studentDailyQuota: number;
    teacherDailyQuota: number;
    retryTimes: number;
    timeoutMs: number;
}

interface AiContextConfig {
    enabled?: boolean;
    allowDuringLesson?: boolean;
    allowedWindows?: TimeWindow[];
    blockedWindows?: TimeWindow[];
}

interface TimeWindow {
    start?: string | Date;
    end?: string | Date;
}

interface AskRequest {
    contextType?: ContextType;
    contextId?: string;
    pid?: number;
    problemId?: string | number;
    questionType?: string;
    question?: string;
    userQuestion?: string;
    code?: string;
    currentCode?: string;
    language?: string;
    compilerMessages?: string[] | string;
    conversationId?: string;
    quotaCost?: number;
    targetStudentId?: string;
}

interface LoadedContext {
    contextType?: ContextType;
    doc?: any;
    problem?: any;
    allowed: boolean;
    reason?: string;
}

interface AiRecordData {
    rid: ObjectId;
    initialCode: string;
    lang: string;
}

let runtimeConfig: RuntimeConfig = {
    providers: [],
    providerApiKeys: {},
    studentDailyQuota: DEFAULT_STUDENT_DAILY_QUOTA,
    teacherDailyQuota: DEFAULT_TEACHER_DAILY_QUOTA,
    retryTimes: 2,
    timeoutMs: 120000,
};

const tutoringColl = db.collection<any>('ai_tutoring_sessions' as any);
const quotaResetColl = db.collection<any>('ai_quota_resets' as any);

function normalizeBaseUrl(url = '') {
    return (url || '').replace(/\/+$/, '');
}

function parseProviders(raw: string): AiProviderConfig[] {
    if (!raw?.trim()) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('providers must be a JSON array');
    return parsed
        .filter((item) => item && PROVIDER_TYPES.includes(item.type))
        .map((item) => ({
            ...item,
            name: item.name || `${item.type}:${item.model}`,
            baseUrl: item.baseUrl || (item.type === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1'),
            maxTokens: item.maxTokens || 2000,
        }));
}

function looksLikeEnvName(value: string) {
    return /^[A-Z_][A-Z0-9_]*$/.test(value);
}

function providerApiKey(provider: AiProviderConfig) {
    if (provider.apiKey) return provider.apiKey;
    if (runtimeConfig.providerApiKeys[provider.name || '']) return runtimeConfig.providerApiKeys[provider.name || ''];
    if (runtimeConfig.providerApiKeys[provider.type]) return runtimeConfig.providerApiKeys[provider.type];
    if (!provider.apiKeyEnv) return '';
    const envValue = process.env[provider.apiKeyEnv];
    if (envValue) return envValue;
    return looksLikeEnvName(provider.apiKeyEnv) ? '' : provider.apiKeyEnv;
}

function isTeacher(handler: Handler) {
    return handler.user.hasPerm(PERM.PERM_EDIT_DOMAIN)
        || handler.user.hasPerm(PERM.PERM_EDIT_PROBLEM)
        || handler.user.hasPerm(PERM.PERM_EDIT_HOMEWORK)
        || handler.user.hasPerm(PERM.PERM_EDIT_TRAINING)
        || handler.user.hasPerm(PERM.PERM_EDIT_CONTEST);
}

function truthySetting(value: any) {
    return value === true || value === 1
        || value === 'true' || value === '1'
        || value === 'on' || value === 'yes';
}

function getDomainAiConfig(domain: any) {
    return {
        enabled: truthySetting(domain?.aieduAiEnabled),
        studentDailyQuota: Math.max(Number(runtimeConfig.studentDailyQuota ?? DEFAULT_STUDENT_DAILY_QUOTA), 0),
        teacherDailyQuota: Math.max(Number(runtimeConfig.teacherDailyQuota ?? DEFAULT_TEACHER_DAILY_QUOTA), 0),
    };
}

function dayWindow(timeZone: string) {
    const now = moment.tz(timeZone || 'Asia/Shanghai');
    const start = now.clone().startOf('day');
    return {
        resetDate: start.format('YYYY-MM-DD'),
        startAt: start.toDate(),
        endAt: start.clone().add(1, 'day').toDate(),
    };
}

async function getQuota(handler: Handler) {
    const domainConfig = getDomainAiConfig(handler.domain);
    const role = isTeacher(handler) ? 'TEACHER' : 'STUDENT';
    const totalQuota = role === 'TEACHER' ? domainConfig.teacherDailyQuota : domainConfig.studentDailyQuota;
    const userId = String(handler.user._id);
    const window = dayWindow(handler.user.timeZone);
    const latestReset = await quotaResetColl.find({ userId, resetDate: window.resetDate })
        .sort({ resetAt: -1, createdAt: -1 })
        .limit(1)
        .next();
    const resetAt = latestReset?.resetAt instanceof Date ? latestReset.resetAt : null;
    const usageStart = resetAt && resetAt > window.startAt ? resetAt : window.startAt;
    const usedQuota = await tutoringColl.countDocuments({
        userId,
        createdAt: { $gte: usageStart, $lt: window.endAt },
    });
    return {
        role,
        usedQuota,
        totalQuota,
        remainingQuota: Math.max(totalQuota - usedQuota, 0),
    };
}

function parseTime(value: string | Date | undefined) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function isInWindow(now: Date, window: TimeWindow) {
    const start = parseTime(window.start);
    const end = parseTime(window.end);
    return (!start || start <= now) && (!end || now <= end);
}

function checkWindowConfig(config: AiContextConfig | undefined, defaultAllowed: boolean) {
    if (config?.enabled === false) return { allowed: false, reason: '当前场景已关闭 AI 功能。' };
    const now = new Date();
    if (config?.blockedWindows?.some((window) => isInWindow(now, window))) {
        return { allowed: false, reason: '当前时间段不允许使用 AI。' };
    }
    if (config?.allowedWindows?.length && !config.allowedWindows.some((window) => isInWindow(now, window))) {
        return { allowed: false, reason: '当前不在允许使用 AI 的时间段内。' };
    }
    return { allowed: defaultAllowed, reason: defaultAllowed ? '' : '当前场景不允许使用 AI。' };
}

function isWithinCourseLesson(tdoc: Tdoc) {
    const beginAt = parseTime((tdoc as any).lessonBeginAt) || parseTime(tdoc.beginAt);
    const explicitEndAt = parseTime((tdoc as any).lessonEndAt);
    const lessonDurationHours = Number((tdoc as any).lessonDurationHours || DEFAULT_COURSE_LESSON_DURATION_HOURS);
    const endAt = explicitEndAt || (beginAt ? new Date(beginAt.getTime() + lessonDurationHours * 3600 * 1000) : null);
    if (!beginAt || !endAt) return false;
    return beginAt <= new Date() && new Date() <= endAt;
}

async function loadContext(handler: Handler, request: AskRequest): Promise<LoadedContext> {
    const contextType = request.contextType;
    const contextId = request.contextId;
    const pid = Number(request.pid || request.problemId || 0) || undefined;
    const context: LoadedContext = { contextType, allowed: true };
    if (pid) context.problem = await ProblemModel.get(handler.args.domainId, pid);
    if (!contextType || contextType === 'problem') return context;

    if (!contextId) return { ...context, allowed: false, reason: '缺少场景 ID。' };

    if (contextType === 'training') {
        const tdoc = await TrainingModel.get(handler.args.domainId, new ObjectId(contextId)) as TrainingDoc;
        const windowCheck = checkWindowConfig((tdoc as any).ai, true);
        return { ...context, doc: tdoc, allowed: windowCheck.allowed, reason: windowCheck.reason };
    }

    const tdoc = await ContestModel.get(handler.args.domainId, new ObjectId(contextId)) as Tdoc;
    if (!tdoc || tdoc.rule !== contextType) return { ...context, allowed: false, reason: '场景不存在或类型不匹配。' };
    const aiConfig = (tdoc as any).ai as AiContextConfig | undefined;
    if (contextType === 'contest') {
        const tsdoc = await ContestModel.getStatus(handler.args.domainId, tdoc.docId, handler.user._id);
        if (ContestModel.isOngoing(tdoc, tsdoc)) {
            return { ...context, doc: tdoc, allowed: false, reason: '比赛进行中不允许使用 AI。' };
        }
    }
    if (contextType === 'course' && isWithinCourseLesson(tdoc) && aiConfig?.allowDuringLesson !== true) {
        return { ...context, doc: tdoc, allowed: false, reason: '课程上课期间默认不允许使用 AI。' };
    }
    const windowCheck = checkWindowConfig(aiConfig, true);
    return { ...context, doc: tdoc, allowed: windowCheck.allowed, reason: windowCheck.reason };
}

function normalizeStudentQuestion(questionType: string, question = '') {
    const defaultQuestion = STUDENT_QUESTION_TYPES[questionType];
    if (!defaultQuestion) throw new ForbiddenError('学生只能使用默认 AI 提问场景。');
    if (question && question.trim() !== defaultQuestion) throw new ForbiddenError('学生不能自由输入 AI 问题。');
    return defaultQuestion;
}

function requestPid(request: AskRequest) {
    return Number(request.pid || request.problemId || 0) || 0;
}

function resolveRecordLang(language = '') {
    const langs = SettingModel.langs || {};
    const raw = String(language || '').trim();
    if (raw && langs[raw]) return raw;
    const lower = raw.toLowerCase();
    if (lower && langs[lower]) return lower;
    const aliases: Record<string, string[]> = {
        c: ['cc.c', 'c'],
        cc: ['cc.cc11', 'cc.cc17', 'cc'],
        'c++': ['cc.cc11', 'cc.cc17', 'cc'],
        cpp: ['cc.cc11', 'cc.cc17', 'cc'],
        cxx: ['cc.cc11', 'cc.cc17', 'cc'],
        java: ['java.java11', 'java'],
        js: ['nodejs', 'javascript', 'js'],
        javascript: ['nodejs', 'javascript', 'js'],
        ts: ['typescript', 'ts'],
        typescript: ['typescript', 'ts'],
        py: ['py.py3', 'python3', 'python', 'py'],
        python: ['py.py3', 'python3', 'python', 'py'],
        python3: ['py.py3', 'python3', 'python', 'py'],
        pas: ['pas', 'pascal'],
        pascal: ['pas', 'pascal'],
        sql: ['sql'],
        sh: ['sh', 'bash'],
        shell: ['sh', 'bash'],
        bash: ['sh', 'bash'],
    };
    for (const candidate of aliases[lower] || []) {
        if (langs[candidate]) return candidate;
    }
    if (langs['cc.cc11']) return 'cc.cc11';
    return Object.keys(langs)[0] || 'cc.cc11';
}

function commentPrefixForLang(lang: string) {
    const key = lang.toLowerCase();
    if (/(^|\.)(py|python|sh|bash|rb|ruby|pl|perl|r|racket|yaml|yml)(\.|$)/.test(key)) return '#';
    if (/(^|\.)(sql|lua|hs|haskell)(\.|$)/.test(key)) return '--';
    if (/(^|\.)(pas|pascal)(\.|$)/.test(key)) return '{}';
    return '//';
}

function commentLines(lang: string, text: string) {
    const prefix = commentPrefixForLang(lang);
    const lines = String(text || '').split(/\r?\n/);
    if (prefix === '{}') return lines.map((line) => `{ ${line} }`).join('\n');
    return lines.map((line) => `${prefix} ${line}`).join('\n');
}

function buildInitialRecordCode(request: AskRequest, context: LoadedContext, question: string, lang: string) {
    const pid = requestPid(request);
    const rawCode = request.code || request.currentCode || '';
    const header = [
        'AI 问答记录',
        `问题类型：${request.questionType || 'CUSTOM'}`,
        `提问：${question}`,
        `场景：${context.contextType || 'problem'}`,
        `题目 ID：${pid}`,
    ].join('\n');
    return [
        commentLines(lang, header),
        rawCode || commentLines(lang, '未提供源代码。'),
    ].join('\n\n');
}

function buildAnnotatedRecordCode(request: AskRequest, initialCode: string, answer: string, lang: string) {
    const rawCode = request.code || request.currentCode || '';
    if (!rawCode || request.questionType === 'THINKING_GUIDANCE') return initialCode;
    return [
        initialCode,
        commentLines(lang, ['AI 注释答复', answer].join('\n')),
    ].join('\n\n');
}

function buildPrompt(request: AskRequest, context: LoadedContext, teacher: boolean) {
    const questionType = request.questionType || 'CUSTOM';
    const question = teacher
        ? (request.question || request.userQuestion || '').trim()
        : normalizeStudentQuestion(questionType, request.question || request.userQuestion || '');
    if (!question) throw new Error('请输入问题。');
    const compilerMessages = Array.isArray(request.compilerMessages)
        ? request.compilerMessages.join('\n')
        : request.compilerMessages || '';
    const code = request.code || request.currentCode || '';
    const parts = [
        `用户角色：${teacher ? '教师' : '学生'}`,
        `问题类型：${questionType}`,
        `提问：${question}`,
    ];
    if (context.contextType) parts.push(`场景：${context.contextType}`);
    if (context.doc?.title) parts.push(`场景标题：${context.doc.title}`);
    if (context.problem) {
        parts.push(`题目：${context.problem.title || context.problem.pid || context.problem.docId}`);
        parts.push(`题面：\n${String(context.problem.content || '').slice(0, 12000)}`);
    }
    if (code) parts.push(`当前代码（${request.language || 'unknown'}）：\n\`\`\`\n${code.slice(0, 20000)}\n\`\`\``);
    if (compilerMessages) parts.push(`编译/运行信息：\n${compilerMessages.slice(0, 8000)}`);
    return parts.join('\n\n');
}

async function requestJson(provider: AiProviderConfig, path: string, payload: any, headers: Record<string, string>) {
    const apiKey = providerApiKey(provider);
    if (!apiKey) throw new Error(`Provider ${provider.name} is missing apiKey/apiKeyEnv`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), runtimeConfig.timeoutMs);
    try {
        const response = await fetch(`${normalizeBaseUrl(provider.baseUrl)}${path}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
        const text = await response.text();
        const data = text ? JSON.parse(text) : {};
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 1000)}`);
        return data;
    } finally {
        clearTimeout(timer);
    }
}

function textFromResponses(data: any) {
    if (typeof data.output_text === 'string') return data.output_text.trim();
    const parts: string[] = [];
    for (const item of data.output || []) {
        for (const content of item.content || []) {
            if (typeof content.text === 'string') parts.push(content.text);
        }
    }
    return parts.join('\n').trim();
}

function textFromChat(data: any) {
    const content = data.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) return content.map((item) => item.text || '').join('\n').trim();
    return '';
}

function textFromAnthropic(data: any) {
    return (data.content || []).map((item) => item?.text || '').join('\n').trim();
}

async function callProvider(provider: AiProviderConfig, prompt: string) {
    const apiKey = providerApiKey(provider);
    const maxTokens = provider.maxTokens || 2000;
    if (provider.type === 'anthropic') {
        const data = await requestJson(provider, '/messages', {
            model: provider.model,
            max_tokens: maxTokens,
            temperature: provider.temperature,
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: prompt }],
        }, {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': provider.anthropicVersion || '2023-06-01',
        });
        const text = textFromAnthropic(data);
        if (!text) throw new Error('LLM 响应中没有可用文本。');
        return text;
    }
    if (provider.type === 'openai-responses') {
        const payload: any = {
            model: provider.model,
            input: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: prompt },
            ],
            max_output_tokens: maxTokens,
        };
        if (provider.temperature !== undefined) payload.temperature = provider.temperature;
        if (provider.reasoningEffort) payload.reasoning = { effort: provider.reasoningEffort };
        const data = await requestJson(provider, '/responses', payload, {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        });
        const text = textFromResponses(data);
        if (!text) throw new Error('LLM 响应中没有可用文本。');
        return text;
    }
    const payload: any = {
        model: provider.model,
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt },
        ],
        max_completion_tokens: maxTokens,
    };
    if (provider.temperature !== undefined) payload.temperature = provider.temperature;
    if (provider.reasoningEffort) payload.reasoning_effort = provider.reasoningEffort;
    const data = await requestJson(provider, '/chat/completions', payload, {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
    });
    const text = textFromChat(data);
    if (!text) throw new Error('LLM 响应中没有可用文本。');
    return text;
}

async function callLLM(prompt: string) {
    if (!runtimeConfig.providers.length) throw new Error('未配置可用 LLM provider。');
    const errors: string[] = [];
    for (let retry = 0; retry <= runtimeConfig.retryTimes; retry++) {
        for (const provider of runtimeConfig.providers) {
            try {
                const text = await callProvider(provider, prompt);
                return { text, provider: provider.name || provider.type, retry };
            } catch (err: any) {
                const message = err?.message || String(err);
                errors.push(`${provider.name || provider.type}[${retry}]: ${message}`);
                logger.warn(`LLM provider ${provider.name || provider.type} failed on retry ${retry}: ${message}`);
            }
        }
    }
    throw new Error(errors.join('\n'));
}

async function saveTutoringSession(handler: Handler, request: AskRequest, context: LoadedContext, question: string, answer: string, provider: string, recordId?: ObjectId) {
    const conversationId = request.conversationId || randomUUID();
    const turnIndex = await tutoringColl.countDocuments({ conversationId }) + 1;
    const doc = {
        username: handler.user.uname || String(handler.user._id),
        userId: String(handler.user._id),
        problemId: String(request.pid || request.problemId || ''),
        homeworkId: context.contextType === 'homework' ? String(request.contextId || '') : '',
        submissionId: String((request as any).submissionId || ''),
        domainId: handler.args.domainId,
        conversationId,
        turnIndex,
        conversationScopeKey: [
            handler.args.domainId,
            context.contextType || 'problem',
            request.contextId || '',
            request.pid || request.problemId || '',
        ].join(':'),
        problemTitleSnapshot: context.problem?.title || '',
        targetStudentId: request.targetStudentId || '',
        questionType: request.questionType || 'CUSTOM',
        userQuestion: question,
        aiResponseJson: JSON.stringify({ content: answer, provider }),
        requestPayloadJson: JSON.stringify({
            ...request,
            code: request.code ? `[${request.code.length} chars]` : undefined,
            currentCode: request.currentCode ? `[${request.currentCode.length} chars]` : undefined,
        }),
        hydroContextJson: JSON.stringify({
            contextType: context.contextType,
            contextId: request.contextId,
            problemId: request.pid || request.problemId,
        }),
        preAcQuestionIndex: null,
        recordId: recordId?.toHexString() || '',
        createdAt: new Date(),
        feedbackRating: null,
        feedbackComment: '',
        status: 'COMPLETED',
    };
    await tutoringColl.insertOne(doc);
    return { conversationId, turnIndex };
}

async function createAiRecord(handler: Handler, request: AskRequest, context: LoadedContext, question: string): Promise<AiRecordData> {
    const pid = requestPid(request);
    const lang = resolveRecordLang(request.language);
    const initialCode = buildInitialRecordCode(request, context, question, lang);
    const rid = await RecordModel.add(handler.args.domainId, pid, handler.user._id, lang, initialCode, false, { type: 'judge' });
    return { rid, initialCode, lang };
}

async function updateAiRecord(handler: Handler, recordData: AiRecordData, status: STATUS, code: string, message: string) {
    const rdoc = await RecordModel.update(handler.args.domainId, recordData.rid, {
        status,
        score: 0,
        time: 0,
        memory: 0,
        judgeAt: new Date(),
        judger: null,
        compilerTexts: [message],
        judgeTexts: [],
        testCases: [],
        code,
    } as any, undefined, { progress: '' } as any);
    if (rdoc) handler.ctx.broadcast('record/change', rdoc);
}

function sanitizeContextConfig(input: any): AiContextConfig {
    const raw = typeof input === 'string' ? JSON.parse(input) : input || {};
    const config: AiContextConfig = {};
    if (typeof raw.enabled === 'boolean') config.enabled = raw.enabled;
    if (typeof raw.allowDuringLesson === 'boolean') config.allowDuringLesson = raw.allowDuringLesson;
    if (Array.isArray(raw.allowedWindows)) config.allowedWindows = raw.allowedWindows.map((w) => ({ start: w.start, end: w.end }));
    if (Array.isArray(raw.blockedWindows)) config.blockedWindows = raw.blockedWindows.map((w) => ({ start: w.start, end: w.end }));
    return config;
}

class AiAssistantStatusHandler extends Handler {
    @param('contextType', Types.String, true)
    @param('contextId', Types.String, true)
    @param('pid', Types.UnsignedInt, true)
    async get(_domainId: string, contextType?: ContextType, contextId?: string, pid?: number) {
        const domainConfig = getDomainAiConfig(this.domain);
        const quota = await getQuota(this);
        const context = await loadContext(this, { contextType, contextId, pid });
        this.response.body = {
            ok: true,
            enabled: domainConfig.enabled,
            allowed: domainConfig.enabled && context.allowed,
            reason: domainConfig.enabled ? context.reason : '当前域未开启 AI 功能。',
            quota,
            studentQuestionTypes: STUDENT_QUESTION_TYPES,
            teacher: isTeacher(this),
        };
    }
}

class AiAssistantAskHandler extends Handler {
    async post() {
        let recordData: AiRecordData | null = null;
        try {
            const domainConfig = getDomainAiConfig(this.domain);
            if (!domainConfig.enabled) throw new ForbiddenError('当前域未开启 AI 功能。');
            const request = (this.request.body || {}) as AskRequest;
            const teacher = isTeacher(this);
            const quota = await getQuota(this);
            const quotaCost = Math.max(Number(request.quotaCost || 1), 1);
            if (quota.remainingQuota < quotaCost) throw new ForbiddenError(`今日 AI 问答次数不足，剩余 ${quota.remainingQuota} 次。`);
            const pid = requestPid(request);
            if (!pid) throw new ForbiddenError('AI 提问必须绑定题目。');

            const context = await loadContext(this, request);
            if (!context.problem) throw new ForbiddenError('题目不存在或不可访问。');
            if (!context.allowed) throw new ForbiddenError(context.reason || '当前场景不允许使用 AI。');
            const question = teacher
                ? (request.question || request.userQuestion || '')
                : normalizeStudentQuestion(request.questionType || '', request.question || request.userQuestion || '');
            const prompt = buildPrompt(request, context, teacher);
            recordData = await createAiRecord(this, request, context, question);
            const result = await callLLM(prompt);
            const annotatedCode = buildAnnotatedRecordCode(request, recordData.initialCode, result.text, recordData.lang);
            await updateAiRecord(this, recordData, STATUS.STATUS_AI_ANSWER, annotatedCode, result.text);
            const saved = await saveTutoringSession(this, request, context, question, result.text, result.provider, recordData.rid);
            const nextQuota = await getQuota(this);
            this.response.body = {
                ok: true,
                answer: result.text,
                provider: result.provider,
                retry: result.retry,
                conversationId: saved.conversationId,
                turnIndex: saved.turnIndex,
                remainingQuota: nextQuota.remainingQuota,
                recordId: recordData.rid.toHexString(),
                recordUrl: this.url('record_detail', { rid: recordData.rid }),
            };
        } catch (err: any) {
            this.response.status = err instanceof ForbiddenError ? 403 : 400;
            const message = err?.message || String(err);
            if (recordData) {
                await updateAiRecord(this, recordData, STATUS.STATUS_AI_ERROR, recordData.initialCode, message);
            }
            this.response.body = {
                ok: false,
                error: message,
                ...(recordData ? {
                    recordId: recordData.rid.toHexString(),
                    recordUrl: this.url('record_detail', { rid: recordData.rid }),
                } : {}),
            };
        }
    }
}

class AiAssistantContextConfigHandler extends Handler {
    @param('contextType', Types.String)
    @param('contextId', Types.ObjectId)
    async post(domainId: string, contextType: ContextType, contextId: any) {
        if (!CONTEXT_TYPES.includes(contextType) || contextType === 'problem') throw new ForbiddenError('不支持的 AI 场景配置类型。');
        const config = sanitizeContextConfig(this.request.body?.config ?? this.request.body);
        if (contextType === 'training') {
            const tdoc = await TrainingModel.get(domainId, contextId);
            if (!this.user.own(tdoc)) this.checkPerm(PERM.PERM_EDIT_TRAINING);
            const nextConfig = { ...((tdoc as any).ai || {}), ...config };
            await DocumentModel.set(domainId, DocumentModel.TYPE_TRAINING, tdoc.docId, { ai: nextConfig } as any);
            this.response.body = { ok: true, config: nextConfig };
            return;
        }
        const tdoc = await ContestModel.get(domainId, contextId);
        if (!tdoc || tdoc.rule !== contextType) throw new ForbiddenError('场景不存在或类型不匹配。');
        if (contextType === 'contest') {
            if (!this.user.own(tdoc)) this.checkPerm(PERM.PERM_EDIT_CONTEST);
        } else if (!this.user.own(tdoc)) this.checkPerm(PERM.PERM_EDIT_HOMEWORK);
        const nextConfig = { ...((tdoc as any).ai || {}), ...config };
        await DocumentModel.set(domainId, DocumentModel.TYPE_CONTEST, tdoc.docId, { ai: nextConfig } as any);
        this.response.body = { ok: true, config: nextConfig };
    }
}

export const Config = Schema.object({
    providers: Schema.string().role('textarea').default(DEFAULT_PROVIDERS).description('LLM providers JSON array. Supported type: anthropic, openai-responses, openai-chat. Providers are tried in order.'),
    anthropicApiKey: Schema.string().default('').role('secret').description('Secret API key for provider named/type anthropic. Prefer this over embedding keys in providers JSON.'),
    openaiResponsesApiKey: Schema.string().default('').role('secret').description('Secret API key for provider named/type openai-responses. Prefer this over embedding keys in providers JSON.'),
    openaiChatApiKey: Schema.string().default('').role('secret').description('Secret API key for provider named/type openai-chat. Prefer this over embedding keys in providers JSON.'),
    studentDailyQuota: Schema.number().default(DEFAULT_STUDENT_DAILY_QUOTA).min(0).description('Global daily AI quota for students.'),
    teacherDailyQuota: Schema.number().default(DEFAULT_TEACHER_DAILY_QUOTA).min(0).description('Global daily AI quota for teachers.'),
    retryTimes: Schema.number().default(2).min(0).description('Provider-chain retry times after the first failed round. Default 2.'),
    timeoutMs: Schema.number().default(120000).min(10000).description('Upstream LLM request timeout in milliseconds.'),
}).description('AI assistant');

export async function apply(ctx: Context, config: ReturnType<typeof Config>) {
    runtimeConfig = {
        providers: parseProviders(config.providers || DEFAULT_PROVIDERS),
        providerApiKeys: Object.fromEntries(Object.entries({
            anthropic: config.anthropicApiKey,
            'openai-responses': config.openaiResponsesApiKey,
            'openai-chat': config.openaiChatApiKey,
        }).filter(([, value]) => value)),
        studentDailyQuota: Math.max(Number(config.studentDailyQuota ?? DEFAULT_STUDENT_DAILY_QUOTA), 0),
        teacherDailyQuota: Math.max(Number(config.teacherDailyQuota ?? DEFAULT_TEACHER_DAILY_QUOTA), 0),
        retryTimes: Number.isFinite(config.retryTimes) ? config.retryTimes : 2,
        timeoutMs: config.timeoutMs || 120000,
    };

    await Promise.all([
        tutoringColl.createIndex({ userId: 1, createdAt: 1 }),
        tutoringColl.createIndex({ conversationId: 1, turnIndex: 1 }),
        quotaResetColl.createIndex({ userId: 1, resetDate: 1, resetAt: -1 }),
    ]);

    ctx.inject(['setting'], (c) => {
        c.setting.DomainSetting(
            SettingModel.Setting('setting_ai_assistant', 'aieduAiEnabled', false, 'boolean', 'AI assistant enabled', 'Enable AI tutoring for this domain.'),
        );
    });

    ctx.i18n.load('zh', {
        setting_ai_assistant: 'AI 助手',
        'AI assistant enabled': '开启 AI 助手',
        'Enable AI tutoring for this domain.': '是否在当前域开启 AI 问答功能。',
        'Global daily AI quota for students.': '学生每日 AI 问答次数，全局生效。',
        'Global daily AI quota for teachers.': '教师每日 AI 问答次数，全局生效。',
        'AI assistant': 'AI 助手',
        'Checking AI availability...': '正在检查 AI 可用状态...',
        'Thinking guidance': '问思路',
        'Code hint': '看代码给提示',
        'Explain compile error': '解释编译错误',
        'Custom AI question': '输入自定义 AI 问题',
        'Ask AI': '询问 AI',
        'AI assistant is unavailable.': 'AI 助手当前不可用。',
        'Choose an AI question.': '请选择一个 AI 问题。',
        'AI assistant status check failed.': 'AI 助手状态检查失败。',
        'Asking AI...': '正在询问 AI...',
        'AI request failed.': 'AI 请求失败。',
        'View AI answer record': '查看 AI 答复记录',
        'Please enter a question.': '请输入问题。',
    });

    ctx.Route('ai_assistant_status', '/ai-assistant/status', AiAssistantStatusHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('ai_assistant_ask', '/ai-assistant/ask', AiAssistantAskHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('ai_assistant_context_config', '/ai-assistant/context/:contextType/:contextId', AiAssistantContextConfigHandler, PRIV.PRIV_USER_PROFILE);

    const injectAiAssistantPanel = async (handler) => {
        if (!handler.user.hasPriv(PRIV.PRIV_USER_PROFILE)) return;
        if (!getDomainAiConfig(handler.domain).enabled) return;
        const { pdoc, tdoc } = handler.response.body;
        if (!pdoc) return;
        handler.response.body.aiAssistantPanel = await handler.renderHTML('ai_assistant_panel.html', {
            pdoc,
            tdoc,
            contextType: tdoc?.rule || 'problem',
            contextId: tdoc?._id?.toString?.() || '',
            askUrl: handler.url('ai_assistant_ask'),
            statusUrl: handler.url('ai_assistant_status'),
            teacher: isTeacher(handler),
            studentQuestionTypes: STUDENT_QUESTION_TYPES,
        });
    };
    ctx.on('handler/after/ProblemDetail', injectAiAssistantPanel);
    ctx.on('handler/after/ProblemDetailHandler', injectAiAssistantPanel);
}
