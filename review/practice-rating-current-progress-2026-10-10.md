# Hydro 练习评分当前进展与验证报告

- 日期：2026-10-10；分支 `work/rating-all-data-shadow`；本轮评审基线 `7e299eff0bfaf2e766d96ab7e0ad136238ff70ea`。
- 已完成 M2 加固，并实现 M3 的前向预测工具与管理员只读页面。可进入**受控试用准备**，尚不能宣称模型已经有效或所有域均可运行。
- [M2 加固、逐域容量与性能报告](practice-rating-m2-hardening-2026-10-10.md)；[任务清单](WORK-HYDRO-RATING.md)；[实施方案](../doc/design/hydro-rating-implementation-plan-2026-10-08.md)。
- [本地测试库逐域只读试算与手工复核反馈](practice-rating-local-simulation-feedback-2026-10-10.md)：23 域中 15 域拟合成功、7 域样本不足、1 域超限；这是训练内诊断，前向效果仍待观察。
- [最新远端修复本地复验](practice-rating-remote-fixes-verification-2026-10-10.md)：基线 `9f86fc37`，修复本轮实测的 Lint／测试夹具问题后，四项指定检查及完整本地 CI 检查、构建和测试通过；远端 Actions 状态未据此改写。

## 2026-10-11 同步与质量复验

已成功 fetch 并核对 `origin/course-v2.2@580f114f`；当前工作分支已包含该提交，合入检查为 `Already up to date`。最新[逐域评分质量报告](../doc/design/practice-rating-local-quality-2026-10-11.md)及[脱敏聚合结果](../doc/design/practice-rating-local-quality-2026-10-11.json)记录 23 域只读试算：15 域成功、7 域样本不足、cpptrain 超限，无 Mongo 写操作。成熟过程 26,011；回顾性留出只覆盖 362/5,209（6.95%），模型加权 Brier 0.1245，高于整体完成率基线 0.1059，不能宣布预测质量达标。手工梯度复算一致，所有成熟过程题目版本仍未知。

四项必要 CI、全部评分测试及完整测试 371/371 通过，新质量测试已接入评分和完整入口。回顾性诊断不代表严格历史回放、真正未来冻结或独立外部模拟；M3-03、真实未来效果、真实管理员试用仍待完成。未推送、发布或部署。

## 已完成与待完成

| 任务 | 状态 |
| --- | --- |
| M0/M1：口径、状态映射、去重、7 天窗口、90 天成熟样本 | 已实现，评分单元与既有回归通过 |
| M2：联合 1PL、影子快照、每日任务、固定 run 查询 | 已实现并加固；历史显式 UID 排除、空数据保留有效结果、有效排除策略版本、未知题目版本比例均有 Mongo 回归 |
| M2：容量与性能 | 已盘点本机 hydro 的全部 23 个域；隔离库 20 万条边界和新索引已验证。cpptrain 295,913 条超限，不能启用该域试算。高峰负载与新索引在线构建未验证 |
| M3-01：冻结未来预测 | 已实现管理员显式候选对冻结，实际概率/基线/策略先保存，再开始观察；非历史回放 |
| M3-02：成熟结果、分桶、Brier 和基线 | 已实现只读评估，真实适配器合成未来时间验证通过；没有真实未来期数据 |
| M3-03：独立模拟外部参考 | 未完成，需要后续真实独立模拟和人工研究判断；不得用训练拟合代替 |
| M3-04：管理员只读试用 | 仅系统管理员可访问；最新 HTTP/模板 29/29 与完整本地 CI 通过，安装环境未启用 |

**模型效果仍是“尚无结论”。** 当前可准备在容量允许、明确授权的域内进行小范围管理员试用和前向数据采集；公开榜单、跨域等值、精确成长、反作弊与多模型均不在本轮范围。

## M3 使用契约

`practice-rating-freeze` 接受单域最多 1,000 个明确的 `{uid,pid}` 候选对。它只保存尚无合格首次尝试、且同一活动 run 内用户与题目都有估计并处于同一连通组件的组合。不构造全站用户×题目笛卡尔积，不为无训练的新学生/新题伪造 1500。

新增独立集合 `practice_rating_predictions`：单个有界文档保存实际概率、整体训练完成率基线、题目训练完成率基线、原 runId/训练日期/模型版本、有效排除策略及摘要。写入得到确认后设置 frozenAt 和完整性摘要；只有 frozen 状态可评估。模型、基线和排除策略在后续更换活动 run、修改测试账户配置或虚拟账户标记后仍保持原值。

只对 `t0 > frozenAt` 的真实首次合格尝试等待 7 天。没有作答不补失败；冻结前/冻结同刻的过程单独计数；窗口开放、pending、缺失结果均不计成熟样本。输出固定十个分桶 `[0,0.1)` … `[0.9,1]`、预测与实际比例、样本数及同一评估样本上的三种 Brier。零样本指标为 null，结论为“尚无结论”。工具始终提供描述统计，不自动宣称教育效度或达标。

评估是只读的当前有效结果视图，报告带 asOf；后来重测可能改变**新的评估报告**，不会改旧预测。没有历史评测日志时不能还原过去被覆盖的判定；需要留存某日评估证据时保存当日脚本输出。当前数据库适配器版本始终未知，前向工具使用未知版本的域内题号，不把当前题面哈希当历史版本。

```bash
# 先做容量核对、试算，再由管理员显式保存影子估计
hydrooj cli script practice-rating-run '{"domainId":"YOUR_DOMAIN","write":true}'

# 在学生尚未开始这些题之前冻结；返回 predictionId、实际纳入数和跳过原因计数
hydrooj cli script practice-rating-freeze '{"domainId":"YOUR_DOMAIN","pairs":[{"uid":2,"pid":100},{"uid":3,"pid":101}]}'

# 之后读取实际发生作答的成熟结果；不会用后来规则改写冻结队列
hydrooj cli script practice-rating-evaluate '{"domainId":"YOUR_DOMAIN","predictionId":"RETURNED_ID"}'

# 单独开启管理员只读试用；默认不开放，enabled 控制每日拟合，两者独立
hydrooj cli script practice-rating-configure '{"domainId":"YOUR_DOMAIN","adminTrial":true}'
```

以上为操作说明，本轮未在安装实例执行。configure 现在只修改显式提供的 enabled、adminTrial 或 excludedUids；省略其他字段保留旧配置，只有明确传入 excludedUids:[] 才清空排除。旧 teacherTrial 不再用于授权。run 的显式排除与保存配置取并集；冻结使用训练 run 与冻结时配置的排除并集，并保存当时实际策略。

## 管理员专用试用边界

入口：`/d/<domain>/course/<tid>/practice-rating` 和对应的 `homework` 路径。只有拥有 PRIV_EDIT_SYSTEM 的系统管理员（本人会话、非 sudo 代入）且对应域显式 adminTrial=true 时，页面/侧栏入口才可访问。普通教师、域管理员和学生均被服务端拒绝；历史 teacherTrial=true 不授权。该页面独立于 classroomFeedback 开关，使用活动所分配的学生名单与题单进行选择限制。

管理员只能从对应课程/作业名单选择；题目必须在其题单且满足当前用户的题目可见权限。跨域、越名单 UID/题号、隐藏题目均在服务器检查。请求从已解析的 domain 和路由 tid 获取边界，不信任 query/body 中伪造的 domainId。返回只包含允许的姓名/题目标题和估计摘要，无提交证据、源代码或其他活动来源。

页面显示整数 R/D、暂定/样本不足/已估计、原评估日期和解释；空数据保留旧估计时提示最近运行样本不足，最近运行失败则明确展示告警。相同 run、同组件才显示配对概率。GET 不写评分/预测，响应 no-store；没有教师写入评分接口。

## 验证与限制

| 检查 | 结果 |
| --- | --- |
| 全部评分提取/1PL 单测 | 38/38 通过（包含在完整 `yarn test`） |
| M2 真实适配器/Mongo 集成 | 最新 18/18 通过，包含配置部分更新和租约中断状态 |
| M3 固定分桶/Brier、冻结、未来窗口、配置变化、重测、失败候选/校验 | 6/6 通过 |
| 既有 Rating V2 单测 | `node -r @hydrooj/register test/rating-v2.spec.ts`，27/27 通过 |
| 管理员页面独立 HTTP/真实 Nunjucks 模板套件 | `node --test test/classroom-feedback-entry.js`，29/29 通过 |
| 完整 CI 测试入口 | `yarn test` 全部前置批次与最后 HTTP 67/67 通过 |
| CI 构建阶段 | `yarn build:ui:iconfont`、`yarn lint:ci`、`yarn build`、`yarn build:ui:production:webpack` 全通过 |
| 额外检查 | 新评分 TypeScript 测试/工具独立 ESLint `--max-warnings=0` 与 TypeScript 检查通过；`git diff --check` 通过 |
| 容量工具 | 20 万条压力、20 万零 1 条拒绝、索引和快照复用断言通过；指标不等同生产并发达标 |

完整测试实际使用 `CI=true`、仓库 `test/classroom-feedback-test-isolate.cjs`，`MONGOMS_SYSTEM_BINARY` 指向已缓存的 MongoDB 8.2.1；从本地 Corepack 缓存运行 Yarn 4.14.1，避免隔离 home 导致重复下载。复现新增文件类型检查：

```bash
yarn exec eslint test/practice-rating-model.spec.ts test/practice-rating-integration.spec.ts \
  test/practice-rating-validation.spec.ts tools/practice-rating-capacity.ts --max-warnings=0
yarn exec tsc --ignoreConfig --noEmit --skipLibCheck --target es2022 \
  --module preserve --moduleResolution bundler --esModuleInterop --strict false --types node \
  test/practice-rating-model.spec.ts test/practice-rating-integration.spec.ts \
  test/practice-rating-validation.spec.ts tools/practice-rating-capacity.ts
```

未通过/未执行事项：初次集成测试在沙箱因监听端口 EPERM 无法启动，随后在获准的隔离运行中通过；新增页面最初的 HTML 断言在未加载模板引擎的测试实例失败，测试改为加载真实模板服务后通过；新增文件的初始格式检查已修复。当前无未修复的代码门禁失败。Sentry 未提供令牌，生产 UI 构建给出不上传 source map 的提示，构建成功且本轮没有发布。

真实未来预测、独立模拟、真实管理员试用与生产忙时服务共存尚未执行。未合并、发布或部署，旧业务字段及排名逻辑保持不变。完整 CI 指本地使用既有依赖执行仓库 CI 的构建/检查/测试阶段；未重装依赖，未声称远端 GitHub Actions 已运行。

M2 由独立评审上下文重新检查全部差异，未发现可行动 P0–P2；M3 的第二独立评审因工具额度不可用，主执行上下文按冻结时间、失败写入、配置/活动 run 漂移、重测、隐藏资料、跨域和撤权清单完成复核及补测。没有将该轮描述成已通过独立评审。

临时日志：`/tmp/hydro-rating-final-{test,lint,build,ui}.log`、`/tmp/hydro-rating-m3-validation-final.log`；实测聚合 JSON 随报告提交。构建自动生成的根 `tsconfig.json` 已恢复，不纳入提交；业务库凭据、源码/身份数据和临时运行日志均未加入版本控制。

## 2026-10-10 管理员专用权限收敛（追加开发）

以下保留远端开发时的验证限制；最新本地执行结果见[远端修复复验报告](practice-rating-remote-fixes-verification-2026-10-10.md)。

用户决定：新算法及其试用页面在效果成熟前**仅开放给系统管理员**。本轮将课程/作业试用页从教师授权改为同时满足 `PRIV_EDIT_SYSTEM`、本人会话非代入登录、域级显式 `adminTrial=true` 的服务端鉴权。普通授课教师、课程负责人、域管理员与学生均不得访问；原有 `teacherTrial` 即使为 true 也不再授权。管理员页面与课堂反馈开关解耦，仍只列出对应活动的学生和题目。导航及标题改为“管理员试用”，不新增学生或教师入口。

`practice-rating-configure` 仅更新显式传入的 `enabled/adminTrial/excludedUids`；省略排除名单保留旧值，显式 `excludedUids:[]` 才清空。教师页面最近计算失败时展示明确提示，但继续读取最后有效快照。新增配置部分更新的 Mongo 集成用例，以及系统管理员/教师/域管理员/学生、老开关、课程作业入口、失败提示、撤权和功能开关独立性的 HTTP 回归用例。

**新一轮 CI 尚未通过。** GitHub Actions 在提交 `8c44f1e2` 和 `02c74cb9` 的 push 上均于约 3 秒内返回 failure，工作流 API 未返回任何执行步骤、下载日志返回 BlobNotFound；对 `38024934482` 发起一次失败作业重试也未进入可检查的构建/测试步骤。无法确认失败属于平台调度、账户配额或具体仓库配置，不能视为源码构建失败，也不能声称本轮 HTTP/集成测试已通过。合并前必须由可工作的 CI/本地完整依赖环境实际执行 `yarn lint:ci`、`yarn build`、`yarn test:practice-rating:integration`、`node --test test/classroom-feedback-entry.js`、`yarn test`，并保存日志。此前通过的 CI 只覆盖管理员权限修改**之前**的代码。

本轮未修改旧 `difficulty/rp/rpInfo/level/rank`，没有改变模型公式和训练口径，也未合并或部署。向教师和学生开放需要以后另外设计授权、可解释性和发布资格，而不是简单复用管理员开关。

## 2026-10-10 配置与试用状态加固（后续修复）

根据代码复核，修复 `practice-rating-configure` 的 Schemastery 可选数组隐式空数组行为：省略 `excludedUids` 必须保留旧排除配置，显式传入 `[]` 才清空。Mongo 配置集成测试增加真正执行 Schema 校验后对 `undefined` 的断言，防止未来库升级回归。

对 `practice_rating_runs` 的新写入快照记录持有租约 token；读报告时只在最新运行状态为 `writing` 时核对活动租约，区分仍在写入与已中断／租约过期的任务。管理员试用页对应展示“仍在写入”或“异常中断”，保留上一份有效 R/D；新增 Mongo 集成用例覆盖有效租约、过期租约及已有结果不被覆盖。

管理员权限测试新增模拟 sudo 代入会话，要求课程与作业试用 URL 均返回 403。所有修改仍保持在独立影子评分集合及管理员页面，不影响旧 `difficulty/rp/rpInfo/level/rank`。

**验证边界：**此次通过 GitHub 文件接口提交，当前执行容器无法联网克隆仓库，也没有完整 Hydro/Yarn 依赖，因此尚未实际执行新增 Mongo/HTTP 回归或全量编译。用户确认 GitHub Actions 已到免费额度上限，当前不将远端 CI 失败作为代码缺陷，但仍需在 Codex 已有完整本地环境实际运行 `yarn lint:ci`、`yarn build`、`yarn test:practice-rating:integration`、`node --test test/classroom-feedback-entry.js` 后才能声明通过。本轮未合并、发布或部署。

## 2026-10-10 最新本地复验

已在 `9f86fc37` 上实际执行上述四项检查，修复两处零警告 Lint 阻塞、中断快照夹具的时间排序和新增测试静态检查问题后全部通过。补充非法排除名单配置不变、仍具管理权限的 sudo 会话拒绝和隐藏题目权限回归；Mongo 18/18、预测验证 6/6、独立 HTTP 29/29、完整 `yarn test` 367/367，图标／类型／生产 UI 构建通过。独立复核未发现明确可行动的 P0–P2。

额外检查 HTTP 测试文件时仍有与远端基线一致的既有 8 个 Lint 错误、32 个警告，未改写无关测试。必要 CI 门禁无未修复失败；远端 GitHub Actions 未由本地结果代替，真实未来预测结论仍待采集。命令、环境、失败复现与日志位置见[详细报告](practice-rating-remote-fixes-verification-2026-10-10.md)。
