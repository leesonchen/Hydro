# Hydro 测试与发布交接

本目录保存可复用测试工具、用例计划、缺陷分析、精简发布记录和少量关键图片。根 [test/](../../test/README.md) 保存自动化回归源码。所有历史版本和结果均指当次执行，不能视为当前环境状态。

## 长期保留与本地产物

| 位置 | 用途 | Git |
| --- | --- | --- |
| 根 `test/` | 回归源码、集成入口和复现脚本 | 提交 |
| `scripts/`、`skills/` | 复用驱动、报告工具与 skill 源码 | 提交 |
| `fixes/`、`releases/` 中的文档、用例和场景脚本 | 版本、根因、复现、验证范围与后续处理 | 提交 |
| `assets/history-layout/` | 桌面修复前后、窄屏修复后三张代表图 | 提交 |
| `.local/`、各批次 `evidence/` | 完整矩阵、批量截图、运行 JSON、环境快照、日志、重试与一次性工具 | 仅本地，已忽略 |
| 根 `test-reports/`、`test-results/`、`playwright-report/` 等 | 工具生成报告 | 仅本地，已忽略 |
| 根 `testuser.txt`、`test/testuser.txt` | 真实测试账号 | 仅本地，已忽略 |

完整运行产物先写入 `.local/<批次>/`，整理后只提交能说明问题和支撑交接的简明结论。新增图片应有具体解释价值，避免每个成功用例都提交截图。需要跨成员共享完整证据时，使用团队共享存储或 CI 产物，并约定有效期；本次未上传任何文件。

本次整理保留了原始内容：`.local/` 保持原批次路径，原完整报告在 `.local/full-reports/`；迁移清单也存放在 `.local/`。这些是本机归档，团队阅读仓库报告无需取得归档文件。精简报告不能重新生成原始逐项证据，重新验证应按用例计划运行。

## 交接索引

| 批次 | 历史版本 Hydro / UI | 结果与入口 |
| --- | --- | --- |
| 初次发布 | dev.2 / dev.2 | [53 项：51 通过、1 失败、1 阻塞](releases/2026-10-12-dev.2/system-test-report.md)；[普通课程模板误判](releases/2026-10-12-dev.2/defects.md) |
| 课程模板修复 | dev.2 / dev.4 | [13 项浏览器回归通过](fixes/2026-10-12-course-template/system-test-report.md) |
| 日期与比赛设置修复 | dev.2 / dev.5 | [24 项代码/构建检查、18 项浏览器回归通过](fixes/2026-10-13-course-datetime/system-test-report.md) |
| 后续发布 | dev.6 / dev.7 | [12 项通过](releases/2026-10-13-dev.6-7/system-test-report.md) |
| 扩大浏览器复测 | dev.6 / dev.7 | [36 项：35 通过、1 失败](releases/2026-10-13-browser-retest-dev.6-7/system-test-report.md)；[排队与布局缺陷](releases/2026-10-13-browser-retest-dev.6-7/defects.md) |
| 队列与布局修复发布 | dev.7 / dev.8 | [30 项通过及部署清理结论](releases/2026-10-13-rating-queue-fix/system-test-report.md)；[根因、复现与关键对照图](fixes/2026-10-13-rating-queue-history/fix-report.md) |

表中 Hydro 稳定基版本均为 `5.0.7`，UI 为 `4.58.5`。普通全站发信的 MSG-02 历史阻塞仍需具备相应权限的隔离账号补测，不能由其他消息用例的通过替代。

## 继续测试

共享浏览器工具读取根 `testuser.txt` 的本地标签账号，格式见 [testuser.example.txt](testuser.example.txt)。也可使用 `HYDRO_TEST_CREDENTIALS` 指定本地凭据文件。运行需要仓库依赖、Chrome、Docker 权限，以及正常的 Hydro 和判题服务；环境可通过 `HYDRO_TEST_BASE_URL`、`HYDRO_TEST_DOMAIN`、`HYDRO_TEST_CHROME` 指定。

在根目录运行，先将本轮计划、`change-scope.json` 和发布说明准备到 `.local/<run>/`。实际部署目录和目标容器必须按本轮环境填写。

```bash
node doc/test/scripts/compare-releases.cjs \
  --container hydro \
  --previous /root/.hydro/dev-releases/<previous> \
  --current /root/.hydro/dev-releases/<current> \
  --out doc/test/.local/<run>/evidence/release-comparison.json

node doc/test/scripts/browser-system-test.cjs \
  --container hydro \
  --cases doc/test/.local/<run>/test-cases.json \
  --out doc/test/.local/<run>/evidence

node doc/test/scripts/extra-course-test.cjs \
  --container hydro \
  --out doc/test/.local/<run>/evidence/extra-course

node doc/test/scripts/generate-report.cjs --run doc/test/.local/<run>
```

日期专项工具为 `scripts/course-datetime-test.cjs`。三个共享浏览器运行脚本要求显式 `--out`；每轮使用独立目录。历史批次的场景脚本保留用于复现，运行前阅读其参数、夹具和清理逻辑；部分默认写入批次 `evidence/`，该输出同样被忽略。一次性结果聚合、清理状态核验脚本仅保存在本地归档。

`--only ID,ID` 聚焦复测时包含前置用例。合并结果不得用未执行项覆盖已完成项；CLI 和夹具准备不代替浏览器操作。只有获准发送真实消息时才传 `--allow-feedback`。写入使用独立临时域，结束后核对数据清理与全局配置恢复。

完整报告生成器用于本地运行目录，生成结果再人工精简为仓库交接记录。流程细节见 [hydro-release-system-test](skills/hydro-release-system-test/SKILL.md)。发布与升级仍遵守 [AGENTS.md](../../AGENTS.md)。
