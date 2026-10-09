# Hydro 练习评分 M2 运行与验收报告

- 日期：2026-10-09。
- 分支：`work/rating-all-data-shadow`；接续 PR-A 提交 `3811fe72`。
- 范围：PR-B / M2，管理员影子链路本地实现；未合并、发布、部署或连接生产数据库。
- 依据：[实施方案](../doc/design/hydro-rating-implementation-plan-2026-10-08.md)、[简化 MVP 修订](../doc/design/hydro-rating-minimal-mvp-scope-revision-2026-10-08.md)、[任务与验收映射](WORK-HYDRO-RATING.md)。

## 1. 本轮交付与使用边界

完成“域内真实提交 → 7 天学习过程 → 联合 R/D → 独立快照 → 管理员只读报告”的链路。每日任务默认关闭，只对显式启用的域串行运行。既有判题、比赛结果及 `difficulty/rp/rpInfo/level/rank` 无新增写入路径。

目前足以供管理员在测试环境进行影子试算和查询；尚无教师/学生页面、教师访问权限或未来期验证报告。M3 和真实效果仍待完成，不能把本报告当作完整 MVP 上线验收。**预测效果尚无结论。**

| 文件 | 职责 |
| --- | --- |
| [model.ts](../packages/hydrooj/src/lib/practice-rating/model.ts) | 纯联合 1PL、连通组件、暂定/已估计状态、数值失败保护 |
| [adapter.ts](../packages/hydrooj/src/lib/practice-rating/adapter.ts) | 单域最小投影、时间/活动来源、服务/测试/团队账号排除 |
| [runner.ts](../packages/hydrooj/src/lib/practice-rating/runner.ts) | 默认只读、独立线程拟合、冻结样本/证据和诊断、写入调度 |
| [store.ts](../packages/hydrooj/src/lib/practice-rating/store.ts) | 五个独立集合、校验摘要、租约、原子活动指针、固定 run 查询 |
| [practice-rating.ts](../packages/hydrooj/src/script/practice-rating.ts) | 三个管理员脚本和现有 `task/daily` hook |
| [模型测试](../test/practice-rating-model.spec.ts)、[集成测试](../test/practice-rating-integration.spec.ts) | 数值参考对账、临时 MongoDB、失败/并发/旧字段回归 |

## 2. 固定模型与输入口径

`modelVersion=practice-rating-1pl-v1`；完成概率为 `1/(1+10^((D-R)/400))`。每次从固定先验重新拟合，不将上一轮后验叠加到相同历史。

| 参数 | 固定值 |
| --- | --- |
| 观察窗口 / 成熟样本窗口 | 首次合格提交后 7 天 / 最近 90 天内结束且成熟 |
| 先验中心 / 标准差 | 1500 / 600，用户和题目两侧相同 |
| 斜率 | `ln(10)/400` |
| 迭代上限 / 最大变化收敛阈值 | 300 / `1e-5` |
| 用户 / 题目最低样本数 | 10 / 20，用于内部 estimated 状态 |

`estimated` 同时要求该对象有成功和失败，所在组件至少有 2 名用户和 2 道题；其余有样本对象是 `provisional`。无训练样本时 run 是 `insufficient`，缺少用户或题目时返回空值，不以 0 或 1500 冒充估计。数值不收敛时不发布分数或条件标准误，也不替换活动 run。`conditionalSe` 仅为固定另一侧参数的条件曲率估计，不是联合置信区间。

按单域分别拟合；版本明确时分开，历史版本未知时用 `revision=null` 并报告数量。适配器没有可验证的历史版本字段，当前数据库路径均标为未知，不使用当前题面哈希。不同组件的 R/D 不计算配对概率；相同 1500 中心不证明跨域、组件或月份可直接比较。

适配器扫描域内截止时可用的完整提交历史，以免把近 90 天第一条提交误当 t0。只读取 `_id/domainId/pid/uid/status/judgeAt/contest/practiceContest`，不读取代码、编译输出或比赛结算缓存。提交时间来自 ObjectId，结果可知时间来自当前 `judgeAt`。内置服务 UID 1、`vuser` 标记的虚拟团队账号和显式排除 UID 被排除；实际个人提交保留。

活动与账号排除元数据使用采集时刻 `capturedAt` 作为 `knownAt`。指定过去的 `asOf` 时不会把这些新获取元数据应用于旧截止；当前重测也不能恢复此前结果，因而过去截止试算只是保守的近似诊断，不能冒充严格历史前向验证。

## 3. 快照、并发与失败保护

使用独立的 `practice_rating_runs/episodes/users/problems/active`。每次保存真实过程、实际训练观测及窗口内最小提交证据，包含 t0、窗口终点、标签、原记录 ID 和来源；不是只有哈希或可变化的原记录引用。已保存的旧标签不因后续重测而改变。

run 保存 `runId/scope/asOf/capturedAt/modelVersion/sampleVersion`、固定参数、诊断、数量及输入/输出 SHA-256。写入后重新读取并对账数量与摘要，标为 complete 后才原子切换活动指针。切换同时匹配租约 token、上一活动 run 和不早于现有版本的 cutoff。半写、校验失败、锁过期或旧 cutoff 均保留原活动结果；失败候选记录在独立集合中保留，不删除原 run。

若数据库已经切换指针但调用方丢失响应，错误分支重新读取活动指针；确认候选已激活时返回成功，保持已验证快照 complete，不将可读的活动结果降为 failed。回归测试先复现活动快照不可读，再验证此恢复路径。

一次查询先捕获一个 complete run，再用它同时查 R/D；查询期间活动指针改变也继续读已捕获版本。查询层拒绝混合 run/scope，缺失对象或跨组件返回空概率。报告不含提交证据或记录 ID。

| 运行限制 | 行为 |
| --- | --- |
| 单域记录上限 | 200,000；超出直接失败，不拟合截断输入 |
| record 查询时限 / 批大小 | 120 秒 / 1,000 |
| 模型计算 | 原生 Worker Thread，512 MB old-generation 限额，5 分钟超时 |
| 单域写入锁 | 30 分钟 token 租约，批量写入时续租；过期持有者不能发布或释放继任锁 |
| 运行并发 | 同进程同域防重入、跨进程同域写入租约；daily 各域串行 |
| 快照写入 | 每批 500 文档；单文档超过 12 MB 时拒绝 |

独立线程避免拟合占据 HTTP/判题事件循环；上述限制是首版保护，没有生产负载或备份恢复验收。默认只读试算不创建影子集合、索引或租约；仅显式写入/配置才创建对应数据。空训练集可发布新的 insufficient 快照；这是没有当前证据，并非计算故障。

## 4. 管理员操作入口

以下是部署后的使用示例，本轮只验证临时库与脚本注册，没有执行这些安装环境命令。将 `YOUR_DOMAIN` 和 UID/pid 替换为目标测试域中的真实值。

```bash
# 默认只读试算，返回扫描/排除/拟合摘要
hydrooj cli script practice-rating-run '{"domainId":"YOUR_DOMAIN"}'

# 显式保存并切换该域的独立影子版本
hydrooj cli script practice-rating-run '{"domainId":"YOUR_DOMAIN","write":true}'

# 查询同一活动版本中的用户 R、题目 D 和配对完成概率
hydrooj cli script practice-rating-report '{"domainId":"YOUR_DOMAIN","uid":2,"pid":100}'

# 显式启用每日更新，并配置已确认的测试/服务 UID
hydrooj cli script practice-rating-configure '{"domainId":"YOUR_DOMAIN","enabled":true,"excludedUids":[123,456]}'

# 停止后续每日运行；保留既有影子数据和排除配置
hydrooj cli script practice-rating-configure '{"domainId":"YOUR_DOMAIN","enabled":false,"excludedUids":[123,456]}'
```

`asOf` 可选，单位为 UTC epoch 毫秒，默认当前采集截止；不允许未来截止。`revision` 省略表示未知版本。run 的临时 `excludedUids` 与已配置排除列表取并集；configure 会替换保存的列表，省略时清空，停用时若需保留排除列表应原样传入。

也可在现有系统管理脚本页运行。网页入口继承 `PRIV_EDIT_SYSTEM` 和 sudo；CLI 使用现有部署管理员入口。脚本没有新注册公共 route，也没有授予教师全站读取权。网页执行仍由 Hydro 既有设施创建 pretest 日志记录；对应 record 详情限制为执行者读取，且这些记录被模型排除。“只读”指评分链路不写影子结果或业务评分字段，不改变既有脚本日志机制。

daily 仅读取 `enabled=true` 的域，单域失败写日志并继续其他启用域。禁用 daily 不阻止管理员显式手动试算/写入。

## 5. 本地验证

所有集成数据均为测试临时 MongoDB，未读取生产或 Docker 安装库。

| 命令 | 实际结果 |
| --- | --- |
| `yarn test:practice-rating` | 提取器 28 + 模型 10 全通过，含 Worker 等价/错误传播和独立稠密 Newton 数值对账 |
| `yarn test:practice-rating:integration` | 11 全通过，覆盖适配/默认只读、重复写、标签冻结、半写、校验损坏、指针响应丢失、混读、指针移动、租约、旧截止、daily 隔离 |
| `yarn exec tsc -b packages/hydrooj --pretty false` | 通过 |
| 两个新测试文件的独立 TypeScript 检查 | 通过，命令见下方 |
| `yarn lint:ci` | 通过 |
| 两个新测试文件的显式 ESLint | 通过，根 lint 范围未包含 test |
| `node -r @hydrooj/register test/rating-v2.spec.ts` | 既有 27 项通过 |
| 课程/赛后/团队回归 | 通过，命令见下方 |
| `yarn build` | 通过；本轮修复 Hydro 导出 `superagent` 代理声明、VJudge 重复代理初始化及 MarkdownIt 编辑器插件类型兼容 |
| `node -r @hydrooj/register test/markdown-it-media.spec.ts` | 4 全通过，含编辑器 MarkdownIt 14 与主渲染器 MarkdownIt 15 的运行兼容 |
| `node test/entry.js` | HTTP 回归 66/66 全通过 |
| `yarn test` | 完整测试入口通过，含所有前置批次、评分 Mongo 集成和最终 HTTP 66/66 |
| 本轮测试文件的单独 ESLint | MarkdownIt 测试严格检查通过；`test/main.ts` 0 错误、13 条既有警告，与 HEAD 对照数量一致，`--max-warnings=0` 因既有警告未通过 |

```bash
yarn exec tsc --ignoreConfig --noEmit --skipLibCheck --target es2022 \
  --module preserve --moduleResolution bundler --esModuleInterop \
  --strict false --types node \
  test/practice-rating-model.spec.ts test/practice-rating-integration.spec.ts
yarn exec eslint test/practice-rating-model.spec.ts test/practice-rating-integration.spec.ts --max-warnings=0
node --test test/course-feedback-structure.spec.js test/practice-record-connection.spec.js test/contest-team-regressions.spec.js
```

本轮补齐了全仓构建的类型兼容问题：Hydro 导出的 `superagent` 现在声明运行时注入的代理方法，VJudge 复用该初始化，编辑器显式兼容 MarkdownIt 14/15 的插件声明。构建产生的根 `tsconfig.json` 改动已恢复，不纳入提交。

HTTP 回归最初在私有内容反馈用例中把批量 `setUserRole` 用于尚不存在的域成员，导致隐藏题目权限错误被重定向到加入域页面并最终呈现 200；测试已改为逐个建立成员记录，`node test/entry.js` 现为 66/66 全通过。生产登录限流规则保持生效，测试在用例边界清理计数，并验证 IP 和账户限额触发及清理后的恢复。

另修复 `system` 域权限错误被重定向到“加入 system 域”的问题。个人收件箱在无 system 成员身份时仍按反馈授权返回 403；普通域的非成员继续获得加入域重定向，两条路径都有 HTTP 回归断言。

初次 M2 验证日志位于 `/tmp/hydro-rating-m2-*.log`；本轮修复后的完整测试日志为 `/tmp/hydro-repair-full-test-verified.log`，HTTP 日志为 `/tmp/hydro-repair-http-verified.log`。这些日志为临时验收材料，不随提交保存。

## 6. 下一批任务

M2-01–05 已有本地工程证据，T11–T14 及影子链路的 T16/T17 完成；教师访问的 T18 仍待 M3。PR-C 从 M3-01 接续：冻结未来首次合格作答的预测，等待 7 天成熟结果，提供固定分桶、Brier/样本数、整体均值与题目历史完成率基线，并增加教师授权只读试用及解释。独立模拟只作为外部参考。

尚无真实未来观测、生产运行容量或教师试用验证。公开榜单、跨域等值、精确成长、K1/K2 和比赛 Rating 改造均继续延期。
