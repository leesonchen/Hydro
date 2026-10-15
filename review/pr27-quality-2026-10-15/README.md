# PR #27 质量收敛与验证记录

日期：2026-10-15。仓库：`leesonchen/hydromod`。PR：<https://github.com/leesonchen/hydromod/pull/27>。

目标分支为 `course-v2.2`，开发分支为 `fix/classroom-test-post-contest-practice-20261015`。本轮从 `0b7f4641` 开始，已合入目标分支 `a4d13fa5`，合并过程没有冲突。业务需求冻结在 [课堂测试与普通比赛契约](../classroom-assessment-vs-contest-contract-2026-10-15.md)，该文件本轮没有修改。

## 修复提交

| 提交 | 内容 |
| --- | --- |
| `5fd8394a` | 合入最新 `course-v2.2`，保留原 PR 开发历史。 |
| `1e675cb1` | 统一课堂记录 HTTP 与实时发送的父课程授权；隔离预运行、全局查询和实时投影；补齐测试依赖及边界回归。 |
| `0411b2d5` | 增加真实 Hydro HTTP/WebSocket 集成测试及独立入口；修复旧认证、反馈和监考测试夹具。 |
| `52fef1bb` | 清理 CI lint 的格式、导入顺序、命名和等价计数写法，保留异常路径的诊断计数行为。 |
| `0fde974a` | 权限过滤后保留空页的下一页入口，避免遮住较老的普通比赛记录；增加真实 HTML 回归。 |

最终代码验证对象为 `0fde974a7a7bef32ef360c3b68620e733b92d7aa`。随后保存的报告与日志提交只增加验证材料。

## 已解决的问题

1. `practice-record-connection.spec.js`、`submission-provenance.spec.js` 补入实际 `canShowClassroomSelfRecord` 测试依赖。所报 `contest-team-regressions.spec.js` 第 260 行语法错误在本轮起始版本没有复现；该文件原始语法检查和原有 9 项测试均通过，本轮增加实际 OI 投影和权限边界测试后仍通过。
2. 课堂正式记录订阅拒绝其他活动的全零 contest ID 预运行事件。显式预运行订阅仅接受本人、当前测试题目的记录，并重新检查父课程权限。
3. HTTP 列表、详情、代码下载、全局 `all/allDomain` 和两条 WebSocket 路由统一使用父课程授权。普通比赛 ID 搭配全局参数也逐条核验课堂记录，不能把普通比赛权限扩展为课堂权限。
4. 子比赛旧 owner、maintainer、assign 和普通比赛管理员权限不再改变课堂学生的记录可见性。父课程教师绕过课堂投影，学生按实际课堂赛制的自身结果窗口投影；无父课程实时授权的全局题目状态摘要不公开课堂结果。
5. 实时发送重新读取账户、领域角色、课程资格和章节授权，保留原连接的权限范围。教师降级后关闭原教师连接，即使其仍为学生且查看本人记录，也不能继续接收原先未投影的数据。
6. 队列发送前、HTML 渲染后再次检查权限与可见性配置。课程测试延期后，旧连接按当前子测试时间投影，渲染途中变化的旧 payload 被丢弃。
7. 修复完整测试发现的夹具问题：认证课堂测试提供真实班级学生结构和课程权限；监考 HTML 断言检查实际展示的事件名称与会话；反馈 VM 测试补齐现有模块依赖。没有通过放宽产品授权或跳过测试消除失败。
8. 额外执行 CI lint 并清理其失败。涉及目标分支既有 Rating 文件的改动只做等价整理，保留已有 Rating 算法与准入策略。

## 权限链路与执行证据

`assertCourseAssessmentAccess` 仍是父课程资格与管理权限的统一判断。课堂记录的共享 `assertRecordActivityAccess` 在其基础上约束记录所属人和正式结果窗口；实时检查复用该判断。

| 场景 | 入口与断言 | 结果 |
| --- | --- | --- |
| 教师赛前预览 | 没有比赛查看/编辑权限的父课程维护人可访问课堂题目；不产生测试到场。 | 通过 |
| 学生正式开始与教师提交 | 合格学生主动开始后正式提交；教师提交为 staff，教师/课程外学生不能正式报名。 | 通过 |
| 成绩板与代码 | 父课程教师访问实时 default、CSV、Ghost、代码 ZIP 与单条代码下载；仅统计真实到场，学生/旧子比赛 owner/普通比赛管理员被拒绝。 | 通过 |
| 正式与练习记录 | 列表、详情、代码下载及两条真实 WS 路由；学生仅本人，教师按当前父课程权限读取。 | 通过 |
| 权限撤销 | 班级移除、节点关闭、维护人移除后 HTTP 拒绝，正式/练习 WS 关闭，后续队列不再发送，历史记录保留。 | 通过 |
| 教师降级但仍为学生 | 新 HTTP 自身记录按学生投影；旧教师列表/详情连接关闭。 | 通过 |
| 跨活动预运行 | 学生与教师的课堂正式订阅均不能接收全零 contest ID 的其他预运行。 | 通过 |
| 全局记录旁路 | `all/allDomain` × 无 tid/普通比赛 tid，HTTP 与 WS 均逐条授权；全域权限测试保留真实受限 session scope。 | 通过 |
| 全局自身记录投影 | 具有全局记录权限的课堂学生仍按该课堂 ACM 投影，不能套用另一普通比赛的投影。 | 通过 |
| 时间调整与渲染竞态 | 父子测试时间延期后旧 WS 隐藏进行中 ACM 分数；渲染期间配置改变不发送旧内容。 | 通过 |
| 缺考学生赛后练习 | 历史缺失开关默认允许；明确关闭后拒绝；练习写入 `practiceContest`，不生成到场、不修改正式成绩或 Rating 证据。 | 通过 |
| 普通比赛与翻页 | 保持报名、开始时间与显式补交开关；过滤课堂记录形成空页时，真实 HTML 仍可翻到下一页的普通比赛记录。 | 通过 |
| 认证与 Rating 隔离 | 认证准入、冻结证明、正式出席、教师/练习排除，以及完整 Rating 回归均通过。 | 通过 |

集成测试使用真正启动的 Hydro、隔离 MongoDB、supertest 登录会话、`ws` 网络连接、生产模板和真实事件订阅。数据库直接写入仅用于构造夹具、权限变动和推进测试时间；没有直接调用被测 handler 或模拟父课程授权。独立入口为 `yarn test:classroom-assessment:integration`，同一测试也接入 `test/main.ts`，随完整 `yarn test` 执行。

## 实际构建与测试

环境为 Node.js `v22.20.0`、Yarn `4.14.1`、仓库依赖 TypeScript `6.0.3`，使用本机已有 MongoDB `8.2.1`。测试 profile 与数据均隔离。

| 检查 | 最终实际结果 | 原始日志 |
| --- | --- | --- |
| 所有受 Git 管理的 JS/CJS/MJS `node --check` | 124 个文件通过，退出 0。 | [syntax.log](syntax.log) |
| `yarn build` | 项目 TypeScript 构建通过，退出 0。 | [build.log](build.log) |
| `yarn build:ui:production:webpack` | 生产 UI 编译成功，退出 0。 | [ui-build.log](ui-build.log) |
| `yarn lint:ci` | 零错误、零警告，退出 0。 | [lint.log](lint.log) |
| 四份权限/提交/比赛专项回归 | 110/110，通过，退出 0。 | [permissions.log](permissions.log) |
| 独立真实 HTTP/WebSocket/HTML 集成 | 17/17，通过，退出 0。 | [runtime.log](runtime.log) |
| 完整 `yarn test` | 退出 0；27 个 node:test 进程汇总 691/691；0 失败、取消或跳过，最后 Hydro 应用测试 89/89；链中的非 TAP 脚本亦全部完成。 | [full-test.log](full-test.log) |

完整测试的实际环境参数为：

```sh
COREPACK_HOME=/home/leeson/.cache/node/corepack \
MONGOMS_SYSTEM_BINARY=/home/leeson/.cache/mongodb-binaries/mongod-x64-ubuntu-8.2.1 \
NODE_OPTIONS=--require=/home/leeson/work/Hydro/test/classroom-feedback-test-isolate.cjs \
yarn test
```

这些参数复用已安装的 Yarn/MongoDB，防止 `os.homedir()` 隔离后重复下载。最初受沙箱本地端口限制和重复下载影响的尝试已经替换为允许本地临时端口的完整实际执行，当前没有依赖或测试环境阻碍。权限负例会产生预期的 403/WS 错误日志，测试断言及最终退出码用于判断执行结果。

完整测试中 node:test 各进程的汇总计数在 [verification.json](verification.json) 保存；独立专项与集成测试是重叠验证，不能与完整测试数字相加。日志 SHA-256 见 [checksums.sha256](checksums.sha256)。

## 剩余事项与合并结论

- 没有已知 P0/P1/P2 阻塞项，最终结果以保存的完整测试退出码为准。
- P3：全局列表仍按原始页边界取记录后过滤，因此可见条数可能少于每页配置值；已验证过滤后的空页保留原有翻页能力，不影响较老普通比赛记录的访问，也不公开无权记录。
- PR #27 保留原开发分支与 Draft 状态；本轮没有合并、创建重复 PR、部署或发布包。

结论：**达到技术合并条件**。冻结契约、父课程授权边界、普通比赛回归、最新目标分支同步、构建、CI lint 和完整自动化均有实际通过的执行证据。唯一 P3 显示条数限制不影响授权或翻页，非合并阻塞项。最终合并与 PR 状态调整由仓库审阅流程决定。
