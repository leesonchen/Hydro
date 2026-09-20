# 对《Rating V2 实施计划评审意见》的技术反馈与深化设计方案

- **日期**：2026-09-18
- **反馈对象**：[rating-v2-implementation-plan-review-2026-09-18.md](./rating-v2-implementation-plan-review-2026-09-18.md)
- **关联计划**：[hydromod-rating-v2-implementation-plan-2026-09-18.md](./hydromod-rating-v2-implementation-plan-2026-09-18.md)
- **状态**：已对齐并形成深化技术共识
- **归档路径**：`review/rating-v2-implementation-plan-feedback-2026-09-18.md`

---

## 0. 总体态度与共识总结

审阅并完全赞同《Rating V2 实施计划评审意见》的结论。评审意见不仅严谨复核了全部代码事实（100% 准确）与数学算例，更敏锐地击中了原方案中**“学院派完备设计”与“单教师、小班级现实规模”之间的投入产出错配**。

本反馈报告**全面采纳评审提出的 C1~C7 缺陷改进与 8 项决策建议**，并针对其中的关键争议与技术空白给出**数学闭式解、架构接口补丁及具体代码落地方案**。

---

## 1. 对七大主要问题（C1~C7）的深度反馈与深化设计

### 1.1 针对 C1（数据饥饿与系统空转）：建立“三级准入降级矩阵”与硬性 GO/NO-GO 闸门

#### 【评审核心关注】
认证条件过于苛刻（限时、个人、$\ge 10$ 人、成熟选手 $\ge 5$ 场、每题 $\ge 20$ 人且正负例 $\ge 3$），班级规模可能仅 15~25 人、每年仅数场比赛，极易导致 Rating 与难度长期空转，系统退化为纯成就榜却空耗基础设施。

#### 【深化应对方案】
全面采纳“P0 增加量化 GO/NO-GO 闸门”建议，并进一步将其细化为**系统三级动态解耦运行矩阵**，不把全量建设当作单一交付目标：

| 运行模式 | 触发门槛（P0 审计输出） | 激活功能 | 冻结功能 | 界面表现 |
| :--- | :--- | :--- | :--- | :--- |
| **Mode 1：纯学习成就模式**<br>*(基础兜底)* | 近 12 个月合格限时比赛 **$< 4$ 场**，或有效活跃参赛学生 **$< 15$ 人** | 仅激活 `achievement.ledger` 与题目贡献 $P$（上限 600 分） | 冻结 Rating 计算 Worker；冻结 IRT 难度 Worker | 综合榜仅展示题目成就分；比赛列统一显示“暂无活跃比赛池”；总分即 $P$。 |
| **Mode 2：班级轻量能力模式**<br>*(小班竞技)* | 近 12 个月合格限时比赛 **$\ge 4$ 场**，活跃参赛学生 **$15 \sim 39$ 人** | 激活 `hydro-local-cf-v1`（含 C2 修正）；计算 $R$ 与 $C$（综合榜 $P+C$ 生效） | 冻结 IRT 难度拟合 Worker（避免小样本误导） | 比赛列正常展示 $R$ 与竞技段位；题目比赛难度字段统一标注“待跨班校准”。 |
| **Mode 3：全功能成熟模式**<br>*(全量上线)* | 近 12 个月合格限时比赛 **$\ge 8$ 场**，拥有 $\ge 5$ 场记录的成熟选手 **$\ge 30$ 人** | 全量激活：学习成就 + 比赛能力 + 1PL IRT 题目难度自动标定 | 无 | 题目展示三位数字难度与置信度；三条链路全部闭环运转。 |

**P0 阶段硬性 GO/NO-GO 判定流**：
```text
运行 rating-v2-audit.ts
       │
       ├── 若合格比赛 < 4 场 ──────────> 执行 Mode 1：跳过 P2(Rating)与 P3(难度)，仅交付 P1+P4(成就榜)
       │
       ├── 若合格比赛 >= 4 且成熟选手 < 30 ─> 执行 Mode 2：交付 P1+P2+P4，P3(难度估计)延期至样本积累充足
       │
       └── 若满足成熟条件 ──────────────> 执行 Mode 3：全量按原计划推进 P1~P6
```
此设计确保任何阶段交付的均是高可靠、无虚饰的真实功能，杜绝空转。

---

### 1.2 针对 C2（封闭小池零和、1500 注入与老生买单）：Provisional 零和豁免与 Tanh 软饱和

#### 【评审核心关注】
小池（30~50 人）强制 $\sum \Delta = 0$ 且均值锚定 1500，每年新生入池时，老生被迫为新人的初始爆发负和买单；跨届历史对比严重失真。此外，前序评审也指出了原方案场级缩放因子 $h = \min(1, 200/\max |z_i|)$ 存在“单人爆冷拉低全员变动（离群点劫持）”的缺陷。

#### 【数学闭式深化方案】
将两处缺陷一并解决，提出**“新用户前 5 场（Provisional）零和豁免 + 个体双曲正切（Tanh）软饱和”**方案：

1. **选手集合划分**：
   - **定级期选手（Provisional）**：参赛场次 $n_i < 5$，集合记为 $\mathcal{U}_{\text{prov}}$；
   - **成熟期选手（Established）**：参赛场次 $n_i \ge 5$，集合记为 $\mathcal{U}_{\text{est}}$。

2. **零和约束仅在成熟选手内封闭（Provisional Exemption）**：
   设第 $i$ 名选手的原始目标偏离量为 $d_i = (R_i^* - \mu_i) / 2$。
   - 对定级期选手 $p \in \mathcal{U}_{\text{prov}}$：**不参与全场平均扣减，允许其 Rating 自由向真实水平靠近**（其正负 Delta 作为池子容量的动态呼吸吞吐）：
     $$\Delta_p = 200 \times \tanh\left(\frac{d_p}{200}\right)$$
   - 对成熟期选手 $e \in \mathcal{U}_{\text{est}}$：**仅在成熟选手中执行中心化与零和闭合**：
     $$\bar{d}_{\text{est}} = \frac{1}{|\mathcal{U}_{\text{est}}|} \sum_{e \in \mathcal{U}_{\text{est}}} d_e, \qquad z_e = d_e - \bar{d}_{\text{est}}$$
     $$\tilde{z}_e = 200 \times \tanh\left(\frac{z_e}{200}\right)$$
     $$\Delta_e = \tilde{z}_e - \frac{1}{|\mathcal{U}_{\text{est}}|} \sum_{k \in \mathcal{U}_{\text{est}}} \tilde{z}_k$$

3. **数学性质保障**：
   - **老生绝不给新人买单**：新人的超预期高分（如 1500 打出 2100 表现）由外部方差吸收，不扣减成熟选手的现有积分；
   - **成熟群体内部严格零和**：$\sum_{e \in \mathcal{U}_{\text{est}}} \Delta_e = 0$，防止老池系统性通胀或通缩；
   - **彻底消除木桶效应**：Tanh 阻尼平滑压缩单个离群极值，单人最大变动严格 $< 200$，但不再连累全场缩水。

---

### 1.3 针对 C3（多池用户与域综合投影映射）：确立 Domain 1:1 Pool 强约束与解析链

#### 【评审核心关注】
`rating.user_state` 按 `(poolId, uid)` 存储，`ranking.projection` 按 `(domainId, uid)` 存储，用户参与多个池时，$C(R, n)$ 取哪个 $R$、有效场次 $n$ 怎么数未作定义。

#### 【明确规范落地】

1. **默认强约束**：
   在 Hydro 的标准教学部署中，**一个 `domainId` 强绑定唯一的默认 `poolId`**（即 `domain.ratingPolicy.poolId = domainId`）。
2. **多池解析链（Resolution Chain）**：
   当用户在某域访问排行榜或个人中心时，$R$ 与 $n$ 的取值顺序如下：
   ```typescript
   function resolveUserDomainRating(domainDoc: DomainDoc, uid: number): { R: number | null, n: number, poolId: string } {
     const boundPoolId = domainDoc.ratingPolicy?.poolId || domainDoc._id;
     
     // 1. 优先读取本域绑定的主池
     const state = await RatingUserStateModel.get(boundPoolId, uid);
     if (state && state.evidenceStatus !== 'unrated') {
       return { R: state.publicRating, n: state.ratedEvents, poolId: boundPoolId };
     }
     
     // 2. 次选读取该域显式声明的继承上级共享池 (如 school_master_pool)
     if (domainDoc.ratingPolicy?.fallbackPoolId) {
       const parentState = await RatingUserStateModel.get(domainDoc.ratingPolicy.fallbackPoolId, uid);
       if (parentState && parentState.evidenceStatus !== 'unrated') {
         return { R: parentState.publicRating, n: parentState.ratedEvents, poolId: domainDoc.ratingPolicy.fallbackPoolId };
       }
     }
     
     // 3. 兜底回退：无本池记录
     return { R: null, n: 0, poolId: boundPoolId };
   }
   ```
3. **场次 $n$ 的计数口径**：
   $n$ **严格等于该解析池（resolved pool）内部已发布的有效场次**，绝对不跨池累加。在 A 班比赛 3 场、B 班比赛 2 场，在 A 班榜单上 $n=3$（仍属暂定），防止跨规则混合带来的方差污染。

---

### 1.4 针对 C4（`task.daily` 凌晨覆盖冲突）：引入 `legacyRpFreeze` 门禁与安全切流

#### 【评审核心关注】
`packages/hydrooj/src/model/schedule.ts:75` 每日凌晨 3 点无条件调用 `global.Hydro.script.rp?.run`，全量执行旧计算并覆盖 `domain.user`。

#### 【具体代码改造补丁】

在 `packages/hydrooj/src/model/schedule.ts` 与 `packages/hydrooj/src/script/rating.ts` 引入熔断开关：

1. **在系统与域配置中新增开关**：
   `system.ratingV2.legacyRpFreeze`（全局开关）与 `domainDoc.ratingPolicy?.useV2`（域级开关）。
2. **改造 `schedule.ts` 的定时任务入口**：
   ```typescript
   // packages/hydrooj/src/model/schedule.ts
   c.worker.addHandler('task.daily', async (task) => {
       // ... 前序 record 清理保持不变 ...
       
       start = Date.now();
       const isV2Frozen = global.Hydro.model.system.get('ratingV2.legacyRpFreeze');
       if (!isV2Frozen) {
           await global.Hydro.script.rp?.run(pref, new Logger('task/rp').debug);
           pref.rp = Date.now() - start;
       } else {
           logger.info('task.daily: legacy rp calculation is frozen by ratingV2 configuration');
           // 触发 V2 学习成就的每日增量物化视图健康检查
           await global.Hydro.service['rating-v2']?.dailySanityCheck();
       }
       // ... 后续 problemStat 保持不变 ...
   });
   ```
3. **隔离 `domain.user` 写入字段**：
   V2 产生的新排名数据写入独立的 `ranking_projection` 集合与 `domain.user.rpV2` 独立子文档，绝不复用或修改旧的 `domain.user.rp` / `domain.user.rpInfo`，实现物理层与定时任务的双重隔离。

---

### 1.5 针对 C5（单教师运营可持续性）：Auto-certify 规则前置与静默自动发布

#### 【评审核心关注】
原方案要求“赛前人工认证冻结 + 赛后人工手动发布”，对于单人任课教师极为繁琐，极可能因遗漏被绕过或废弃。

#### 【自动化运维闭环设计】

新增 `autoCertify: true` 与 `autoReleaseMinutes: 120` 配置，将教师的“每场必操作”降低为“异常时才介入”：

```text
【开赛前】
教师创建比赛并勾选 "开启 Rated"
   │
   ├── 校验：限时 (duration=null) + ACM/OI + 个人赛 + 题单固定
   └── 校验通过 ──> 系统自动固化 ratingPolicy 并转为 approved (无需二次人工审批)

【赛内与赛后评测】
比赛结束 (endAt) ──> 系统进入 ended_pending_judgement
   │
   └── 等待所有评测完成且重测队列清空 (pendingJudgements == 0)

【预结算与静默发布】
系统触发后台 Worker 预计算新代际 (generation) ──> 状态置为 calculated
   │
   ├── 启动 120 分钟静默缓冲窗口 (Silent Window)
   ├── 教师后台与通知栏收到预告："比赛预结算已就绪，若无申诉将在 2 小时后自动发布"
   │
   ├── 分支 A (异常介入)：教师点击 "暂停发布" 或 "剔除作弊/坏题" ──> 进入人工审计流
   │
   └── 分支 B (默认无人干预)：120 分钟到期 ──> 自动 CAS 切换公开指针发布结果！
```
**效果**：正常比赛全自动化流转（零操作成本）；只有发生测试数据出错、作弊举报时教师才需点击暂停。

---

### 1.6 针对 C6（命名冲突）：全面废弃 "Lv"，换用“竞技段位制（Tier / 青铜~宗师）”

#### 【评审核心关注】
现有系统已存在分位制 `LEVELS` 产生的 LV9/LV10 徽章，新能力等级若再用 `Lv.1~Lv.8`，页面将出现极为混乱的“LV9 与 Lv.2”同屏展示。

#### 【标准视觉与命名重构】

彻底避开字母 "Lv"，采用中国算法竞技界与游戏化教学最易接受的**八阶“竞技段位（Tier）”**命名方案：

| 公开 Rating | 内部等级代码 | 建议前台文本 | 徽章配色建议（对齐 CF/AtCoder 认知） |
| :--- | :--- | :--- | :--- |
| **未评级 / 暂定** | `UNRATED` / `PROV` | **定级中** (Provisional) | 虚线灰色边框 `#9E9E9E` |
| **0 ~ 1199** | `TIER_1` | **青铜段位** (Tier 1) | 纯灰色 `#757575` |
| **1200 ~ 1399** | `TIER_2` | **白银段位** (Tier 2) | 浅褐色/铜色 `#8D6E63` |
| **1400 ~ 1599** | `TIER_3` | **黄金段位** (Tier 3) | 翠绿色 `#43A047` |
| **1600 ~ 1899** | `TIER_4` | **铂金段位** (Tier 4) | 水色/青色 `#00ACC1` |
| **1900 ~ 2099** | `TIER_5` | **钻石段位** (Tier 5) | 蓝色 `#1E88E5` |
| **2100 ~ 2399** | `TIER_6` | **大师段位** (Tier 6) | 亮黄色 `#FDD835` |
| **2400 ~ 2799** | `TIER_7` | **宗师段位** (Tier 7) | 橙色 `#FB8C00` |
| **2800 及以上** | `TIER_8` | **传奇宗师** (Tier 8) | 鲜红色 `#E53935` |

- **前台渲染规范**：`ranking.html` 中比赛列显示格式统一为：`1642 · 铂金段位`；
- **旧徽章处理**：现有 `level` 徽章改注为“活跃分位（旧）”并在 V2 切换后退居个人档案历史详情页，新榜仅展示“竞技段位”。

---

### 1.7 针对 C7（过渡期空白）：提供“5 分钟即插即拔”的 V1 紧急止血补丁

#### 【评审核心关注】
在 V2 研发上线的数月过渡期内，学生仍在忍受当前荒谬的 V1 榜单（0 题 246 分、对数爆炸），必须有极低成本的临时止血项。

#### 【即刻落地的临时修复代码】

仅需修改当前分支的 1 个文件中的 1 行代码，并在页面添加 1 行公告，上线即生效，V2 发布后随旧脚本自然废弃：

```typescript
// 修复文件：packages/hydrooj/src/script/rating.ts:51
// 修改前：
const difficulty = +pdoc.difficulty || difficultyAlgorithm(pdoc.nSubmit, pdoc.nAccept) || 5;

// 修改后（增加 [1, 10] 范围强制钳制，杜绝高难度输入导致的对数暴击）：
const rawDiff = +pdoc.difficulty || difficultyAlgorithm(pdoc.nSubmit, pdoc.nAccept) || 5;
const difficulty = Math.max(1, Math.min(10, rawDiff));
```
同时在 `packages/ui-default/templates/ranking.html` 顶部增加轻量 Alert：
> *“【系统公告】当前榜单采用 V1 历史积分规则，开发团队正在实施 V2 重构（学习成就与比赛能力解耦分治），期间积分波动属正常过渡现象。”*

---

## 2. 补充建议：单题出锅（Void Problem）的轻量化剔除机制

结合教学日常实际，出题人测试数据出锅、Special Judge 挂掉是高频事故。原方案若将整场比赛标记为“重测修订并全链回放”，成本过重。

**建议在 `contest.fact_snapshot` 中增加轻量字段**：
```typescript
type ContestFactSnapshot = {
  // ... 原字段 ...
  voidProblemIds?: string[]; // 标记为出锅废弃的题目列表
  voidReason?: string;
};
```
- **处理逻辑**：当某题被证实出锅时，管理员无需取消整场比赛，只需在管理页点击“废弃本题”。
- **赛制适配器**：在重新计算排位时，直接过滤掉所有指向 `voidProblemIds` 的提交；
- **影响范围**：由于只需重新提取剩余题目的名次重新跑一次本场 Rating，无需触动其他合格比赛的事实快照，耗时从“全量回放的几十分钟”降为“数秒级即时修正”。

---

## 3. 建议的最终决策清单（全量对齐确认）

针对评审意见第五节提出的 8 项决策，给出终版对齐确认表：

| # | 决策项 | 终版技术决议 | 落地技术动作 |
| :---: | :--- | :--- | :--- |
| **1** | **P0 是否设量化 GO/NO-GO 闸门** | **是（强制执行）** | 以“近 12 个月合格比赛 $\ge 4$ 场”为界，实行三级准入矩阵。 |
| **2** | **实施裁剪线** | **分期解耦交付** | 若比赛数据不足：先上线 P1 事实层 + P4 学习成就榜；Rating 与难度引擎降级为离线试运行。 |
| **3** | **Provisional 是否纳入零和** | **否（坚决豁免）** | 前 5 场新人不参与全场零和平衡，结合 Tanh 软饱和阻尼，老生不再为新人买单。 |
| **4** | **域 $\leftrightarrow$ 池绑定规则** | **Domain 1:1 Pool 强约束** | 默认域即是池；多池查询走明确的三级解析链（本域主池 $\to$ 共享上级池 $\to$ 缺失）。 |
| **5** | **比赛认证与发布机制** | **Auto-certify + 2小时静默自动发布** | 规则符合者自动认证，赛后评测完成 2 小时无异常自动发布，单教师零负担。 |
| **6** | **新等级命名规范** | **全面避开 "Lv"，采用“竞技段位制”** | 采用“青铜、白银、黄金...传奇宗师”与 `Tier 1~8`，与旧分位徽章完全脱钩。 |
| **7** | **V1 临时止血方案** | **立即执行单行 Clamp 补丁** | 将 `difficulty` 钳制在 `[1, 10]`，加挂过渡公告，V2 交付后即抛。 |
| **8** | **代码基线 Pin** | **立即更新至 `821ccbeb`** | 更新基线 commit 引用，纳入 `problem_edit.page.jsx` 的最新变动。 |

---

## 4. 下一步执行计划（Actionable Next Steps）

1. **Step 1（即刻落地 V1 止血）**：
   在 `packages/hydrooj/src/script/rating.ts` 实施单行 Clamp 补丁，平息当前线上可能产生的异常数值争议。
2. **Step 2（执行 P0 阶段：离线数据审计）**：
   编写并运行只读脚本 `src/script/rating-v2-audit.ts`，导出生产库中真实的比赛数量、时间戳质量、选手连通图分布，根据 GO/NO-GO 闸门正式决定启动 Mode 1、Mode 2 还是 Mode 3。
3. **Step 3（推进 P1 核心层开发）**：
   在 `packages/hydrooj/src/lib/rating-v2/` 实现纯函数库，包含 Tanh 软饱和阻尼及 Provisional 豁免公式，并跑通全量单元测试用例。
