# Rating V2 · 算分脚本操作指导（生产环境）

- **日期**：2026-09-19
- **适用对象**：需要在生产环境（hydro2 容器）运行评分计算与验证的管理员
- **前提**：只读安全——所有脚本对源集合（`document`/`record`/`document.status`/`domain.user`）**只读**；唯一写入目标是独立集合 **`ratingv2_shadow`**（`write:true` 时），可用 `db.ratingv2_shadow.drop({poolId:...})` 全量撤销，不影响线上任何功能。

---

## 1. 脚本清单

| 脚本 | 用途 | 典型场景 |
|---|---|---|
| `rating-v2-audit` | P0 盘点：比赛供给、成熟选手、题目暴露、难度字段、A 分布（只读、不写库） | 定期体检、闸门复核 |
| `rating-v2-replay` | 影子回放：按时间顺序重放合格比赛 → 能力 Rating → 难度拟合 → 学习成就 → P/C/RP 投影（`write:true` 写影子集合） | 每次评分更新、试运行发布前 |

代码位置：`packages/hydrooj/src/lib/rating-v2/*`（纯计算）+ `src/script/rating-v2-{audit,replay}.ts`（注册入口）。参数全部可配置并带默认值（试验口径：`minParticipants=1`、全部 rated 赛制、含个人计时）。

## 2. 运行方式

### 方式 A（推荐）：随版本发布后用 CLI 脚本

新版本（包含上述文件）发布到容器后：

```bash
# 影子回放（默认只出报告不写库；write:true 写 ratingv2_shadow）
docker exec hydro2 sh -c 'cd /root/.hydro/dev-releases/$(cat /root/.hydro/dev-releases/active 2>/dev/null || echo .) 2>/dev/null; true'
# 进入 hydrooj CLI 后：
hydrooj script rating-v2-replay '{"write":true,"poolId":"shadow-trial","refDomain":"cpptrain"}'
hydrooj script rating-v2-audit '{"minParticipants":1,"windowMonths":12}'
```

> 说明：`active` 文件内容为当前 release 目录名；脚本注册依赖新 release 内的 hydrooj 包。

### 方式 B（当前容器立即可用）：打包 + 独立 runner

当前生产 release 尚未包含新脚本时，用 esbuild 打包纯计算核心，在容器内用其自带的 mongodb 驱动运行：

```bash
# ① 在仓库打包（宿主机）
cd /home/leeson/Hydro/packages/hydrooj
npx esbuild src/lib/rating-v2/shadow-replay.ts --bundle --platform=node --format=cjs \
  --packages=external --outfile=/tmp/rating-v2-shadow-bundle.js
docker cp /tmp/rating-v2-shadow-bundle.js hydro2:/tmp/

# ② runner（/tmp/rating-v2-shadow-runner.js，已置于容器）要点：
#    NODE_PATH 指向当前 release 的 node_modules；MongoClient 连接 127.0.0.1:27017/hydro；
#    handle = { collection: (n) => db.collection(n) };
#    runShadowReplay(handle, { write:true, poolId:'shadow-trial', refDomain:'cpptrain' }, console.log)

docker exec hydro2 sh -c 'timeout 550 /root/.nix-profile/bin/node /tmp/rating-v2-shadow-runner.js'
```

完整 runner 已在本容器 `/tmp/rating-v2-shadow-runner.js`，改参数即可复用。**换库/换容器时注意**：uri 与 NODE_PATH 里的 release 目录名要相应更新。

## 3. 参数参考（rating-v2-replay）

| 参数 | 默认 | 说明 |
|---|---|---|
| `rules` | `[acm,oi,ioi,strictioi]` | 计入的 rated 赛制白名单 |
| `minParticipants` | 1 | 合格比赛的最少窗口内有效参赛人数（D1：试验期放宽到 1） |
| `includeDuration` | true | 是否纳入个人计时比赛（D3：转正式认证前建议 `false` 对照复跑） |
| `includeAssign` | true | 是否纳入课程布置的比赛 |
| `provisionalEvents` | 5 | 定级场次数；之前为暂定选手（零和豁免） |
| `maxDelta` | 200 | 单场Rating 变动的 Tanh 软饱和上界 |
| `difficultyMinPriorEvents` | 5 | 学员至少多少场后，其赛内结果才产生难度观测 |
| `difficultyMinStudents` / `MaxSe` | 20 / 150 | provisional 难度门槛（学生数 / 条件标准误） |
| `priorMean` / `priorSd` | 1500 / 600 | 难度与能力的初始先验 |
| `refDomain` | cpptrain | 新旧榜对比的参照域 |
| `poolId` | default | 评分池标识（写入影子集合时作为隔离键） |
| `write` | **false** | 是否落库；false = 纯报告（干跑） |

`rating-v2-audit` 参数（`minParticipants/rules/includeDuration/includeAssign/windowMonths/startSpreadSample`）语义相同。

## 4. 结果解读与验证查询

回放结束打印 `SUMMARY`（JSON）。关键字段与建议验证：

```javascript
// mongosh 连接后（只读）：
// ① 拟合状态：nonconverged 必须为 0 或个位数且不发布
db.ratingv2_shadow.countDocuments({poolId:'shadow-trial', kind:'difficulty', status:'nonconverged'})
// ② provisional 难度题数（Mode 3 闸门 ≥50）
db.ratingv2_shadow.countDocuments({poolId:'shadow-trial', kind:'difficulty', provisionalLike:true})
// ③ 校准斜率与留出指标（SUMMARY.calibrationSlope / calibrationHeldOut）
//    - slope ≈ 1：模型标尺自洽；明显偏离 1 说明学生-题目匹配度仍在演化
//    - brierCalibrated 应 ≤ brierRaw；meanAbsDevCalibrated 越小越自洽
// ④ 单题期望 vs 实际（人工抽查模板）：
//    期望解出率 = Σ sigmoid(k·a·(μ−D)) / n，与 pos/students 对比，偏差 >25pp 的题已在 SUMMARY.m15Anomalies
// ⑤ 用户一致性：observations 按 uid 聚合，比较 expRate vs actRate（抽查报告 §二 的方法）
```

**验收基线（2026-09-19 实测）**：nonconverged=0；provisional=172；slope=0.8868；留出 Brier 0.1521（raw 0.1512）；分桶 MAD 0.0127（raw 0.0200）；M15 异常 0。若复跑结果显著劣化（nonconverged>10、MAD>0.03、M15>10），先检查是否有新的大规模比赛/批量改分，再报告。

## 5. 常见操作场景

```text
① 日常评分更新（试运行）
   rating-v2-replay {write:true, poolId:'shadow-trial'}
② 正式认证前的口径对照（个人计时排除版）
   rating-v2-replay {write:true, poolId:'shadow-certified', includeDuration:false}
③ 干跑评估（不落库）
   rating-v2-replay {write:false}
④ 新学期全量重算（清空影子池后重放）
   db.ratingv2_shadow.deleteMany({poolId:'shadow-trial'})
   rating-v2-replay {write:true, poolId:'shadow-trial'}
⑤ 赛季体检
   rating-v2-audit {minParticipants:1, windowMonths:12}
```

## 6. 安全与纪律

1. 所有脚本对源数据**只读**；`write:true` 只新增/清空 `ratingv2_shadow` 中对应 `poolId` 的文档。
2. **永远不要**直接改 `ratingv2_shadow` 里的单条评分——修正走"修订事实 → 重放"路径（计划 §13.5），影子阶段即重新跑脚本。
3. 正式切榜前必须完成：`includeDuration=false` 对照报告（D3）、新旧榜差异公示、回退预案（保留上一代 `poolId` 即天然回退）。
4. 若 mongosh 中对 `journal` 字段使用 `$ne:{}` 出现可疑结果（历史已知其查询计划不稳），改用 record 表口径或重跑一次核对。
5. 校准斜率、难度状态等诊断随每次回放自动输出，无需手工维护；发现 `m15Anomalies` 非空时先人工复核该题的赛内证据再处置。
