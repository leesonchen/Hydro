# Hydro 本地课程反馈：构建与完整包验证

日期：2026-10-06。继续分支 `work/hydro-local-feedback-20261005` 和 [Draft PR #11](https://github.com/leesonchen/hydromod/pull/11)，本轮起点为 `53fa6990fb66493777b5c63365fe8b6d5e973a20`。

验证内容对应源码提交 `98d8c0f159cedabcdaf2b7b46bbc15a42e6e9163`，验收文档与截图单独提交。

## 判定与范围

尚未达到发布条件：全库 `lint:ci` 仍有既有错误和警告。本轮已修复全量类型及 UI 构建阻塞，并补上解包后的 Hydro／UI 完整生产包验证。源码功能、构建通过与已部署是不同状态；运行中的 Docker Hydro 未升级、未重启，没有连接真实班级数据进行测试。

反馈仍在 Hydro 内完成认证、授权、存储、查询和纠错。同题跨课时共享本课程结果、原观察与处理历史保留、材料可得不代表学生实际使用等口径不变。

## 本轮修复

| 问题 | 可复现的影响 | 最小修复与验证 |
| --- | --- | --- |
| Windows 路径漏匹配 `@types/` 规则 | 真实 webpack 将 Node／Undici 声明当模块解析，产生 37 个错误，完整 UI 无法构建 | 类型文件及 message 文件规则匹配两种路径分隔符；真实声明上下文编译为字符串，生产构建通过 |
| 配置编辑器回退仍用旧 YAML 参数 | 全量 TypeScript 有 4 个 `noArrayIndent` 错误；回退到文本框时序列缩进与 Monaco 不一致 | 四处调用使用当前依赖支持的 `seqNoIndent`；实际编辑器生命周期与 YAML 往返测试通过 |
| TypeScript 声明只接受单引号 | 当前 Node 文件使用双引号，提示加载器抛出 `Cannot read properties of undefined (reading 'split')`；一个文件中的后续模块也被遗漏 | 读取两种引号和全部模块声明；真实 Node `fs.d.ts`、旧式声明及完整生产浏览器加载通过 |

以上新增 4 项构建回归已纳入默认 `yarn test`。测试先复现编译与声明解析失败，再验证修复；没有修改依赖声明或稳定版本、提交锁文件、关闭检查规则。

## 门禁与证据

| 验证项 | 实测结果 | 状态 |
| --- | --- | --- |
| 全量 TypeScript 项目构建 | 0 错误；`tsc -b --pretty false` | 通过 |
| 完整默认 UI 生产构建 | webpack 0 错误、3 警告；最后一次 134.282 秒 | 通过，有警告 |
| 新增构建回归 | 4 项通过、0 失败 | 通过 |
| 完整项目回归 | 默认 `yarn test` 共 224 项通过、0 失败，含新增的 4 项构建回归；最后一次完整测试 81.8 秒 | 通过 |
| 实际解包后的完整浏览器流程 | 8 组通过，页面／控制台及脚本、样式、字体 HTTP 错误 0 | 通过 |
| 本地包内容 | Hydro 141 文件、UI 816 文件；8 份语言 YAML 解析通过；必需运行资源均在包中 | 通过 |
| 全库 lint | 535 文件，103 错误、122 警告；与本轮起点逐条比较，新增诊断 0 | 未通过 |
| 改动与依赖 | 差异检查通过；原有依赖声明和包版本不变；打包只调整临时副本中的 workspace 引用 | 通过 |
| 实际 WSL Docker 环境 | `Ubuntu-22.04` 的 `hydro` 为 running／healthy，Node `v22.16.0`；启动时间仍是 `2026-10-04T13:08:26.782816363Z` | 只读核对通过 |
| 注册表安装、真实班级、机构备份恢复 | 未发布、未升级安装，不执行真实数据测试 | 后续授权范围 |

全库 lint 采用文件、级别、规则、消息的多重集比较，归一化诊断内的行号，不把相同总数直接当作“无新增”。改动的三个 UI 源文件没有新增诊断；构建配置的既有 `rupture` 引号警告仍保留。不得据此宣称全库门禁通过。

生产构建的两项警告是已有资源及入口体积超过 webpack 建议，另一项来自子编译。体积警告涉及 Monaco、Mermaid 等原有模块；本轮不扩展为编辑器或图表依赖重构。子编译警告仍需在工程收口时取得详细原因。以上由 UI 维护任务跟进，PR 保持 Draft。

两次以 D 盘临时目录运行的完整回归（含串行运行）触发已有 App 测试的 30 秒启动上限，随后清理中的异步操作报错，进程退出 1；均未计入通过。改用仍有超过 10GB 可用空间的系统临时目录后，单独的 61 项集成测试通过，初始化为 8.550 秒；最终完整回归 224 项通过。本轮没有扩大超时或跳过测试。这个对照说明需要核验本机临时数据库环境，不能把失败只归因于并行编译，也不能外推成正式 MongoDB 的性能结论。

## 完整包验证边界

`test/prepare-feedback-package-check.cjs` 将源码复制到工作树的临时目录，按现有发布流程的口径把 workspace 依赖改为本仓库版本，仅在临时副本离线执行 `npm pack --ignore-scripts`，再解包检查。没有调用发布脚本、包注册表或安装命令。生产构建本来会删除 source map，资源核验按实际运行需要排除 manifest 中的 `.map` 项。

`test/classroom-feedback-browser.js --built-ui` 支持使用 `HYDRO_FEEDBACK_PACKAGE_ROOT` 加载解包后的 Hydro 和 UI。验证实例只绑定 loopback，建立临时 MongoDB、示例教师与学生，使用包内真实模板、完整 webpack 脚本与样式。依赖复用工作树已有安装；这验证包内容与组合运行，不替代从私有注册表安装到目标容器的验收。

8 组浏览器验收覆盖：真实 Monaco 声明加载、A 录入与草稿、待复测完成与精确撤销、丢失回执和 403 重试、已确认保存后的读取失败、B 的真实成绩变化与 PJAX 节点替换、12 项管理操作中一项失败后仅重试失败项、390px 布局和键盘。失败注入入口只在隔离测试脚本内；后台的注入故障日志不是正式服务故障。测试结束后停止本任务的临时 Hydro 和两个临时数据库进程。

当前运行容器中的 Node 不在 Docker 默认 PATH；版本核对使用 `/root/.nix-profile/bin/node`。这是环境核对，不表示容器已经装入本轮代码。

## 可复现入口

已有依赖的仓库内，先设置隔离环境，再串行运行门禁。本轮最终使用 Windows 系统临时目录；需确认临时数据库目录有足够空间，不能照抄上一轮因系统盘空间不足而采用的 D 盘设置：

```powershell
# TEMP/TMP 使用本机系统临时目录；本次为 C:\Users\13813\AppData\Local\Temp。
$env:MONGOMS_SYSTEM_BINARY = (Resolve-Path .cache/mongodb-binaries/mongod-x64-win32-8.2.1.exe).Path
$env:NODE_OPTIONS = '--require=' + (Resolve-Path test/classroom-feedback-test-isolate.cjs).Path
node node_modules/typescript/bin/tsc -b --pretty false
corepack yarn test
node node_modules/eslint/bin/eslint.js packages plugins modules framework --ext .ts,.tsx,.jsx,.vue,.yaml,.yml --max-warnings=0
```

完整 UI 单独运行 `node packages/ui-default/build --production --detail`。纯构建回归入口为 `node --test test/ui-build-regressions.spec.js`。在没有发布凭据的子进程运行，不上传 Sentry release 或 source map。

本地包验证入口为 `node test/prepare-feedback-package-check.cjs`，其输出给出 `FEEDBACK_PACKAGE_ROOT`。在另一终端把这个目录设为 `HYDRO_FEEDBACK_PACKAGE_ROOT`，执行 `node test/classroom-feedback-browser.js --built-ui`；按其 `FEEDBACK_PREVIEW_URL` 执行已有浏览器测试。用本机已有 Playwright 设置 `HYDRO_PLAYWRIGHT_MODULE`，用 `HYDRO_FEEDBACK_BROWSER_OUTPUT` 指定截图目录；这些变量仅供测试。

逐项摘要、包哈希和源码哈希见 [实测摘要](assets/course-feedback-package-2026-10-06/validation.json)。本轮截图为 [A 名单](assets/course-feedback-package-2026-10-06/a-roster.png)、[B 进度](assets/course-feedback-package-2026-10-06/b-progress.png)、[待复测](assets/course-feedback-package-2026-10-06/pending-retest.png)、[课程管理](assets/course-feedback-package-2026-10-06/course-manage.png)、[窄屏](assets/course-feedback-package-2026-10-06/mobile.png)。上一轮 [实施记录](HYDRO-COURSE-FEEDBACK-IMPLEMENTATION-2026-10-06.md) 保留其当时的证据。

## 下一阶段任务

| 批次 | 工作与验收边界 | 状态 |
| --- | --- | --- |
| E1 构建与完整包 | 修复构建阻塞、真实完整包浏览器验收、串行完整回归 | 已完成：全量类型、生产构建、224 项回归及 8 组完整包浏览器检查通过 |
| E2 工程检查收口 | 按业务风险拆分既有 lint 缺陷；安全正则、异步错误和控制流优先，各子系统用相关测试复核；查明子编译警告 | 未开始，不能批量自动改动无关插件或降低门禁 |
| E3 Hydro 本地材料条件 | 班级／学期设置一次，课程继承，题目按需覆盖；表达资料可得，不能自动标为学生使用参考代码或已掌握；新观察可保留录入时条件，旧事实不回填伪造 | 未实施，先核对现有班级、课程配置与权限后形成具体变更 |
| E4 获准后的安装与试点 | 按仓库指定私有发布与升级脚本；核对目标 `hydro` 容器版本、健康和完整包资源；只在获准的一个班级试点，验证机构备份恢复 | 未授权，不在本轮执行 |

AI-EDU 消费端、线上 IDE 轨迹、共享身份服务仍是独立后续任务，不成为 Hydro 反馈运行的前置条件。
