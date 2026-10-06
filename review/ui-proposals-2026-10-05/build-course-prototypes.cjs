// Generate the review-only static course prototypes; no service or database calls.
const fs = require('node:fs');
const path = require('node:path');
const out = __dirname;
const generated = new Set();
const students = [
  ['陈子涵', 'Accepted', 'pass', '核对过', '刚刚'],
  ['林逸凡', 'Wrong Answer', 'fail', '指导过', '1 分钟前'],
  ['王梓晨', '未提交', 'muted', '—', ''],
  ['刘嘉乐', 'Accepted', 'pass', '—', ''],
  ['何雨桐', 'Wrong Answer', 'fail', '需复测', '8 分钟前'],
  ['张思源', '未提交', 'muted', '指导过', '10 分钟前'],
  ['周亦辰', 'Accepted', 'pass', '需复测', '12 分钟前'],
  ['徐安琪', '未提交', 'muted', '—', ''],
];
const scoreCells = [[100,100,0],[0,100,null],[null,null,null],[100,100,100],[0,null,null],[null,0,null],[100,100,null],[null,null,null]];
const problems = [['P103','数字反转'],['P104','循环求和'],['P105','数位统计']];
const nav = [['content','课程内容','course-content.html'],['progress','课程进度','course-progress.html'],['feedback','课程反馈','course-feedback.html'],['manage','课程管理','course-manage.html']];
const button = (text, href, primary = false) => `<a class="button compact${primary ? ' primary' : ''}" href="${href}">${text}</a>`;
const student = (name) => `<span class="student-name"><span class="avatar" aria-hidden="true">${name[0]}</span><span>${name}</span></span>`;
const title = (text, sub = '', action = '') => `<div class="section__header"><h1 class="section__title">${text}${sub ? `<small>${sub}</small>` : ''}${action}</h1></div>`;
const tabs = (items, active) => `<nav class="native-tabs" aria-label="页面视图">${items.map(([key,text,href]) => `<a ${key === active ? 'class="active" aria-current="page"' : ''} href="${href}">${text}</a>`).join('')}</nav>`;
const feedbackTabs = (active, done = false, empty = false) => tabs([
  ['record','随手记录','course-feedback.html'],
  ['pending',`待复测 <span class="inline-count">${empty ? 0 : done ? 1 : 2} 条</span>`,empty ? 'pending-retests-empty.html' : done ? 'pending-retests-done.html' : 'pending-retests.html'],
  ['history','最近记录','course-feedback-history.html'],
], active);
const manageTabs = (active) => tabs([
  ['members','班级成员管理','course-manage.html'],
  ['extra','临时调课学生','course-manage-extra.html'],
  ['nodes','课程节点管理','course-manage-nodes.html'],
], active);
function sidebar(active, done = false, empty = false, zhouDone = false) {
  return `<aside><section class="section side"><div class="course-banner"><h2>GESP 二级 · 春季班</h2><p>第 3 课 · 循环练习</p><p>8 位学生 · 教师：李老师</p></div><ol class="menu">${nav.map(([key,text,href]) => `<li><a class="menu__link ${key === active ? 'active' : ''}" ${key === active ? 'aria-current="page"' : ''} href="${href}">${text}</a></li>`).join('')}</ol></section><section class="section side" id="pending-list"><div class="section__header"><h2 class="section__title pending-title">待复测<span class="retest">${empty ? 0 : done || zhouDone ? 1 : 2} 条观察</span></h2></div>${!done && !empty ? '<div class="pending-item"><a href="retest-detail.html">何雨桐</a><p>数字反转 · 题意理解</p></div>' : ''}${!empty && !zhouDone ? '<div class="pending-item"><a href="retest-detail-zhou.html">周亦辰</a><p>数字反转 · 边界</p></div>' : empty ? '<div class="pending-item muted">当前没有待复测记录</div>' : ''}<div class="section__footer"><a href="${empty ? 'pending-retests-empty.html' : done ? 'pending-retests-done.html' : zhouDone ? 'pending-retests-zhou-done.html' : 'pending-retests.html'}">查看待复测清单 →</a></div></section></aside>`;
}
function shell(active, label, main, options = {}) {
  const page = options.full ? main : `<div class="layout"><div>${main}</div>${sidebar(active, options.done, options.empty, options.zhouDone)}</div>`;
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${label} · HydroOJ 课程原型</title><link rel="stylesheet" href="hydro-native.css"><link rel="stylesheet" href="proposals.css"><link rel="stylesheet" href="course-prototypes.css"></head><body><div class="prototype-bar"><div class="prototype-bar-inner"><span>A + B 组合 · 静态原型 · 示例数据，不保存</span><nav class="proposal-links" aria-label="原型导航"><a href="index.html">设计总览</a><a href="course-feedback.html">名单记录 A</a><a href="course-progress-record.html">原位记录 B</a></nav></div></div><header class="nav"><div class="nav-inner"><img class="native-logo" src="hydro-logo.png" alt="Hydro"><span class="nav__item">首页</span><span class="nav__item">题库</span><a class="nav__item nav--active" href="course-content.html">课程</a><span class="nav__item">评测记录</span><span class="nav-account">李老师 ▾</span></div></header><main class="page"><div class="breadcrumb"><a href="course-content.html">课程</a><span>›</span><a href="course-content.html">GESP 二级 · 春季班</a><span>›</span>${label}</div>${page}</main><footer class="native-footer">HydroOJ 原生样式 · 课程界面静态确认稿</footer></body></html>`;
}
const write = (name, content) => {
  if (name === 'course-feedback-saved.html') content = content.replace(/\sid="student-\d+"/g, '');
  fs.writeFileSync(path.join(out, name), content); generated.add(name);
};
const section = (body) => `<section class="section">${body}</section>`;
const recordExplanation = `<div class="section__footer"><details><summary>记录说明</summary><p>记录实际发生的指导、核对和复测需要。备注与细项可空；未提交的学生也可以记录。“核对过”只表示做过核对。所有观察仅供有权限的教师查看。</p></details></div>`;
function actions(name, origin = 'roster', problemIndex = 0) {
  const studentIndex = students.findIndex(s => s[0] === name);
  const quick = studentIndex === 1 && problemIndex === 0;
  const target = quick ? (origin === 'progress' ? 'course-progress-saved.html' : 'course-feedback-saved.html') : 'record-result.html';
  return `<div class="table-actions">${['指导过','核对过','需复测'].map((kind, i) => button(kind, `${target}#${quick ? '' : `${origin}-${studentIndex}-${problemIndex}-`}${['guided','checked','retest'][i]}`)).join('')}</div>`;
}
function optionalNote(name) {
  return `<details class="row-note"><summary aria-label="给${name}加备注或细项">备注 ▾</summary><div class="note-box field-stack"><label>细项（可空）<select class="select"><option>不指定细项</option><optgroup label="指导过"><option>思路指导</option><option>调试指导</option></optgroup><optgroup label="核对过"><option>思路核对</option><option>边界核对</option><option>代码解释</option></optgroup><optgroup label="需复测"><option>题意理解</option><option>边界</option><option>迁移练习</option></optgroup></select></label><label>备注（可空）<textarea class="textbox" maxlength="500" placeholder="例如：提醒后能自行检查边界"></textarea></label><span class="muted small">再点对应动作记录。</span></div></details>`;
}
const context = (p = 0) => `<div class="context"><label>当前课时<select class="select"><option>第 3 课 · 循环练习</option></select></label><label>当前题目<select class="select">${problems.map(([pid,name],j) => `<option ${j === p ? 'selected' : ''}>${pid} · ${name}</option>`).join('')}</select></label><label class="search">找学生<input class="textbox" type="search" placeholder="姓名或用户名"></label></div>`;
function receipt(text, href, linkText = '撤销这次记录') { return `<div class="save-receipt">✓ ${text}<a href="${href}">${linkText}</a></div>`; }
function roster(saved = false, target = '林逸凡', kind = '指导过', p = 0) {
  const rows = students.map(([name,status,color,observation,time],i) => {
    if (p) { const score = scoreCells[i][p]; status = score === null ? '未提交' : score === 100 ? 'Accepted' : 'Wrong Answer'; color = score === null ? 'muted' : score === 100 ? 'pass' : 'fail'; observation = '—'; time = ''; }
    if (saved && name === target) observation = kind;
    return `<tr id="student-${i}"><td>${student(name)}</td><td><span class="${color}">${status}</span></td><td><span class="${observation === '需复测' ? 'retest' : observation === '—' ? 'muted' : ''}">${saved && name === target ? kind : observation}</span>${time ? `<small class="muted">${saved && name === target ? '刚刚' : time}</small>` : ''}</td><td>${actions(name,'roster',p)}</td><td>${optionalNote(name)}</td></tr>`;
  }).join('');
  return section(`${title('课程反馈','本题名单 · 8 位学生')}${feedbackTabs('record')}${context(p)}${saved ? receipt(`已记录 ${target} · ${kind}`, 'record-retract-confirm.html') : ''}<div class="section__body no-padding table-scroll"><table class="data-table roster-table feedback-table"><colgroup><col class="col-name"><col class="col-status"><col class="col-observation"><col class="col-actions"><col class="col-optional"></colgroup><thead><tr><th>学生</th><th>提交状态</th><th>最近观察</th><th>随手记录</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>${recordExplanation}`);
}
write('course-feedback.html', shell('feedback','课程反馈',roster()));
write('course-feedback-saved.html', shell('feedback','课程反馈',`<div class="saved-options">${['指导过','核对过','需复测'].map((kind,j) => `<div id="${['guided','checked','retest'][j]}" class="record-state">${roster(true,'林逸凡',kind)}</div>`).join('')}</div>`));
const resultStates = [];
for (const origin of ['roster','progress']) for (const [i,s] of students.entries()) for (const [p,[pid,name]] of problems.entries()) for (const [j,kind] of ['指导过','核对过','需复测'].entries()) {
  const back = origin === 'progress' ? `course-progress.html#record-${i}-${p}` : (p ? `course-feedback-${pid.toLowerCase()}.html` : 'course-feedback.html');
  resultStates.push(`<div class="record-state" id="${origin}-${i}-${p}-${['guided','checked','retest'][j]}">${title('记录结果','示例状态')}<div class="section__body"><p class="page-purpose">${s[0]} · 第 3 课 · ${pid} ${name}</p>${receipt(`已记录 ${s[0]} · ${kind}`, 'record-retract-confirm.html')}<p class="small muted">${kind === '需复测' ? '实际接入后，这条观察进入待复测清单。' : '回到原位置可继续记录。'}</p>${button('返回原位置',back,true)}</div></div>`);
}
write('record-result.html',shell('feedback','课程反馈 › 记录结果',section(`<div class="saved-options">${resultStates.join('')}</div>`)));
const content = section(`${title('课程内容','4 个课时', '<a class="header-action" href="course-manage-nodes.html">管理课程节点 →</a>')}<div class="section__body"><p class="page-purpose">查看讲义和练习，沿课程章节进入学习。</p></div><div class="chapter"><div class="chapter-heading"><span class="chapter-number">01</span><h2>基础与条件语句</h2><span class="small muted">2 个课时</span></div><details class="lesson-summary"><summary>第 1 课 · 基础回顾 <span class="muted small">讲义已开放</span></summary><p>变量、输入输出与表达式。</p></details><details class="lesson-summary"><summary>第 2 课 · 条件练习 <span class="muted small">讲义已开放</span></summary><p>条件分支与大小比较。</p></details></div><div class="chapter"><div class="chapter-heading"><span class="chapter-number">02</span><h2>循环语句</h2><span class="small muted">2 个课时</span></div><article class="lesson-focus"><div class="lesson-heading"><h3>第 3 课 · 循环练习</h3><span class="inline-count">讲义、题目已开放</span></div><div class="table-actions">${button('阅读讲义','course-lecture.html',true)}${button('查看进度','course-progress.html')}${button('本课反馈','course-feedback.html')}</div><div class="problem-list">${problems.map(([pid,name]) => `<span><a href="course-lecture.html#${pid.toLowerCase()}">${pid} · ${name}</a></span><span class="muted">${pid === 'P105' ? '拓展练习' : '课堂练习'}</span><a href="course-feedback.html">本题反馈 →</a>`).join('')}</div></article><details class="lesson-summary"><summary>第 4 课 · 循环巩固 <span class="muted small">尚未开放</span></summary><p>循环的综合练习。教师可在课程节点管理中调整开放设置。</p></details></div><div class="section__footer">课程内容沿用原有讲义、题目与章节开放规则。</div>`);
let problemLinkIndex = 0;
write('course-content.html',shell('content','课程内容',content.replace(/<a href="course-feedback.html">本题反馈 →<\/a>/g, () => {
  const [pid] = problems[problemLinkIndex++];
  return `<a href="${pid === 'P103' ? 'course-feedback.html' : `course-feedback-${pid.toLowerCase()}.html`}">本题反馈 →</a>`;
})));
const lecture = section(`${title('第 3 课 · 循环练习','课程讲义')}<div class="course-toolbar">${button('返回课程内容','course-content.html')}${button('查看本课进度','course-progress.html')}${button('进入本课反馈','course-feedback.html')}<span class="muted small">讲义摘要示例</span></div><div class="section__body topic-copy"><h2>循环与数位处理</h2><p>这一课练习确定循环条件、更新循环变量，并检查边界。先用几组小数据推演，再运行程序核对结果。</p><h3>从个位开始处理一个整数</h3><p>用 <code>n % 10</code> 取个位，随后用 <code>n /= 10</code> 去掉已经处理的数位。</p><pre><code>while (n &gt; 0) {\n    int digit = n % 10;\n    // 使用 digit 完成当前这一步\n    n /= 10;\n}</code></pre>${problems.map(([pid,name],i) => `<article class="lesson-exercise" id="${pid.toLowerCase()}"><h3>${pid} · ${name}</h3><p>${['反转一个非负整数的十进制数位；结果以整数输出。例如 120 → 21。','给定非负整数 n，用循环求 1 到 n 的和；n 为 0 时结果为 0。','统计一个非负整数的十进制位数；0 的位数为 1。'][i]}</p>${button('查看本课进度','course-progress.html')}${button('记录本题观察',i === 0 ? 'course-feedback.html' : `course-feedback-${pid.toLowerCase()}.html`)}</article>`).join('')}</div>`);
write('course-lecture.html',shell('content','课程内容 › 讲义',lecture));
for (const [pid,name] of problems.slice(1)) {
  write(`course-feedback-${pid.toLowerCase()}.html`,shell('feedback','课程反馈',roster(false,'林逸凡','指导过',problems.findIndex(p => p[0] === pid))));
}
function progress(open = false, saved = false) {
  const rows = students.map(([name], i) => {
    let row = `<tr><td>${student(name)}</td>${scoreCells[i].map((score,j) => `<td><span class="${score === null ? 'muted' : score === 100 ? 'pass' : 'fail'}">${score === null ? '—' : score}<small class="judged-state">${score === null ? '未提交' : score === 100 ? 'Accepted' : 'Wrong Answer'}</small></span><a class="cell-note" href="#record-${i}-${j}">记录 ▾</a></td>`).join('')}<td class="score-total">${scoreCells[i].reduce((s,v) => s + (v || 0),0)}</td></tr>`;
    for (const [j,[pid,problemName]] of problems.entries()) row += `<tr class="inline-feedback ${i === 1 && j === 0 ? 'default-record' : ''}" id="record-${i}-${j}"><td colspan="5"><div class="inline-panel"><div class="target"><strong>${name} · ${pid} ${problemName}</strong><br>第 3 课 · ${scoreCells[i][j] === null ? '当前未提交' : `最新提交：${scoreCells[i][j] === 100 ? 'Accepted' : 'Wrong Answer'}`}</div>${actions(name,'progress',j)}</div><details class="inline-optional"><summary>加备注或细项（可空）</summary><div class="field-stack"><label>细项<select class="select"><option>不指定细项</option><option>思路指导</option><option>调试指导</option><option>思路核对</option><option>边界核对</option><option>代码解释</option><option>题意理解</option><option>边界</option><option>迁移练习</option></select></label><label>备注<textarea class="textbox" maxlength="500" placeholder="例如：提醒后能自行检查边界"></textarea></label></div></details><div class="inline-optional"><a href="course-progress.html">收起记录 ▴</a></div></td></tr>`;
    return row;
  }).join('');
  return section(`${title('课程进度','评测结果', '<a class="header-action" href="course-feedback.html">转到名单记录 →</a>')}<div class="context"><label>当前课时<select class="select"><option>第 3 课 · 循环练习</option></select></label><span class="small muted">8 位学生 · 3 道题</span></div>${saved ? receipt(`已记录 林逸凡 · ${saved}`,'record-retract-confirm.html') : ''}<div class="section__body no-padding table-scroll"><table class="data-table scoreboard ${open ? 'progress-open' : ''}"><colgroup><col class="col-user"><col><col><col><col style="width:9%"></colgroup><thead><tr><th>学生</th>${problems.map(([pid,name]) => `<th><a href="course-lecture.html#${pid.toLowerCase()}">${pid} · ${name}</a><small>满分 100</small></th>`).join('')}<th>总分</th></tr></thead><tbody>${rows}</tbody></table></div><div class="legend"><span class="pass">100 · Accepted</span><span class="fail">0 · Wrong Answer</span><span>— · 未提交</span></div><div class="section__footer">沿用现有课程成绩口径。教师可在格内记录观察；观察不会改变分数。</div>`);
}
write('course-progress.html',shell('progress','课程进度',progress()));
write('course-progress-record.html',shell('progress','课程进度',progress(true)));
write('course-progress-saved.html',shell('progress','课程进度',`<div class="saved-options">${['指导过','核对过','需复测'].map((kind,j) => { const slug = ['guided','checked','retest'][j]; return `<div id="${slug}" class="record-state">${progress(true,kind).replace(/(id="record-|href="#record-)/g,m => m.replace('record-',`${slug}-record-`))}</div>`; }).join('')}</div>`));
const history = section(`${title('课程反馈','原始观察与跟进记录')}${feedbackTabs('history')}<div class="context list-filter"><label>学生<select class="select"><option>全部学生</option><option>何雨桐</option><option>林逸凡</option></select></label><label>题目<select class="select"><option>全部题目</option><option>P103 · 数字反转</option></select></label></div><div class="observations">${[
  ['陈子涵','核对过','刚刚','已核对边界与循环退出条件。',''],
  ['林逸凡','指导过','1 分钟前','提醒后发现末尾 0 的处理问题。',''],
  ['何雨桐','需复测','8 分钟前','能复述题意，但对 120 的输出仍需确认。','retest-detail.html'],
  ['张思源','指导过','10 分钟前','讨论了循环变量如何更新；尚无提交。',''],
  ['周亦辰','需复测','12 分钟前','评测已通过，仍需口头检查输入 0 的边界。','retest-detail-zhou.html'],
].map(([name,kind,time,note,href]) => `<article class="observation-row"><div>${student(name)}</div><div class="event-body"><span class="event-kind ${kind === '需复测' ? 'retest' : ''}">${kind}</span>P103 · 数字反转<p class="event-note">${note}</p><p class="event-meta">第 3 课 · 李老师记录 · ${time}</p></div><div class="event-link">${href ? `<a href="${href}">待复测 →</a>` : '<a href="record-retract-confirm.html">撤销记录</a>'}</div></article>`).join('')}</div><div class="section__footer">默认按时间显示最近记录；已撤销、已跟进记录保留事件历史。</div>`);
write('course-feedback-history.html',shell('feedback','课程反馈',history));
const pendingFilters = `<div class="context list-filter"><label>学生<select class="select"><option>全部学生</option><option>何雨桐</option><option>周亦辰</option></select></label><label>题目<select class="select"><option>全部题目</option><option>P103 · 数字反转</option></select></label><span class="muted small">按记录时间显示</span></div>`;
function pendingItem(name, zhou = false, onlyRemaining = false) {
  return `<article class="followup-row"><div>${student(name)}<p class="followup-context">李老师记录</p></div><div><a class="followup-topic" href="${zhou ? 'retest-detail-zhou.html' : 'retest-detail.html'}">P103 · 数字反转</a><p class="followup-context">第 3 课 · ${zhou ? '边界 · 12 分钟前' : '题意理解 · 8 分钟前'}</p><p class="followup-note">${zhou ? '评测已通过，仍需口头检查输入 0 的边界。' : '能复述题意，但对 120 的输出仍需确认。'}</p><p class="followup-context">最新提交：<span class="${zhou ? 'pass' : 'fail'}">${zhou ? 'Accepted' : 'Wrong Answer'}</span></p><details class="followup-optional"><summary>加跟进备注（可空）</summary><textarea class="textbox" maxlength="500" placeholder="例如：学生已重新演算边界，继续观察"></textarea></details></div><div class="followup-actions">${button('完成跟进',onlyRemaining ? 'pending-retests-empty.html' : zhou ? 'pending-retests-zhou-done.html' : 'pending-retests-done.html',true)}<br><a href="${zhou ? 'retest-detail-zhou.html' : 'retest-detail.html'}">查看上下文 →</a></div></article>`;
}
function pending(done = false, empty = false, zhouDone = false) {
  return section(`${title('待复测',`${empty ? 0 : done || zhouDone ? 1 : 2} 条观察待跟进`)}${feedbackTabs('pending',done || zhouDone,empty)}${empty ? receipt('待复测观察已全部跟进','retest-done.html','查看处理示例') : done || zhouDone ? receipt(`${zhouDone ? '周亦辰' : '何雨桐'}的复测跟进已完成`,zhouDone ? 'retest-done-zhou.html' : 'retest-done.html','查看处理记录') : ''}${pendingFilters}${empty ? '<div class="empty-state"><h2>当前没有待复测记录</h2><p>课堂中遇到需要再确认的情况，点一次“需复测”即可加入清单。</p>'+button('返回名单继续记录','course-feedback.html',true)+'</div>' : (done ? '' : pendingItem('何雨桐',false,zhouDone))+(zhouDone ? '' : pendingItem('周亦辰',true,done))}<div class="section__footer">每条待办对应一次“需复测”观察。“完成跟进”记录教师已处理这次待办；提交通过不会自动关闭待办。</div><div class="prototype-state">状态示例：<a href="pending-retests.html">待跟进 2 条</a><a href="pending-retests-done.html">处理一条后</a><a href="pending-retests-empty.html">清单为空</a><a href="retest-done.html">已跟进记录</a></div>`);
}
write('pending-retests.html',shell('feedback','课程反馈 › 待复测',pending()));
write('pending-retests-done.html',shell('feedback','课程反馈 › 待复测',pending(true),{done:true}));
write('pending-retests-zhou-done.html',shell('feedback','课程反馈 › 待复测',pending(false,false,true).replaceAll('href="pending-retests-done.html"','href="pending-retests-zhou-done.html"'),{zhouDone:true}));
write('pending-retests-empty.html',shell('feedback','课程反馈 › 待复测',pending(true,true),{done:true,empty:true}));
function retestDetail(zhou = false, done = false) {
  const name = zhou ? '周亦辰' : '何雨桐';
  return section(`${title('复测跟进',`${name} · ${done ? '已跟进' : '待跟进'}`,'<a class="header-action" href="'+(done ? 'pending-retests-done.html' : 'pending-retests.html')+'">返回清单 →</a>')}<div class="detail-keyline"><strong>${name} · P103 数字反转</strong><p>GESP 二级 · 第 3 课 · ${zhou ? '边界' : '题意理解'}</p></div><div class="event-timeline"><article class="timeline-item"><h3><span class="retest">需复测</span> <small>李老师 · ${zhou ? '12' : '8'} 分钟前</small></h3><p>${zhou ? '评测已通过，仍需口头检查输入 0 的边界。' : '能复述题意，但对 120 的输出仍需确认。'}</p></article><article class="timeline-item"><h3>最新提交 <small>${zhou ? '11' : '6'} 分钟前</small></h3><p><span class="${zhou ? 'pass' : 'fail'}">${zhou ? 'Accepted · 100 分' : 'Wrong Answer · 0 分'}</span><br>可作为复测的参考，仍由教师判断是否需要继续观察。</p><p><a href="submission-preview.html">查看提交代码与评测 →</a></p></article>${done ? '<article class="timeline-item current"><h3><span class="pass">已完成跟进</span> <small>李老师 · 刚刚</small></h3><p>未填写跟进备注。原始观察和本次处理记录均保留。</p></article>' : ''}</div><div class="section__body">${done ? `<p class="small muted">之后仍需确认时，新增一次“需复测”观察。</p><div class="detail-actions">${button('回到待复测清单','pending-retests-done.html')}${button('新增一次需复测','course-feedback.html#student-4',true)}</div>` : `<details class="followup-optional"><summary>添加跟进备注或关联提交（可空）</summary><div class="field-stack"><label>跟进备注<textarea class="textbox" maxlength="500" placeholder="记录这次复测实际做了什么，可留空"></textarea></label><label>关联提交编号<input class="textbox" placeholder="可选，填本次检查的提交编号"></label></div></details><div class="detail-actions"><a class="small" href="record-retract-confirm.html">撤销这条观察</a>${button('完成跟进',zhou ? 'pending-retests-empty.html' : 'pending-retests-done.html',true)}</div>`}</div><div class="section__footer">完成跟进只关闭这次待办，不修改题目成绩或判定学生已经掌握。</div>`);
}
write('retest-detail.html',shell('feedback','课程反馈 › 复测跟进',retestDetail()));
write('retest-detail-zhou.html',shell('feedback','课程反馈 › 复测跟进',retestDetail(true).replaceAll('submission-preview.html','submission-preview-zhou.html').replaceAll('pending-retests-empty.html','pending-retests-zhou-done.html')));
write('retest-done.html',shell('feedback','课程反馈 › 已跟进记录',retestDetail(false,true),{done:true}));
write('retest-done-zhou.html',shell('feedback','课程反馈 › 已跟进记录',retestDetail(true,true).replaceAll('pending-retests-done.html','pending-retests-zhou-done.html').replaceAll('student-4','student-6').replaceAll('submission-preview.html','submission-preview-zhou.html'),{zhouDone:true}));
write('submission-preview.html',shell('feedback','复测参考 › 提交记录',section(`${title('提交记录','题目与评测上下文摘要')}<div class="detail-keyline"><strong>何雨桐 · P103 数字反转</strong><p>第 3 课 · 6 分钟前 · C++11 · <span class="fail">Wrong Answer</span></p></div><div class="section__body topic-copy"><p>这里对接既有提交详情页。示例展示教师为什么需要复测，不另建代码编辑器。</p><pre><code>int reversed = 0;\nwhile (n &gt; 0) {\n    reversed = reversed * 10 + n % 10;\n    n /= 10;\n}\n// 继续核对学生对题意和边界的解释。</code></pre><div class="detail-actions">${button('返回复测跟进','retest-detail.html',true)}${button('查看课程进度','course-progress.html')}</div></div>`)));
write('submission-preview-zhou.html',fs.readFileSync(path.join(out,'submission-preview.html'),'utf8').replaceAll('何雨桐','周亦辰').replaceAll('6 分钟前','11 分钟前').replaceAll('class="fail">Wrong Answer','class="pass">Accepted').replaceAll('retest-detail.html','retest-detail-zhou.html'));
function manageRows(extra = false) {
  const entries = extra ? students.slice(6) : students.slice(0,6);
  return entries.map(([name], i) => `<tr><td class="muted">${1001 + (extra ? 6 : 0) + i}</td><td>${student(name)}</td><td><span class="${extra && i === 1 ? 'muted' : 'pass'}">${extra && i === 1 ? '未认领' : '已认领'}</span></td><td>${extra ? '不计排名' : '参与排名'}</td><td><div class="table-actions">${button(extra && i === 1 ? '代认领' : '取消认领','manage-action-confirm.html')}${button(extra ? '恢复排名' : '设为不计排名','manage-action-confirm.html')}</div></td></tr>`).join('');
}
function manage(extra = false) {
  return section(`${title('课程管理','课程认领、排名与开放设置','<a class="header-action" href="course-edit-preview.html">编辑课程 →</a>')}${manageTabs(extra ? 'extra' : 'members')}<div class="course-toolbar">${extra ? button('编辑临时调课学生','course-edit-preview.html#extra-students',true) : button('批量代认领','manage-action-confirm.html',true)+button('批量取消认领','manage-action-confirm.html')}${button('全课程不计排名','manage-action-confirm.html')}${button('全课程恢复排名','manage-action-confirm.html')}</div><p class="manage-hint">${extra ? '临时调课学生来自课程中的额外学生名单，保留原有认领与排名设置。' : '班级成员来自既有班级名单；这里管理其课程认领和排名状态。'}</p><div class="section__body no-padding table-scroll"><table class="data-table manage-table"><thead><tr><th>UID</th><th>学生</th><th>课程认领</th><th>排名状态</th><th>操作</th></tr></thead><tbody>${manageRows(extra)}</tbody></table></div><div class="section__footer">课堂观察统一在“课程反馈”记录。课程编辑与管理权限沿用原有规则。</div>`);
}
write('course-manage.html',shell('manage','课程管理',manage()));
write('course-manage-extra.html',shell('manage','课程管理',manage(true)));
const nodes = section(`${title('课程管理','课程节点设置')}${manageTabs('nodes')}<div class="course-toolbar"><span class="small muted">全部节点：</span>${button('开放讲义','manage-action-confirm.html')}${button('关闭讲义','manage-action-confirm.html')}${button('开放题目','manage-action-confirm.html')}${button('关闭题目','manage-action-confirm.html')}${button('重置题目开放','manage-reset-confirm.html')}</div><div class="section__body no-padding table-scroll"><table class="data-table manage-table node-rows"><thead><tr><th>节点</th><th>课时</th><th>讲义</th><th>题目</th></tr></thead><tbody>${['基础回顾','条件练习','循环练习','循环巩固'].map((name,i) => `<tr><td class="muted">${i+1}</td><td>第 ${i+1} 课 · ${name}</td><td><span class="${i === 3 ? 'muted' : 'pass'}">${i === 3 ? '未开放' : '已开放'}</span> · <a href="course-lecture.html">查看讲义</a><div class="table-actions">${button('编辑','course-edit-preview.html')}${button('开放','manage-action-confirm.html')}${button('关闭','manage-action-confirm.html')}</div></td><td>${i === 2 ? 'P103 / P104 / P105' : '本课练习'}<div class="table-actions">${button('开放','manage-action-confirm.html')}${button('关闭','manage-action-confirm.html')}${button('重置','manage-reset-confirm.html')}</div></td></tr>`).join('')}</tbody></table></div><div class="section__footer">“重置”清除手工题目开放设置，之后按课程原有开放规则计算。</div>`);
write('course-manage-nodes.html',shell('manage','课程管理',nodes));
const edit = section(`${title('编辑课程','沿用既有编辑入口')}<div class="section__body field-stack"><p class="page-purpose">以下为现有字段的布局摘要；完整章节、前置条件与课程规则仍使用既有编辑页。</p><label>课程名称<input class="textbox" value="GESP 二级 · 春季班"></label><label>课程班级<select class="select"><option>GESP 二级春季班</option></select></label><label id="extra-students">临时调课学生 UID<input class="textbox" value="1007,1008"></label><label><input type="checkbox" checked> 公开课程成绩</label><label><input type="checkbox"> 启用迟交罚分</label><label>每课课时长度（小时）<input type="number" class="textbox" value="2"></label><div class="detail-actions">${button('返回课程管理','course-manage.html',true)}</div></div>`);
write('course-edit-preview.html',shell('manage','课程管理 › 编辑课程',edit));
function confirm(label, copy, back) {
  return `<div class="native-confirm"><h2>${label}</h2><p>${copy}</p><div class="detail-actions">${button('返回',''+back)}<span class="small muted">静态示例，无实际操作</span></div></div>`;
}
write('manage-action-confirm.html',shell('manage','课程管理 › 操作确认',confirm('课程管理操作确认','实施时沿用既有操作，并明确展示当前操作、学生范围和影响。<br>单个学生操作与全课程批量操作分别显示作用对象。','course-manage.html')));
write('manage-reset-confirm.html',shell('manage','课程管理 › 重置题目开放',confirm('重置题目开放设置？','清除所选课程节点的手工题目开放设置。下一次按课程原有规则重新计算可访问题目。<br>学生提交、成绩和教师观察记录保留。','course-manage-nodes.html')));
write('record-retract-confirm.html',shell('feedback','课程反馈 › 撤销记录',confirm('撤销这条观察？','仅在误点或记录有误时使用。撤销后保留原始观察和撤销事件；“需复测”被撤销后移出待办。<br>实施时展示这条记录的学生、题目、动作与时间，并校验撤销权限。','course-feedback-history.html')));
const definitions = [
  ['课程内容','教什么、练什么','原有章节、讲义、题目与开放状态。','course-content.html'],
  ['课程进度','系统里做到了哪一步','既有评测成绩；在学生 × 题目格里展开 B 记录。','course-progress.html'],
  ['课程反馈','教师实际看到了什么','A 名单一键记录；查看最近观察与复测跟进。','course-feedback.html'],
  ['课程管理','课程如何运行','保留认领、排名、临时调课与节点开放管理。','course-manage.html'],
  ['待复测','还有哪些观察需要跟进','属于课程反馈，按观察列待办；教师点击完成跟进。','pending-retests.html'],
];
const overview = section(`<div class="design-intro"><h1>课程界面 · A + B 组合确认稿</h1><p>保留已确认的 HydroOJ 表格与右侧课程导航。A 负责整班连续记录，B 负责看进度时顺手记录，两处保存到同一份课程反馈。</p></div><div class="section__body no-padding table-scroll"><table class="data-table definition-table"><thead><tr><th>页面</th><th>回答的日常问题</th><th>页面职责</th><th>打开原型</th></tr></thead><tbody>${definitions.map(([name,question,meaning,href]) => `<tr><td>${name}</td><td>${question}</td><td>${meaning}</td><td><a href="${href}">查看 →</a></td></tr>`).join('')}</tbody></table></div><div class="section__footer">这些是教师视角的原型。反馈与复测不对学生公开；管理入口仍按原有课程编辑权限显示。</div>`)+`<div class="prototype-map">${[
  ['课程内容','content-preview.png','course-content.html','讲义与题目为主；直接进入对应课时的进度和反馈。','course-lecture.html','讲义摘要'],
  ['课程进度 · B','progress-preview.png','course-progress.html','默认收起记录面板，查看成绩时点格内“记录”即可展开。','course-progress-record.html','展开记录'],
  ['课程反馈 · A','feedback-preview.png','course-feedback.html','整班选一次课时和题目，每位学生点一个动作。','course-feedback-history.html','最近记录'],
  ['待复测','pending-preview.png','pending-retests.html','已有上下文时点一次“完成跟进”；有疑问再查看详情。','retest-detail.html','复测上下文'],
  ['课程管理','manage-preview.png','course-manage.html','保持原有三个管理区，日常课堂反馈移到独立入口。','course-manage-nodes.html','节点管理'],
  ['完成跟进后','retest-done-preview.png','retest-done.html','完成处理从待办移出，保留观察和处理记录；需再确认可新增观察。','pending-retests-empty.html','清单为空'],
].map(([name,img,href,copy,extra,label]) => section(`<div class="section__header"><h2 class="section__title">${name}</h2></div><a href="${href}"><img src="${img}" alt="${name}静态原型"></a><div class="section__body"><p>${copy}</p><a href="${href}">打开页面 →</a><a href="${extra}">${label} →</a></div>`)).join('')}</div>`+section(`<div class="section__header"><h2 class="section__title">教师的最小操作路径</h2></div><div class="workflow">整班记录：选课时和题目一次 → 对学生点“指导过／核对过／需复测”。<br>进度表记录：点学生 × 题目的“记录” → 点一个动作。<br>复测跟进：看待办已有上下文 → 点“完成跟进”；备注、细项、关联提交均可空。</div><div class="section__footer">评测通过不自动关闭待办，核对过不自动表示掌握。无需逐课签到或重复确认课程管理设置。</div>`);
write('index.html',shell('', '设计总览',overview,{full:true}));
// Preserve the user's existing A/B preview URLs while upgrading their navigation.
write('a-roster.html',shell('feedback','课程反馈',roster()));
write('b-scoreboard.html',shell('progress','课程进度',progress(true)));
console.log('Generated course content, progress, feedback, management and retest static states.');
fs.writeFileSync(path.join(out, 'prototype-files.json'), JSON.stringify([...generated],null,2));
