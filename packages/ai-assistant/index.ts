import { randomUUID } from 'crypto';
import {
    ContestModel, Context, DocumentModel, ForbiddenError, Handler,
    Logger, ObjectId, PERM, PRIV, ProblemModel, Schema, SettingModel, TrainingModel, Types,
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

let runtimeConfig: RuntimeConfig = {
    providers: [],
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

function providerApiKey(provider: AiProviderConfig) {
    return provider.apiKey || (provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : '');
}

function isTeacher(handler: Handler) {
    return handler.user.hasPerm(PERM.PERM_EDIT_DOMAIN)
        || handler.user.hasPerm(PERM.PERM_EDIT_PROBLEM)
        || handler.user.hasPerm(PERM.PERM_EDIT_HOMEWORK)
        || handler.user.hasPerm(PERM.PERM_EDIT_TRAINING)
        || handler.user.hasPerm(PERM.PERM_EDIT_CONTEST);
}

function getDomainAiConfig(domain: any) {
    return {
        enabled: domain?.aieduAiEnabled === true,
        studentDailyQuota: Math.max(Number(domain?.aieduAiStudentDailyQuota ?? DEFAULT_STUDENT_DAILY_QUOTA), 0),
        teacherDailyQuota: Math.max(Number(domain?.aieduAiTeacherDailyQuota ?? DEFAULT_TEACHER_DAILY_QUOTA), 0),
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

async function saveTutoringSession(handler: Handler, request: AskRequest, context: LoadedContext, question: string, answer: string, provider: string) {
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
        createdAt: new Date(),
        feedbackRating: null,
        feedbackComment: '',
        status: 'COMPLETED',
    };
    await tutoringColl.insertOne(doc);
    return { conversationId, turnIndex };
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
        try {
            const domainConfig = getDomainAiConfig(this.domain);
            if (!domainConfig.enabled) throw new ForbiddenError('当前域未开启 AI 功能。');
            const request = (this.request.body || {}) as AskRequest;
            const teacher = isTeacher(this);
            const quota = await getQuota(this);
            const quotaCost = Math.max(Number(request.quotaCost || 1), 1);
            if (quota.remainingQuota < quotaCost) throw new ForbiddenError(`今日 AI 问答次数不足，剩余 ${quota.remainingQuota} 次。`);
            if (!teacher && !request.pid && !request.problemId) throw new ForbiddenError('学生 AI 提问必须绑定题目。');

            const context = await loadContext(this, request);
            if (!context.allowed) throw new ForbiddenError(context.reason || '当前场景不允许使用 AI。');
            const question = teacher
                ? (request.question || request.userQuestion || '')
                : normalizeStudentQuestion(request.questionType || '', request.question || request.userQuestion || '');
            const prompt = buildPrompt(request, context, teacher);
            const result = await callLLM(prompt);
            const saved = await saveTutoringSession(this, request, context, question, result.text, result.provider);
            const nextQuota = await getQuota(this);
            this.response.body = {
                ok: true,
                answer: result.text,
                provider: result.provider,
                retry: result.retry,
                conversationId: saved.conversationId,
                turnIndex: saved.turnIndex,
                remainingQuota: nextQuota.remainingQuota,
            };
        } catch (err: any) {
            this.response.status = err instanceof ForbiddenError ? 403 : 400;
            this.response.body = { ok: false, error: err?.message || String(err) };
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
    retryTimes: Schema.number().default(2).min(0).description('Provider-chain retry times after the first failed round. Default 2.'),
    timeoutMs: Schema.number().default(120000).min(10000).description('Upstream LLM request timeout in milliseconds.'),
}).description('AI assistant');

export async function apply(ctx: Context, config: ReturnType<typeof Config>) {
    runtimeConfig = {
        providers: parseProviders(config.providers || DEFAULT_PROVIDERS),
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
            SettingModel.Setting('setting_ai_assistant', 'aieduAiStudentDailyQuota', DEFAULT_STUDENT_DAILY_QUOTA, 'number', 'Student daily AI quota'),
            SettingModel.Setting('setting_ai_assistant', 'aieduAiTeacherDailyQuota', DEFAULT_TEACHER_DAILY_QUOTA, 'number', 'Teacher daily AI quota'),
        );
    });

    ctx.i18n.load('zh', {
        setting_ai_assistant: 'AI 助手',
        'AI assistant enabled': '开启 AI 助手',
        'Enable AI tutoring for this domain.': '是否在当前域开启 AI 问答功能。',
        'Student daily AI quota': '学生每日 AI 问答次数',
        'Teacher daily AI quota': '教师每日 AI 问答次数',
    });

    ctx.Route('ai_assistant_status', '/ai-assistant/status', AiAssistantStatusHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('ai_assistant_ask', '/ai-assistant/ask', AiAssistantAskHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('ai_assistant_context_config', '/ai-assistant/context/:contextType/:contextId', AiAssistantContextConfigHandler, PRIV.PRIV_USER_PROFILE);
}
