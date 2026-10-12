# PR #13 / PR #14 合并前评审

**修复进展（2026-10-11）：** 两份 PR 的功能已迁入当前分支工作区，下面的原始缺陷已修复；完整测试、类型构建、UI 生产构建和全仓库 lint 均通过。最终实施与验证见 [INTEGRATION.md](INTEGRATION.md)。本文件其余部分保留首次评审时的证据与结论；试集成补丁及旧诊断日志属于历史材料，不能作为最终代码使用。

评审结论：**暂不直接合并到 `course-v2.2`**。发现 5 项需要修复的问题，其中 4 项有行为复现，另 1 项由 TypeScript 检查确认。PR #14 还需要迁移到当前分支的内置课程模块，不能只选择某一侧解决冲突。

## 评审基线

| 对象 | 提交 | 状态 |
| --- | --- | --- |
| 当前分支 `course-v2.2` | `580f114fc434899f857ebb38affd736d8a56f5a1` | 评审前工作区干净 |
| [PR #13](https://github.com/leesonchen/hydromod/pull/13) | `481d26f6270327a29d047f320cee0444e15e5df7` | 浏览器比赛监控，Draft |
| [PR #14](https://github.com/leesonchen/hydromod/pull/14) | `7e90aa00cb4f1c8ae86de317f412ed2d8033752e` | 课堂测试章节，Draft |

两个 PR 的目标分支都是 `master-mod`，不是当前 `course-v2.2`。共同祖先为 `008c43844ffa19abf97405af0be1344e84c5ad76`。GitHub 显示可合并只代表它们可以合入远程目标分支。

## 需要修复的问题

### 1. [P1] PR #13 的监控模式参数导致编译失败

[contest.ts:413](https://github.com/leesonchen/hydromod/blob/481d26f6270327a29d047f320cee0444e15e5df7/packages/hydrooj/src/handler/contest.ts#L413) 的 `monitorMode = 'off'` 被推断为 `string`；`includes()` 校验不会把它收窄为 `Tdoc.monitorMode` 的 `'off' | 'browser'`。传给 `contest.edit(..., Partial<Tdoc>)` 时类型不兼容。

保留当前分支的比赛更新流程进行试合并后，在 `contest.edit` 和 `contest.add` 处新增 2 条 TS2345。给参数显式标注 `NonNullable<Tdoc['monitorMode']>` 后，这 2 条错误消失，诊断与基线完全一致。附带的 PR #13 试集成补丁已包含该类型修复。

当前本地依赖下，基线本身仍有 16 条诊断，涉及 `DumpOptions.seqNoIndent` 和 `Context.logger`。因此不能声称完整类型检查通过。原始诊断见 `typecheck-baseline.log`、`typecheck-pr13-before-fix.log`、`typecheck-pr13-after-fix.log`。

### 2. [P1] PR #14 把 ACM 测试成绩恒定读成 0

[assessment.ts:136](https://github.com/leesonchen/hydromod/blob/7e90aa00cb4f1c8ae86de317f412ed2d8033752e/packages/course-management/model/assessment.ts#L136) 统一读取 `tsdoc.score`。ACM 规则统计返回 `accept`、`time`、`detail`、`display`，不返回数值 `score`。

已用 PR #14 的真实 ACM 统计函数复现：学生通过一道题，`accept = 1`；测试结果仍为 `score = 0`，`passScore = 1` 时 `completed = false`。任何正数门槛都无法通过，依赖该测试完成的后续课时无法解锁。

修复应按赛制定义达标指标：ACM 使用通过题数，OI/IOI/StrictIOI 使用分数，并同步调整编辑器的标签、范围和前置章节聚合逻辑。默认门槛为 0 的含义也应保持一致。

### 3. [P2] PR #13 与当前分支的团队参赛状态不兼容

[contest-monitor.ts:50](https://github.com/leesonchen/hydromod/blob/481d26f6270327a29d047f320cee0444e15e5df7/packages/hydrooj/src/handler/contest-monitor.ts#L50) 只按个人 UID 查询参赛状态。当前分支的 `ContestDetailBaseHandler` 会先调用 `getTeamVid()`，再用团队 UID 读取状态。

因此，已通过团队参赛的成员能看到监控横幅，但心跳、切屏等所有上报会被 `ContestNotAttendedError` 拒绝，并持续显示同步失败。复现脚本已确认该行为。这是合入当前分支时出现的兼容问题。

修复应复用当前比赛参与者解析逻辑，以团队状态验证参赛资格，同时保留实际操作学生的 UID 用于监控记录；并测试个人限时结束、团队参赛和成员权限。

### 4. [P2] PR #13 队列溢出会误删未确认的事件

[contest_monitor_client.html:43](https://github.com/leesonchen/hydromod/blob/481d26f6270327a29d047f320cee0444e15e5df7/packages/ui-default/templates/partials/contest_monitor_client.html#L43) 在收到 ACK 后无条件 `pending.shift()`；[第 64 行](https://github.com/leesonchen/hydromod/blob/481d26f6270327a29d047f320cee0444e15e5df7/packages/ui-default/templates/partials/contest_monitor_client.html#L64) 的溢出处理可能提前删除正在发送的心跳，或正在发送的队首事件。

已复现：让初始心跳保持未完成，再产生 120 个粘贴事件；队列淘汰该心跳；随后心跳 ACK 到达，代码又删除第一个粘贴事件。请求直接跳到 sequence 3，sequence 2 从未发送却已被删除。

修复应根据 `(sessionId, pageInstanceId, sequence)` 精确删除收到 ACK 的事件，不能根据当前位置删除。溢出时也应保护正在发送的事件。

### 5. [P2] PR #13 的去重提前返回使部分写入失败无法恢复

[contest-monitor.ts:60](https://github.com/leesonchen/hydromod/blob/481d26f6270327a29d047f320cee0444e15e5df7/packages/hydrooj/src/handler/contest-monitor.ts#L60) 先插入事件，随后才写会话状态。如果会话写入失败，客户端重试相同事件时，[第 63 行](https://github.com/leesonchen/hydromod/blob/481d26f6270327a29d047f320cee0444e15e5df7/packages/hydrooj/src/handler/contest-monitor.ts#L63) 会立即返回 `ok: true, duplicate: true`，不再修复会话。

已注入一次会话写入失败复现：`page_hidden` 事件已保存，但 `hiddenSince` 未保存；重试得到成功 ACK；随后 `page_visible` 事件没有离开时长。客户端已经移除原事件，无法再恢复这次状态转换。

修复应让事件与会话转换具备一致的重试语义，例如事务或持久化处理状态；重放时也不能重复增加时长或覆盖更新的会话状态。

## 合并准备与冲突迁移

隔离试合并目录：`/tmp/hydro-pr13-pr14-review`。先合入 PR #13，再试合入 PR #14。

PR #13 有 1 个冲突文件：`packages/hydrooj/src/handler/contest.ts`。已在隔离目录解决，保留当前分支的团队参赛、赛后练习、首页横幅开关、单次配置更新及状态重算，并将 `monitorMode` 纳入同一个更新对象。

`pr13-trial-integration.patch` 是相对上述当前分支提交的试集成补丁，已经通过 `git apply --check`。它包含第 1 项类型修复，**尚未修复第 3–5 项，不是可发布补丁**。

PR #14 在 PR #13 试合并基础上出现 9 个冲突路径，原始冲突记录见 `pr14-merge-conflicts.diff`：

| PR #14 原路径 / 冲突路径 | 当前分支迁移目标与处理要求 |
| --- | --- |
| `packages/course-management/README.md` | 原插件已删除；迁移新增说明，不恢复旧插件包 |
| `packages/course-management/handler/class.ts` | `packages/hydrooj/src/builtin/course-management/handler/class.ts`；迁入模板测试复制和题目映射，保留域解析、班级编辑锁、权限校验、重命名回滚 |
| 内置 `handler/course.ts` | 合入测试 DAG 解析、验证、同步、成绩与删除保护，保留结构修订号、历史编号、并发校验及课程反馈保护 |
| 内置 `index.ts` | 合入唯一索引和 Rating 保护；补齐 `DocumentModel` 的本地 API 导入，保留当前插件初始化方式 |
| 内置 `model/assessment.ts` | 新文件迁入内置模块；将 `from 'hydrooj'` 改为与该目录一致的 `../../../plugin-api` |
| 内置 `model/course.ts` | 合入测试节点类型和进度保护，保留当前稳定的题目归属逻辑 |
| `packages/hydrooj/src/handler/contest.ts` | 将课堂测试权限检查叠加到当前参与者解析流程，保留团队和赛后练习逻辑 |
| `packages/ui-default/pages/course_edit.page.ts` | 合入课堂测试字段，保留课时排序、稳定编号和讲义访问配置 |
| `packages/ui-default/templates/course_detail.html` | 合入测试入口和成绩展示，保留讲义权限及普通课时成绩板配置；测试入口单独控制权限 |

迁移还需同时修改 `model/structure.ts`：题目计分归属、访问归属及历史归属覆盖都应跳过 assessment 节点。否则普通课时和测试复用同一 PID 时，现有结构函数会把测试节点当作普通课时归属。

班级重命名、归档、课程调班和时间更新也需要覆盖派生测试。例如当前班级重命名只迁移 `rule: 'course'` 的分配组，独立测试会残留旧组名，学生进入测试时会被分配校验拒绝。这些属于集成工作，尚未实现或进行端到端验证。

两个 PR 都包含共同提交 `cef5af2b`，会删除 CodeQL 定时扫描配置；试集成补丁保留了该上游改动。实施合并时应明确是否保留这项与功能无关的配置变化。

## 验证结果与范围

- 行为复现：`node --test review/pr13-pr14-2026-10-11/reproduce.cjs`，4/4 通过。这里通过表示确认了上述缺陷，不表示功能验收通过。使用真实 PR 源码及真实 ACM 统计函数；数据库和浏览器网络由可控桩模拟。
- 当前分支及 PR #13 试集成版本均通过 4 个既有回归测试文件：课程反馈结构、团队参赛、练习记录关联、练习编辑区。
- PR #13 试集成类型检查：未修复时比基线多 2 条诊断；参数类型修复后与基线 16 条诊断完全一致。
- PR #13 试集成补丁通过 `git apply --check` 与差异空白检查。
- PR #14 尚未完成迁移或类型检查；没有声称两个 PR 的联合构建或端到端测试通过。
- 两个 PR 的最新 GitHub build 都因账户计费/额度问题未启动，任务没有执行步骤。已读取 check annotations 确认；这既不是代码构建失败的证据，也不能替代验证。

后续应先修复 5 项问题，再迁移 PR #14，并验证个人/团队参赛、课堂测试复制与首次进入、ACM/OI 达标解锁、试题权限、断网重试和故障恢复、班级重命名及课程结构编辑。解决本地基线类型检查问题后，再执行完整构建、UI 构建及相关集成测试。

本次只在主工作区新增评审材料。当前分支 HEAD 保持原提交；没有合并、推送、发布开发包或更新 Hydro 服务。
