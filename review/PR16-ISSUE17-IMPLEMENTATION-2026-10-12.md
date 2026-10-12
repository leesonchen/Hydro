# PR #16 与 Issue #17 处理记录

日期：2026-10-12。当前分支：`course-v2.2`。完整复审基线：`805608a1`。

## 处理结果

- PR [#16](https://github.com/leesonchen/hydromod/pull/16) 已在本地快进合并，包含 `f5a1838d` 和 `b8fd9733`。它拒绝超过当前已验证题目满分的正式记录，避免异常判题分数影响整场认证回放。
- Issue [#17](https://github.com/leesonchen/hydromod/issues/17) 的课堂测验资格能力已实现：管理员开赛前显式认证、冻结正式学生名单和场次，服务器记录可信提交事实，结束后显式释放，认证影子回放重新核验证据。
- 课堂测验始终保持 `rated:false`。普通课程、作业、历史记录和默认 trial 不自动取得认证资格，也不触发旧公开 RP 计算。
- 本轮没有推送远程、变更 GitHub PR/Issue 状态、发布部署、操作线上数据或切换公开榜。

## 评估与修复

| 事项 | 结论与处理 |
| --- | --- |
| PR #16 的超满分回放保护 | 接受并合并，保留整场拒绝处理语义及回归测试 |
| 成绩释放未检查相同分值上界 | P2，已补齐；使用重新解析且版本匹配的满分，避免仅标记异常成绩已释放 |
| 认证成就可能接受超满分记录 | P2，已补齐，异常记录不能得到认证成就积分 |
| 直接把课堂测验设置为 rated | 不采用；会进入旧 trial/公开 RP 路径，绕过新认证条件 |
| 课程修改与认证的跨文档原子性 | 保留明确限制；策略写入对测验字段进行条件更新，释放与回放重新核验课程条件，未宣称全库事务快照 |

共同分值校验要求分数有限、非负，可信满分有限且大于零，分数不能超过满分；不信任旧记录中的历史满分值。

## 关键不变量与写入路径

| 不变量 | 权威来源 | 相关写入/核验路径 |
| --- | --- | --- |
| 只有合法的独立课堂测验能认证 | 同域父课程、assessment DAG 节点及反向绑定 | certify、课程同步、release、certified replay |
| 正式学生身份和场次不能由请求伪造 | 冻结 UID 名单、父课程准入、测验报名 | 提交处理器重新检查；教师为 staff，名单外为 unknown |
| 场次事实不可变 | RecordModel 中的 `classroomSession` | add/reset/update/关联新重评；过滤整体和点路径更新 |
| 答题条件改变后不能继续使用旧认证 | 课程条件签名、测验签名、题目版本 | certify 最终检查与字段条件写入；release/replay 重新检查 |
| 成绩必须完整且在可信分值范围内 | 当前题目证据与最终判题状态 | release/replay/成就计算 |
| 认证不会绕过旧评级保护 | 课堂测验 `rated:false` | 课程创建及同步、旧评级路径、认证候选查询 |

认证只支持同步个人 ACM/OI。正式名单必须无重复、至少达到冻结人数门槛；学生必须拥有有效账号、加入课程、
节点解锁且报名该测验，不能是教师。归档班级不能提供准入。
认证策略包括父课程及节点、课程条件签名、名单、随机场次标识、题目版本与已有比赛配置签名。

课程同步保留策略和 `rated:false`，变更分配、维护教师或 DAG 答题条件后旧策略失效。
开赛前可重新认证；开始后不能补认证。正常重评保留原始提交事实，新生成的重评记录仍被排除为新的正式作答。

## 验证

临时 MongoDB 使用 `MONGOMS_SYSTEM_BINARY=/home/leeson/.cache/mongodb-binaries/mongod-x64-ubuntu-8.2.1`。

- PR 合并后的证据测试：12/12，通过，日志 `/tmp/hydro-pr16-evidence.log`。
- 完整回归：`NODE_OPTIONS=--require=/home/leeson/Hydro/test/classroom-feedback-test-isolate.cjs npm run test`，459/459，通过，日志 `/tmp/hydro-issue17-full-test.log`。
- 完整回归后补充的两项边界测试：`node -r @hydrooj/register test/rating-v2-evidence.spec.ts`，16/16，通过，日志 `/tmp/hydro-issue17-evidence-final.log`。
- 完整回归后补充的真实课程同步测试：`node --test test/contest-assessment-monitor.spec.js`，25/25，通过，日志 `/tmp/hydro-issue17-course-lifecycle.log`。
- `node_modules/.bin/tsc -b --pretty false`：通过。
- `npm run lint:ci`：通过。最初的唯一 import 排序警告已修复。
- `git diff --check`：通过。

测试覆盖实际提交处理器持久化、RecordModel 不可变事实、真实父课程准入、认证命令、Mongo 认证回放、
真实课程同步及策略保留，并检查未写公开用户评分。新增边界覆盖教师/归档班级/未解锁/错误名单、
伪造或缺失场次、人数不足、未完成重评、超满分、开始后认证失败、课程条件变更、普通比赛与课堂测验同池兼容。

从原始基线重新检查完整实现、PR 内容及所有测试变更，未发现剩余可操作的 P0–P2 问题。
本轮所有工作树变更均纳入提交，没有刻意排除的文件。

## 操作边界

这次实现提供认证资格和影子结果。Issue 中后续公开 Rating/RP 发布仍须单独设计、审核和启用，
包括代际发布/历史判题快照及公开榜切换；现有 release 仅释放到认证影子回放。
认证操作锁不自动过期；进程崩溃后的清理继续遵循已有 token 核对流程。
未验证线上实例、公开榜发布或跨文档并发快照；上述行为未在本轮实施。

管理员操作见 [Rating V2 操作指导](rating-v2-operations-guide.md)，第 7、8 节。
