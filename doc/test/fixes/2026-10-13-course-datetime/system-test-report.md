# 课程日期与比赛设置修复报告

三项评审发现均已处理，部署为 `hydrooj 5.0.7-dev.2` / UI `4.58.5-dev.5`。2026-10-13（Asia/Shanghai）完成 **24项相关代码/构建回归测试、18项浏览器回归，全部通过**。计划见 [18项用例](test-cases.json)，最终逐项数据见 [browser-results.json](evidence/browser-results.json)。

## 评估与处理

| 发现 | 原因及影响 | 本次处理 |
| --- | --- | --- |
| 比赛设置测试阻断CI | 原生布局移除了自定义toggle包装，旧测试读取null.classList。 | 保留原生布局；测试改为验证OI→ACM→OI的实际disabled状态和FormData提交。 |
| 修改分数会截断时间 | 分钟级回显在分数、监控和blur事件中被重新转成ISO，丢失秒和毫秒；已开始测评因此可能被时间保护拒绝。 | 测评控件显示并编辑秒；未修改时间的完整原始ISO保留，明确修改一个边界只更新该边界。 |
| 默认时间偏移 | 用户时区的课时文字被按浏览器时区解释，可能偏移8小时甚至超出课程范围。 | 模板携带用户IANA时区，先转换为实际时间，再显示为浏览器本地时间；默认课时窗口按用户时区计算并覆盖夏令时。 |

新增日期帮助模块为 [course-datetime.ts](../../../../packages/ui-default/utils/course-datetime.ts)；[源码差异](evidence/fix-diff.patch)保留页面、模板、依赖与比赛测试改动。日期模块使用项目已有的moment-timezone，并声明UI构建依赖。严格日期解析拒绝无效日历日期。模板状态修复及此前安全改动保留。

## 验证与发布

| 检查 | 结果及证据 |
| --- | --- |
| 定向测试 | 24/24通过，含比赛设置、完整页面初始化日期/模板、相邻文本解析与UI打包回归；[TAP](evidence/unit-tests.tap)。 |
| 类型检查 | `tsc -p tsconfig.ui.json --noEmit`通过；[记录](evidence/typecheck.json)。 |
| 构建与发布 | 官方`./build-and-publish-dev.sh --packages ui-default`编译成功，私有`https://npm.leeson.top/`的`dev`标签发布`4.58.5-dev.5`；[记录](evidence/build-publish.json)。 |
| 更新 | 安装中的官方`install-dev-from-private-npm.sh update --packages ui-default`，完成后容器内`pm2 restart hydrooj`。 |
| 部署目录 | `/root/.hydro/dev-releases/20261013003217`。 |
| 健康 | 四项PM2服务online，`http://localhost:8082/d/exam/login` HTTP200；实际bundle含精度保护和时区标记；[最终核验](evidence/final-health.json)。 |
| 包对比 | [实际部署对比](evidence/release-comparison.json)：UI dev.4→dev.5，后端、framework、common的实际包文件无变化。 |

第一次发布调用在依赖解析阶段等待，因为Yarn没有显式读取代理配置。诊断时私有仓库及依赖元数据均可通过已授权代理访问；取消尚未构建或发布的等待调用，将YARN_HTTP_PROXY/YARN_HTTPS_PROXY设为授权代理环境值后，用同一官方脚本完成发布。[过程记录](evidence/publish-network.json)；注册源保持原配置。

## 浏览器逐项结果

使用`testuser.txt`的本地标签管理员xingchen与学生amily，通过Chrome/CDP执行保存、报名、选题、提交和模板复制。写入全部使用独立临时域。时区测试采用每个Chrome会话的Emulation设置，读取管理员实际配置的Asia/Shanghai时区；API/CLI只准备夹具及补充核对持久数据。

| 编号 | 用例 | 结果 | 观察 | 截图 |
| --- | --- | --- | --- | --- |
| DATE-01 | 达标分数及监控编辑保留时间精度 | 通过 | 改为75分及浏览器监控后，秒47和毫秒321/654完整保留。 | [截图1](evidence/datetime/screenshots/DATE-01.png) |
| DATE-02 | 单独修改结束时间 | 通过 | 明确修改结束时间后，仅结束时间变化，开始时间含毫秒保持。 | [截图1](evidence/datetime/screenshots/DATE-02.png) |
| DATE-03 | 已开始测评允许修改分数及监控 | 通过 | 已开始测评修改90分及关闭监控保存成功；父DAG与子测评时间完全保留。 | [截图1](evidence/datetime/screenshots/DATE-03.png) |
| DATE-04 | 不同时区的默认测评时间 | 通过 | 用户Asia/Shanghai、浏览器UTC及America/Los_Angeles：两次默认值均保存为原始课时UTC时间。 | [截图1](evidence/datetime/screenshots/DATE-04.png) |
| CSET-01 | 原生比赛设置切换赛制及保存 | 通过 | OI→ACM→OI禁用状态与FormData一致；OI封榜及浏览器监控实际保存成功。 | [截图1](evidence/contest-retest/screenshots/CSET-01.png) |
| COUR-01 | 可视化章节编辑与稳定编号 | 通过 | 新增、删除、再次新增并保存；编号6→7，测评绑定保留。 | [截图1](evidence/core/screenshots/COUR-01.png) |
| COUR-02 | 学生认领与初始门禁 | 通过 | 认领课程后初始章节可见，未达标章节题目403。 | [截图1](evidence/course-access-retest/screenshots/COUR-02.png) |
| COUR-03 | 管理分组与破坏操作确认 | 通过 | 管理页对象切换、取消及确认关闭生效。 | [截图1](evidence/core/screenshots/COUR-03.png) |
| COUR-04 | 手工关闭阻止 SELF 越权 | 通过 | 关闭后详情和提交页均403。 | [截图1](evidence/core/screenshots/COUR-04.png) |
| COUR-05 | 手工开放与恢复访问规则 | 通过 | 手工开放生效，恢复规则后重新403。 | [截图1](evidence/core/screenshots/COUR-05.png) |
| COUR-06 | 学生不能管理或编辑课程 | 通过 | 学生管理和编辑页均403。 | [截图1](evidence/core/screenshots/COUR-06.png) |
| ASM-01 | 父课程准入与独立测评 | 通过 | 认领父课程前拒绝，认领后独立报名成功。 | [截图1](evidence/course-access-retest/screenshots/ASM-01.png) |
| TPL-01 | 课程模板保存 | 通过 | 显式保存为独立模板，保留测评节点、移除实例绑定，源课程保留。 | [截图1](evidence/extra-course/attempts/2026-10-13T00-35-22-352Z/screenshots/TPL-01-before.png)、[截图2](evidence/extra-course/attempts/2026-10-13T00-35-22-352Z/screenshots/TPL-01-after.png) |
| TPL-02 | 班级复制含测评模板 | 通过 | 两个班级通过真实选择模板复制，得到不同课程及测评ID，题目映射有效。 | [截图1](evidence/extra-course/attempts/2026-10-13T00-35-22-352Z/screenshots/TPL-02-class-1.png)、[截图2](evidence/extra-course/attempts/2026-10-13T00-35-22-352Z/screenshots/TPL-02-class-2.png) |
| TPL-03 | 已有模板普通 Update | 通过 | 已有模板Update保存标题，teachers分类及无实例测评节点保留。 | [截图1](evidence/extra-course/attempts/2026-10-13T00-35-22-352Z/screenshots/TPL-03-before.png)、[截图2](evidence/extra-course/attempts/2026-10-13T00-35-22-352Z/screenshots/TPL-03-after.png) |
| ASM-02 | 正常进入题目列表开始作答 | 通过 | 开始后可访问私有题目并保存开始时间。 | [截图1](evidence/core/screenshots/ASM-02.png) |
| ASM-03 | 真实判题与测评期间成绩隐藏 | 通过 | 教师可见Accepted/100，学生结束前隐藏成绩及后续章节。 | [截图1](evidence/core/screenshots/ASM-03.png) |
| ASM-04 | 结束后成绩与后续章节自动解锁 | 通过 | 结束后显示100分，并开放后续章节及题目。 | [截图1](evidence/core/screenshots/ASM-04.png) |

DATE-04的额外直接证据：[UTC默认值](evidence/datetime/screenshots/DATE-04-0-defaults.png)、[洛杉矶默认值](evidence/datetime/screenshots/DATE-04-1-defaults.png)。界面时间按浏览器时区变化，保存的开始时间均为`2026-10-12T23:35:00.000Z`、结束时间均为`2026-10-13T02:35:00.000Z`。DATE-01/03的精确秒、毫秒以及子测评时间另由服务端状态补充核对；浏览器动作与截图保留为直接证据。

## 初始尝试与重测

[日期首次结果](evidence/datetime/results.json)中的CSET-01没有找到提交按钮：脚本误用普通课程的无name按钮选择器，原生比赛页的Update按钮为`name=operation,value=update`。修正为实际Update按钮并排除Clone按钮后，[比赛设置重测](evidence/contest-retest/results.json)通过。

[核心首次结果](evidence/core/browser-results.json)中的COUR-02导航等待超时，页面停留在已报名的子测评，没有收到课程请求或JS异常。同地址报名的旧等待条件可能在提交导航完成前满足。驱动已对同地址提交确认新文档后再继续，并支持路径切换；[报名及课程门禁重测](evidence/course-access-retest/browser-results.json)均通过。原始超时证据保留，最终矩阵只采用选定并完成的重测结果，skipped项没有覆盖已完成结果。

## 清理、范围与复用

五个临时域已全部删除，课程、班级、提交、消息、任务和活动存储残留均为零；[逐域核验](evidence/final-cleanup-verification.json)。35个存储记录已安排autoDelete，正常保留期7天。额外模板夹具的班级行清理另见 [cleanup.json](evidence/extra-course/cleanup.json)。

本轮覆盖三项评审问题及相关18项路径，没有将原dev.2的53项全量结果改写为在dev.5上全部通过。发布说明见 [Release note](release-notes.md)。复用入口见 [hydro-release-system-test skill](../../skills/hydro-release-system-test/SKILL.md)，已增加`course-datetime-test.cjs`流程；脚本支持`--only`定向重测，核心脚本只为需要时序的用例启动测评等待。
