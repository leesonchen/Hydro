# 普通课程编辑修复与浏览器回归报告

修复已部署到 Docker `hydro`：`hydrooj 5.0.7-dev.2` / `@hydrooj/ui-default 4.58.5-dev.4`。本轮 **13 项浏览器用例全部通过**，4 项代码回归测试通过，UI 类型检查与正式构建通过。执行于 2026-10-13（Asia/Shanghai）；发布及首次复现开始于 2026-10-12。完整逐项数据见 [最终结果](evidence/browser-results.json)，计划见 [test-cases.json](test-cases.json)。

## 原因与修复

原 dev.2 的普通课程编辑页包含 `button[name="isTemplate"][value="true"]`（另存为模板）。前端以同名元素存在作为当前模板状态，把空班级分配字段填成 `teachers`。普通 Update 未提交模板操作标记，后端正确拒绝该分配，返回 400「不能分配课程给 teachers 组」。[本轮修复前的真实浏览器截图](evidence/before/screenshots/COUR-01.png)及 [HTTP 复现记录](evidence/before/reproduction.json)确认了这一链路；[原发布诊断](../../releases/2026-10-12-dev.2/defects.md)证明前一版也存在相同问题。

前端现在读取模板编辑页专用的隐藏输入 `input[type="hidden"][name="isTemplate"]`，并核对值为 `true`。普通课程的另存为模板按钮仍只在点击时提交其操作值。后端原有校验保留。改动见 [源码补丁](evidence/course-template-fix.patch)；[最终已部署 bundle 与健康检查](evidence/final-health.json)确认修复代码已实际生效。

另一项原报告中的 MSG-02 属于账号能力不足：测试用户没有普通全站发信权限。该项没有通过修改真实账号权限处理，仍按原报告记录为阻塞；内容反馈及独立回复权限在原发布报告中已通过验证。本轮无需发送新的真实消息。

## 发布与检查

| 项目 | 实际结果 |
| --- | --- |
| 目标 | `http://localhost:8082`，Docker `hydro` |
| UI | `4.58.5-dev.2 → 4.58.5-dev.4`，稳定基版本仍为 `4.58.5` |
| 后端 | `5.0.7-dev.2`，实际包文件无变化 |
| 发布 | 官方 `./build-and-publish-dev.sh --packages ui-default`，私有 `https://npm.leeson.top/`、`dev` 标签 |
| 更新 | 已安装的官方 `install-dev-from-private-npm.sh update --packages ui-default` |
| 重启 | 容器内 `pm2 restart hydrooj` |
| 活动目录 | `/root/.hydro/dev-releases/20261012152438` |
| 服务 | 四项 PM2 服务 online；`/d/exam/login` HTTP 200 |
| 类型检查 | `tsc -p tsconfig.ui.json --noEmit`，通过 |
| 构建 | UI webpack 编译成功 |
| 回归测试 | `node --test test/course-template-state.spec.js`，4/4 通过，已接入 `npm test` |

构建发布证据见 [build-publish.json](evidence/build-publish.json)、[类型检查](evidence/typecheck.json)、[测试 TAP](evidence/unit-tests.tap)。[实际部署包对比](evidence/release-comparison.json)显示只更新 UI，后端及 framework/common 的包文件无变化。该 UI 包同时保留工作区已有的课程时间选择器调整，详见 [Release note](release-notes.md)。

## 浏览器逐项结果

使用 `testuser.txt` 的本地标签管理员 xingchen 和学生 amily；密码仅在运行时读取。Chrome/CDP 的真实浏览器操作完成保存、报名、提交、选题及班级复制；API/CLI 仅准备隔离夹具并补充核对持久状态。浏览器环境见 [environment.json](evidence/after/environment.json)。截图展示临时测试域，不包含登录密码、会话材料或真实课程数据。

| 编号 | 用例 | 结果 | 观察 | 截图 |
| --- | --- | --- | --- | --- |
| COUR-01 | 可视化章节编辑与稳定编号 | 通过 | 真实选择题目后连续保存新增、删除、再次新增；编号 6 → 7，原测评绑定保留。 | [证据 1](evidence/course-native-input/screenshots/COUR-01.png) |
| COUR-02 | 学生认领与初始门禁 | 通过 | 认领课程后初始章节可见，未达标章节的题目仍为 403。 | [证据 1](evidence/after/screenshots/COUR-02.png) |
| COUR-03 | 管理分组与破坏操作确认 | 通过 | 管理页三类对象可操作；取消不变更，确认关闭后显示成功。 | [证据 1](evidence/after/screenshots/COUR-03.png) |
| COUR-04 | 手工关闭阻止 SELF 越权 | 通过 | 关闭章节后，学生的题目详情和提交页面均返回 403。 | [证据 1](evidence/after/screenshots/COUR-04.png) |
| COUR-05 | 手工开放与恢复访问规则 | 通过 | 手工开放生效，恢复规则后未达标章节重新返回 403。 | [证据 1](evidence/after/screenshots/COUR-05.png) |
| COUR-06 | 学生不能管理或编辑课程 | 通过 | 学生访问课程管理、编辑页均为 403。 | [证据 1](evidence/after/screenshots/COUR-06.png) |
| ASM-01 | 父课程准入与独立测评 | 通过 | 认领父课程前拒绝进入测评；认领后可独立报名，测评不计 Rating。 | [证据 1](evidence/after/screenshots/ASM-01.png) |
| TPL-01 | 课程模板保存 | 通过 | 显式保存生成独立模板，测评节点保留但不携带实例 contestTid，源课程测评保留。 | [证据 1](evidence/extra-course/attempts/2026-10-12T23-08-22-131Z/screenshots/TPL-01-before.png)、[证据 2](evidence/extra-course/attempts/2026-10-12T23-08-22-131Z/screenshots/TPL-01-after.png) |
| TPL-02 | 班级复制含测评模板 | 通过 | 两个班级通过真实 Add Course 对话框复制，获得不同课程和测评 ID，题目映射有效。 | [证据 1](evidence/extra-course/attempts/2026-10-12T23-08-22-131Z/screenshots/TPL-02-class-1.png)、[证据 2](evidence/extra-course/attempts/2026-10-12T23-08-22-131Z/screenshots/TPL-02-class-2.png) |
| TPL-03 | 已有模板普通 Update | 通过 | 模板使用隐藏标记；普通 Update 保存新标题，保留 teachers 分类且不生成测评实例。 | [证据 1](evidence/extra-course/attempts/2026-10-12T23-08-22-131Z/screenshots/TPL-03-before.png)、[证据 2](evidence/extra-course/attempts/2026-10-12T23-08-22-131Z/screenshots/TPL-03-after.png) |
| ASM-02 | 正常进入题目列表开始作答 | 通过 | 测评开始后可打开私有题目，开始时间保存。 | [证据 1](evidence/after/screenshots/ASM-02.png) |
| ASM-03 | 真实判题与测评期间成绩隐藏 | 通过 | 教师浏览器可见 Accepted/100；学生成绩和后续章节在结束前保持隐藏。 | [证据 1](evidence/after/screenshots/ASM-03.png) |
| ASM-04 | 结束后成绩与后续章节自动解锁 | 通过 | 结束后学生可见 100 分及后续章节，并可访问解锁题目。 | [证据 1](evidence/after/screenshots/ASM-04.png) |

浏览器页面为直接证据；编号、测评绑定、题目映射和无 Rating 属性的精确核对另有服务端状态补充。最终矩阵以每项实际完成的结果合并，未执行的 skipped 项没有覆盖已完成结果。

## 重测过程与范围

保留 [初次修复后执行](evidence/after/browser-results.json)：COUR-01 前两次保存已为 302/200，第三次保存未发出请求而超时，没有 400、原错误页或未处理 JS 异常。表单超时的具体原因未确认，不将其归因为新的产品故障。[单独重测原流程](evidence/course-retest/browser-results.json)随后通过。

为加强用例，新增章节时明确选择有效题目。第一次使用合成字段事件及整段题名查询未完成 Autocomplete 选择；[控件诊断](evidence/course-final/COUR-01-diagnostics.json)显示无原生表单校验错误、章节未获得题目。[最终重测](evidence/course-native-input/browser-results.json)改用真实 CDP 键盘输入题号并点击可见选项后，通过完整的三次保存及编号、绑定核对。以上初次尝试均保留，最终矩阵采用此完成记录。

本报告只覆盖本次修复相关的 13 项浏览器回归。原 dev.2 的 53 项全量结果保留为历史报告，不改写为在 dev.4 上全部通过；普通消息的权限阻塞也未混入这 13 项结果。

## 清理与证据

六个本轮自建测试域全部删除，课程、班级、提交、任务、消息及活动存储残留均为零。[最终数据库只读核验](evidence/final-cleanup-verification.json)逐域记录了清理结果。模板班级夹具的域内班级行由补充清理步骤删除后再次核验，见 [模板测试清理](evidence/extra-course/cleanup.json)。共 42 个存储记录已安排 autoDelete，正常保留期为 7 天；这些记录不属于活动残留。

可复用的主浏览器脚本已补充真实题号输入、选择及失败控件诊断；额外模板脚本增加 TPL-03。现有 [hydro-release-system-test skill](../../skills/hydro-release-system-test/SKILL.md)继续复用这些脚本；下一次执行时须将额外脚本的全部计划 ID 并入矩阵。
