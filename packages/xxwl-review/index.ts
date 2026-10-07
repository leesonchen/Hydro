import { promises as fsp } from 'fs';
import path from 'path';
import {
    Context, Handler, Logger, param, PRIV, Schema, Types,
} from 'hydrooj';

export const name = 'xxwl-review';

const logger = new Logger('xxwl-review');
const DEFAULT_DATA_DIR = 'data';
const PROBLEMS = [
    { id: 'p1', title: '幸运数字', max: 50, desc: 'O(√n) 因数遍历与基础计数' },
    { id: 'p2', title: '快递无人机', max: 75, desc: '字符网格中由 * 围成闭合边界的内外判定与 o 计数；不提供圆心/半径，通常从网格连通性或外部标记角度分析' },
    { id: 'p3', title: '南京名片', max: 75, desc: 'N/J 图形输出，中心对齐与笔画顺序' },
    { id: 'p4', title: '折纸', max: 100, desc: '2ⁿ×2ⁿ 纸张折叠，求左上角方块编号与朝向' },
    { id: 'p5', title: '旅行计划', max: 100, desc: '图上最短路径/状态 DP' },
    { id: 'p6', title: '桌面游戏', max: 100, desc: '两人轮流操作，求必胜方，Minimax + Alpha-Beta' },
];

const SYSTEM_PROMPT = `你是一位信息学竞赛教练，为参加编程竞赛的学生撰写个性化代码点评。
代码点评面向学生本人和教师，语气专业但鼓励，重点分析代码质量而非仅罗列分数。
必须基于学生实际源码和评测串下结论；不要编造源码中不存在的函数、变量或行号。
题意以提供的完整题面为准，不要只根据题目标题或图片主观补全算法。
参考解法只用于理解正确思路和定位差距；代码点评必须主要评价学生代码，不要把参考解法当作学生代码。
评测结果只写摘要（如“全 WA”“RE 2，AC 3”），不要在输出中展示由 *、x、r、t、c、o、. 组成的原始评测串。
所有非满分题都必须被检查到：重点题可放在“可改进项”展开，其他题至少要在“题目要点总结”中逐题说明。
对未提交题只说明“未提交，无法进行源码层面的代码点评”，不要补写正确算法、不要推测原因、不要做总结评价。
只输出一份完整代码点评，不要重复标题、“强项”、“可改进项”、“题目要点总结”或“总体评价”章节。
如果源码未提交或信息不足，要明确说明证据不足，并给出可执行的下一步建议。`;

interface StudentRecord {
    id: string;
    region: string;
    total: number;
    scores: Record<string, number>;
    global_rank: number;
    region_rank: number;
    percentile: number;
    report_string?: Record<string, string>;
}

interface AnalysisData {
    global: {
        n_students: number;
        total_mean: number;
        total_median: number;
        total_std?: number;
        zero_count?: number;
        pass_count?: number;
        total_quantiles?: Record<string, number>;
    };
    regions?: Record<string, any>;
    problems?: Record<string, any>;
    students: StudentRecord[];
}

interface RuntimeConfig {
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
    statementMaxChars: number;
    solutionMaxChars: number;
    timeoutMs: number;
    adminUids: string;
}

function resolveDataDir(dataDir = DEFAULT_DATA_DIR) {
    const trimmed = (dataDir || DEFAULT_DATA_DIR).trim() || DEFAULT_DATA_DIR;
    return path.isAbsolute(trimmed) ? trimmed : path.resolve(__dirname, trimmed);
}

let runtimeConfig: RuntimeConfig = {
    dataDir: resolveDataDir(process.env.XXWL_REVIEW_DATA_DIR || DEFAULT_DATA_DIR),
    title: '信息与未来 2026 个人分析',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-5.5',
    endpoint: 'auto',
    reasoningEffort: 'high',
    maxOutputTokens: 2200,
    codeMaxChars: 20000,
    statementMaxChars: 8000,
    solutionMaxChars: 6000,
    timeoutMs: 180000,
    adminUids: '1966',
};
let cachedMtime = 0;
let cachedData: AnalysisData | null = null;
let cachedStudents = new Map<string, StudentRecord>();
const generationTasks = new Map<string, Promise<string>>();
const REVIEW_TITLE_PATTERN = '代码(?:点评|审核|评审|审查|审阅)';

function normalizeExamId(id = '') {
    return id.trim().toUpperCase();
}

function requireDataDir() {
    if (!runtimeConfig.dataDir) throw new Error('数据目录不可用，请检查 Hydro 插件配置中的 dataDir。');
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

function buildStatusParts(status = '') {
    const labels: Record<string, string> = {
        '*': 'AC',
        x: 'WA',
        r: 'RE',
        t: 'TLE',
        c: 'CE',
        o: '输出超限',
        '.': '未提交',
    };
    const order = ['*', 'x', 'r', 't', 'c', 'o', '.'];
    const counts = new Map<string, number>();
    for (const ch of status) counts.set(ch, (counts.get(ch) || 0) + 1);
    return order
        .filter((ch) => counts.has(ch))
        .map((ch) => ({
            ch,
            label: labels[ch] || ch,
            count: counts.get(ch) || 0,
            className: ch === '*' ? 'ac' : ch === '.' ? 'missing' : 'bad',
        }));
}

function summarizeReportString(status = '') {
    const parts = buildStatusParts(status);
    return parts.map((part) => `${part.label} ${part.count}`).join('，') || '无评测串';
}

function summarizeRawStatus(status = '') {
    const parts = buildStatusParts(status);
    if (!parts.length) return '无评测串';
    if (parts.length === 1) return parts[0].ch === '*' ? `全 ${parts[0].label}` : `${parts[0].label} ${parts[0].count}`;
    return parts.map((part) => `${part.label} ${part.count}`).join('，');
}

function replaceRawStatusStrings(text: string) {
    return text.split(/(```[\s\S]*?```)/g).map((part) => {
        if (part.startsWith('```')) return part;
        return part
            .replace(/评测串\s*(?:[:：]\s*)?([*xrtc.o]{3,})/gi, (_all, raw) => `评测结果：${summarizeRawStatus(raw.toLowerCase())}`)
            .replace(/([（(])([*xrtc.o]{3,})([）)])/gi, (_all, left, raw, right) => {
                if (!/[xrtc*.o]/i.test(raw)) return `${left}${raw}${right}`;
                return `${left}${summarizeRawStatus(raw.toLowerCase())}${right}`;
            });
    }).join('');
}

function displayReviewText(text: string) {
    return replaceRawStatusStrings(text
        .replace(/代码(?:审核|评审|审查|审阅)/g, '代码点评')
        .replace(/代码点评评语/g, '代码点评'));
}

function buildProblemRows(student: StudentRecord) {
    return PROBLEMS.map((problem) => ({
        ...problem,
        score: student.scores?.[problem.id] ?? 0,
        status: student.report_string?.[problem.id] || '',
        statusParts: buildStatusParts(student.report_string?.[problem.id] || ''),
        statusSummary: summarizeReportString(student.report_string?.[problem.id] || ''),
    }));
}

function pct(value = 0) {
    return `${(value * 100).toFixed(1)}%`;
}

function round2(value = 0) {
    return Math.round(value * 100) / 100;
}

function buildStatsView(data: AnalysisData) {
    const students = [...data.students].sort((a, b) => a.global_rank - b.global_rank || a.id.localeCompare(b.id));
    const regionList = (Object.keys(data.regions || {}).length
        ? Object.keys(data.regions || {})
        : Array.from(new Set(students.map((s) => s.region)))).sort();
    const regionRows = regionList.map((region) => {
        const item = data.regions?.[region] || {};
        return {
            region,
            n: item.n_students || students.filter((s) => s.region === region).length,
            mean: round2(item.total_mean || 0),
            median: round2(item.total_median || 0),
            std: round2(item.total_std || 0),
            problemMeans: PROBLEMS.map((p) => round2(item.per_problem?.[p.id]?.mean || 0)),
        };
    });
    const problemRows = PROBLEMS.map((p) => {
        const item = data.problems?.[p.id] || {};
        return {
            ...p,
            mean: round2(item.mean || 0),
            std: round2(item.std || 0),
            zeroRate: pct(item.zero_rate || 0),
            fullRate: pct(item.full_rate || 0),
            discrimination: round2(item.discrimination || 0),
            byRegion: regionList.map((region) => ({
                region,
                mean: round2(item.per_region?.[region] || 0),
            })),
        };
    });
    return {
        global: {
            ...data.global,
            total_std: round2(data.global.total_std || 0),
            pass_rate: pct((data.global.pass_count || 0) / Math.max(data.global.n_students || 1, 1)),
            zero_rate: pct((data.global.zero_count || 0) / Math.max(data.global.n_students || 1, 1)),
        },
        regionRows,
        problemRows,
        leaderboardRows: students,
    };
}

function buildDiagnosisHint(student: StudentRecord) {
    const rows = PROBLEMS.map((p) => ({
        ...p,
        score: student.scores?.[p.id] ?? 0,
        status: student.report_string?.[p.id] || '',
    }));
    const strengths = [...rows]
        .sort((a, b) => (b.score / b.max) - (a.score / a.max))
        .slice(0, 2)
        .map((p) => `${p.id} ${p.score}/${p.max}（${summarizeReportString(p.status)}）`)
        .join('；');
    const weaknesses = [...rows]
        .sort((a, b) => (b.max - b.score) - (a.max - a.score))
        .slice(0, 3)
        .map((p) => `${p.id} 失 ${p.max - p.score} 分，${p.score}/${p.max}（${summarizeReportString(p.status)}）`)
        .join('；');
    const mustCover = rows
        .filter((p) => p.max - p.score > 0 || [...p.status].some((ch) => ch !== '*'))
        .map((p) => `${p.id} ${p.score}/${p.max}（${summarizeReportString(p.status)}）`)
        .join('；');
    return `建议强项候选：${strengths || '无'}\n建议可改进项优先级：${weaknesses || '无'}\n必须检查到的非满分/异常评测题：${mustCover || '无'}`;
}

function truncateMiddle(text: string, maxChars: number) {
    if (!maxChars || text.length <= maxChars) return text;
    const keepHead = Math.floor(maxChars / 2);
    const keepTail = maxChars - keepHead;
    return `${text.slice(0, keepHead)}\n\n// ……中间省略 ${text.length - maxChars} 个字符，因单文件过长……\n\n${text.slice(-keepTail)}`;
}

function truncateText(text: string, maxChars: number, label = '内容') {
    if (!maxChars || text.length <= maxChars) return text;
    const keepHead = Math.floor(maxChars / 2);
    const keepTail = maxChars - keepHead;
    return `${text.slice(0, keepHead)}\n\n[${label}过长，中间省略 ${text.length - maxChars} 个字符]\n\n${text.slice(-keepTail)}`;
}

function withLineNumbers(source: string) {
    const lines = source.split(/\r?\n/);
    if (!lines.length) return '1: // 空文件';
    return lines.map((line, index) => `${String(index + 1).padStart(4, ' ')}: ${line}`).join('\n');
}

async function readSource(studentId: string, pid: string) {
    const sourcePath = path.join(requireDataDir(), 'code', studentId, `${pid}.cpp`);
    try {
        const source = await fsp.readFile(sourcePath, 'utf-8');
        return withLineNumbers(truncateMiddle(source, runtimeConfig.codeMaxChars));
    } catch (err: any) {
        if (err?.code === 'ENOENT') return '   1: // 未提交';
        return `   1: // 读取失败: ${err?.message || String(err)}`;
    }
}

async function readSourceForDisplay(studentId: string, problem: typeof PROBLEMS[number]) {
    const file = `${problem.id}.cpp`;
    const sourcePath = path.join(requireDataDir(), 'code', studentId, file);
    try {
        const source = await fsp.readFile(sourcePath, 'utf-8');
        return {
            id: problem.id,
            title: problem.title,
            file,
            exists: true,
            source,
        };
    } catch (err: any) {
        return {
            id: problem.id,
            title: problem.title,
            file,
            exists: false,
            source: err?.code === 'ENOENT' ? '// 未提交' : `// 读取失败: ${err?.message || String(err)}`,
        };
    }
}

async function readSourcesForDisplay(studentId: string) {
    return Promise.all(PROBLEMS.map((problem) => readSourceForDisplay(studentId, problem)));
}

async function readProblemStatement(pid: string) {
    const statementPath = path.join(requireDataDir(), 'problems', `${pid}.md`);
    try {
        return truncateText(await fsp.readFile(statementPath, 'utf-8'), runtimeConfig.statementMaxChars, '题面');
    } catch (err: any) {
        if (err?.code === 'ENOENT') return '';
        logger.warn(`Read problem statement ${pid} failed: ${err?.message || String(err)}`);
        return '';
    }
}

async function readProblemStatementFull(pid: string) {
    const statementPath = path.join(requireDataDir(), 'problems', `${pid}.md`);
    try {
        return await fsp.readFile(statementPath, 'utf-8');
    } catch (err: any) {
        if (err?.code === 'ENOENT') return '题面暂不可用，请联系管理员检查 data/problems 目录。';
        throw err;
    }
}

function safeAnimationFilename(filename = '') {
    const base = path.basename(filename);
    return /^[A-Z0-9._-]+\.html$/i.test(base) ? base : '';
}

function extractHtmlTitle(source: string, fallback: string) {
    const match = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return (match?.[1] || fallback.replace(/\.html$/i, ''))
        .replace(/\s+/g, ' ')
        .trim();
}

async function readSolutionAnimations(pid: string) {
    const solutionDir = path.join(requireDataDir(), 'solutions', pid);
    try {
        const entries = await fsp.readdir(solutionDir, { withFileTypes: true });
        const files = entries
            .filter((entry) => entry.isFile() && safeAnimationFilename(entry.name) === entry.name)
            .map((entry) => entry.name)
            .sort((a, b) => a.localeCompare(b));
        const animations: { file: string, title: string }[] = [];
        for await (const file of files) {
            const source = await fsp.readFile(path.join(solutionDir, file), 'utf-8');
            animations.push({ file, title: extractHtmlTitle(source, file) });
        }
        return animations;
    } catch (err: any) {
        if (err?.code === 'ENOENT') return [];
        logger.warn(`Read solution animations ${pid} failed: ${err?.message || String(err)}`);
        return [];
    }
}

async function readSolutionAnimationFile(pid: string, filename: string) {
    const safeName = safeAnimationFilename(filename);
    if (!safeName) return '';
    return await fsp.readFile(path.join(requireDataDir(), 'solutions', pid, safeName), 'utf-8');
}

async function readReferenceSolutions(pid: string) {
    const solutionDir = path.join(requireDataDir(), 'solutions', pid);
    try {
        const entries = await fsp.readdir(solutionDir, { withFileTypes: true });
        const files = entries
            .filter((entry) => entry.isFile() && /\.(?:c|cc|cpp|cxx|md|txt)$/i.test(entry.name))
            .map((entry) => entry.name)
            .sort((a, b) => a.localeCompare(b));
        const blocks: string[] = [];
        for await (const file of files) {
            const filePath = path.join(solutionDir, file);
            const source = await fsp.readFile(filePath, 'utf-8');
            const ext = path.extname(file).slice(1).toLowerCase() || 'txt';
            const lang = ['c', 'cc', 'cpp', 'cxx'].includes(ext) ? 'cpp' : ext;
            const body = lang === 'cpp'
                ? withLineNumbers(truncateMiddle(source, runtimeConfig.solutionMaxChars))
                : truncateText(source, runtimeConfig.solutionMaxChars, '参考解法');
            blocks.push(`#### ${file}\n\`\`\`${lang}\n${body}\n\`\`\``);
        }
        return blocks.join('\n');
    } catch (err: any) {
        if (err?.code === 'ENOENT') return '';
        logger.warn(`Read reference solutions ${pid} failed: ${err?.message || String(err)}`);
        return '';
    }
}

async function buildProblemContext() {
    const chunks: string[] = [];
    for await (const p of PROBLEMS) {
        const [statement, solutions] = await Promise.all([
            readProblemStatement(p.id),
            readReferenceSolutions(p.id),
        ]);
        chunks.push(`### ${p.id} ${p.title}（满分 ${p.max}）
考点摘要：${p.desc}
${statement ? `完整题面：\n${statement}` : '完整题面：未提供，请仅按考点摘要和学生代码谨慎分析。'}

参考解法（仅用于校准正确思路，不是学生代码）：
${solutions || '未提供'}`);
    }
    return chunks.join('\n\n');
}

async function buildReviewPrompt(student: StudentRecord, data: AnalysisData) {
    const problemContext = await buildProblemContext();
    const diagnosisHint = buildDiagnosisHint(student);
    const reportLines = PROBLEMS
        .map((p) => `    ${p.id}: ${student.report_string?.[p.id] || '无'}`)
        .join('\n');
    const codeBlocks: string[] = [];
    for await (const problem of PROBLEMS) {
        const source = await readSource(student.id, problem.id);
        codeBlocks.push(`### ${problem.id}.cpp\n\`\`\`cpp\n${source}\n\`\`\``);
    }
    const instruction5 = '5. `可改进项`：只展开 1-3 个最值得讲的失分题。每项的小标题只写“题号 + 题名 + 得分/评测结果摘要”，例如“p5 旅行计划 0/100，全 RE”；'
        + '正文用自然语言依次说明得分现象、学生代码行号/片段、错误根因和改法；不要把原始评测串字符、以及“现象 / 代码证据 / 根因 / 正确思路”这些词或箭头原样写出来。引用代码用 ```cpp 代码块，且不要引用参考解法作为学生代码。';
    const instruction6 = '6. `题目要点总结`：必须按 p1-p6 顺序逐题覆盖，每题 1 句。满分题写清核心做法；'
        + '非满分且已提交的 WA/RE/TLE/CE/输出超限题写清“得分/评测结果摘要 + 主要问题 + 正确要点”，即使未在“可改进项”展开也不能省略；未提交题只写“未提交，无法进行源码层面的代码点评”，不要补正确算法或总结评价。';
    return `请为学生 ${student.id} 撰写代码点评。

## 比赛信息
- 总人数：${data.global.n_students} 人，满分 500
- 全体均分：${data.global.total_mean}，中位数 ${data.global.total_median}

## 题目信息
${problemContext}

## 该学生数据
- 总分：${student.total}/500
- 全体排名：#${student.global_rank}（P${student.percentile}）
- 考区 ${student.region} 排名：#${student.region_rank}
- 各题得分：p1=${student.scores.p1} p2=${student.scores.p2} p3=${student.scores.p3} p4=${student.scores.p4} p5=${student.scores.p5} p6=${student.scores.p6}
- 评测串（每字符对应一个测试点，*=AC x=WA r=RE t=TLE o=输出超限 c=编译错误 .=未提交）：
${reportLines}

## 自动诊断提示
${diagnosisHint}

## 该学生提交的源代码
${codeBlocks.join('\n')}

## 输出要求
1. 用 Markdown 格式，以 \`# 代码点评 - ${student.id}\` 开头。
2. 第一行用粗体写成绩摘要：总分/满分、百分位、全体排名、考区排名。
3. 只使用以下四个二级标题，且顺序固定：\`## 强项\`、\`## 可改进项\`、\`## 题目要点总结\`、\`## 总体评价\`。
4. \`强项\`：选择 1-2 个最值得表扬的题或代码习惯，必须引用学生实际代码片段或行号说明为什么有效；没有明显强项时写“暂无明显强项”，不要硬夸。
${instruction5}
${instruction6}
7. \`总体评价\`：用 1 段总结能力画像和下一步训练重点，必须点名最需要补的 1-2 个已提交题型/能力；未提交题只能作为“需要先完成提交”的事实，不评价其代码质量或算法水平。
8. 全文 450-900 字（中文），表达精炼、言之有物；如果某题证据不足，明确写“证据不足”，不要猜测。
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
        try {
            data = text ? JSON.parse(text) : {};
        } catch {
            data = { raw: text };
        }
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
    for await (const endpoint of endpoints) {
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
    let trimmed = text.trim();
    const titlePattern = new RegExp(`#\\s*${REVIEW_TITLE_PATTERN}\\s*-\\s*${student.id}\\b`, 'g');
    const titleMatches = Array.from(trimmed.matchAll(titlePattern));
    if (titleMatches.length > 1 && titleMatches[1].index !== undefined) {
        trimmed = trimmed.slice(0, titleMatches[1].index).trimEnd();
    }
    for (const heading of ['\n## 强项', '\n## 弱点/进步点', '\n## 可改进项', '\n## 题目要点总结', '\n## 总体评价', '\n## 建议']) {
        const first = trimmed.indexOf(heading);
        const second = first >= 0 ? trimmed.indexOf(heading, first + 1) : -1;
        if (second >= 0) {
            trimmed = trimmed.slice(0, second).trimEnd();
            break;
        }
    }
    trimmed = displayReviewText(trimmed);
    if (new RegExp(`^#\\s*代码点评\\s*-\\s*${student.id}\\b`).test(trimmed)) return `${trimmed}\n`;
    return `# 代码点评 - ${student.id}\n\n**成绩：${student.total}/500 (P${student.percentile})`
        + ` | 全体#${student.global_rank} | 考区${student.region}第${student.region_rank}**\n\n${trimmed.replace(/^#+\s*/, '')}\n`;
}

async function generateReview(student: StudentRecord, data: AnalysisData, force = false) {
    if (!runtimeConfig.apiKey) throw new Error('插件未配置 apiKey，无法实时生成代码点评。');
    if (!force) {
        const existing = await readReview(student.id);
        if (existing) return existing;
    }
    const prompt = await buildReviewPrompt(student, data);
    const review = normalizeReview(await callLLM(prompt), student);
    await writeReview(student.id, review);
    return review;
}

function parseAdminUids() {
    return new Set((runtimeConfig.adminUids || '1966')
        .split(/[,\s;]+/)
        .map((uid) => Number(uid.trim()))
        .filter((uid) => Number.isInteger(uid) && uid > 0));
}

function isReviewAdmin(handler: Handler) {
    return parseAdminUids().has(handler.user?._id);
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
        const sourceFiles = student ? await readSourcesForDisplay(student.id) : [];
        this.response.template = 'xxwl_review.html';
        this.response.body = {
            pageTitle: runtimeConfig.title,
            queryId: examId,
            student,
            problemRows: student ? buildProblemRows(student) : [],
            sourceFiles,
            review: displayReviewText(generatedReview),
            totalStudents: data?.global.n_students || 0,
            globalMean: data?.global.total_mean || 0,
            globalMedian: data?.global.total_median || 0,
            hasGeneratedReview: Boolean(generatedReview),
            canGenerate: Boolean(runtimeConfig.apiKey && runtimeConfig.dataDir),
            canReanalyze: Boolean(runtimeConfig.apiKey && runtimeConfig.dataDir && isReviewAdmin(this)),
            canViewStats: isReviewAdmin(this),
            configError,
            searched: Boolean(examId),
        };
    }
}

class XxwlProblemHandler extends Handler {
    @param('pid', Types.String)
    async get(_domainId: string, pid: string) {
        const problem = PROBLEMS.find((p) => p.id === (pid || '').toLowerCase());
        if (!problem) {
            this.response.status = 404;
            this.response.body = '题目不存在。';
            return;
        }
        this.response.template = 'xxwl_problem.html';
        const [statement, animations] = await Promise.all([
            readProblemStatementFull(problem.id),
            readSolutionAnimations(problem.id),
        ]);
        this.response.body = {
            pageTitle: `${problem.id.toUpperCase()} · ${problem.title}`,
            problem,
            statement,
            animations,
        };
    }
}

class XxwlProblemAnimationHandler extends Handler {
    @param('pid', Types.String)
    @param('filename', Types.String)
    async get(_domainId: string, pid: string, filename: string) {
        const problem = PROBLEMS.find((p) => p.id === (pid || '').toLowerCase());
        const safeName = safeAnimationFilename(filename || '');
        if (!problem || !safeName) {
            this.response.status = 404;
            this.response.body = '动画解法不存在。';
            return;
        }
        try {
            const html = await readSolutionAnimationFile(problem.id, safeName);
            if (!html) throw new Error('empty animation');
            this.response.type = 'text/html';
            this.response.body = html;
        } catch (err: any) {
            if (err?.code !== 'ENOENT') logger.warn(`Read solution animation ${problem.id}/${safeName} failed: ${err?.message || String(err)}`);
            this.response.status = 404;
            this.response.body = '动画解法不存在。';
        }
    }
}

class XxwlStatsHandler extends Handler {
    async get() {
        if (!isReviewAdmin(this)) {
            this.response.status = 403;
            this.response.body = '当前用户没有查看统计分析的权限。';
            return;
        }
        const data = await readAnalysis();
        this.response.template = 'xxwl_stats.html';
        this.response.body = {
            pageTitle: `${runtimeConfig.title} · 统计分析`,
            problems: PROBLEMS,
            stats: buildStatsView(data),
        };
    }
}

class XxwlReviewGenerateHandler extends Handler {
    @param('id', Types.String)
    @param('force', Types.Boolean, true)
    async post(_domainId: string, id: string, force = false) {
        const examId = normalizeExamId(id);
        try {
            if (force && !isReviewAdmin(this)) {
                this.response.body = { ok: false, error: '当前用户没有重新分析权限。' };
                return;
            }
            const data = await readAnalysis();
            const student = cachedStudents.get(examId);
            if (!student) {
                this.response.body = { ok: false, error: `未找到考试编号 ${examId}` };
                return;
            }
            const taskKey = student.id;
            let task = generationTasks.get(taskKey);
            if (!task) {
                task = generateReview(student, data, force).finally(() => generationTasks.delete(taskKey));
                generationTasks.set(taskKey, task);
            }
            const review = await task;
            const html = await this.renderHTML('xxwl_review_content.html', { review: displayReviewText(review) });
            this.response.body = { ok: true, id: student.id, review, html };
        } catch (err: any) {
            this.response.body = { ok: false, error: err?.message || String(err) };
        }
    }
}

export const Config = Schema.object({
    dataDir: Schema.string().default(process.env.XXWL_REVIEW_DATA_DIR || DEFAULT_DATA_DIR).description(
        '数据目录，默认 data，即本插件目录下的 data；需包含 cache/analysis.json、reviews/、code/；相对路径按本插件目录解析',
    ),
    title: Schema.string().default('信息与未来 2026 个人代码分析').description('查询页标题'),
    baseUrl: Schema.string().default('https://api.openai.com/v1').description('OpenAI-compatible API base URL，例如 https://api.openai.com/v1'),
    apiKey: Schema.string().role('secret').default('').description('OpenAI-compatible API Key，用于缺失 review 时实时生成'),
    model: Schema.string().default('gpt-5.5').description('LLM 模型名'),
    endpoint: Schema.union(['auto', 'responses', 'chat'] as const).default('auto').description('API endpoint 类型'),
    reasoningEffort: Schema.string().default('high').description('推理强度，留空则不传'),
    maxOutputTokens: Schema.number().default(2200).min(256).description('最大输出 token'),
    temperature: Schema.number().role('slider').min(0).max(2).step(0.1).description('采样温度；留空则不传'),
    codeMaxChars: Schema.number().default(20000).min(1000).description('每个源码文件放入 prompt 的最大字符数'),
    statementMaxChars: Schema.number().default(8000).min(1000).description('每道题完整题面放入 prompt 的最大字符数'),
    solutionMaxChars: Schema.number().default(6000).min(1000).description('每份参考解法放入 prompt 的最大字符数'),
    timeoutMs: Schema.number().default(180000).min(10000).description('实时生成请求超时毫秒数'),
    adminUids: Schema.string().default('1966').description('允许重新分析并覆盖 review 的 Hydro 用户 UID，多个 UID 用英文逗号、分号或空格分隔'),
}).description('XXWL student review query');

export async function apply(ctx: Context, config: ReturnType<typeof Config>) {
    runtimeConfig = {
        dataDir: resolveDataDir(config.dataDir || process.env.XXWL_REVIEW_DATA_DIR || DEFAULT_DATA_DIR),
        title: config.title || '信息与未来 2026 个人代码分析',
        baseUrl: config.baseUrl || 'https://api.openai.com/v1',
        apiKey: config.apiKey || '',
        model: config.model || 'gpt-5.5',
        endpoint: (config.endpoint || 'auto') as RuntimeConfig['endpoint'],
        reasoningEffort: config.reasoningEffort || '',
        maxOutputTokens: config.maxOutputTokens || 2200,
        temperature: config.temperature,
        codeMaxChars: config.codeMaxChars || 20000,
        statementMaxChars: config.statementMaxChars || 8000,
        solutionMaxChars: config.solutionMaxChars || 6000,
        timeoutMs: config.timeoutMs || 180000,
        adminUids: config.adminUids || '1966',
    };
    cachedData = null;
    cachedStudents = new Map();
    cachedMtime = 0;
    ctx.Route('xxwl_review', '/xinxi', XxwlReviewHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('xxwl_review_problem', '/xinxi/problem/:pid', XxwlProblemHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('xxwl_review_problem_animation', '/xinxi/problem/:pid/solution/:filename', XxwlProblemAnimationHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('xxwl_review_stats', '/xinxi/stats', XxwlStatsHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('xxwl_review_generate', '/xinxi/generate', XxwlReviewGenerateHandler, PRIV.PRIV_USER_PROFILE);
}
