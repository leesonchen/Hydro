# Hydro 2026-10-12-dev.2 系统测试报告

> 后续修复验证：UI `4.58.5-dev.4` 已修复普通课程保存失败，[13 项针对性浏览器回归通过](../../fixes/2026-10-12-course-template/system-test-report.md)。本报告仍记录原 dev.2 的 53 项结果。

生成时间：2026-10-12T14:53:56.092Z

## 测试基线与范围

- 实际部署容器：hydro；实际当前包：hydrooj 5.0.7-dev.2；@hydrooj/ui-default 4.58.5-dev.2；@hydrooj/framework 0.3.2；@hydrooj/common 0.0.11-dev.1；对照部署包：hydrooj 5.0.7-dev.1；@hydrooj/ui-default 4.58.4-dev.41；@hydrooj/framework 0.3.2-dev.1；@hydrooj/common 0.0.11-dev.1。快照版本以 [release-comparison.json](evidence/release-comparison.json) 为准。
- 发布说明：[release-notes.md](release-notes.md)；变更范围：[change-scope.json](change-scope.json)。
- 环境：Chrome/141.0.7390.76，视口 1500×1000，外网访问已屏蔽。页面入口按记录为 /d/exam。
- 计划案例共 53 项；浏览器案例 51 项，CERT 开头 CLI 补充 2 项。API/夹具准备和状态读取仅作辅助证据，不计为测试用例。

## 执行统计

| 范围 | 计划 | 通过 | 失败 | 阻塞 | 跳过 |
|---|---:|---:|---:|---:|---:|
| 浏览器案例 | 51 | 49 | 1 | 1 | 0 |
| CERT CLI 补充 | 2 | 2 | 0 | 0 | 0 |
| 全部计划项 | 53 | 51 | 1 | 1 | 0 |

结果只按 test-cases.json 中的计划 ID 统计。缺少结果记录时记为阻塞；清单外结果不纳入统计。结果页标题严格取自计划用例标题。

## 按变更功能覆盖

| 功能映射 | 变更范围 | 计划 ID | 结果 |
|---|---|---|---|
| ASM-course-assessment | 课程测评节点与成绩前置条件 | COUR-02、COUR-05、ASM-01、ASM-02、ASM-03、ASM-04、ASM-05 | COUR-02：通过；COUR-05：通过；ASM-01：通过；ASM-02：通过；ASM-03：通过；ASM-04：通过；ASM-05：通过 |
| COR-gate | 课程章节门禁与测评并发保护 | COUR-04、COUR-05、ASM-03、ASM-04 | COUR-04：通过；COUR-05：通过；ASM-03：通过；ASM-04：通过 |
| CF-classroomfeedback | 本地课堂反馈与跟进 | CF-01、CF-02、CF-03、CF-04、CF-05、CF-06、CF-07、CF-08 | CF-01：通过；CF-02：通过；CF-03：通过；CF-04：通过；CF-05：通过；CF-06：通过；CF-07：通过；CF-08：通过 |
| PRA-practice | 比赛赛后练习 | PRA-01、PRA-02、PRA-03 | PRA-01：通过；PRA-02：通过；PRA-03：通过 |
| UIoffline | 离线头像与字体回退 | UI-02、UI-03 | UI-02：通过；UI-03：通过 |
| CON-settings | 比赛设置页与设置回显 | CON-01、CON-02、CON-03 | CON-01：通过；CON-02：通过；CON-03：通过 |
| MD-markdown | Markdown 与讲义渲染 | MD-01、MD-02 | MD-01：通过；MD-02：通过 |
| SCR/YAML-editor | 在线编辑器、样例与 YAML 编辑器 | UI-01、UI-04、SCR-01、YAML-01 | UI-01：通过；UI-04：通过；SCR-01：通过；YAML-01：通过 |
| CERT-supplement | Rating 认证 CLI 补充 | CERT-01、CERT-02 | CERT-01：通过；CERT-02：通过 |
| Feedback-conversations | 题目/讲义反馈会话 | UI-05、UI-06、FB-SEND、MSG-01、MSG-02 | UI-05：通过；UI-06：通过；FB-SEND：通过；MSG-01：通过；MSG-02：阻塞 |
| MON-monitor | 浏览器监考 | MON-01、MON-02 | MON-01：通过；MON-02：通过 |
| TEAM-team | 团队参赛交互 | TEAM-01 | TEAM-01：通过 |
| COUR-course-management | 课程结构与管理 | COUR-01、COUR-03、COUR-06、TPL-01、TPL-02 | COUR-01：失败；COUR-03：通过；COUR-06：通过；TPL-01：通过；TPL-02：通过 |
| PR-rating-trial | 评分管理员只读试用 | PR-01、PR-02、PR-03 | PR-01：通过；PR-02：通过；PR-03：通过 |
| ROLE/CLASS-admin | 角色与班级管理 | ROLE-01、ROLE-02、CLASS-01 | ROLE-01：通过；ROLE-02：通过；CLASS-01：通过 |
| UI-settings | 课程、域、账户及比赛页面调整 | UI-01、UI-02、UI-03、UI-04、UI-05、UI-06、CON-01、CON-02、CON-03、COUR-06 | UI-01：通过；UI-02：通过；UI-03：通过；UI-04：通过；UI-05：通过；UI-06：通过；CON-01：通过；CON-02：通过；CON-03：通过；COUR-06：通过 |
| framework-and-dependency | 框架与依赖版本变化（运维信息） | — | 本次计划无对应案例 |

## 测试矩阵

| 计划 ID | 用例标题 | 步骤 | 期望 | 实际 | 角色 | 状态 | 时间 | 证据等级/截图 |
|---|---|---|---|---|---|---|---|---|
| AUTH-01 | 管理员浏览器登录 | 填写本地管理员凭据并提交登录表单 | 进入登录后的页面，显示管理员身份 | loggedIn=true; role=admin | admin | 通过 | 2026-10-12T14:04:21.910Z | A · [screenshots/AUTH-01.png](evidence/screenshots/AUTH-01.png) |
| AUTH-02 | 学生浏览器登录 | 填写本地学生凭据并提交登录表单 | 进入登录后的页面，显示学生身份 | loggedIn=true; role=student | student | 通过 | 2026-10-12T14:04:27.289Z | A · [screenshots/AUTH-02.png](evidence/screenshots/AUTH-02.png) |
| UI-01 | 现有 exam 在线编辑器与补题提示 | 进入现有 Test1 题目，点击进入在线编程模式 | Monaco 编辑器加载，已结束比赛显示补题不计成绩提示 | editorLoaded=true; endedContestSupplementNotice=true; existingExamReadOnly=true | admin | 通过 | 2026-10-12T14:04:29.985Z | A · [screenshots/UI-01.png](evidence/screenshots/UI-01.png) |
| UI-02 | 失效头像与动态头像回退 | 在实际页面令已渲染头像请求失效，再为带回退标记的动态头像模拟失效 | 头像使用同源 /img/avatar.png，srcset 被移除，页面可继续操作 | dynamicSrc=/img/avatar.png | admin | 通过 | 2026-10-12T14:04:33.395Z | A · [screenshots/UI-02.png](evidence/screenshots/UI-02.png) |
| UI-03 | 无外网字体回退 | Chrome 屏蔽外网访问后打开题目与比赛设置页面 | 中文与本地图标正常显示；不请求外部 XiaoLai；当前未打包 XiaoLai 时使用正常回退 | fontState=loaded; bodyFont="Open Sans", "Open Sans", Seravek, "Segoe UI", Verdana, "PingFang SC", "Hiragino Sans GB", "Lantinghei SC", "Microsoft Yahei", "WenQuanYi Micro Hei", sans; externalFontRequests=0; xiaoLaiBundled=false; network=External hosts blocked in Chrome | admin | 通过 | 2026-10-12T14:04:36.721Z | A · [screenshots/UI-03.png](evidence/screenshots/UI-03.png) |
| UI-04 | 公式、代码和样例首行渲染 | 浏览临时题目的公式、代码块与输入输出样例 | KaTeX 公式正常渲染；样例首行没有模板缩进；代码内容正确 | formulas=1; code=true | student | 通过 | 2026-10-12T14:04:39.038Z | A · [screenshots/UI-04.png](evidence/screenshots/UI-04.png) |
| UI-05 | 题目反馈弹窗与空内容校验 | 点击题目反馈入口，提交空内容，再取消 | 显示题目来源和收件人说明，空内容被浏览器拦截，不发送消息 | source=1. 系统测试题 1; emptyInputRejected=true; dialogScreenshot=screenshots/UI-05-dialog.png | student | 通过 | 2026-10-12T14:04:40.418Z | A · [screenshots/UI-05.png](evidence/screenshots/UI-05.png) |
| UI-06 | 讲义标记与引用反馈入口 | 打开讲义，选中一段文本并调用页面标记工具的反馈入口 | 显示引用内容与讲义来源；取消后回到讲义 | source=浏览器系统测试课程 / 系统测试讲义; readOnly=true | student | 通过 | 2026-10-12T14:05:59.330Z | A · [screenshots/UI-06.png](evidence/screenshots/UI-06.png) |
| MD-01 | 完整外层包装按展示规则解包 | 夹具保存带CRLF、标题和Mermaid的完整markdown外层围栏，学生在浏览器打开讲义 | 标题作为标题显示，外层围栏不作为代码显示，数据库原文保持不变 | heading=包装讲义标题; outerFenceShown=false; mermaidContainers=1; sourcePreserved=true | student | 通过 | 2026-10-12T14:06:01.111Z | A · [screenshots/MD-01.png](evidence/screenshots/MD-01.png) |
| MD-02 | 普通代码围栏保留 | 夹具保存只有标题而无Mermaid的markdown示例代码，学生在浏览器打开讲义 | 仍作为代码展示，不误拆为普通标题 | headings=0; code=# 普通代码示例<br>; ordinaryFencePreserved=true | student | 通过 | 2026-10-12T14:06:03.437Z | A · [screenshots/MD-02.png](evidence/screenshots/MD-02.png) |
| FB-SEND | 真实收件人送达与回复 | 提交内容反馈并由收件人回复 | 收件人能收到反馈且回复对话更新 | feedbackId=6accea22e6d76aec43ceb1cf; ownerReceiptVisible=true; adminReplyVisibleToReporter=true; globalSendPermissionRequired=false; supplementalReceipt=scoped message records | student/admin | 通过 | 2026-10-12T14:09:36.736Z | B · [screenshots/FB-SEND.png](evidence/screenshots/FB-SEND.png) |
| CON-01 | 分组设置与开启保存 | 打开临时比赛编辑页，检查四组设置，开启可用布尔开关并保存，再打开编辑页 | 所有可用开关保存并正确回显，比赛规则和时间保留 | cards=4 | admin | 通过 | 2026-10-12T14:04:42.914Z | A · [screenshots/CON-01.png](evidence/screenshots/CON-01.png) |
| CON-02 | 关闭设置与 banner 可见性 | 关闭可用开关保存，验证回显，再检查开启 hideInBanner 后比赛列表 | 可编辑开关关闭状态持久化；已开启的团队模式保持只读；隐藏 banner 不移除列表条目 | offValuesPersisted=true; inList=true; inBanner=false | admin | 通过 | 2026-10-12T14:04:49.053Z | A · [screenshots/CON-02.png](evidence/screenshots/CON-02.png) |
| CON-03 | 学生不能编辑比赛 | 在地址栏访问临时比赛编辑页 | 403 权限页面，不显示编辑表单 | http=403; visiblePermissionPage=true | student | 通过 | 2026-10-12T14:04:57.971Z | A · [screenshots/CON-03.png](evidence/screenshots/CON-03.png) |
| TEAM-01 | 创建、重命名与退出测试团队 | 在临时域团队页创建团队、打开重命名表单保存、退出团队 | 团队卡片、成员与新名称更新，退出后不再显示该团队 | created=true; renamed=true; left=true; renamedScreenshot=screenshots/TEAM-01-renamed.png | student | 通过 | 2026-10-12T14:04:59.516Z | A · [screenshots/TEAM-01.png](evidence/screenshots/TEAM-01.png) |
| COUR-01 | 可视化章节编辑与稳定编号 | 新增章节、保存、删除新增章节、再新增并保存 | 新增章节可保存；已删除编号不复用；原测评绑定保留 | 普通课程编辑提交返回 HTTP 400，提示不能分配给 teachers；缺陷诊断见 defects.md（previous 已存在）。 | admin | 失败 | 2026-10-12T14:05:02.871Z | A · [screenshots/COUR-01.png](evidence/screenshots/COUR-01.png) |
| COUR-02 | 学生认领与初始门禁 | 打开课程，点击认领，查看课程章节及后续题目的直接链接 | 第一章和测评可见，依赖测评的第二章不可访问 | http=403; visiblePermissionPage=true; visibleInitialCourse=true; courseScreenshot=screenshots/COUR-02-initial-course.png | student | 通过 | 2026-10-12T14:05:37.553Z | A · [screenshots/COUR-02.png](evidence/screenshots/COUR-02.png) |
| COUR-03 | 管理分组与破坏操作确认 | 切换三个管理标签；对第一章关闭题目操作先取消，再确认执行 | 确认面板展示课程、课时和学生范围；取消不改变权限，确认显示逐项成功 | tabs=3; cancelledWithoutChange=true; successItems=1 | admin | 通过 | 2026-10-12T14:05:40.245Z | B · [screenshots/COUR-03.png](evidence/screenshots/COUR-03.png) |
| COUR-04 | 手工关闭阻止 SELF 越权 | 教师关闭第一章后，学生直接访问其题目和提交页面 | 题目与提交页面均显示403，不因 SELF 权限绕过 | detailHttp=403; submitPageHttp=403; scopedSelfPermissionDoesNotBypass=true | student | 通过 | 2026-10-12T14:05:46.726Z | A · [screenshots/COUR-04.png](evidence/screenshots/COUR-04.png) |
| COUR-05 | 手工开放与恢复访问规则 | 教师开放第一章，手工开放未达标第二章，学生访问；教师恢复第二章规则，学生再次访问 | 手工开放即时生效；恢复规则后第二章重新锁定 | openFirst=true; manualSecond=true; resetSecondHttp=403 | admin/student | 通过 | 2026-10-12T14:05:48.567Z | A · [screenshots/COUR-05.png](evidence/screenshots/COUR-05.png) |
| COUR-06 | 学生不能管理或编辑课程 | 分别直接访问课程 manage 和 edit 路由 | 两个页面均显示403，不提供管理或编辑控件 | 已执行；详细安全字段未在报告中展开 | student | 通过 | 2026-10-12T14:05:57.549Z | A · [screenshots/COUR-06.png](evidence/screenshots/COUR-06.png) |
| CF-01 | 教师入口、过滤与录入门槛 | 打开课程反馈，切换三个标签；未选择课时题目时检查动作；选择课时和题目 | 名单、历史、待复测可切换；范围未确定时不能录入，选择范围后学生行可录入 | tabs=3; requiresScope=true; teacherCanRecord=true | admin | 通过 | 2026-10-12T14:06:04.640Z | A · [screenshots/CF-01.png](evidence/screenshots/CF-01.png) |
| CF-02 | 指导观察、备注与细项 | 展开学生备注，填写备注和指导细项，点击指导过，刷新页面 | 观察保存并回显，备注和细项进入详情，刷新不产生重复观察 | persisted=true; detailIncludesNote=true; detailScreenshot=screenshots/CF-02-detail.png | admin | 通过 | 2026-10-12T14:06:06.106Z | A · [screenshots/CF-02.png](evidence/screenshots/CF-02.png) |
| CF-03 | 需复测与待跟进计数 | 对同一学生记录需复测，切换待复测标签 | 显示待跟进事件，计数为1，关联正确学生、题目和课时 | pendingCount=1; state=待跟进 | admin | 通过 | 2026-10-12T14:06:09.096Z | A · [screenshots/CF-03.png](evidence/screenshots/CF-03.png) |
| CF-04 | Accepted 不自动完成跟进 | 学生通过浏览器向课程提交正确答案，教师等待判题并刷新待复测列表 | 真实 Accepted 后观察仍待跟进，计数不自动归零 | browserSubmission=Accepted; score=100; pendingCountAfterAccepted=1 | student/admin | 通过 | 2026-10-12T14:06:10.778Z | B · [screenshots/CF-04.png](evidence/screenshots/CF-04.png) |
| CF-05 | 完成跟进与撤销处理 | 在待复测中点击完成跟进，然后撤销这次处理 | 完成后待跟进计数归零，撤销后恢复为1，历史保留操作记录 | resolvedCount=0; undoCount=1; resolutionScreenshot=screenshots/CF-05-resolved.png | admin | 通过 | 2026-10-12T14:06:15.719Z | A · [screenshots/CF-05.png](evidence/screenshots/CF-05.png) |
| CF-06 | 观察详情、撤销与历史过滤 | 打开观察详情，撤销观察，按学生和课时过滤历史 | 详情包含创建与处理记录；撤销后不再待跟进，历史可追溯 | historyIncludesResolveAndUndo=true; retracted=true; pendingCount=0; studentFilter=20001 | admin | 通过 | 2026-10-12T14:06:16.569Z | A · [screenshots/CF-06.png](evidence/screenshots/CF-06.png) |
| CF-07 | 复用题目需明确课时 | 选择在两章复用的题目而不选课时，然后选择其中一章 | 未选课时不能录入；明确课时后可录入，不把两章观察混淆 | ambiguousLessonBlocksRecording=true; explicitLessonEnablesRecording=true | admin | 通过 | 2026-10-12T14:06:18.019Z | A · [screenshots/CF-07.png](evidence/screenshots/CF-07.png) |
| CF-08 | 普通学生无权查看教师观察 | 直接访问课程反馈路由及观察详情 | 403，不泄露名单、备注或观察历史 | listHttp=403; detailHttp=403 | student | 通过 | 2026-10-12T14:06:19.812Z | A · [screenshots/CF-08.png](evidence/screenshots/CF-08.png) |
| PR-01 | 默认关闭 | 尚未启用时访问课程 practice-rating 页面 | 403且课程无试用入口 | http=403; visiblePermissionPage=true; defaultEnabled=false | admin | 通过 | 2026-10-12T14:06:22.128Z | A · [screenshots/PR-01.png](evidence/screenshots/PR-01.png) |
| PR-02 | 临时域启用后的只读与样本不足 | 通过夹具仅启用临时域 adminTrial，点击课程侧栏试用入口，选择学生和题目后查看 | 管理员只读页面显示样本不足及无配对概率，明示模型范围，没有编辑分数功能 | explicitTemporaryOptIn=true; readOnly=true; insufficientSamples=true; noPairProbability=true | admin | 通过 | 2026-10-12T14:26:30.475Z | A · [attempts/08-trial-final/screenshots/PR-02.png](evidence/attempts/08-trial-final/screenshots/PR-02.png) |
| PR-03 | 学生及越界参数拒绝 | 学生直接访问试用页面；管理员输入不在课程名单的UID或PID访问 | 均显示403，不展示其他人的评分数据 | 已执行；详细安全字段未在报告中展开 | student/admin | 通过 | 2026-10-12T14:26:41.973Z | A · [attempts/08-trial-final/screenshots/PR-03.png](evidence/attempts/08-trial-final/screenshots/PR-03.png) |
| PRA-01 | 比赛结束后开启个人练习 | 打开允许练习的临时已结束比赛，从UI进入开始练习，再打开客观题答题页 | 显示个人赛后练习说明、个人练习记录入口和题目上下文 | personalPracticeNotice=true; practiceSubmissionContext=true | student | 通过 | 2026-10-12T14:18:30.705Z | A · [attempts/05-selector-retest/screenshots/PRA-01.png](evidence/attempts/05-selector-retest/screenshots/PRA-01.png) |
| PRA-02 | 浏览器提交与正式成绩隔离 | 通过浏览器提交正确答案，查看个人练习记录，再查看正式比赛页面和榜单 | 个人练习 Accepted；正式报名、提交和成绩没有新增；补充证据带practice归属和服务器提交事实 | accepted=true; practiceMode=practice; normalKind=normal; fullScore=100; formalParticipationUnchanged=true; recordScreenshot=attempts/05-selector-retest/screenshots/PRA-02-practice-records.png | student/admin | 通过 | 2026-10-12T14:18:34.541Z | B · [attempts/05-selector-retest/screenshots/PRA-02.png](evidence/attempts/05-selector-retest/screenshots/PRA-02.png) |
| PRA-03 | 关闭练习后拒绝继续提交 | 夹具将临时比赛 allowPractice 关闭，学生重新访问练习提交地址 | 不再提供可用练习提交入口，直接地址被拒绝；已有练习历史仍可见 | submissionHttp=403; previousPracticeRecordVisible=true | student | 通过 | 2026-10-12T14:18:40.534Z | A · [attempts/05-selector-retest/screenshots/PRA-03.png](evidence/attempts/05-selector-retest/screenshots/PRA-03.png) |
| SCR-01 | C++在线编程与样例自测 | 在临时A+B题进入在线编程，输入C++17代码，点击样例运行自测 | 样例输入1 5进入自测面板，显示 Accepted 和输出6，无首行缩进 | language=cc.cc17o2; pretestAccepted=true; expectedOutput=6; sampleInput=1 5 | student | 通过 | 2026-10-12T14:06:56.647Z | A · [screenshots/SCR-01.png](evidence/screenshots/SCR-01.png) |
| YAML-01 | YAML配置编辑器加载 | 打开临时题目的配置编辑页面，查看其配置与表单 | 已上传配置正常解析，页面无YAML模块或worker错误 | configurationLoaded=true | admin | 通过 | 2026-10-12T14:07:04.480Z | A · [screenshots/YAML-01.png](evidence/screenshots/YAML-01.png) |
| ROLE-01 | 角色增删与默认优先级保存 | 创建临时角色，调整默认项和优先级保存，验证guest/root边界 | 保存成功，恰好一个默认邀请角色，guest首位root末位 | defaultRole=qa_role | admin | 通过 | 2026-10-12T14:07:07.261Z | A · [screenshots/ROLE-01.png](evidence/screenshots/ROLE-01.png) |
| ROLE-02 | 保留名称拒绝 | 尝试创建__proto__角色 | 提示非法角色名称，不新增保留角色 | errorNotification=true; reservedRow=0; text=字段 role 验证失败。 (This role name is reserved.) | admin | 通过 | 2026-10-12T14:07:15.012Z | A · [screenshots/ROLE-02.png](evidence/screenshots/ROLE-02.png) |
| CLASS-01 | 班级设置显示与学生跨权拒绝 | 教师查看临时域班级新建表单，学生直接访问班级设置 | 教师可设置周期、教师/学生、公开榜单与罚时；学生被拒绝 | studentHttp=403; accountImportNotPerformed=true | admin/student | 通过 | 2026-10-12T14:07:16.465Z | A · [screenshots/CLASS-01.png](evidence/screenshots/CLASS-01.png) |
| MSG-01 | 无发信权限的消息只读界面 | 使用当前管理员打开消息页，核对只读标记与缺失的新建/输入控件，不发送消息 | 没有全站发信权限时不显示新建或输入区域；页面正常渲染；截图遮蔽私人对话 | readOnly=true; newButton=false; inputControls=0; privateDialoguesMasked=true | admin | 通过 | 2026-10-12T14:07:19.742Z | A · [screenshots/MSG-01.png](evidence/screenshots/MSG-01.png) |
| MSG-02 | 有发信权限时空输入不能发送 | 使用具有发信权限的测试学生打开自己作为目标的新对话，保持内容为空 | 输入框为空时发送按钮禁用，不产生真实消息；截图遮蔽私人对话 | 测试学生无全站普通发信权限，未修改账号权限；此阻塞不构成产品缺陷。反馈回复权限独立，送达/回复验证状态以 FB-SEND 行为准。 | student | 阻塞 | 2026-10-12T14:07:21.380Z | A · [screenshots/MSG-02.png](evidence/screenshots/MSG-02.png) |
| ASM-01 | 父课程准入与独立测评 | 未认领课程前访问子测评；认领后从课程进入子测评并报名 | 未认领拒绝；认领后可报名；试卷单独存在且默认不计Rating | beforeParentEnrollment=403; childEnrollmentSaved=true; independent=true; rated=false | student/admin | 通过 | 2026-10-12T14:13:32.042Z | B · [attempts/04-focused-retest/screenshots/ASM-01.png](evidence/attempts/04-focused-retest/screenshots/ASM-01.png) |
| ASM-02 | 正常进入题目列表开始作答 | 等待临时测评开赛，点击题目列表后打开私有题目 | 正常记录开始时间，隐藏题目可见，测评监控脚本启动 | privateProblemVisible=true; startAtSaved=true; monitorMode=browser | student | 通过 | 2026-10-12T14:14:32.435Z | B · [attempts/04-focused-retest/screenshots/ASM-02.png](evidence/attempts/04-focused-retest/screenshots/ASM-02.png) |
| MON-01 | 真实失焦与粘贴事件上报 | 在学生测评页面触发浏览器焦点切换和粘贴动作，教师刷新监考记录 | 教师页面出现对应浏览器事件和会话，明示不能单独作为作弊结论 | pasteReported=true | student/admin | 通过 | 2026-10-12T14:08:06.116Z | A · [screenshots/MON-01.png](evidence/screenshots/MON-01.png) |
| MON-02 | 学生无权查看监考记录 | 直接访问测评monitor页面 | 403，不展示他人事件或会话 | http=403; visiblePermissionPage=true | student | 通过 | 2026-10-12T14:07:42.436Z | A · [screenshots/MON-02.png](evidence/screenshots/MON-02.png) |
| ASM-03 | 真实判题与测评期间成绩隐藏 | 学生在客观题的输入控件作答并点击提交，教师从记录列表查看Accepted，学生查看记录与课程 | 教师看到100分Accepted；学生看不到结束前成绩，后续章节仍锁定 | teacherAccepted=true; score=100; studentScoreHidden=true; nextChapterLocked=true; teacherScreenshot=attempts/04-focused-retest/screenshots/ASM-03-teacher-accepted.png | student/admin | 通过 | 2026-10-12T14:14:36.478Z | B · [attempts/04-focused-retest/screenshots/ASM-03.png](evidence/attempts/04-focused-retest/screenshots/ASM-03.png) |
| ASM-04 | 结束后成绩与后续章节自动解锁 | 测评结束后刷新课程，点击后续章题目 | 显示100分成绩，后续章节出现并可访问 | assessmentScore=100; nextChapterVisible=true; unlockedProblemAccessible=true; courseScreenshot=attempts/04-focused-retest/screenshots/ASM-04-course-unlocked.png | student | 通过 | 2026-10-12T14:15:34.621Z | A · [attempts/04-focused-retest/screenshots/ASM-04.png](evidence/attempts/04-focused-retest/screenshots/ASM-04.png) |
| ASM-05 | 直接编辑子测评与删除已开赛课程拒绝 | 访问子测评编辑页；通过课程编辑页面点击删除并确认 | 均被拒绝，父课程与子测评仍存在 | childEditHttp=403; deleteHttp=403; parentCourseStillPresent=true | admin | 通过 | 2026-10-12T14:09:31.403Z | A · [screenshots/ASM-05.png](evidence/screenshots/ASM-05.png) |
| CERT-01 | 题目版本冻结与释放门槛 | 使用实际认证CLI认证未来比赛并尝试提前释放；浏览器查看其公开比赛界面 | CLI冻结版本且拒绝提前释放；公开榜单/普通rated开关不被认证策略替代 | evidenceType=CLI with browser public-view observation; frozenRevision=true; prematureReleaseRejected=true; rated=true; resultsReleasedAt=null | admin | 通过 | 2026-10-12T14:07:22.793Z | C · [screenshots/CERT-01.png](evidence/screenshots/CERT-01.png) |
| CERT-02 | 教师不得进入学生认证名单 | 认证CLI提交含教师的临时课堂名单；浏览器再次查看课程 | 认证拒绝classroomParticipant，课程和测评正常且未生成错误政策 | evidenceType=CLI with browser course observation; teacherRosterRejected=true; policyNotAdded=true | admin | 通过 | 2026-10-12T14:07:36.699Z | C · [screenshots/CERT-02.png](evidence/screenshots/CERT-02.png) |
| TPL-01 | 课程模板保存 | 打开现有课程编辑页，点击显式 button[name="isTemplate"][value="true"]（Save as Template）。 | 保存出一个独立模板；模板保留 assessment.kind 与题目，但不带已实例化的 assessment.contestTid，原课程仍存在。 | observed=显式 Save as Template 按钮完成浏览器提交；以实际落地的新 course OID 读取模板，保留 assessment 节点，模板 assessment.contestTid 未定义，源课程及其原 exam 引用保留。 | admin | 通过 | 2026-10-12T14:32:19.676Z | B · [extra-course/attempts/2026-10-12T14-32-14-259Z/screenshots/TPL-01-before.png](evidence/extra-course/attempts/2026-10-12T14-32-14-259Z/screenshots/TPL-01-before.png)、[extra-course/attempts/2026-10-12T14-32-14-259Z/screenshots/TPL-01-after.png](evidence/extra-course/attempts/2026-10-12T14-32-14-259Z/screenshots/TPL-01-after.png) |
| TPL-02 | 班级复制含测评模板 | 真实选择 sourceDomain、Autocomplete 中的模板，再确认 Add Course；为两个班级各复制一次并读取结果核对。 | 每个班级都出现复制课程；测评节点保留且各自获得不同的新 assessment.contestTid，题目 PID 对应有效目标题目，不引用源模板中的测评实例。 | observed=管理员在两个班级页面分别通过 Add Course 对话框和真实 Autocomplete 选项完成复制；两份课程均保留测评节点并获得独立 contestTid，child contest.pids 与 assessment 节点 pids 一致、题目在本测试域可读，child sourceCourseTid 分别指向对应复制课程。 | admin | 通过 | 2026-10-12T14:32:24.713Z | B · [extra-course/attempts/2026-10-12T14-32-14-259Z/screenshots/TPL-02-class-1.png](evidence/extra-course/attempts/2026-10-12T14-32-14-259Z/screenshots/TPL-02-class-1.png)、[extra-course/attempts/2026-10-12T14-32-14-259Z/screenshots/TPL-02-class-2.png](evidence/extra-course/attempts/2026-10-12T14-32-14-259Z/screenshots/TPL-02-class-2.png) |

证据等级：A 为直接浏览器操作和结果，B 为浏览器操作辅以接口/日志核验，C 为非浏览器的间接或 CLI 证据。CERT 项的决定性认证操作来自 CLI，即使附有比赛页面截图，也保持 C 等级。所有链接在生成时均核验目标文件存在。

## 重点截图

![课堂反馈观察详情](evidence/screenshots/CF-02-detail.png)

课堂反馈观察详情（[原图](evidence/screenshots/CF-02-detail.png)）

![测评后课程自动解锁](evidence/screenshots/ASM-04-course-unlocked.png)

测评后课程自动解锁（[原图](evidence/screenshots/ASM-04-course-unlocked.png)）

![浏览器监考事件记录](evidence/screenshots/MON-01.png)

浏览器监考事件记录（[原图](evidence/screenshots/MON-01.png)）

![课程编辑 400 缺陷](evidence/screenshots/COUR-01.png)

课程编辑 400 缺陷（[原图](evidence/screenshots/COUR-01.png)）

## 缺陷与限制

- **COUR-01 真实失败：** 普通课程编辑返回 HTTP 400，提示不能分配给 teachers；独立包对比确认 previous 已存在，详见 [defects.md](defects.md)。
- **MSG-02 阻塞：** 测试账号没有普通发信权限，未改动其账号权限，属于前置条件限制。
- FB-SEND 已在授权范围验证提交、域主收件与回复；其他管理员的收件归属由同域消息记录补充核对，并未使用他们的账号登录。
- **并发竞态限制：** 真浏览器顺序操作无法证明课程测评更新中的并发竞态及事务时序正确性。
- **预测质量限制：** 真浏览器只能核对评分试用页展示和权限边界，不能证明数学算法的预测质量；本次为样本不足的只读页面，未把真实估计值、每日拟合或未来预测有效性列为浏览器通过项。
- **失败与阻塞：** 最终状态采用逐项实际结果及有证据的针对性重测；驱动/夹具校准记录保存在 attempts 附录，不混入最终统计。未把无授权或缺少账号能力推断为产品缺陷。

## 清理与保留

- 清理证据：[cleanup.json](evidence/cleanup.json)。残留汇总为 {"domain.user":0,"document":0,"document.status":0,"record":0,"record.stat":0,"record.history":0,"contest.practiceAccess":0,"contest.monitor":0,"contest.monitor.sessions":0,"classroom.feedback.events":0,"task":0,"user.group":0,"vuser":0,"feedback":0,"message":0,"storage":0}；额外清理计数 practice_rating_active=1 表示删除数量，不是残留数量；最终独立核验见 [final-cleanup-verification.json](evidence/final-cleanup-verification.json)，同时覆盖班级补测及全部重测域。
- 另有 7 个附件采用延迟删除，存储保留期 7 天；活动对象清理状态与延迟附件清理分别记录。

## 证据索引

完整逐项结果：[browser-results.json](evidence/browser-results.json)。时间列为 UTC；页面截图显示账号设定时区。

- [evidence/attempts/04-focused-retest/screenshots/ASM-01.png](evidence/attempts/04-focused-retest/screenshots/ASM-01.png)
- [evidence/attempts/04-focused-retest/screenshots/ASM-02.png](evidence/attempts/04-focused-retest/screenshots/ASM-02.png)
- [evidence/attempts/04-focused-retest/screenshots/ASM-03.png](evidence/attempts/04-focused-retest/screenshots/ASM-03.png)
- [evidence/attempts/04-focused-retest/screenshots/ASM-04.png](evidence/attempts/04-focused-retest/screenshots/ASM-04.png)
- [evidence/attempts/05-selector-retest/screenshots/PRA-01.png](evidence/attempts/05-selector-retest/screenshots/PRA-01.png)
- [evidence/attempts/05-selector-retest/screenshots/PRA-02.png](evidence/attempts/05-selector-retest/screenshots/PRA-02.png)
- [evidence/attempts/05-selector-retest/screenshots/PRA-03.png](evidence/attempts/05-selector-retest/screenshots/PRA-03.png)
- [evidence/attempts/08-trial-final/screenshots/PR-02.png](evidence/attempts/08-trial-final/screenshots/PR-02.png)
- [evidence/attempts/08-trial-final/screenshots/PR-03.png](evidence/attempts/08-trial-final/screenshots/PR-03.png)
- [evidence/extra-course/attempts/2026-10-12T14-32-14-259Z/screenshots/TPL-01-after.png](evidence/extra-course/attempts/2026-10-12T14-32-14-259Z/screenshots/TPL-01-after.png)
- [evidence/extra-course/attempts/2026-10-12T14-32-14-259Z/screenshots/TPL-01-before.png](evidence/extra-course/attempts/2026-10-12T14-32-14-259Z/screenshots/TPL-01-before.png)
- [evidence/extra-course/attempts/2026-10-12T14-32-14-259Z/screenshots/TPL-02-class-1.png](evidence/extra-course/attempts/2026-10-12T14-32-14-259Z/screenshots/TPL-02-class-1.png)
- [evidence/extra-course/attempts/2026-10-12T14-32-14-259Z/screenshots/TPL-02-class-2.png](evidence/extra-course/attempts/2026-10-12T14-32-14-259Z/screenshots/TPL-02-class-2.png)
- [evidence/screenshots/ASM-04-course-unlocked.png](evidence/screenshots/ASM-04-course-unlocked.png)
- [evidence/screenshots/ASM-05.png](evidence/screenshots/ASM-05.png)
- [evidence/screenshots/AUTH-01.png](evidence/screenshots/AUTH-01.png)
- [evidence/screenshots/AUTH-02.png](evidence/screenshots/AUTH-02.png)
- [evidence/screenshots/CERT-01.png](evidence/screenshots/CERT-01.png)
- [evidence/screenshots/CERT-02.png](evidence/screenshots/CERT-02.png)
- [evidence/screenshots/CF-01.png](evidence/screenshots/CF-01.png)
- [evidence/screenshots/CF-02-detail.png](evidence/screenshots/CF-02-detail.png)
- [evidence/screenshots/CF-02.png](evidence/screenshots/CF-02.png)
- [evidence/screenshots/CF-03.png](evidence/screenshots/CF-03.png)
- [evidence/screenshots/CF-04.png](evidence/screenshots/CF-04.png)
- [evidence/screenshots/CF-05.png](evidence/screenshots/CF-05.png)
- [evidence/screenshots/CF-06.png](evidence/screenshots/CF-06.png)
- [evidence/screenshots/CF-07.png](evidence/screenshots/CF-07.png)
- [evidence/screenshots/CF-08.png](evidence/screenshots/CF-08.png)
- [evidence/screenshots/CLASS-01.png](evidence/screenshots/CLASS-01.png)
- [evidence/screenshots/CON-01.png](evidence/screenshots/CON-01.png)
- [evidence/screenshots/CON-02.png](evidence/screenshots/CON-02.png)
- [evidence/screenshots/CON-03.png](evidence/screenshots/CON-03.png)
- [evidence/screenshots/COUR-01.png](evidence/screenshots/COUR-01.png)
- [evidence/screenshots/COUR-02.png](evidence/screenshots/COUR-02.png)
- [evidence/screenshots/COUR-03.png](evidence/screenshots/COUR-03.png)
- [evidence/screenshots/COUR-04.png](evidence/screenshots/COUR-04.png)
- [evidence/screenshots/COUR-05.png](evidence/screenshots/COUR-05.png)
- [evidence/screenshots/COUR-06.png](evidence/screenshots/COUR-06.png)
- [evidence/screenshots/FB-SEND.png](evidence/screenshots/FB-SEND.png)
- [evidence/screenshots/MD-01.png](evidence/screenshots/MD-01.png)
- [evidence/screenshots/MD-02.png](evidence/screenshots/MD-02.png)
- [evidence/screenshots/MON-01.png](evidence/screenshots/MON-01.png)
- [evidence/screenshots/MON-02.png](evidence/screenshots/MON-02.png)
- [evidence/screenshots/MSG-01.png](evidence/screenshots/MSG-01.png)
- [evidence/screenshots/MSG-02.png](evidence/screenshots/MSG-02.png)
- [evidence/screenshots/PR-01.png](evidence/screenshots/PR-01.png)
- [evidence/screenshots/ROLE-01.png](evidence/screenshots/ROLE-01.png)
- [evidence/screenshots/ROLE-02.png](evidence/screenshots/ROLE-02.png)
- [evidence/screenshots/SCR-01.png](evidence/screenshots/SCR-01.png)
- [evidence/screenshots/TEAM-01.png](evidence/screenshots/TEAM-01.png)
- [evidence/screenshots/UI-01.png](evidence/screenshots/UI-01.png)
- [evidence/screenshots/UI-02.png](evidence/screenshots/UI-02.png)
- [evidence/screenshots/UI-03.png](evidence/screenshots/UI-03.png)
- [evidence/screenshots/UI-04.png](evidence/screenshots/UI-04.png)
- [evidence/screenshots/UI-05.png](evidence/screenshots/UI-05.png)
- [evidence/screenshots/UI-06.png](evidence/screenshots/UI-06.png)
- [evidence/screenshots/YAML-01.png](evidence/screenshots/YAML-01.png)

辅助环境证据：[environment.json](evidence/environment.json)；包基线：[release-comparison.json](evidence/release-comparison.json)。
