# PR #10～#14 选择性引入实施验收

日期：2026-10-12。实施基线 `01329554`，分支 `course-v2.2`。
依据 [已确认计划](PR10-PR14-INTEGRATION-PLAN-2026-10-12.md) 执行。

## 已完成

- 第一阶段：当前 Rating V2 的 27 项算法测试纳入根测试命令，提交 `3b4c6e93`。
- 第二阶段：迁入 PR #12 卡片、开关、移动端、深色样式、折叠帮助和简体/繁体翻译。
  保留监控、团队、赛后练习、首页展示、权限条件、赛制切换、上传和操作按钮。
  开关的灰显状态随实际 disabled 属性同步；实际表单和页面脚本回归已纳入根测试入口。
- 第三阶段：新提交保存服务器时间、类型、参与身份、来源上下文、规范题目、题目版本和满分。
  时间在读取题目证据前捕获；旧记录不回填。正常重评保留原始事实，生成重评记录关联原记录。
  结果更新不能覆盖来源字段，业务迁移和删除仍可清理比赛关联。
- 第三阶段：增加显式的认证资格、原因码和管理员认证入口；trial 默认保持现行口径。
  certified 首期只支持同步个人 ACM/OI；要求开赛前冻结、成绩可见、足够有效参与者及当前题目证据。
  排除未证明的历史来源；未完成评测/异常分数阻断整场；认证池域隔离、重叠窗口拒绝及并发互斥已验证。
  策略写入原子校验全部冻结字段，拒绝检查期间的并发配置修改。
- 第三阶段：认证成就按域隔离，排除题主/未公开/版本不符记录，显式引用去重并按实际满分归一化。
  保留当前算法和旧业务字段。操作语义见 [认证影子口径](rating-v2-operations-guide.md#7-认证影子口径2026-10-12)。
- 第四阶段：PR #11/#13/#14 保留已集成实现，完成隔离数据库、HTTP 和真实 Chromium 操作验收。

实施提交：`3b4c6e93`（算法测试入口）、`fb273a9d`（基线兼容修复）、
`800defa6`（比赛设置页）、`3f64d7f2`（提交事实及认证资格层）。

## 为完成验证修复的基线问题

- 已声明的 `@cordisjs/plugin-logger` 本机缺失，恢复 1.0.2 到被忽略的 node_modules，未修改依赖版本。
- 当前 Cordis 的 logger 使用 `args`；修正适配。原生 logger 不是需注入的服务，移除模板的该依赖，
  解决 HTML 页面返回 JSON 的问题，实际 HTTP 68/68 通过。
- js-yaml 5 使用 `seqNoIndent`；替换 YAML 编辑器与诊断输出的旧选项，恢复既有回归及类型构建。
- 用户编辑模板两处头像补齐已有的失败回退标记；字体下载导入按现有 lint 规则排序。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| 完整根测试 `npm run test` | TAP 汇总 452/452，0 失败；包含新增测试和最后 HTTP 68/68 |
| 新事实/资格/表单聚焦测试 | 21/21；包含并发认证、异常来源/分数、版本、域隔离、满分及真实表单脚本 |
| 最后提交时间调整后的事实回归 | 7/7，通过真实 Mongo 新建、重评和更新路径 |
| 比赛模型并发配置回归 | 24/24，实际 ContestModel/DocumentModel/Mongo 验证冻结字段原子校验 |
| `node_modules/.bin/tsc -b --pretty false` | 通过 |
| `npm run lint:ci` | 同等全仓库 ESLint 命令通过，0 警告/错误 |
| `NODE_OPTIONS=--max_old_space_size=8192 node packages/ui-default/build --production` | 通过；未配置 Sentry 上传，未发布 release |
| `git diff --check` | 通过 |
| 真实 Chromium 课堂反馈 | 11 个检查通过，页面错误为 0 |
| 真实 Chromium 比赛设置/监控/测验 | 5 个检查通过，页面错误为 0 |

完整根测试使用缓存 MongoDB 8.2.1 和 `test/classroom-feedback-test-isolate.cjs`，
只创建临时数据库和配置，不连接部署数据库：

```bash
MONGOMS_SYSTEM_BINARY=/home/leeson/.cache/mongodb-binaries/mongod-x64-ubuntu-8.2.1 \
NODE_OPTIONS=--require=/home/leeson/Hydro/test/classroom-feedback-test-isolate.cjs npm run test
node_modules/.bin/tsc -b --pretty false
npm run lint:ci
NODE_OPTIONS=--max_old_space_size=8192 node packages/ui-default/build --production
```

## 浏览器证据与范围

实例只监听 `127.0.0.1:37611`，域 `feedback-browser`；临时教师 UID 2、学生 UID 3，
使用生产 webpack 资源，测试结束后已关闭临时 Hydro/Mongo 并清理实例配置。

- 课堂反馈：名单动作、细项/草稿、跟进撤销、丢回执及被拒重试、保存后读失败、
  成绩格真实 PJAX、批量权限、无效 JSON、讲义 Mermaid、YAML worker、移动端及键盘控件。
- 设置页：真实编辑保存后 `monitorMode=browser`、`allowPractice`、`hideInBanner` 保留；
  OI/ACM 切换控制隐藏成绩开关；浅色/深色移动端没有横向溢出。
- 监控：真实浏览器断网后恢复重传、粘贴事件、导航离开；学生 viewer 被 403 拒绝，教师能查看事件。
- 测验：真实首次入课与报名、结束前成绩不展示、结束后达标成绩与前置章节解锁；
  派生测验不能走普通比赛编辑页面。
- 团队、复制、重判、生命周期故障和浏览器往返缓存另由已有 Mongo/HTTP/客户端回归验证，
  未声称在实体考试设备或真实部署中完成全部人工操作。

日志与截图仅位于 `/tmp/hydro-pr-adoption-*`，例如 `final-test.log`、`types.log`、
`full-lint.log`、`final-ui.log`、`feedback-browser.log` 和 `browser/result.json`。
原始故障截图、测试账号、生成资源和临时数据库不进入版本控制。

## 当前边界

本轮未推送、发布开发包、升级容器、认证任何线上比赛或修改公开排名。
认证模式是正式发布前的资格准备，默认试验行为保持不变。
缺历史事实的记录和未支持的正式赛制保持排除；课堂测验入 Rating、异步进度、AI-EDU、
历史评测快照和代际发布沿用原计划的后续边界。
