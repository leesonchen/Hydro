# Hydro 课程链路工程收口：E2 验收

日期：2026-10-06。分支 `work/hydro-local-feedback-20261005`，继续 [Draft PR #11](https://github.com/leesonchen/hydromod/pull/11)。本轮起点 `6ecad262c152ba00300a411461f85380bc8107ae`；文本解析提交 `c2ef7709cd68159e6c22d01e2020052954566342`，课程检查与 YAML 兼容提交 `a3cbe50183aed7053710d200af6bd15889f51d72`。验收记录另行提交。

## 判定与范围

批准的课程范围已完成，保持 Draft。全库 lint 尚未通过，其他模块的历史问题单独列账；没有授权目标容器安装或真实班级试点。

按用户本轮决定移除“材料可得条件”，不再作为 E3 待开发项，不增加教师配置或录入步骤。模拟集训另行设计。Hydro 本地认证、存储、查询、原观察与复测历史，以及同题跨课时共享“本课程该题”结果的口径不变。

本轮没有修改公开 API、反馈事件结构、数据库索引、依赖版本、锁文件或稳定包版本，无数据迁移。不合并、不发布、不部署、不升级或重启运行容器。

## 问题、修复与复核

| 问题 | 基线证据 | 修复和验收 |
| --- | --- | --- |
| 讲义包装正则在长尾空白失败时反复回溯 | 从起点提交读取真实函数，10 万空格后接非法尾字符，在独立 worker 中超过 2 秒被终止 | 只检查首尾行的语言和相同围栏，再截取正文；保留 LF／CRLF、反引号／波浪号、正文内部原文；不完整或不符合原识别条件的包装不动 |
| 样例标题重叠空白匹配在失败时反复回溯 | 从起点读取真实匹配函数，10 万空格的异常 Sample input 标题超过 2 秒被终止 | 前缀、空白、可选 `#`、数字分步解析；输入输出编号按原字符串精确匹配，`01` 不等于 `1`；输出代码块仍为必需条件，显式 language-input 类规则保留 |
| 10 个课程文件有 45 个 lint 错误，课程编辑两处原生弹窗会阻断自动交互 | 起点完整诊断中定位到课程文件；编辑错误分支调用 window.alert | 逐项修复危险正则、类型分隔符、控制流括号、声明顺序、局部遮蔽、无用变量和空白；保留复制与解析顺序。无效 JSON 和空数组阻止提交，保留原文，展开并聚焦实际编辑器，以页面内 alert 状态报错 |
| YAML worker 子编译缺少 `format` 导出 | monaco-yaml 可选 formatter 导入 prettier/standalone，被通用空模块替换；实际配置为 format:false | 为这个导入提供只返回原文的专用兼容模块，其他占位规则不变；实际 worker 编译无警告且不打入完整 Prettier，浏览器验证语法校验工作、格式化仍关闭 |

长文本测试先等 worker 就绪，再以 2 秒为执行上限，并在 finally 中终止 worker；启动等待和整项测试也有上限。默认回归覆盖 1 万／10 万空白及长数字的异常文本，测试主进程不会被旧 matcher 卡死。普通包装、异常包装、中英文、可选 `#`、工具栏包裹、编号不匹配、输出缺失和不安全类编号均有用例。

## 实测门禁

| 验证项 | 实测结果 | 状态 |
| --- | --- | --- |
| 完整默认回归 | 232 项通过，0 失败，0 跳过；保留原 224 项，增加 6 项文本与 2 项 YAML 构建回归；79.3 秒 | 通过 |
| 全量类型检查 | TypeScript 6.0.3，0 错误；171.8 秒 | 通过 |
| 生产 UI 构建 | webpack 5.111.1，0 错误；子编译警告 0；仅 2 项既有体积警告；webpack 162.689 秒，整条构建命令 174.2 秒 | 通过，有体积警告 |
| 目标课程文件 | 原 10 文件，错误 45 → 0，警告 40 → 39；另计 2 个新内部模块和构建配置，共 13 文件、0 错误、40 警告 | 错误归零，保留警告逐项说明 |
| 全库 lint | 535 → 537 文件，错误 103 → 58，警告 122 → 121；逐条多重集对比新增 0，移除 46 条 | 仍未通过，剩余为既有诊断 |
| 完整生产包浏览器 | 原 8 组全部保留，加 JSON、讲义样例、YAML 三组，共 11 组通过；页面／控制台及脚本、样式、字体 HTTP 错误 0 | 通过 |
| 本地离线包 | Hydro 141 文件，UI 818 文件；8 份语言 YAML 正常；必需模板、完整生产脚本与资源均存在 | 通过 |
| WSL 运行环境 | Ubuntu-22.04 的 Docker hydro running／healthy，Node v22.16.0；启动时间仍为 2026-10-04T13:08:26.782816363Z，HTTP 8082 返回 200 | 只读核对通过 |
| 数据、版本与部署边界 | 无迁移或真实课程数据测试；版本、依赖与锁文件不变；隔离进程正常停止 | 已遵守 |

两项构建警告分别是 asset size limit 和 entrypoint size limit，涉及已有 Monaco、Mermaid、主题等资源。本轮没有关闭性能提示或扩大体积阈值。

首次完整回归在已有 App 初始化的 30 秒上限内未完成，清理引发数据库连接错误，未计为通过。随后同一系统临时目录、同一超时下独立 61 项通过（初始化 9.998 秒），最终完整 232 项通过。没有扩大超时或跳过检查；现有证据不足以把第一次失败只归因于磁盘或并发负载。

浏览器首轮 11 组交互断言通过，但最终错误检查捕获 Canceled，未计为通过。追踪定位到新增测试在有效 YAML 的异步校验尚未完成时销毁编辑器。测试改为确认错误标记已清零后清理，未过滤该异常；使用全新临时实例重跑后 11 组通过、错误 0。两轮实例的应用、两个临时 MongoDB 及临时 profile 均通过测试专用 loopback 停止入口正常清理。此入口仅在 test 脚本中。

## 课程文件与保留警告

分母为批准的原 10 个课程文件，再单独列出 2 个新内部模块和 1 个构建配置。没有使用全库自动修复，没有修改 lint 配置。逐条诊断内的行号归一化后，用文件、级别、规则、消息多重集比较，避免同总数掩盖新问题。

| 文件 | 起点错误 | 当前错误 | 当前警告 |
| --- | --- | --- | --- |
| `packages/hydrooj/src/builtin/course-management/handler/class.ts` | 2 | 0 | 21 |
| `packages/hydrooj/src/builtin/course-management/handler/course.ts` | 15 | 0 | 13 |
| `packages/hydrooj/src/builtin/course-management/index.ts` | 0 | 0 | 3 |
| `packages/hydrooj/src/builtin/course-management/model/course.ts` | 3 | 0 | 1 |
| `packages/hydrooj/src/handler/course-management.ts` | 0 | 0 | 1 |
| `packages/ui-default/backendlib/lecture-markdown.ts` | 3 | 0 | 0 |
| `packages/ui-default/components/highlighter/prismjs.js` | 2 | 0 | 0 |
| `packages/ui-default/pages/course_edit.page.ts` | 9 | 0 | 0 |
| `packages/ui-default/pages/course_lecture.page.ts` | 1 | 0 | 0 |
| `packages/ui-default/pages/domain_class_edit.page.ts` | 10 | 0 | 0 |
| `packages/ui-default/components/highlighter/sample-input.ts` | 新文件 | 0 | 0 |
| `packages/ui-default/components/monaco/disabled-format.ts` | 新文件 | 0 | 0 |
| `packages/ui-default/build/config/webpack.ts` | 0 | 0 | 1 |

以下 40 条均是起点已有警告。保留原因逐项列出；它们没有被降级、屏蔽或改成并发。

| 序号 | 文件与行 | 规则 | 保留原因 |
| --- | --- | --- | --- |
| 1 | `packages/hydrooj/src/builtin/course-management/handler/class.ts:1` | `simple-import-sort/imports` | 既有导入排序建议；本轮不扩大为导入整理，保持已验证初始化行为。 |
| 2 | `packages/hydrooj/src/builtin/course-management/handler/class.ts:165` | `max-len` | 既有行宽提示；不展开相邻文案、表达式或错误消息，避免无关差异。 |
| 3 | `packages/hydrooj/src/builtin/course-management/handler/class.ts:170` | `max-len` | 既有行宽提示；不展开相邻文案、表达式或错误消息，避免无关差异。 |
| 4 | `packages/hydrooj/src/builtin/course-management/handler/class.ts:185` | `max-len` | 既有行宽提示；不展开相邻文案、表达式或错误消息，避免无关差异。 |
| 5 | `packages/hydrooj/src/builtin/course-management/handler/class.ts:196` | `no-await-in-loop` | 逐层读取当前题目引用；下一层依赖上一层，不可并发。 |
| 6 | `packages/hydrooj/src/builtin/course-management/handler/class.ts:217` | `no-await-in-loop` | 按原题顺序解析来源、查目标引用并回退；保留确定的映射与首个错误顺序。 |
| 7 | `packages/hydrooj/src/builtin/course-management/handler/class.ts:220` | `no-await-in-loop` | 按原题顺序解析来源、查目标引用并回退；保留确定的映射与首个错误顺序。 |
| 8 | `packages/hydrooj/src/builtin/course-management/handler/class.ts:226` | `no-await-in-loop` | 按原题顺序解析来源、查目标引用并回退；保留确定的映射与首个错误顺序。 |
| 9 | `packages/hydrooj/src/builtin/course-management/handler/class.ts:256` | `no-await-in-loop` | 每道缺失题先授权再复制；保留串行编号分配和失败停止顺序。 |
| 10 | `packages/hydrooj/src/builtin/course-management/handler/class.ts:257` | `no-await-in-loop` | 每道缺失题先授权再复制；保留串行编号分配和失败停止顺序。 |
| 11 | `packages/hydrooj/src/builtin/course-management/handler/class.ts:775` | `no-await-in-loop` | 班级模板按顺序授权、解析、补题、创建并读取课程；后一个课时开始时间依赖前一项，不改成并发。 |
| 12 | `packages/hydrooj/src/builtin/course-management/handler/class.ts:782` | `no-await-in-loop` | 班级模板按顺序授权、解析、补题、创建并读取课程；后一个课时开始时间依赖前一项，不改成并发。 |
| 13 | `packages/hydrooj/src/builtin/course-management/handler/class.ts:786` | `no-await-in-loop` | 班级模板按顺序授权、解析、补题、创建并读取课程；后一个课时开始时间依赖前一项，不改成并发。 |
| 14 | `packages/hydrooj/src/builtin/course-management/handler/class.ts:788` | `no-await-in-loop` | 班级模板按顺序授权、解析、补题、创建并读取课程；后一个课时开始时间依赖前一项，不改成并发。 |
| 15 | `packages/hydrooj/src/builtin/course-management/handler/class.ts:790` | `no-await-in-loop` | 班级模板按顺序授权、解析、补题、创建并读取课程；后一个课时开始时间依赖前一项，不改成并发。 |
| 16 | `packages/hydrooj/src/builtin/course-management/handler/class.ts:792` | `no-await-in-loop` | 班级模板按顺序授权、解析、补题、创建并读取课程；后一个课时开始时间依赖前一项，不改成并发。 |
| 17 | `packages/hydrooj/src/builtin/course-management/handler/class.ts:793` | `no-await-in-loop` | 班级模板按顺序授权、解析、补题、创建并读取课程；后一个课时开始时间依赖前一项，不改成并发。 |
| 18 | `packages/hydrooj/src/builtin/course-management/handler/class.ts:796` | `max-len` | 既有行宽提示；不展开相邻文案、表达式或错误消息，避免无关差异。 |
| 19 | `packages/hydrooj/src/builtin/course-management/handler/class.ts:815` | `no-await-in-loop` | 班级模板按顺序授权、解析、补题、创建并读取课程；后一个课时开始时间依赖前一项，不改成并发。 |
| 20 | `packages/hydrooj/src/builtin/course-management/handler/class.ts:856` | `no-await-in-loop` | 班级模板按顺序授权、解析、补题、创建并读取课程；后一个课时开始时间依赖前一项，不改成并发。 |
| 21 | `packages/hydrooj/src/builtin/course-management/handler/class.ts:862` | `no-await-in-loop` | 班级模板按顺序授权、解析、补题、创建并读取课程；后一个课时开始时间依赖前一项，不改成并发。 |
| 22 | `packages/hydrooj/src/builtin/course-management/handler/course.ts:142` | `style/quotes` | 既有字符串引号样式；输出文案和本轮功能无关，留作独立样式整理。 |
| 23 | `packages/hydrooj/src/builtin/course-management/handler/course.ts:168` | `max-len` | 既有行宽提示；不展开相邻文案、表达式或错误消息，避免无关差异。 |
| 24 | `packages/hydrooj/src/builtin/course-management/handler/course.ts:201` | `style/quotes` | 既有字符串引号样式；输出文案和本轮功能无关，留作独立样式整理。 |
| 25 | `packages/hydrooj/src/builtin/course-management/handler/course.ts:209` | `style/quotes` | 既有字符串引号样式；输出文案和本轮功能无关，留作独立样式整理。 |
| 26 | `packages/hydrooj/src/builtin/course-management/handler/course.ts:218` | `style/quotes` | 既有字符串引号样式；输出文案和本轮功能无关，留作独立样式整理。 |
| 27 | `packages/hydrooj/src/builtin/course-management/handler/course.ts:255` | `style/quotes` | 既有字符串引号样式；输出文案和本轮功能无关，留作独立样式整理。 |
| 28 | `packages/hydrooj/src/builtin/course-management/handler/course.ts:258` | `style/quotes` | 既有字符串引号样式；输出文案和本轮功能无关，留作独立样式整理。 |
| 29 | `packages/hydrooj/src/builtin/course-management/handler/course.ts:328` | `no-await-in-loop` | 依次核验题目并收集规范 ID；保留原列表顺序和首个错误，不为样式警告改变执行语义。 |
| 30 | `packages/hydrooj/src/builtin/course-management/handler/course.ts:341` | `no-await-in-loop` | 依次核验题目并收集规范 ID；保留原列表顺序和首个错误，不为样式警告改变执行语义。 |
| 31 | `packages/hydrooj/src/builtin/course-management/handler/course.ts:543` | `github/array-foreach` | 既有同步集合遍历建议；本轮不重写未改变的集合处理。 |
| 32 | `packages/hydrooj/src/builtin/course-management/handler/course.ts:561` | `github/array-foreach` | 既有同步集合遍历建议；本轮不重写未改变的集合处理。 |
| 33 | `packages/hydrooj/src/builtin/course-management/handler/course.ts:1030` | `logical-assignment-operators` | 既有逻辑赋值写法建议；保留显式条件和赋值，避免无关控制流变化。 |
| 34 | `packages/hydrooj/src/builtin/course-management/handler/course.ts:1990` | `max-len` | 既有行宽提示；不展开相邻文案、表达式或错误消息，避免无关差异。 |
| 35 | `packages/hydrooj/src/builtin/course-management/index.ts:197` | `max-len` | 既有行宽提示；不展开相邻文案、表达式或错误消息，避免无关差异。 |
| 36 | `packages/hydrooj/src/builtin/course-management/index.ts:300` | `consistent-return` | 既有钩子按条件返回 cleanup 标记；无重定向时无返回，保留框架协议。 |
| 37 | `packages/hydrooj/src/builtin/course-management/index.ts:347` | `consistent-return` | 既有钩子按条件返回 cleanup 标记；无重定向时无返回，保留框架协议。 |
| 38 | `packages/hydrooj/src/builtin/course-management/model/course.ts:1` | `simple-import-sort/imports` | 既有导入排序建议；本轮不扩大为导入整理，保持已验证初始化行为。 |
| 39 | `packages/hydrooj/src/handler/course-management.ts:1` | `simple-import-sort/imports` | 既有导入排序建议；本轮不扩大为导入整理，保持已验证初始化行为。 |
| 40 | `packages/ui-default/build/config/webpack.ts:144` | `style/quote-props` | 构建配置中 rupture 的既有属性引号；与 YAML 兼容无关，不扩大改动。 |

## 其他模块独立台账

分母为本次全库检查中课程范围以外有诊断的 21 个文件，共 58 错误、81 警告。它们与起点逐条相符，本轮未修改；不能将课程范围归零写成全库门禁通过。完整规则、消息及行列见 [诊断证据](assets/course-engineering-2026-10-06/lint-details.json)。后续需按各模块的业务风险单独确定修复范围。

| 文件 | 错误 | 警告 |
| --- | --- | --- |
| `framework/framework/server.ts` | 3 | 0 |
| `packages/ai-assistant/index.ts` | 9 | 9 |
| `packages/hydrooj/bin/hydro-maintenance.js` | 0 | 13 |
| `packages/hydrooj/src/builtin/contest-homework-stats/index.ts` | 1 | 1 |
| `packages/hydrooj/src/builtin/userlist/handler/bulkimport.ts` | 2 | 9 |
| `packages/hydrooj/src/builtin/userlist/handler/import.ts` | 6 | 12 |
| `packages/hydrooj/src/builtin/userlist/handler/user.ts` | 2 | 13 |
| `packages/hydrooj/src/builtin/userlist/index.ts` | 2 | 2 |
| `packages/hydrooj/src/handler/problem.ts` | 0 | 2 |
| `packages/hydrooj/src/handler/userlist.ts` | 0 | 1 |
| `packages/hydrooj/src/lib/rating-v2/calibration.ts` | 4 | 0 |
| `packages/hydrooj/src/script/rating-v2-audit.ts` | 0 | 5 |
| `packages/hydrooj/src/service/server.ts` | 0 | 1 |
| `packages/hydrooj/src/settings.ts` | 1 | 0 |
| `packages/migrate/exam.ts` | 2 | 0 |
| `packages/migrate/index.ts` | 1 | 0 |
| `packages/sonic/index.ts` | 1 | 1 |
| `packages/ui-default/components/scratchpad/ScratchpadToolbarContainer.jsx` | 0 | 1 |
| `packages/ui-default/components/scratchpad/capabilities.ts` | 2 | 0 |
| `packages/url-audit/index.ts` | 6 | 0 |
| `packages/xxwl-review/index.ts` | 16 | 11 |

## 可复现入口与证据

已有锁定依赖的 Windows 工作树中，本次使用系统 TEMP／TMP，临时 MongoDB 使用既有缓存二进制；不连接运行容器的数据库：

```powershell
$env:CI = 'true'
Remove-Item Env:SENTRY_AUTH_TOKEN -ErrorAction SilentlyContinue
$env:MONGOMS_SYSTEM_BINARY = (Resolve-Path .cache/mongodb-binaries/mongod-x64-win32-8.2.1.exe).Path
$env:NODE_OPTIONS = '--max-old-space-size=8192 --require=' + (Resolve-Path test/classroom-feedback-test-isolate.cjs).Path
node node_modules/typescript/bin/tsc -b --pretty false
corepack yarn test
node packages/ui-default/build --production --detail
node node_modules/eslint/bin/eslint.js packages plugins modules framework --ext .ts,.tsx,.jsx,.vue,.yaml,.yml --max-warnings=0 --format json --output-file .cache/feedback-e2-full-lint.json
```

最后一条预期退出 1，因为全库既有诊断仍未清零。不能改变检查规则使它通过。独立解析／构建检查为 `node --test test/course-text-parsing.spec.js test/ui-build-regressions.spec.js`（12 项通过），旧正则可终止复现为 `node test/reproduce-course-text-regressions.cjs`，默认读取本轮起点。

完整包入口为 `node test/prepare-feedback-package-check.cjs`。只在临时副本中转换 workspace 引用并离线打包、解包，不访问注册表或安装包。使用输出的 HYDRO_FEEDBACK_PACKAGE_ROOT，清除上述 NODE_OPTIONS 的隔离 profile 预加载（浏览器脚本自建 profile），运行 `node test/classroom-feedback-browser.js --built-ui`。按照 FEEDBACK_PREVIEW_URL 执行 `node test/classroom-feedback-browser.spec.js <URL>`，设置本机已有 Playwright 的 HYDRO_PLAYWRIGHT_MODULE 和截图目录 HYDRO_FEEDBACK_BROWSER_OUTPUT。完成后向同一 loopback 实例的 /feedback-preview-stop POST 空 JSON，应用正常退出并清理两个临时数据库；运行容器不参与这些操作。

包内生产资源由已验证源码构建，构建发生在提交前；页脚的 git 标记为 c2ef770-dirty。验证复用工作树已有依赖，不替代私有注册表安装到目标容器的验收。生产包及截图 SHA-256、11 组检查名称、全部 lint 对比数据与日志摘要见 [实测摘要](assets/course-engineering-2026-10-06/validation.json) 和诊断证据。

截图：[课程 JSON 页面内错误与定位](assets/course-engineering-2026-10-06/course-edit-invalid.png)、[讲义与样例](assets/course-engineering-2026-10-06/course-lecture.png)、[A 名单](assets/course-engineering-2026-10-06/a-roster.png)、[B 进度](assets/course-engineering-2026-10-06/b-progress.png)、[待复测](assets/course-engineering-2026-10-06/pending-retest.png)、[课程管理](assets/course-engineering-2026-10-06/course-manage.png)、[窄屏](assets/course-engineering-2026-10-06/mobile.png)。JSON 和讲义截图已人工目视核对。

## 后续边界

E2 课程范围完成；其他模块 58 错误和课程范围外 81 警告未处理。E3 材料条件已移出本轮，模拟集训另行设计。E4 目标容器安装、真实班级及机构备份恢复需另行授权，本轮不执行。AI-EDU 消费端仍是独立后续任务，不能成为 Hydro 录入和查询的依赖。
