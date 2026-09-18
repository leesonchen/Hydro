# 常用 OJ 网站题目难度与选手水平（Rating）计算规则调研报告

> **调研对象**：AtCoder / Kenkoooo (AtCoder Problems)、Codeforces、LeetCode (含社区难度系统)、TopCoder、洛谷等  
> **报告归档路径**：`reports/oj_difficulty_and_rating_rules.md`  
> **日期**：2026 年 9 月  

---

## 1. 概述与核心理论基础

在竞技编程（Competitive Programming）与现代在线评测系统（OJ）中，量化**“选手的技术水平”**与**“题目的客观难度”**是构建评级体系、推荐训练路线和组织公平赛事的两大基石。

### 1.1 核心哲学：尺度对齐（Scale Alignment）
早期的评测系统往往将选手与题目割裂开来（例如：题目按“普及组/提高组”或“Easy/Medium/Hard”划分，选手按比赛得分或 AC 题数累计积分）。然而，现代主流 OJ（如 Codeforces、AtCoder 等）普遍采用**统一尺度度量**：
- **将题目难度（Difficulty）与选手积分（Rating）映射到同一个数值空间中**。
- **题目难度的核心定义**：  
  > **若某道题目的难度值为 $D$，则意味着一个技术水平（内部 Rating）恰好为 $D$ 的选手，在比赛常规情境下有恰好 50% 的概率能够通过该题。**

### 1.2 理论基石：Bradley-Terry 模型、Elo 体系与项目反应理论（IRT）

1. **Bradley-Terry 模型**：
   假设选手/实体 $i$ 与 $j$ 的真实技术实力分别为 $S_i, S_j > 0$，则 $i$ 击败 $j$ 的概率为：
   $$P(i \text{ 胜 } j) = \frac{S_i}{S_i + S_j}$$
   若定义选手 Rating 为实力的对数尺度：$R = c \ln S \implies S = \exp(R/c)$，则胜率公式自然演化为 Logistic（Sigmoid）函数：
   $$P(i \text{ 胜 } j) = \frac{1}{1 + \exp\left(-\frac{R_i - R_j}{c}\right)}$$

2. **Elo 评分系统（Elo Rating System）**：
   广泛应用于国际象棋与多人竞技。传统国际象棋中常取底数为 10，常数 $c = 400/\ln 10$：
   $$E_A = \frac{1}{1 + 10^{(R_B - R_A)/400}}$$

3. **项目反应理论（Item Response Theory, IRT）**：
   心理测量学与教育统计学中的核心理论。其中**单参数逻辑斯蒂模型（1PL / Rasch 模型）**与**双参数逻辑斯蒂模型（2PL）**正是现代 OJ 题目难度估算的直接数学来源：
   $$P(Y_{ui} = 1 \mid \theta_u, b_i, a_i) = \frac{1}{1 + \exp(-a_i (\theta_u - b_i))}$$
   - $\theta_u$：受试者（选手）能力值（Rating）；
   - $b_i$：题目难度（Difficulty）；
   - $a_i$：题目区分度/判别力（Discrimination）。

当将选手的 Elo Rating 与 IRT 的题目难度统一时，**“做出一道题”在统计上等同于“选手在一次 1v1 对决中战胜了该题目”**。

---

## 2. Kenkoooo (AtCoder Problems) 题目难度与表现计算体系

[kenkoooo.com/atcoder](https://kenkoooo.com/atcoder/)（AtCoder Problems）是全球算法竞赛界最著名、应用最广泛的第三方训练辅助与难度标定平台。其题目难度（Difficulty）计算模块由 pepsin-amylase 等核心贡献者主导设计并持续演进。

### 2.1 难度定义与数学模型

在 AtCoder Problems 中，单道题目的难度通过赛后 Rated 选手的实际做题情况与选手内部 Rating 进行最大似然估计（MLE）拟合得到。

#### (1) 做题成功率公式（Logistic 曲线）
对于内部 Rating 为 $R_u$ 的选手，通过难度为 $D_i$ 的题目的理论概率满足：
$$P(\text{Solve} \mid R_u, D_i) = \frac{1}{1 + 6^{(D_i - R_u) / 400}}$$

**关于底数 6 的数学来源**：
AtCoder 官方的 Performance 胜率模型采用底数 6（而非 Elo 传统的 10），这是 AtCoder 官方赛制（AtCoder Rating System ver 1.00）的既定参数，使得 Rating 相差 400 分的两位选手，强者的胜率约为 $6 / (1 + 6) \approx 85.7\%$。  
为了与官方体系严格对齐，Kenkoooo 的判别力参数（Discrimination）为：
$$a = \frac{\ln 6}{400} \approx 0.004479398673070138$$

#### (2) 概率特征对照
根据该公式，选手 Rating 与题目 Difficulty 的相对差距对解题概率的影响如下：
| 选手 Rating 相对难度差距 ($R_u - D_i$) | 解题概率 $P(\text{Solve})$ | 场景释义 |
| :--- | :--- | :--- |
| **$-400$** | $\frac{1}{1 + 6^1} \approx 14.3\%$ | 越级挑战（高 1 个色段），小概率通过 |
| **$0$** | $\frac{1}{1 + 6^0} = \mathbf{50.0\%}$ | **基准难度定义点（50% 概率）** |
| **$+400$** | $\frac{1}{1 + 6^{-1}} \approx 85.7\%$ | 实力高 1 个色段，大概率稳定过题 |
| **$+490$** | $\approx \mathbf{90.0\%}$ | 达到 90% 绝对把握需要高出约 490 分 |

### 2.2 难度参数 $D$ 的最尤估计与快速数值求解

在场比赛中有 $N$ 名 Rated 参赛者，已知每位选手的内部表现/评分 $R_u$ 以及该选手的实际过题结果 $y_{u} \in \{0, 1\}$（1 表示 AC，0 表示未通过）。

似然函数对数：
$$\ln \mathcal{L}(D) = \sum_{u=1}^N \left[ y_u \ln P(R_u, D) + (1 - y_u) \ln(1 - P(R_u, D)) \right]$$

对 $D$ 求导令导数等于 0：
$$\frac{\partial \ln \mathcal{L}(D)}{\partial D} = \sum_{u=1}^N \left( y_u - P(R_u, D) \right) \cdot \left(-\frac{\ln 6}{400}\right) = 0$$
$$\iff \sum_{u=1}^N P(R_u, D) = \sum_{u=1}^N y_u = N_{\text{solved}}$$

**物理含义**：  
**最佳的题目难度 $D$，就是让“所有选手的理论期望过题人数之和”恰好等于“实际赛场过题人数 $N_{\text{solved}}$”！**

由于 $P(R_u, D)$ 关于 $D$ 是**严格单调递减函数**，因此无需复杂的梯度下降，直接在区间 $[-1000, 4500]$ 上进行**二分查找（Binary Search）**，经过 40~50 次迭代即可在数毫秒内获得精确到小数点后 2 位的极值解。

### 2.3 Kenkoooo API 真实数据结构剖析

调用 Kenkoooo 官方 API（`https://kenkoooo.com/atcoder/resources/problem-models.json`）可获取如下实际元数据：
```json
{
  "abc138_d": {
    "slope": -0.0011986025321558905,
    "intercept": 8.48597477902844,
    "variance": 0.4317652846787837,
    "difficulty": 920,
    "discrimination": 0.004479398673070138,
    "irt_loglikelihood": -1747.6784092163878,
    "irt_users": 4647,
    "is_experimental": false
  }
}
```

各字段核心含义：
1. `difficulty`：计算出的原始题目难度（如 920，属于 Green 段位）。
2. `discrimination`：判别力，恒等于 $\ln(6)/400 \approx 0.0044794$。
3. `irt_users` / `irt_loglikelihood`：参与拟合的有效用户数与拟合优度对数似然值。
4. `is_experimental`：是否为实验性估算（对于引入 Rating 机制前的早期古老赛事，因缺乏连续数据，标记为实验性 🧪）。
5. `slope`, `intercept`, `variance`：**解题耗时回归模型参数**（详见下节）。

### 2.4 解题耗时预测模型（Solve Time Model）
Kenkoooo 不仅估计能否做对，还通过线性回归估计**做对该题所需的时间**：
对成功做对该题的选手用时 $T$（秒）取自然对数，拟合与选手 Rating $R_u$ 的线性关系：
$$\ln T_u \sim \mathcal{N}\left(\text{slope} \cdot R_u + \text{intercept}, \; \text{variance}\right)$$
预估耗时公式：
$$\hat{T}(R_u) = \exp\left(\text{slope} \cdot R_u + \text{intercept}\right)$$
- `slope < 0`：Rating 越高的选手用时越短；
- 例：对于 `abc138_d`，当 $R_u = 1000$ 时，$\ln \hat{T} = -0.0012 \times 1000 + 8.486 = 7.286 \implies \hat{T} \approx 1460 \text{ 秒} \approx 24.3 \text{ 分钟}$。

### 2.5 低分段非线性平滑算法（`clipDifficulty`）
在极其简单的签到题中，二分算出的原始难度 $D$ 往往是**负数**（例如 `abc138_a` 的难度为 $-848$）。如果直接在界面上显示负数难度，对新手体验极不友好。  
Kenkoooo 采用了与 AtCoder 官方一致的**指数平滑裁剪函数**：

```typescript
// 源码来自 atcoder-problems-frontend/src/utils/index.ts
export const clipDifficulty = (difficulty: number): number => {
  return Math.round(
    difficulty >= 400 
      ? difficulty 
      : 400 / Math.exp(1.0 - difficulty / 400)
  );
};
```
数学表达式：
$$D_{\text{disp}} = \begin{cases} D, & D \ge 400 \\ \operatorname{round}\left( \frac{400}{\exp\left(\frac{400 - D}{400}\right)} \right), & D < 400 \end{cases}$$

- 当 $D = 400$ 时，$D_{\text{disp}} = 400$（平滑连续）；
- 当 $D = 0$ 时，$D_{\text{disp}} = 400 / e \approx 147$；
- 当 $D = -848$ 时，$D_{\text{disp}} = 400 / \exp(3.12) \approx 18$。  
通过该映射，**所有负分难度被平滑压缩到 $(0, 400)$ 的灰色区间内**。

### 2.6 用户参考图解析（微信截图说明）
用户在需求中提到的截图（来源于 kenkoooo.com 的规则说明与弹窗），核心即阐述上述关键要点：
1. **Difficulty 含义**：表示具备该数值内部 Rating 的选手有 50% 概率做出的基准分。
2. **段位颜色匹配**：题目难度颜色与 AtCoder 官方段位颜色一致（8 档：灰、茶、绿、水、蓝、黄、橙、红）。
3. **实验性标志（🧪）**：由于旧赛制（2016 年之前）没有官方实时 Rating 数据，通过全历史虚拟反推计算，因此标有 🧪，置信度较低。
4. **个性化推荐逻辑**：推荐题目列表中以 50% 胜率（Moderate）作为高效进阶训练的靶心难度。

---

## 3. AtCoder 官方选手水平（Rating）体系

AtCoder 官方的评级方案由社长 chokudai 与世界顶尖选手 rng_58 共同设计，公布在《AtCoder Rating System ver 1.00》规范中。

### 3.1 单场表现值（Performance $X$）计算
一场比赛结束后，选手在全场 $N$ 名选手中取得的实际排名为 $r$（若多名同分，取并列排名的平均值）。设其他选手 $j$ 的基准能力为 $APerf_j$。  
选手的单场表现值 $X$ 满足以下方程：
$$\sum_{j \ne i} \frac{1}{1 + 6.0^{(X - APerf_j) / 400.0}} = r - 0.5$$
- 左侧为当选手能力为 $X$ 时，对全场每个对手的期望落败概率之和（即选手的期望名次偏差）；
- 右侧为实际名次减去 $0.5$（连续性修正）；
- 同样通过**二分查找**直接求解出单场表现值 $X$。

### 3.2 历史表现加权与时间衰减（Rating 积分合成）
选手过去 $n$ 场比赛的单场表现依次为 $P_1, P_2, \dots, P_n$（其中 $P_1$ 为最新一场）。  
引入对数正态变换函数 $g(X) = 2^{X / 800}$，并赋予越新的比赛更高的几何衰减权重（衰减率 $\lambda = 0.9$）：
$$g(R_{\text{raw}}) = \frac{\sum_{i=1}^n g(P_i) \cdot 0.9^i}{\sum_{i=1}^n 0.9^i}$$
取逆函数 $g^{-1}(y) = 800 \log_2(y)$，得到未修正的内部 Rating：
$$R_{\text{raw}} = 800 \log_2 \left( \frac{\sum_{i=1}^n 2^{P_i / 800} \cdot 0.9^i}{\sum_{i=1}^n 0.9^i} \right)$$

### 3.3 新手收敛修正与防小号惩罚函数 $f(n)$
为了防止新注册选手凭借单场发挥直接登顶，也为了保证评分系统的总体保守性，系统设置了随着参赛场次 $n$ 递减的修正项 $f(n)$：

定义方差衰减比：
$$F(n) = \frac{\sqrt{\sum_{i=1}^n 0.81^i}}{\sum_{i=1}^n 0.9^i}$$
当 $n \to \infty$ 时：
$$F(\infty) = \frac{\sqrt{\frac{0.81}{1 - 0.81}}}{\frac{0.9}{1 - 0.9}} = \frac{1}{10\sqrt{0.19}} \approx 0.2294157$$
$$F(1) = \frac{\sqrt{0.81}}{0.9} = 1.0$$

修正函数 $f(n)$ 定义为：
$$f(n) = \frac{F(n) - F(\infty)}{1 - F(\infty)} \times 1200$$

- **第 1 场**：$f(1) = 1200$，初次参赛显示 Rating 会比真实表现低 1200 分；
- **随着 $n$ 增加**：$f(n)$ 快速递减；大约 10~15 场后，$f(n) \to 0$；
- **修正后 Rating**：$R = R_{\text{raw}} - f(n)$。

### 3.4 选手低分保护映射
与题目类似，若选手最终 Rating $R < 400$，显示 Rating 会做底线平滑：
$$R_{\text{disp}} = \frac{400}{\exp\left(\frac{400 - R}{400}\right)}$$
保证全网选手 Rating 均大于 0。

---

## 4. Codeforces 选手水平与题目难度体系

Codeforces 由 Mike Mirzayanov 创建，是全球规模最大、活跃度最高的算法竞技平台。其评级系统演进经历了多次重大迭代（包括 2015、2018 以及 2020 年的平滑注入更新）。

### 4.1 选手 Rating 更新算法详解

设一场比赛有 $N$ 名选手参加，选手 $i$ 参赛前的 Rating 为 $R_i$。

#### Step 1: 期望名次（Seed）计算
基于标准基数 10 的 Logistic 分布，计算选手 $j$ 优于选手 $i$ 的概率：
$$P(j \text{ 优于 } i) = \frac{1}{1 + 10^{(R_j - R_i) / 400}}$$
选手 $i$ 的全场期望名次（Seed）为：
$$\operatorname{Seed}_i = 1 + \sum_{j \ne i} P(j \text{ 优于 } i)$$

#### Step 2: 目标名次（Geometric Mean Mid）
根据实际比赛名次 $\operatorname{rank}_i$，取期望名次与实际名次的几何平均数：
$$m_i = \sqrt{\operatorname{rank}_i \times \operatorname{Seed}_i}$$
> **原理**：几何平均数平衡了选手“原本实力预期”与“本场发挥”，防止极端异常场次产生过于剧烈的震荡。

#### Step 3: 反解表现 Rating（Binary Search）
利用单调性，二分查找一个虚拟 Rating 值 $R_i^*$，使得在该 Rating 下，选手预期的 Seed 恰好等于 $m_i$：
$$\operatorname{Seed}(R_i^*) = m_i$$

#### Step 4: 初步变化量计算
$$\Delta_i = \frac{R_i^* - R_i}{2}$$

#### Step 5: 全局零和与防通胀修正（Anti-Inflation Adjustment）
为防止全服总体 Rating 随比赛场次不断通胀或通缩，系统计算全场平均变化量：
$$\operatorname{inc} = -\frac{\sum_{k=1}^N \Delta_k}{N} - 1$$
$$\Delta_i \leftarrow \Delta_i + \operatorname{inc}$$

此外，Codeforces 针对高分段（顶部前 $k = \min(N, 4\sqrt{N})$ 名选手）引入了额外的防通胀收缩，高分选手在小比赛中获得正向 Delta 的门槛极高。

#### Step 6: 新用户平滑冷启动机制（2020 年更新）
早期的 Codeforces 新用户初始直接赋予 1500 分，导致大量开小号炸鱼与初始分崩塌。2020 年更新后：
- 新用户**起始显示 Rating 为 0**，内部基准分按 1400 计算；
- 前 6 场比赛设立固定递减的加成分（Delta Bonus）：
  | 参赛场次序号 | 加成分（Bonus） | 累计注入基数 |
  | :---: | :---: | :---: |
  | 1 | +500 | 500 |
  | 2 | +350 | 850 |
  | 3 | +250 | 1100 |
  | 4 | +150 | 1250 |
  | 5 | +100 | 1350 |
  | 6 | +50 | 1400 |
- 6 场之后正式完成冷启动过渡，完全进入常规动态调整。

### 4.2 Codeforces 题目难度评级（Problem Rating）

Codeforces 在 2018 年底由 Mike Mirzayanov 正式引入了连续的题目难度标签（800 到 3500，步长为 100）：
- **评定原则**：题目难度 $D$ 代表具有该 Rating 的选手在常规比赛中有 50% 概率攻克该题。
- **评定方式**：赛后基于所有提交选手的实际得分情况，统计各分数段选手的通过比率，通过 Logistic 曲线拟合求出 50% 拐点，并**四舍五入到最近的整百数**。
- **动态修正**：题目刚出场时根据本场比赛情况初评，后续若重测或发现测试点问题会有微调。

---

## 5. LeetCode 竞赛 Rating 与社区题目难度模型

LeetCode（力扣）是求职面试领域最具影响力的刷题平台，其官方竞赛体系与社区扩展难度体系呈现分层共存的特征。

### 5.1 官方竞赛 Rating 算法
2020 年，力扣竞赛全面换装基于 Elo 的积分体系（由社区顶尖选手兼算法研究者 zerotrac 等人设计）。
- **期望排名**：
  $$E_i = 1 + \sum_{j \ne i} \frac{1}{1 + 10^{(R_j - R_i) / 400}}$$
- **积分变动公式**：
  $$\Delta_i = K \cdot \frac{E_i - \operatorname{rank}_i}{N - 1}$$
  其中 $K$ 是由比赛人数和权重决定的缩放常数。
- **冷启动阻尼**：新账号前几场参赛时，其积分调整幅度施加递增阻尼因子（如 $1/5, 2/5, \dots$ 直至 $1$），防止由于单场好成绩或坏成绩造成积分失真。

### 5.2 社区高精度题目难度分（zerotrac 模型）
LeetCode 官方仅提供 Easy、Medium、Hard 三档粗粒度标签，完全无法满足竞赛进阶选手的梯度训练需求。为此，社区开源项目（[zerotrac222/LeetCode-Questions-Rating](https://github.com/zerotrac222/LeetCode-Questions-Rating)）填补了这一空白：
- **数据源**：爬取每周周赛（Weekly Contest）及双周赛（Biweekly Contest）的全量排名表及选手的参赛 Rating。
- **算法模型**：同 Kenkoooo 类似，采用标准 1PL/2PL IRT 逻辑斯蒂回归，通过二分查找求出使理论解题期望人数最接近实际 AC 人数的切点。
- **输出格式**：给出具体数值（如 LeetCode 第 300 题难度 1820，第 220 题难度 2139），现已成为国内外力扣选手公认的标准难度标尺。

---

## 6. TopCoder 与 洛谷（Luogu）机制对比

### 6.1 TopCoder：经典高斯波动度模型（Normal Distribution + Volatility）
TopCoder 是算法竞技领域的鼻祖平台，其 Rating 系统与国际象棋 Elo 有所不同，采用**正态分布与波动度（Volatility）联合建模**：
- 每位参赛者维护两个状态量：Rating $R_i$ 和波动度 $V_i$（衡量选手水平的不稳定性）。
- 比赛中选手发挥被视作服从正态分布 $\mathcal{N}(R_i, V_i^2)$。
- 选手 $j$ 胜过选手 $i$ 的胜率通过误差函数（Error Function, erf）精确给出：
  $$P(j > i) = 0.5 \times \left( 1 + \operatorname{erf}\left( \frac{R_j - R_i}{\sqrt{2(V_i^2 + V_j^2)}} \right) \right)$$
- 赛后更新不仅改变 Rating，还会根据选手实际发挥与预期的偏差更新下一轮的 $V_i$（发挥稳定则 $V_i$ 减小，爆冷或失常则 $V_i$ 增大）。

### 6.2 洛谷（Luogu）：咕值综合积分与 8 阶离散难度系统
国内最大的算法竞技社区洛谷采用了双轨制：
1. **选手水平评价（咕值系统）**：
   - 咕值并非单纯的对抗性 Rating，而是包含 5 个维度（满分 500 分）：基础信用（100）、社区贡献（0~100）、比赛情况（0~100）、练习情况（0~100）、获得成就（0~100）。
   - 颜色段位：灰（<100）、蓝（100~119）、绿（120~169）、橙（170~229）、红（230+）。
   - 在官方认证的 Rated 比赛中，另外计算独立的比赛 Elo Rating。
2. **题目难度分级**：
   - 采用对齐 NOI/NOIP 系列考纲的 8 阶分类体系：
     `暂无评定`、`入门`、`普及-`、`普及/提高-`、`普及+/提高`、`提高+/省选-`、`省选/NOI-`、`NOI/NOI+/CTSC`。
   - **评定机制**：初期由出题团队/管理员预设，上线后开放社区用户评定反馈，结合过题率与用户投票加权微调。

---

## 7. 各主流 OJ 题目与选手算法全景横向对比

| 平台 / 系统 | 选手水平评价算法 | 题目难度评价算法 | 难度与水平对齐标准 | 冷启动与防膨胀机制 | 数据开放与开源情况 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **AtCoder / Kenkoooo** | AtCoder 官方 Performance 反解 + 0.9 指数历史衰减 | IRT 2PL 模型 + 解题耗时对数正态回归 | **完全对齐**（难度 $D$ 表示 $R=D$ 选手有 50% 概率做对，基数 6） | 新手 $f(n)$ 扣除补偿、$<400$ 指数非线性平滑 | 算法公式开源，Kenkoooo 全开源，API 公开 |
| **Codeforces** | 改进型 Elo（Seed 几何平均 $m_i$ + 表现二分反解） | 赛后基于过题率二分标定，步长 100 分（800~3500） | **完全对齐**（50% 概率做对，基数 10） | 前 6 场固定分段注入（+500 到 +50）、全场净增量零和修正 | 原理博客公开，API 开放，核心公式为公认行业标准 |
| **LeetCode (力扣)** | Elo 变体（$\Delta = K \frac{E - \text{rank}}{N-1}$） | 官方仅 3 级；社区版采用 IRT 2PL 拟合连续分数 | 社区版完全对齐官方 Rating（50% 胜率） | 官方前若干场阻尼阻滞 | 社区项目（zerotrac）完全开源，数据公开 |
| **TopCoder** | 高斯分布模型（Rating + Volatility 波动度，基于 erf） | 无连续难度，按 Div 组别与固定分值（250/500/1000） | 未完全对齐 | 贝叶斯方差自适应更新 | 历史悠久，算法论文公开 |
| **洛谷 (Luogu)** | 比赛 Elo Rating + 综合咕值（信用、做题、成就等） | 8 阶离散难度阶梯（入门至 NOI+） | 经验映射（离散标签） | 咕值周期性衰减，周一刷新 | 规则公开，部分由社区众包共建 |

---

## 8. 面向 Hydro OJ 的工程落地与架构设计建议

结合 Hydro OJ 的微服务/模块化架构（以及私有域、多域支持特性），引入“选手 Rating 体系”与“题目难度自动标定”能够极大提升平台的竞技活跃度与题库治理水平。

### 8.1 方案选型与架构建议

#### 建议 1：选手水平系统选用 **AtCoder 方案**
- **理由**：
  1. Codeforces 的 Seed 机制在大规模公网赛事中表现极佳，但在学校、企业或自建 OJ 的中小规模比赛（如 30~300 人）中，极端名次容易造成分值大起大落。
  2. AtCoder 方案将**单场表现值（Performance）**与**历史汇总（加权平均）**明确解耦。单场比赛即使失误，由于历史 $0.9$ 系数加权和对数平滑，不会造成毁灭性暴跌；新人 $f(n)$ 修正也天然杜绝了小号单场炸鱼的问题。

#### 建议 2：题目难度系统采用 **Kenkoooo IRT 2PL 自动拟合**
- 在 Hydro 中，将题目属性增加一个 `difficulty` 字段（整型或浮点型）。
- 每当一场 Rated 比赛结束后，系统自动触发一个异步 Worker：
  1. 提取所有已拥有 Rating 的选手的提交记录；
  2. 运行二分拟合算法，计算本场每道题目的实际难度；
  3. 若该题目后续在其他比赛再次被使用，通过贝叶斯加权或样本量加权合并新旧难度。

### 8.2 核心算法 Python 参考实现（开箱即用）

以下为可直接集成至 Hydro 评测或后端离线统计脚本的核心计算模块：

```python
import math
from typing import List, Tuple

class OJDifficultyAndRating:
    """
    基于 AtCoder / Kenkoooo 理论构建的题目难度与选手表现值计算器
    """
    
    @staticmethod
    def solve_probability(rating: float, difficulty: float) -> float:
        """
        计算 Rating 为 rating 的选手做对难度为 difficulty 题目的概率 (基数 6)
        """
        exponent = (difficulty - rating) / 400.0
        # 防止浮点溢出
        if exponent > 50.0:
            return 0.0
        if exponent < -50.0:
            return 1.0
        return 1.0 / (1.0 + math.pow(6.0, exponent))

    @classmethod
    def estimate_problem_difficulty(
        cls, 
        user_ratings: List[float], 
        solved_flags: List[bool],
        eps: float = 1e-4
    ) -> float:
        """
        基于二分查找与最大似然准则拟合题目难度
        :param user_ratings: 参赛选手在该比赛前的真实内部 Rating 列表
        :param solved_flags: 对应选手是否做对该题 (True/False)
        :return: 题目估算难度 Difficulty
        """
        actual_solved = sum(1 for f in solved_flags if f)
        total_users = len(user_ratings)
        
        if total_users == 0:
            return 0.0
        # 边界特判：无人做对或全员做对，设定上下界极值
        if actual_solved == 0:
            return max(user_ratings) + 400.0
        if actual_solved == total_users:
            return min(user_ratings) - 400.0
            
        low = -1500.0
        high = 5000.0
        
        for _ in range(80):  # 80 次二分足以达到极高精度
            mid = (low + high) / 2.0
            # 计算当前测试难度下的期望通过人数之和
            expected_solved = sum(cls.solve_probability(r, mid) for r in user_ratings)
            
            # expected_solved 关于 mid 是严格单调递减函数
            if expected_solved > actual_solved:
                # 理论通过人数过多说明假设的难度偏简单，应向高难度调整
                low = mid
            else:
                high = mid
                
        return (low + high) / 2.0

    @classmethod
    def calculate_performance(
        cls, 
        actual_rank: float, 
        competitor_ratings: List[float]
    ) -> float:
        """
        根据比赛排名计算单场 Performance (表现值)
        :param actual_rank: 选手本场实际排名 (允许同分平均名次)
        :param competitor_ratings: 全场其他参赛选手的基准评分列表
        :return: 表现值 Performance
        """
        target = actual_rank - 0.5
        low = -1000.0
        high = 4500.0
        
        for _ in range(80):
            mid = (low + high) / 2.0
            expected_rank = sum(1.0 / (1.0 + math.pow(6.0, (mid - r) / 400.0)) for r in competitor_ratings)
            if expected_rank > target:
                low = mid
            else:
                high = mid
                
        return (low + high) / 2.0

    @staticmethod
    def clip_display_difficulty(diff: float) -> int:
        """
        低分段非线性平滑，避免负数展示
        """
        if diff >= 400.0:
            return round(diff)
        return round(400.0 / math.exp((400.0 - diff) / 400.0))


# --- 单元测试演示 ---
if __name__ == "__main__":
    # 模拟一场 5 人比赛
    ratings = [1200.0, 1500.0, 1800.0, 2100.0, 2400.0]
    # 某题目只有 1800, 2100, 2400 的选手做出了
    solved = [False, False, True, True, True]
    
    diff = OJDifficultyAndRating.estimate_problem_difficulty(ratings, solved)
    disp_diff = OJDifficultyAndRating.clip_display_difficulty(diff)
    print(f"题目拟合难度: {diff:.2f}, 展示难度: {disp_diff}")
    
    # 计算名次第 1 名的选手表现值
    perf_1st = OJDifficultyAndRating.calculate_performance(1.0, ratings[1:])
    print(f"第一名单场表现值: {perf_1st:.2f}")
```

### 8.3 小样本题目的冷启动策略
对于直接录入 Hydro 题库但未经过大型 Rated 比赛检验的新题：
1. **教师/管理员基准设定**：录入题目时选择预估段位（如“青铜/白银/黄金”或经典分级），自动映射为锚点初值（如 1000, 1400, 1800）。
2. **提交通过率自适应修正**：
   当题目在日常练习中累积一定数量提交者时：
   $$\hat{D} = D_{\text{prior}} + \alpha \times \ln\left( \frac{1 - \text{AC\_Rate}}{\text{AC\_Rate} + \epsilon} \right)$$
   利用日常练习数据进行贝叶斯后验更新，直至该题参与正式比赛后再转由 IRT 逻辑回归锁定。

---

## 9. 结论

现代 OJ 题目难度与选手水平计算已经全面走向**“统计学习化”**与**“尺度统一化”**：
1. **理论一致性**：无论是 AtCoder (Kenkoooo)、Codeforces 还是 LeetCode 社区版，其核心均收敛至 **50% 期望胜率的 IRT 逻辑斯蒂模型**。题目难度不再是一个主观标签，而是由全网选手做题表现共同确定的客观统计参数。
2. **工程稳健性**：AtCoder 与 Kenkoooo 通过**对数正态时间衰减**、**新手惩罚 $f(n)$** 以及**低分段指数截断平滑（`clipDifficulty`）**，成功解决了传统 Elo 系统在算法竞技场景下的冷启动震荡、负分体验不佳和历史通胀难题。
3. **平台参考价值**：对于类似 Hydro 的现代化评测系统，以 AtCoder/Kenkoooo 的“表现值反解 + IRT 二分拟合”作为核心算法框架，能够以最小的计算代价和最高的稳定性，快速构建起专业、精准的段位与难度生态。
