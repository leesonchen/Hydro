# PR-A（M0/M1）字段、夹具与验证报告

- 日期：2026-10-09。
- 范围：固定 7 天 episode、近 90 天成熟筛选、域/题号/版本/用户隔离；没有模型、集合、任务、API 或教师页面。
- 代码：[episodes.ts](../packages/hydrooj/src/lib/practice-rating/episodes.ts)；[测试](../test/practice-rating.spec.ts)。

## M0 事实字典

| 事实 | 当前源码/处理 | 生产历史限制 |
| --- | --- | --- |
| 提交时间 | `RecordModel.add()` 生成 ObjectId；适配器应读取 `_id` 时间 | 本轮不扫描数据库、不重建历史快照 |
| 结果可知时间 | 判题结束写 `judgeAt`；提取器要求 `judgeAt <= asOf` | `record.history` 的完整性尚未证明 |
| 身份键 | `domainId`、数值 `pid`、`uid` | 不把跨域同号当同题 |
| 版本 | 可信元数据的 `revision`；缺失为 `unknown` | 当前 Record 没有可靠历史版本；不伪造当前哈希 |
| 来源 | `contest` 活动规则 `course/homework`、普通 contest、`practiceContest`、无 contest | 来源活动元数据须有截止时可知时间；未知保留 UNKNOWN |
| 状态 | `NORMAL_STATUS` 的 AC/WA/TLE/MLE/OLE/RE/CE；waiting/fetched/compiling/judging 为 pending；系统/不可判定状态为 missing | 不把 `STATUS_CODES.fail` 直接当正常失败 |
| 特殊记录 | `RECORD_PRETEST`、`RECORD_GENERATE` 及对应 contest sentinel 排除 | 不从比赛题单或团队汇总复制个人失败 |
| 旧行为 | 旧 `difficulty`、`rp/rpInfo/level/rank`、判题与比赛路径未修改 | M2/M3 仍需集成验证 |

M0 旧机制夹具保留零提交、全失败、全通过的 `difficultyAlgorithm` 算例；旧 RP 源码只作事实基线，不作为新 R/D 输入。合成夹具不含生产账号、代码或私有活动。

## M1 输出和测试

提取器输出 episode、成熟近期观测和诊断：`t0`、窗口终点、原记录 ID、来源、版本状态、`y`、开放/pending/missing/过期计数，以及排除、缺少判定时间和元数据不可用记录。输入不可变，按提交时间和完整 ID 稳定排序，重复输入结果相同。

`test/practice-rating.spec.ts` 共 28 项通过，覆盖修订意见 T01–T10 和补充边界：精确 7 天端点、窗口成熟、无提交、课程/作业/自由/赛后来源、跨域同 pid、unknown/冲突版本、系统故障、pending、CE/WA/TLE 等失败、未来结果、缺 judgeAt、90 天边界、特殊/测试/服务/团队排除、同秒排序与不可变输入。

## 实际验证

| 命令 | 结果 |
| --- | --- |
| `yarn test:practice-rating` | 通过，28 项 |
| `node -r @hydrooj/register test/rating-v2.spec.ts` | 通过，27 项 |
| `node --test test/course-feedback-structure.spec.js test/practice-record-connection.spec.js test/contest-team-regressions.spec.js` | 通过，3 个文件级子测试 |
| `yarn lint:ci` | 通过 |
| `yarn build` | 基线失败；移除本轮提取器后仍是相同的 5 个既有依赖类型错误（md-editor、login-with-oidc 3 处、vjudge） |
| `yarn test`（沙箱） | 临时 MongoDB 启动受限，3 个既有集成文件失败；未修改环境外重跑 73 项相关子测试通过 |
| `yarn test`（允许临时 MongoDB） | 65 项中 64 项通过；既有 `Allows private content feedback...` 在 `test/main.ts:683` 的 DomainModel.add 断言失败，日志显示与本轮文件无关 |
| `git diff --check` | PR-A 提交前已通过；提交 `3811fe72` |

本报告不把构建基线错误、环境/既有集成失败写成新功能通过，也不把单元测试当成 M2/M3 的数值稳定性、原子指针、权限隔离或未来效果验证。生产数据库、发布、部署和公开入口均未访问。
