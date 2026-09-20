# Rating V2 · 决策记录（Decision Record）

- **日期**：2026-09-19
- **性质**：经项目所有者确认的执行决议，作为计划 v1.1 的修订依据
- **关联**：[实施计划](./hydromod-rating-v2-implementation-plan-2026-09-18.md) · [评审意见](./rating-v2-implementation-plan-review-2026-09-18.md) · [反馈方案](./rating-v2-implementation-plan-feedback-2026-09-18.md) · [数据评估](./rating-v2-feedback-data-assessment-2026-09-18.md) · [P0 盘点报告](./rating-v2-p0-audit-report-2026-09-19.md)

| # | 决策 | 内容 | 状态 |
|---|---|---|---|
| D1 | 合格比赛人数门槛可配置 | `minParticipants` 作为配置项；试验期设为 **1**（全放开） | ✅ 已批准，脚本已实现 |
| D2 | 试验口径范围 | 全部 rated 赛制（acm/oi/ioi/strictioi）、含个人计时（duration）、含课程布置（assign） | ✅ 已批准，脚本已实现 |
| D3 | 个人计时场次单独标记 | 试验纳入但打标（`duration>0`），影子报告中与同步场次对比，作为正式认证依据；开考分散中位 9.2h 的泄题风险已知悉 | ✅ 已批准 |
| D4 | Mode 3 判据改为产出型 | "影子运行中达到 provisional 难度门槛（≥20 学生、SE≤150）的题目数 ≥50"取代"成熟选手≥30（全历史）" | ✅ 已批准 |
| D5 | Provisional 零和豁免 + Tanh 软饱和 | 按反馈方案执行；补充边界：全场均为 provisional 时不做中心化，直接 `Δ=tanh(d/200)×200`；文档措辞改为"最大变动近似不超过 200" | ✅ 已批准（含边界补充） |
| D6 | 域↔池绑定 | Domain 1:1 Pool + 三级解析链；fallback 池显示必须携带来源 poolId 标注 | ✅ 已批准 |
| D7 | legacyRpFreeze 范围 | 同时冻结旧 `rp/rpInfo` 与 `calcLevel`（rank/level）；设置项需在 setting.ts 注册 | ✅ 已批准 |
| D8 | 自动发布隐私前置 | auto-certify + 2h 静默发布仅限结果对参赛者本已可见的比赛；隐藏成绩比赛转人工 | ✅ 已批准 |
| D9 | 单题出锅（Void）双态 | 静默窗口内即时生效（重算本场）；已发布后转为回放工单 | ✅ 已批准 |
| D10 | V1 止血范围修正 | clamp（[1,10]）+ 榜单公告；明确 clamp 不改变现有分数（difficulty>10 为 0），仅预防未来事故 | ✅ 已实现，待部署 |
| D11 | 段位命名 | 避开 "Lv"，采用竞技段位（青铜~传奇宗师，Tier 1~8）；预期管理：初期多数学生将落在白银~黄金 | ✅ 已批准 |
| D12 | 基线 pin | 实施启动时更新至当时 HEAD（当前 `ce6d8a53` 之后） | ✅ 已批准 |

## 执行状态

| 项 | 状态 |
|---|---|
| V1 止血（D10） | `packages/hydrooj/src/script/rating.ts` clamp 已改；`packages/ui-default/templates/ranking.html` 公告已加。**未部署生产**（需重启服务，择低峰窗口） |
| P0 审计工具（RV2-03） | `packages/hydrooj/src/script/rating-v2-audit.ts` 已实现（只读、口径全配置、基于 record 表判定参赛）；正式盘点见 P0 报告 |
| P0 盘点 | 已完成（2026-09-19），定档 Mode 2 + 难度影子启动，详见 P0 报告 |
| P2/P4 影子引擎 | 已完成并跑通首轮生产影子回放（222 场、0 失败），详见影子报告；170 题达 provisional 难度门槛，Mode 3 产出闸门（≥50）已满足 |
| 抽查校验 | 已完成（2026-09-19）：10 题人工评估 8 合理 + 1 外部锚点验证 + 1 缺陷（拟合发散）已修复回归；全局校准 8,666 条观测单调、中段偏差 ≤2.2pp、Brier 0.1526 优于基线 37%。详见抽查报告 |
| 算法优化与自洽验证 | 已完成（2026-09-19）：阻尼牛顿（发散 8→0，pid239=-10934→2103）、预测层校准层（slope 0.8868，分桶 MAD 降 36%）、M15 诊断落地；合成真值恢复测试证明能力/难度联合自洽（能力相关 0.973）。详见[算法验证报告](./rating-v2-algorithm-validation-report-2026-09-19.md)；生产操作见[操作指导](./rating-v2-operations-guide.md) |
| 下一步 | duration 对照复跑（D3 固化）→ P1 事实层 + P5 发布机制 → 管理域内测展示 |
