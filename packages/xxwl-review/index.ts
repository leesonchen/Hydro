import path from 'path';
import { promises as fsp } from 'fs';
import {
    Context, Handler, Logger, param, PRIV, Schema, Types,
} from 'hydrooj';

export const name = 'xxwl-review';

const logger = new Logger('xxwl-review');
const PROBLEMS = [
    { id: 'p1', title: '数论枚举', max: 50, desc: 'O(√n) 因数遍历与基础计数' },
    { id: 'p2', title: '几何作图', max: 75, desc: '圆形区域判断与字符网格作图' },
    { id: 'p3', title: '字符画模拟', max: 75, desc: 'N/J 图形输出，中心对齐与笔画顺序' },
    { id: 'p4', title: '折纸状态模拟', max: 100, desc: '2ⁿ×2ⁿ 纸张折叠，求左上角方块编号与朝向' },
    { id: 'p5', title: 'DP/最短路', max: 100, desc: '图上最短路径/状态 DP' },
    { id: 'p6', title: '博弈搜索', max: 100, desc: '两人轮流操作，求必胜方，Minimax + Alpha-Beta' },
];

const SYSTEM_PROMPT = `你是一位信息学竞赛教练，为参加编程竞赛的学生撰写个性化代码审核评语。
评语面向学生本人和教师，语气专业但鼓励，重点分析代码质量而非仅罗列分数。
必须基于学生实际源码和评测串下结论；不要编造源码中不存在的函数、变量或行号。
如果源码未提交或信息不足，要明确说明证据不足，并给出可执行的下一步建议。`;

type StudentRecord = {
    id: string;
    region: string;
    total: number;
    scores: Record<string, number>;
    global_rank: number;
    region_rank: number;
    percentile: number;
    report_string?: Record<string, string>;
};

type AnalysisData = {
    global: {
        n_students: number;
        total_mean: number;
        total_median: number;
    };
    students: StudentRecord[];
};

type RuntimeConfig = {
    dataDir: string;
    title: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    endpoint: 'auto' | 'responses' | 'chat';
    reasoningEffort: string;
    maxOutputTokens: number;
    temperature?: number;
    codeMaxChars: number;
    timeoutMs: number;
};

let runtimeConfig: RuntimeConfig = {
    dataDir: process.env.XXWL_REVIEW_DATA_DIR || '',
    title: '信息与未来 2026 个人分析',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-5.5',
    endpoint: 'auto',
    reasoningEffort: 'high',
    maxOutputTokens: 1800,
    codeMaxChars: 20000,
    timeoutMs: 180000,
};
let cachedMtime = 0;
let cachedData: AnalysisData | null = null;
let cachedStudents = new Map<string, StudentRecord>();
const generationTasks = new Map<string, Promise<string>>();

function normalizeExamId(id = '') {
    return id.trim().toUpperCase();
}

function requireDataDir() {
    if (!runtimeConfig.dataDir) throw new Error('插件未配置 dataDir，请在 Hydro 插件配置中填写 xxwl_judge 数据目录。');
    return runtimeConfig.dataDir;
}

async function readAnalysis() {
    const dataDir = requireDataDir();
    const analysisPath = path.join(dataDir, 'cache', 'analysis.json');
    const stat = await fsp.stat(analysisPath);
    if (cachedData && cachedMtime === stat.mtimeMs) return cachedData;
    const raw = await fsp.readFile(analysisPath, 'utf-8');
    const data = JSON.parse(raw) as AnalysisData;
    cachedData = data;
    cachedMtime = stat.mtimeMs;
    cachedStudents = new Map(data.students.map((student) => [student.id.toUpperCase(), student]));
    return data;
}

async function readReview(id: string) {
    const reviewPath = path.join(requireDataDir(), 'reviews', `${id}.md`);
    try {
        return await fsp.readFile(reviewPath, 'utf-8');
    } catch (err: any) {
        if (err?.code === 'ENOENT') return '';
        throw err;
    }
}

async function writeReview(id: string, content: string) {
    const reviewsDir = path.join(requireDataDir(), 'reviews');
    await fsp.mkdir(reviewsDir, { recursive: true });
    const target = path.join(reviewsDir, `${id}.md`);
    const tmp = `${target}.tmp`;
    await fsp.writeFile(tmp, content, 'utf-8');
    await fsp.rename(tmp, target);
}

function buildProblemRows(student: StudentRecord) {
    return PROBLEMS.map((problem) => ({
        ...problem,
        score: student.scores?.[problem.id] ?? 0,
        status: student.report_string?.[problem.id] || '',
    }));
}

function truncateMiddle(text: string, maxChars: number) {
    if (!maxChars || text.length <= maxChars) return text;
    const keepHead = Math.floor(maxChars / 2);
    const keepTail = maxChars - keepHead;
    return `${text.slice(0, keepHead)}\n\n// ……中间省略 ${text.length - maxChars} 个字符，因单文件过长……\n\n${text.slice(-keepTail)}`;
}

function withLineNumbers(source: string) {
    const lines = source.split(/\r?\n/);
    if (!lines.length) return '1: // 空文件';
    return lines.map((line, index) => `${String(index + 1).padStart(4, ' ')}: ${line}`).join('\n');
}

async function readSource(studentId: string, pid: string) {
    const sourcePath = path.join(requireDataDir(), '代码', studentId, `${pid}.cpp`);
    try {
        const source = await fsp.readFile(sourcePath, 'utf-8');
        return withLineNumbers(truncateMiddle(source, runtimeConfig.codeMaxChars));
    } catch (err: any) {
        if (err?.code === 'ENOENT') return '   1: // 未提交';
        return `   1: // 读取失败: ${err?.message || String(err)}`;
    }
}

async function buildReviewPrompt(student: StudentRecord, data: AnalysisData) {
    const problemLines = PROBLEMS
        .map((p) => `- ${p.id} ${p.title}（满分 ${p.max}）：${p.desc}`)
        .join('\n');
    const reportLines = PROBLEMS
        .map((p) => `    ${p.id}: ${student.report_string?.[p.id] || '无'}`)
        .join('\n');
    const codeBlocks: string[] = [];
    for (const problem of PROBLEMS) {
        const source = await readSource(student.id, problem.id);
        codeBlocks.push(`### ${problem.id}.cpp\n\`\`\`cpp\n${source}\n\`\`\``);
    }
    return `请为学生 ${student.id} 撰写代码审核评语。

## 比赛信息
- 总人数：${data.global.n_students} 人，满分 500
- 全体均分：${data.global.total_mean}，中位数 ${data.global.total_median}

## 题目信息
${problemLines}

## 该学生数据
- 总分：${student.total}/500
- 全体排名：#${student.global_rank}（P${student.percentile}）
- 考区 ${student.region} 排名：#${student.region_rank}
- 各题得分：p1=${student.scores.p1} p2=${student.scores.p2} p3=${student.scores.p3} p4=${student.scores.p4} p5=${student.scores.p5} p6=${student.scores.p6}
- 评测串（每字符对应一个测试点，*=AC x=WA r=RE t=TLE o=输出超限 c=编译错误 .=未提交）：
${reportLines}

## 该学生提交的源代码
${codeBlocks.join('\n')}

## 输出要求
1. 用 Markdown 格式，以 \`# 代码审核 - ${student.id}\` 开头。
2. 第一行用粗体写成绩摘要：总分/满分、百分位、全体排名、考区排名。
3. 分“强项”和“弱点/进步点”两大部分：
   - 强项：找出得分最高或算法最出色的题，引用代码关键片段，说明为什么写得好。
   - 弱点：找出失分最多的题，定位具体代码行的 bug 或算法错误，解释根因，给出正确思路或伪代码。
4. 引用学生实际代码时用 \`\`\`cpp 代码块，并指出具体行号。
5. 最后给出 2-3 条针对性改进建议。
6. 全文 200-500 字（中文），避免泛泛而谈，每个论断都要有代码证据。
`;
}

function normalizeBaseUrl(url: string) {
    return (url || 'https://api.openai.com/v1').replace(/\/+$/, '');
}

async function requestJson(url: string, payload: any) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), runtimeConfig.timeoutMs || 180000);
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${runtimeConfig.apiKey}`,
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
        const text = await response.text();
        let data: any;
        try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
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

async function callResponses(userPrompt: string) {
    const payload: any = {
        model: runtimeConfig.model,
        input: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
        ],
        max_output_tokens: runtimeConfig.maxOutputTokens,
    };
    if (runtimeConfig.reasoningEffort) payload.reasoning = { effort: runtimeConfig.reasoningEffort };
    if (runtimeConfig.temperature !== undefined) payload.temperature = runtimeConfig.temperature;
    const data = await requestJson(`${normalizeBaseUrl(runtimeConfig.baseUrl)}/responses`, payload);
    const text = textFromResponses(data);
    if (!text) throw new Error('LLM 响应中没有可用文本。');
    return text;
}

async function callChat(userPrompt: string) {
    const payload: any = {
        model: runtimeConfig.model,
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
        ],
        max_completion_tokens: runtimeConfig.maxOutputTokens,
    };
    if (runtimeConfig.reasoningEffort) payload.reasoning_effort = runtimeConfig.reasoningEffort;
    if (runtimeConfig.temperature !== undefined) payload.temperature = runtimeConfig.temperature;
    const data = await requestJson(`${normalizeBaseUrl(runtimeConfig.baseUrl)}/chat/completions`, payload);
    const text = textFromChat(data);
    if (!text) throw new Error('LLM 响应中没有可用文本。');
    return text;
}

async function callLLM(userPrompt: string) {
    const endpoints = runtimeConfig.endpoint === 'auto' ? ['responses', 'chat'] : [runtimeConfig.endpoint];
    const errors: string[] = [];
    for (const endpoint of endpoints) {
        try {
            return endpoint === 'responses' ? await callResponses(userPrompt) : await callChat(userPrompt);
        } catch (err: any) {
            const message = err?.message || String(err);
            errors.push(`${endpoint}: ${message}`);
            logger.warn(`LLM ${endpoint} failed: ${message}`);
        }
    }
    throw new Error(errors.join('\n'));
}

function normalizeReview(text: string, student: StudentRecord) {
    const trimmed = text.trim();
    if (trimmed.startsWith(`# 代码审核 - ${student.id}`)) return `${trimmed}\n`;
    return `# 代码审核 - ${student.id}\n\n**成绩：${student.total}/500 (P${student.percentile}) | 全体#${student.global_rank} | 考区${student.region}第${student.region_rank}**\n\n${trimmed.replace(/^#+\s*/, '')}\n`;
}

async function generateReview(student: StudentRecord, data: AnalysisData) {
    if (!runtimeConfig.apiKey) throw new Error('插件未配置 apiKey，无法实时生成评语。');
    const existing = await readReview(student.id);
    if (existing) return existing;
    const prompt = await buildReviewPrompt(student, data);
    const review = normalizeReview(await callLLM(prompt), student);
    await writeReview(student.id, review);
    return review;
}

class XxwlReviewHandler extends Handler {
    @param('id', Types.String, true)
    async get(_domainId: string, id = '') {
        const examId = normalizeExamId(id);
        let configError = '';
        let data: AnalysisData | null = null;
        try {
            data = await readAnalysis();
        } catch (err: any) {
            configError = err?.message || String(err);
        }
        const student = data && examId ? cachedStudents.get(examId) || null : null;
        const generatedReview = student ? await readReview(student.id) : '';
        this.response.template = 'xxwl_review.html';
        this.response.body = {
            pageTitle: runtimeConfig.title,
            queryId: examId,
            student,
            problemRows: student ? buildProblemRows(student) : [],
            review: generatedReview,
            totalStudents: data?.global.n_students || 0,
            globalMean: data?.global.total_mean || 0,
            globalMedian: data?.global.total_median || 0,
            hasGeneratedReview: Boolean(generatedReview),
            canGenerate: Boolean(runtimeConfig.apiKey && runtimeConfig.dataDir),
            configError,
            searched: Boolean(examId),
        };
    }
}

class XxwlReviewGenerateHandler extends Handler {
    @param('id', Types.String)
    async post(_domainId: string, id: string) {
        const examId = normalizeExamId(id);
        try {
            const data = await readAnalysis();
            const student = cachedStudents.get(examId);
            if (!student) {
                this.response.body = { ok: false, error: `未找到考试编号 ${examId}` };
                return;
            }
            let task = generationTasks.get(student.id);
            if (!task) {
                task = generateReview(student, data).finally(() => generationTasks.delete(student.id));
                generationTasks.set(student.id, task);
            }
            const review = await task;
            const html = await this.renderHTML('xxwl_review_content.html', { review });
            this.response.body = { ok: true, id: student.id, review, html };
        } catch (err: any) {
            this.response.body = { ok: false, error: err?.message || String(err) };
        }
    }
}

export const Config = Schema.object({
    dataDir: Schema.string().default(process.env.XXWL_REVIEW_DATA_DIR || '').description('xxwl_judge 数据目录，需包含 cache/analysis.json、reviews/、代码/'),
    title: Schema.string().default('信息与未来 2026 个人分析').description('查询页标题'),
    baseUrl: Schema.string().default('https://api.openai.com/v1').description('OpenAI-compatible API base URL，例如 https://api.openai.com/v1'),
    apiKey: Schema.string().role('secret').default('').description('OpenAI-compatible API Key，用于缺失 review 时实时生成'),
    model: Schema.string().default('gpt-5.5').description('LLM 模型名'),
    endpoint: Schema.union(['auto', 'responses', 'chat'] as const).default('auto').description('API endpoint 类型'),
    reasoningEffort: Schema.string().default('high').description('推理强度，留空则不传'),
    maxOutputTokens: Schema.number().default(1800).min(256).description('最大输出 token'),
    temperature: Schema.number().role('slider').min(0).max(2).step(0.1).description('采样温度；留空则不传'),
    codeMaxChars: Schema.number().default(20000).min(1000).description('每个源码文件放入 prompt 的最大字符数'),
    timeoutMs: Schema.number().default(180000).min(10000).description('实时生成请求超时毫秒数'),
}).description('XXWL student review query');

export async function apply(ctx: Context, config: ReturnType<typeof Config>) {
    runtimeConfig = {
        dataDir: config.dataDir || process.env.XXWL_REVIEW_DATA_DIR || '',
        title: config.title || '信息与未来 2026 个人分析',
        baseUrl: config.baseUrl || 'https://api.openai.com/v1',
        apiKey: config.apiKey || '',
        model: config.model || 'gpt-5.5',
        endpoint: (config.endpoint || 'auto') as RuntimeConfig['endpoint'],
        reasoningEffort: config.reasoningEffort || '',
        maxOutputTokens: config.maxOutputTokens || 1800,
        temperature: config.temperature,
        codeMaxChars: config.codeMaxChars || 20000,
        timeoutMs: config.timeoutMs || 180000,
    };
    cachedData = null;
    cachedStudents = new Map();
    cachedMtime = 0;
    ctx.Route('xxwl_review', '/xxwl-review', XxwlReviewHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('xxwl_review_generate', '/xxwl-review/generate', XxwlReviewGenerateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.injectUI('UserDropdown', 'xxwl_review', { icon: 'chart-bar', text: '个人分析查询' },
        (handler) => handler.user.hasPriv(PRIV.PRIV_USER_PROFILE));
}
