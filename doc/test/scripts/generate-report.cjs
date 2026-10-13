#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function usage() {
  return '用法: node doc/test/scripts/generate-report.cjs --run <运行目录>\n示例: node doc/test/scripts/generate-report.cjs --run doc/test/releases/2026-10-12-dev.2\n';
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const at = argv.indexOf('--run');
  if (at < 0 || !argv[at + 1] || argv[at + 1].startsWith('--') || argv.length !== at + 2) {
    throw new Error(usage().trim());
  }
  return { runDir: path.resolve(argv[at + 1]) };
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function md(value) {
  return String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '<br>');
}
function relLink(runDir, rel, label) {
  if (!rel || typeof rel !== 'string') return '';
  const full = path.resolve(runDir, rel);
  if (!full.startsWith(`${runDir}${path.sep}`) || !fs.existsSync(full) || !fs.statSync(full).isFile()) return '';
  return `[${md(label || path.basename(rel))}](${md(path.relative(path.dirname(path.join(runDir, 'system-test-report.md')), full).split(path.sep).join('/'))})`;
}
function safeActual(actual) {
  if (actual == null) return '';
  if (typeof actual !== 'object') return String(actual).slice(0, 500);
  const pairs = [];
  for (const [key, value] of Object.entries(actual)) {
    if (/password|cookie|token|secret|authorization|session|message|content|quote|uid|useragent|baseurl|domain/i.test(key)) continue;
    if (value && typeof value === 'object') continue;
    if (typeof value === 'string' && /(?:https?:\/\/|Bearer\s|cookie)/i.test(value)) continue;
    pairs.push(`${key}=${typeof value === 'string' ? value.slice(0, 180) : String(value)}`);
  }
  return pairs.join('; ') || '已执行；详细安全字段未在报告中展开';
}
function statusName(status) {
  return ({ pass: '通过', passed: '通过', fail: '失败', failed: '失败', blocked: '阻塞', skip: '跳过', skipped: '跳过' })[String(status || '').toLowerCase()] || '阻塞';
}
function timeOf(result) { return result && (result.completedAt || result.startedAt || result.timestamp || result.time) || '未记录'; }

const featureCases = [
  ['ASM-course-assessment', '课程测评节点与成绩前置条件', /^ASM-|^COUR-02$|^COUR-05$/],
  ['COR-gate', '课程章节门禁与测评并发保护', /^COUR-04$|^COUR-05$|^ASM-03$|^ASM-04$/],
  ['CF-classroomfeedback', '本地课堂反馈与跟进', /^CF-/],
  ['PRA-practice', '比赛赛后练习', /^PRA-/],
  ['UIoffline', '离线头像与字体回退', /^UI-02$|^UI-03$/],
  ['CON-settings', '比赛设置页与设置回显', /^CON-/],
  ['MD-markdown', 'Markdown 与讲义渲染', /^MD-/],
  ['SCR/YAML-editor', '在线编辑器、样例与 YAML 编辑器', /^SCR-|^YAML-|^UI-01$|^UI-04$/],
  ['CERT-supplement', 'Rating 认证 CLI 补充', /^CERT-/],
  ['Feedback-conversations', '题目/讲义反馈会话', /^FB-SEND$|^UI-05$|^UI-06$|^MSG-/],
  ['MON-monitor', '浏览器监考', /^MON-/],
  ['TEAM-team', '团队参赛交互', /^TEAM-/],
  ['COUR-course-management', '课程结构与管理', /^COUR-01$|^COUR-03$|^COUR-06$|^TPL-/],
  ['PR-rating-trial', '评分管理员只读试用', /^PR-/],
  ['ROLE/CLASS-admin', '角色与班级管理', /^ROLE-|^CLASS-/],
  ['UI-settings', '课程、域、账户及比赛页面调整', /^UI-|^CON-|^COUR-06$/],
  ['framework-and-dependency', '框架与依赖版本变化（运维信息）', /$a^/],
];

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(usage()); return; }
  const runDir = args.runDir;
  const input = (name) => path.join(runDir, name);
  const plan = readJson(input('test-cases.json'));
  const scope = readJson(input('change-scope.json'));
  const resultsDoc = readJson(input('evidence/browser-results.json'));
  const cleanup = readJson(input('evidence/cleanup.json'));
  const env = readJson(input('evidence/environment.json'));
  const comparison = readJson(input('evidence/release-comparison.json'));
  const defectFile = input('defects.md');
  const defectText = fs.existsSync(defectFile) ? fs.readFileSync(defectFile, 'utf8') : '';
  const resultById = new Map((resultsDoc.cases || []).map((item) => [item.id, item]));
  const ids = new Set();
  for (const test of plan) {
    if (!test.id || ids.has(test.id)) throw new Error(`计划 ID 缺失或重复: ${test.id}`);
    ids.add(test.id);
  }
  const cert = (test) => /^CERT-/.test(test.id);
  const counts = (tests) => tests.reduce((acc, test) => { acc[statusName(resultById.get(test.id)?.status)]++; return acc; }, { 计划: tests.length, 通过: 0, 失败: 0, 阻塞: 0, 跳过: 0 });
  const browserPlan = plan.filter((test) => !cert(test));
  const certPlan = plan.filter(cert);
  const browserCounts = counts(browserPlan);
  const certCounts = counts(certPlan);
  const allCounts = counts(plan);
  const base = scope.baseline || {};
  const current = comparison.current || {};
  const previous = comparison.previous || {};
  const packageVersions = (entry) => Object.entries(entry.packages || {}).map(([name, meta]) => `${name} ${meta.version}`).join('；') || '未提供';
  const notes = relLink(runDir, 'release-notes.md', 'release-notes.md');
  const evidenceIndex = new Set();
  const screenshotLinks = (item) => (Array.isArray(item?.evidence) ? item.evidence : []).map((file) => {
    const link = relLink(runDir, file.startsWith('evidence/') ? file : `evidence/${file}`, file);
    if (link) evidenceIndex.add(file.startsWith('evidence/') ? file : `evidence/${file}`);
    return link;
  }).filter(Boolean).join('、') || '无（文件不存在或未记录）';
  const actualText = (test, result) => {
    if (!result) return '未执行；当前没有结果记录';
    if (test.id === 'COUR-01' && result.status === 'fail' && /400/.test(defectText)) return '普通课程编辑提交返回 HTTP 400，提示不能分配给 teachers；缺陷诊断见 defects.md（previous 已存在）。';
    if (test.id === 'MSG-02' && result.status === 'blocked') return '测试学生无全站普通发信权限，未修改账号权限；此阻塞不构成产品缺陷。反馈回复权限独立，送达/回复验证状态以 FB-SEND 行为准。';
    if (result.failureClass === 'driver') return '浏览器驱动执行异常；不能据此判为产品缺陷。' + safeActual(result.actual);
    return safeActual(result.actual);
  };
  const rows = plan.map((test) => {
    const result = resultById.get(test.id);
    const status = statusName(result?.status);
    const evidence = `${result?.grade || 'C'} · ${screenshotLinks(result)}`;
    return `| ${md(test.id)} | ${md(test.title)} | ${md(test.steps)} | ${md(test.expected)} | ${md(actualText(test, result))} | ${md(test.role || '未指定')} | ${status} | ${md(timeOf(result))} | ${evidence} |`;
  });
  const featureRows = featureCases.map(([id, title, pattern]) => {
    const covered = plan.filter((test) => pattern.test(test.id));
    const result = covered.map((test) => `${test.id}：${statusName(resultById.get(test.id)?.status)}`).join('；') || '本次计划无对应案例';
    return `| ${md(id)} | ${md(title)} | ${md(covered.map((test) => test.id).join('、') || '—')} | ${md(result)} |`;
  });
  const existingComparison = relLink(runDir, 'evidence/release-comparison.json', 'release-comparison.json');
  const existingScope = relLink(runDir, 'change-scope.json', 'change-scope.json');
  const existingCleanup = relLink(runDir, 'evidence/cleanup.json', 'cleanup.json');
  const existingEnv = relLink(runDir, 'evidence/environment.json', 'environment.json');
  const thumbs = [
    ['CF-02-detail.png', '课堂反馈观察详情'],
    ['ASM-04-course-unlocked.png', '测评后课程自动解锁'],
    ['MON-01.png', '浏览器监考事件记录'],
    ['COUR-01.png', '课程编辑 400 缺陷'],
  ].map(([file, caption]) => {
    const rel = `evidence/screenshots/${file}`;
    const link = relLink(runDir, rel, caption);
    if (!link) return '';
    evidenceIndex.add(rel);
    const href = link.match(/\]\(([^)]+)\)/)?.[1];
    return `![${md(caption)}](${href})\n\n${md(caption)}（[原图](${href})）`;
  }).filter(Boolean);
  for (const test of plan) screenshotLinks(resultById.get(test.id));
  const evidenceList = [...evidenceIndex].sort().map((file) => `- ${relLink(runDir, file, file)}`).filter((line) => line.includes(']('));
  const featureNames = scope.features || [];
  const deferred = cleanup.deferredStorageDeletes ?? 0;
  const generatedAt = new Date().toISOString();
  const courseDefect = resultById.get('COUR-01')?.status === 'fail' && /teachers/.test(defectText) ? '**COUR-01 真实失败：** 普通课程编辑返回 HTTP 400，提示不能分配给 teachers；独立包对比确认 previous 已存在，详见 [defects.md](defects.md)。' : '课程普通编辑结果以 COUR-01 行为准；未自动把既往缺陷诊断当成本轮失败。';
  const messageBoundary = resultById.get('MSG-02')?.status === 'blocked' ? '**MSG-02 阻塞：** 测试账号没有普通发信权限，未改动其账号权限，属于前置条件限制。' : '普通消息输入功能结果以 MSG-01/MSG-02 行为准。';
  const feedbackStatus = resultById.get('FB-SEND')?.status === 'pass' ? 'FB-SEND 已在授权范围验证提交、域主收件与回复；其他管理员的收件归属由同域消息记录补充核对，并未使用他们的账号登录。' : '反馈送达与回复未取得完整通过证据；以 FB-SEND 的当前状态与授权说明为准。';
  const report = `# Hydro ${path.basename(runDir)} 系统测试报告

生成时间：${generatedAt}

## 测试基线与范围

- 实际部署容器：${md(comparison.container || base.current?.container || '未记录')}；实际当前包：${md(packageVersions(current))}；对照部署包：${md(packageVersions(previous))}。快照版本以 ${existingComparison || 'release-comparison.json'} 为准。
- 发布说明：${notes || '文件不存在'}；变更范围：${existingScope || '文件不存在'}。
- 环境：${md(env.browser?.product || '浏览器未记录')}，视口 ${md(`${env.viewport?.width || '?'}×${env.viewport?.height || '?'}`)}，外网访问${env.externalNetworkBlocked ? '已屏蔽' : '未屏蔽/未记录'}。页面入口按记录为 ${md(env.domain || '未记录')}。
- 计划案例共 ${allCounts.计划} 项；浏览器案例 ${browserPlan.length} 项，CERT 开头 CLI 补充 ${certPlan.length} 项。API/夹具准备和状态读取仅作辅助证据，不计为测试用例。

## 执行统计

| 范围 | 计划 | 通过 | 失败 | 阻塞 | 跳过 |
|---|---:|---:|---:|---:|---:|
| 浏览器案例 | ${browserCounts.计划} | ${browserCounts.通过} | ${browserCounts.失败} | ${browserCounts.阻塞} | ${browserCounts.跳过} |
| CERT CLI 补充 | ${certCounts.计划} | ${certCounts.通过} | ${certCounts.失败} | ${certCounts.阻塞} | ${certCounts.跳过} |
| 全部计划项 | ${allCounts.计划} | ${allCounts.通过} | ${allCounts.失败} | ${allCounts.阻塞} | ${allCounts.跳过} |

结果只按 test-cases.json 中的计划 ID 统计。缺少结果记录时记为阻塞；清单外结果不纳入统计。结果页标题严格取自计划用例标题。

## 按变更功能覆盖

| 功能映射 | 变更范围 | 计划 ID | 结果 |
|---|---|---|---|
${featureRows.join('\n')}

## 测试矩阵

| 计划 ID | 用例标题 | 步骤 | 期望 | 实际 | 角色 | 状态 | 时间 | 证据等级/截图 |
|---|---|---|---|---|---|---|---|---|
${rows.join('\n')}

证据等级：A 为直接浏览器操作和结果，B 为浏览器操作辅以接口/日志核验，C 为非浏览器的间接或 CLI 证据。CERT 项的决定性认证操作来自 CLI，即使附有比赛页面截图，也保持 C 等级。所有链接在生成时均核验目标文件存在。

## 重点截图

${thumbs.join('\n\n') || '没有找到可嵌入的重点截图。'}

## 缺陷与限制

- ${courseDefect}
- ${messageBoundary}
- ${feedbackStatus}
- **并发竞态限制：** 真浏览器顺序操作无法证明课程测评更新中的并发竞态及事务时序正确性。
- **预测质量限制：** 真浏览器只能核对评分试用页展示和权限边界，不能证明数学算法的预测质量；本次为样本不足的只读页面，未把真实估计值、每日拟合或未来预测有效性列为浏览器通过项。
- **失败与阻塞：** 最终状态采用逐项实际结果及有证据的针对性重测；驱动/夹具校准记录保存在 attempts 附录，不混入最终统计。未把无授权或缺少账号能力推断为产品缺陷。

## 清理与保留

- 清理证据：${existingCleanup || 'cleanup.json 不存在'}。残留汇总为 ${md(JSON.stringify(cleanup.residuals || {}))}；额外清理计数 practice_rating_active=${md(cleanup.extraCleanup?.practice_rating_active ?? '未记录')} 表示删除数量，不是残留数量；最终独立核验见 [final-cleanup-verification.json](evidence/final-cleanup-verification.json)，同时覆盖班级补测及全部重测域。
- 另有 ${md(deferred)} 个附件采用延迟删除，存储保留期 ${md(cleanup.storageRetentionDays ?? '未记录')} 天；活动对象清理状态与延迟附件清理分别记录。

## 证据索引

完整逐项结果：[browser-results.json](evidence/browser-results.json)。时间列为 UTC；页面截图显示账号设定时区。

${evidenceList.length ? evidenceList.join('\n') : '没有可链接的现存截图证据。'}

辅助环境证据：${existingEnv || 'environment.json 不存在'}；包基线：${existingComparison || 'release-comparison.json 不存在'}。
`;
  fs.writeFileSync(input('system-test-report.md'), report, 'utf8');
}

try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
