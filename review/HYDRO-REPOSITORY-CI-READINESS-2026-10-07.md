# Hydro 全库检查与 GitHub CI 修复验收

日期：2026-10-07。仓库 leesonchen/hydromod；继续 work/hydro-local-feedback-20261005 与 Draft PR #11。用户新增授权处理全库错误和 CI；原 E2 课程工程记录保留为历史测量，本报告覆盖这次扩展范围。

修复起点为 f8eb9da8ae3fad9c1dd569d9219dc796abe9471f；已验证并推送源码为 4df5a215f9a465daedac09a6f1d4dee37f69d3f0。Hydro 本地反馈、同题共享课程结果以及已移出的材料条件范围均保持不变。不合并、不发布、不部署，不升级或重启运行容器。

## 确认的问题与处置

| 问题 | 取证与修复 | 状态 |
| --- | --- | --- |
| 私有仓库 CI 无法检出 | 原工作流仅声明 id-token:write，导致 contents 没有读取权限；运行 37483275906 的检出返回 Repository not found、退出 128。改为 contents:read | 已修复，后续检出和安装通过 |
| 严格 lint 阻止 CI 后续步骤 | 修复检出后的运行 37546368803 在 Lint 报 58 错误、121 警告，共 179 条，与本地 537 文件诊断一致。逐文件修改；不全库自动修复、不降低规则 | 已修复，lint:ci 退出 0 |
| URL 审计吞掉下游错误 | finally 中的 5 个提前 return 会覆盖下游抛出的错误。把记录过滤放入独立函数，外层继续保留下游错误和结果；审计写入失败仍只告警 | 已修复，过滤、错误、结果与写入失败回归通过 |
| 评测串长空白反复回溯 | 可选冒号两侧的空白量词可反复交换字符。改为带必需冒号的可选分组，保留原捕获编号、中英文标点和状态摘要 | 已修复，10 万空白与长数字的可终止 worker 验证通过 |
| 必要的串行操作与检查冲突 | 班级复制、引用链、导入、权限操作、维护就绪检查、提供方重试继续逐项等待；不改为并发，不加规则豁免 | 已修复，引用链、重试、维护和原有复制测试通过 |
| 工作流版本漂移与发布步骤 | 使用仓库 packageManager 指定的 Yarn；移除强制改版本、dedupe、构建状态缓存和第三方跳过判断。CI 只验证，移除自动发布步骤与 Sentry 发布 token 注入 | 已修复，不改依赖声明、版本或锁文件 |
| Linux 快速执行使无关测试累积请求计数 | 运行 37554048481 的构建均通过，App 集成 61 项中 39 通过、22 失败；日志显示先触发 global 的 100 次／5 秒配额，随后影响反馈、登录和其他接口。仅在隔离测试的 beforeEach 清理 global 计数，不改正式限流；新增用例直接验证 403 拒绝及计数清理后恢复 | 已修复，62 项应用集成及最终远端完整测试通过 |

其余修改限于诊断对应的导入、类型标点、引号、返回值一致性、长行拆分和等价 API。迁移用户 ID 查询改为预先生成已占用 ID 集合，保留匹配优先级和分配顺序；6 组现有纯函数测试通过，没有执行数据迁移。点评提示词拆行前后 1280 个字符逐字一致，SHA-256 为 4ecf97170aceb889de3516cfcdcfef43efeb29c2a8b3f3137592a6a58c761c61。

## 实测门禁

| 门禁与分母 | 本轮结果 |
| --- | --- |
| 全库 lint，537 个配置覆盖文件 | 58 错误、121 警告 → 0 错误、0 警告；max-warnings=0 保持不变 |
| 全量类型构建，包括默认 UI、UI-next、插件及后端项目 | yarn build 退出 0，TypeScript 6.0.3，0 错误 |
| 默认完整回归 | 原有 232 项全部保留，新增 17 项审计／解析／串行回归和 1 项 HTTP 限流回归，共 250 项通过，0 失败、0 取消、0 跳过 |
| 新增回归中的历史复现 | 17 项按起点源码运行：7 通过、10 失败；包含 8 类审计过滤吞错、写入失败覆盖结果、长文本超过 2 秒。隔离 worker 已终止，没有阻塞主进程 |
| 生产构建 | webpack 0 错误、2 项既有体积警告；子编译警告 0 |
| 完整生产包浏览器 | 11 组全部重跑通过，页面／控制台与资源 HTTP 错误 0；隔离应用与两个临时数据库已停止 |
| GitHub CI | PR 源码运行 [37555177130](https://github.com/leesonchen/hydromod/actions/runs/37555177130) 和推送运行 [37555173117](https://github.com/leesonchen/hydromod/actions/runs/37555173117) 全部通过；PR 日志实测 250 项通过、0 失败，应用初始化 1.958 秒 |

首次完整回归没有计为通过：前 188 项通过，App 的 before hook 在既有 30 秒上限处失败、61 项取消，并在退出后产生 MongoNotConnectedError。生产构建结束后，同一配置、数据库二进制及 30 秒超时下单独 61 项通过，初始化 12.340 秒；随后完整默认包 249 项通过。远端揭示跨用例限流干扰后，新增 1 项限流回归；最终完整默认包 250 项通过，初始化 14.971 秒。没有改测试超时、删除测试、忽略错误或跳过用例。首次门禁脚本 5/6 是历史失败结果，最终完整回归门禁 3/3 通过。

体积警告为 asset size limit 与 entrypoint size limit，与上阶段一致，不是子编译警告。Sentry 构建插件另提示未提供 token，未创建 release 或上传 source map；没有补入发布凭据。运行器 action 的 Node 版本弃用提示属于上游兼容通知，另行列账，不通过升级依赖掩盖本轮错误。

## 隔离环境与边界

本地验证使用工作树已有依赖，Node v22.20.0、Yarn 4.14.1；临时 MongoDB 使用本地 8.2.1 二进制，测试 profile 位于工作树 .cache。完整包只在临时副本中离线打包并解包，Hydro 141 文件、UI 818 文件及 8 份语言 YAML 均检查；没有注册表发布、目标安装或真实数据写入。

WSL Ubuntu-22.04 的 Docker hydro 仅只读核对：running、healthy、HTTP 8082 返回 200，Node v22.16.0，StartedAt 仍为 2026-10-04T13:08:26.782816363Z。构建自动产生的根 tsconfig 变动在交付前恢复，不提交生成器副作用。依赖版本、公开 API、反馈事件结构和数据库索引没有变化，不需迁移。

## 可复现入口

在已有依赖工作树设置 CI=true，移除 SENTRY_AUTH_TOKEN，以 MONGOMS_SYSTEM_BINARY 指向本地测试 MongoDB，并通过 NODE_OPTIONS 加载 test/classroom-feedback-test-isolate.cjs。执行 yarn lint:ci、yarn build、yarn test、默认 UI 生产构建。门禁使用 review-fix-release-loop 的 run_release_gates.py。

独立回归为 node --test test/repository-ci-regressions.spec.js；迁移纯函数验证为 node -r @hydrooj/register packages/migrate/tests/exam.spec.ts。完整包入口仍是 test/prepare-feedback-package-check.cjs 和 test/classroom-feedback-browser.js --built-ui；浏览器使用现有 test/classroom-feedback-browser.spec.js，验证后通过 loopback 的 /feedback-preview-stop 正常停止应用及两个临时数据库。

历史复现命令为 node --require ./test/reproduce-repository-ci-regressions.cjs --test test/repository-ci-regressions.spec.js，预期退出 1、7 通过和 10 失败；仅使用 git show 读取固定起点的五个生产文件，不检出或重写工作树。该入口不加入默认 CI 测试。

结构化实测摘要与诊断基线：[validation.json](assets/repository-ci-2026-10-07/validation.json)。E2 历史报告：[课程工程验收](HYDRO-COURSE-ENGINEERING-2026-10-06.md)。

本轮提交：2098a67d4（CI 权限与验证流程）、b9a32c650（审计错误与文本解析）、2748acb33（全库严格检查与串行顺序）、4df5a215f（测试配额隔离）。生产包由本轮产品源码构建；隔离页面后台页脚标记为 2748acb-dirty，随后只改测试与验收记录。浏览器截图：[A 名单](assets/repository-ci-2026-10-07/a-roster.png)、[B 进度](assets/repository-ci-2026-10-07/b-progress.png)、[待复测](assets/repository-ci-2026-10-07/pending-retest.png)、[课程管理](assets/repository-ci-2026-10-07/course-manage.png)、[课程 JSON 错误](assets/repository-ci-2026-10-07/course-edit-invalid.png)、[讲义与样例](assets/repository-ci-2026-10-07/course-lecture.png)、[窄屏](assets/repository-ci-2026-10-07/mobile.png)。JSON 页内错误截图已目视核对。

## 后续范围

全库检查与 CI 本轮收口；材料可得条件继续移出，不新增教师录入步骤，模拟集训另行设计。PR 保持 Draft。真实班级试点、机构备份恢复、目标容器安装和部署仍需另行授权；AI-EDU 消费端与线上 IDE 轨迹不作为 Hydro 本地闭环前置条件。
