# Hydro RP 计算机制与题目得分合理性分析报告

- **日期**：2026-09-18
- **排查对象**：用户 `xingchen` 及当前域排行榜（`cpp课程` / 全站域）
- **核心问题**：
  1. 为什么 `xingchen` 通过的题目量最多（442 题），但哪怕只看“题目”这一栏，得分（271）也不是最高（例如通过 5 题的用户得分为 275，通过 18 题的用户得分为 274，通过 0~1 题的用户也有 240~260）？
  2. 目前系统的 RP（Rating Point）计算是否合理？

---

## 一、排查结论速览

经过对系统源码（[rating.ts](file:///home/leeson/Hydro/packages/hydrooj/src/script/rating.ts)、[ranking.html](file:///home/leeson/Hydro/packages/ui-default/templates/ranking.html)、[difficulty.ts](file:///home/leeson/Hydro/packages/hydrooj/src/lib/difficulty.ts)）的完整审计，导致该反常现象的核心原因如下：

1. **核心算法具有极端的“对数边际压缩”（底数 1.03）**：
   “题目”一栏的分数并非线性做题数，而是对原始做题难度总分进行 $\log_{1.03}$ 对数压缩。当分数达到 270 分区间后，函数进入极平缓阶段，**每增加近 100 点原始分，界面显示仅增加 1 分**，导致做 200 题与做 442 题的分数差距极其微小。
2. **题目难度权重（difficulty）倍数失衡**：
   单题原始积分为 `score * (difficulty / 100)`。若题库中存在自定义高难度题目（如管理员/教师录入难度为 50、100 甚至按 Codeforces 标准填了 1000+），少数几道题提供的原始分，就可以直接超越刷几百道默认难度题（difficulty=5）的总和。
3. **部分分（Partial Score）全面计分**：
   系统计算题目积分判定的是 `psdoc.score > 0`，而非 `psdoc.status === STATUS_ACCEPTED`。做过多道题且获得部分分（即使 0 题完全 AC）的用户，依然能累计大量原始分并获得 240+ 的题目分。
4. **离线批处理与实时统计存在时间差**：
   “通过量（`nAccept`）”由提交判题即时自增；而“题目得分（`rpInfo.problem`）”与总 RP 依赖离线脚本 `hydrooj rating` 批量计算。若用户近期做题量激增但后台未触发重算，题目得分将停留在历史计算时点。

---

## 二、底层算法公式与代码解析

### 1. 数据来源映射

在排行榜前端模板 [ranking.html](file:///home/leeson/Hydro/packages/ui-default/templates/ranking.html) 中：
- 表头【RP】：对应 `udoc.rp`（所有子模块得分之和）
- 表头【题目】：对应 `udoc.rpInfo.problem`（做题维度得分）
- 表头【比赛】：对应 `udoc.rpInfo.contest`（比赛维度得分）
- 表头【通过】：对应 `udoc.nAccept`（当前域内通过题目总数）

### 2. 题目得分计算公式

定义于 [packages/hydrooj/src/script/rating.ts](file:///home/leeson/Hydro/packages/hydrooj/src/script/rating.ts#L31-L59)：

```typescript
// 1. 遍历当前域所有有通过记录的题目
for (const pdoc of problems) {
    // 获取难度，缺省保底为 5，自适应难度区间通常为 1~10
    const difficulty = +pdoc.difficulty || difficultyAlgorithm(pdoc.nSubmit, pdoc.nAccept) || 5;
    const p = difficulty / 100;

    // 遍历用户该题的最高状态
    for (const psdoc of psdocs) {
        if (!psdoc.rid || psdoc.uid === pdoc.owner || !psdoc.score) continue;
        udict[psdoc.uid] += min(psdoc.score, 100) * p; // 累加原始分
    }
}

// 2. 对所有用户的原始分执行以 1.03 为底的对数截断
for (const key in udict) {
    udict[key] = max(0, min(udict[key], log(udict[key]) / log(1.03)));
}
```

#### 对数压缩函数的数学对照：

$$\text{题目得分} = \log_{1.03}(S) = \frac{\ln(S)}{\ln(1.03)}$$

| 原始难度累积总分 $S$ | 题目最终展示得分 $\log_{1.03}(S)$ | 对应现实做题场景 | 边际收益特征 |
| :--- | :--- | :--- | :--- |
| **100** | **155.8 分** | 做 10~20 道基础题 | 极快起步 |
| **500** | **210.2 分** | 做 50~100 道题 | 快速上升 |
| **1,000** | **233.7 分** | 做 100~150 道题 | 增速放缓 |
| **2,000** | **257.1 分** | 做 200~300 道题 | 增长沉重 |
| **3,050** | **271.0 分**（xingchen 当前） | 做约 440 道常规难度题 | **每提升 1 分需多拿约 90 点原始分** |
| **3,400** | **275.0 分**（计翔 当前） | 做少数高难度/高权重题 | 虽只多 4 分，但需多 350 原始分 |
| **10,000** | **311.6 分** | 极海量做题或极高难度 | 几乎逼近天花板 |

导数分析：
$$\frac{d}{dS} \log_{1.03}(S) = \frac{1}{S \cdot \ln(1.03)} \approx \frac{33.83}{S}$$
当 $S = 3000$ 时，导数仅为 $\approx 0.011$。刷题量在从 200 题冲刺到 400+ 题时，视觉上的得分提升会产生严重的“停滞感”。

---

## 三、四大核心疑问剖析

### 1. 为什么我（xingchen）做题量最多（442 题），题目分却仅有 271？
- **题量被严重压缩**：442 道常规题目（难度系数若在 5~8 之间）累计的原始分为 $442 \times 7 \approx 3094$ 分。根据对数函数计算，$\log_{1.03}(3094) = 271.4$，四舍五入即为 **271** 分。
- **题目难度的平均值偏向基础**：如果做的多是课后基础练习、签到题、语法题，单题权重较低，在对数压缩下无法形成巨大分差。

### 2. 为什么通过 5 题的“计翔”能拿到 275 分？
- 275 分所需的原始分为约 3400 分。
- 只要题库中存在几道录入时未做范围约束的高难度题目（例如 `difficulty` 设置为了 500、1000、或 100），满分通过一道即可获得数百甚至上千点原始分。做 3~5 道高权重题，总分瞬间反超做数百道基础题。

### 3. 为什么通过 0~1 题的用户能有 240~260 的题目得分？
- 源码中为 `if (!psdoc.score) continue;`，只要在测试点中拿到了部分分（即使由于超时/报错并未 AC），其得分都会乘以 `difficulty / 100` 计入原始总分。
- 许多学生参加过考试或作业，虽然没有全对 AC，但积累了大量 40~80 的部分分，经对数转换后同样能落在 230~250 分段。

### 4. 为什么第一名（徐梓桐）RP 为 310，总榜被完全拉开？
- 比赛模块（`RpTypes.contest`）的分数是基于 CF/Elo 体系算出的 Rating 线性映射（`rating / 4 - 375`）。
- **总 RP 计算方式是直接线性相加**：
  $$\text{RP} = \text{题目分} + \text{比赛分} + \text{题解分}$$
- 徐梓桐的做题分为 272，但参加了 37 场 Rated 比赛，比赛分贡献了 37 分，两者直接相加达到 309~310 分。相比之下，单靠做题即使做到上千道，做题分也很难突破 280~290。

---

## 四、当前 RP 计算是否合理？

**结论：当前机制存在显著的失衡与不合理设计。**

1. **正向激励受阻（做题性价比极低）**：
   底数 1.03 导致天花板来得过早，学生在努力刷了 200~400 道题后，分数几乎不再上涨，严重挫伤打卡刷题的主动性。
2. **缺乏难度归一化（权重暴击隐患）**：
   系统直接信任并使用 `+pdoc.difficulty`，若录题人员对难度标尺理解不一致（有人按 1~10 填，有人按 100 分制填，有人按 CF 1500 填），会造成单题分值相差成百上千倍。
3. **“通过”与“得分”口径矛盾，用户认知困惑**：
   将部分分计入做题分，导致排行榜出现“0 通过却有 240 多分”的荒谬现象，与“通过”列产生强烈冲突。
4. **比赛权重过度挤占总榜**：
   比赛分是线性叠加的，做题分是对数封顶的，导致总排行榜事实上沦为“比赛场次榜”，做题模块的权重被极度边缘化。

---

## 五、优化建议与调整方向

### 方案 A：平滑对数压缩曲线，加入做题数量保底（推荐）
修改 [packages/hydrooj/src/script/rating.ts](file:///home/leeson/Hydro/packages/hydrooj/src/script/rating.ts)：
1. 将对数底数调大（如改为 $1.05 \sim 1.08$）或者采用分段函数，放宽中高分段的斜率。
2. 引入数量线性分：例如 $\text{最终题目分} = 0.2 \times \text{nAccept} + 0.8 \times \log_{\text{base}}(S)$，确保做题量多的人具备坚实的底分优势。

### 方案 B：严格限制题目难度（Difficulty Normalization）
在进入计分前，对 `pdoc.difficulty` 进行上下限截断与归一化：
```typescript
let difficulty = +pdoc.difficulty || difficultyAlgorithm(pdoc.nSubmit, pdoc.nAccept) || 5;
difficulty = Math.max(1, Math.min(10, difficulty)); // 强制约束在 1~10 之间
```
彻底杜绝因个别题目录入异常高数值而导致“做几题顶几百题”的数值崩溃。

### 方案 C：将题目计分限制为仅 AC 题目
修改过滤条件，仅对真正通过的题目计分：
```typescript
if (!psdoc.rid || psdoc.uid === pdoc.owner || psdoc.status !== STATUS.STATUS_ACCEPTED) continue;
```
使“通过数”与“题目得分”在业务逻辑上保持正相关，消除 0 通过却高分的反直觉现象。

### 方案 D：手动触发离线重算以刷新当前成绩
若需要立即让你的最新 442 题成绩刷新到榜单，可以在服务端终端手动执行一次 Rating 刷新脚本：
```bash
hydrooj rating
# 或指定当前域：
hydrooj rating --domainId <当前域ID>
```

---

## 六、补充意见（根据评审复核）

对上述分析再核对源码后，需要补充并更正以下几点：

1. **对数底数的调整方向需要修正。** 对于 $b>1$，
   $\log_b(S)=\ln(S)/\ln(b)$ 及其关于 $S$ 的导数都会随底数增大而减小。因此，将
   `1.03` 调大到 `1.05~1.08` 会进一步压低高分段的得分和斜率，并不能“放宽”压缩。
   如果目标是提高中高分段的增幅，应将底数调小（例如向 `1.02` 靠近），或采用经过验证的分段函数；具体参数仍应结合历史数据回放后确定。

2. **比赛分不是按参赛场次线性累加。** `RpTypes.contest.run` 只取最新的 10 场 Rated 比赛，按时间顺序逐场调用 `rating(users)`，并用每场返回的 `new` 值替换用户当前 rating，最后再统一映射为 `rating / 4 - 375`。因此，参加 37 场比赛不能直接解释为增加 37 点比赛 RP，“比赛场次排行榜”的结论缺乏源码依据；更准确的表述应是比赛模块采用最近 10 场的滚动 rating 机制。

3. **总 RP 还包含隐藏的 `delta` 项。** `runInDomain` 会遍历全部 `RpTypes` 并把各项结果相加；其中隐藏的 `delta` 类型从用户的 `rpdelta` 字段读取并写入总 RP。故三项公式
   “题目 + 比赛 + 题解”只适用于没有 RP 调整值的用户；对存在 `rpdelta` 的用户，应写成：
   $$\text{RP}=\text{题目分}+\text{比赛分}+\text{题解分}+\text{delta}.$$

4. **重算命令应通过已注册脚本调用。** `rating.ts` 注册的脚本 ID 是 `rp`，CLI 入口使用
   `hydrooj cli script <id> <JSON>`，不存在顶层 `hydrooj rating` 命令，`--domainId` 也不会自动转换为脚本参数。可使用：

   ```bash
   hydrooj cli script rp '{}'
   hydrooj cli script rp '{"domainId":"<当前域ID>"}'
   ```

以上四点会影响对排行榜异常的归因和后续调参建议；在实际修改算法前，应先按滚动 rating、`delta` 项及正确 CLI 流程重新采样数据。
