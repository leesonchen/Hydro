# 监控模式代码评审与源码自测（2026-10-14）

后续修复及复测结果见 [fix-report.md](fix-report.md)；以下为修复前评审记录。

范围：`5b5072c9` 相对 `696b984d`，PR #21 的 17 个文件。结论：有两个 P1 功能缺陷，建议修复后再验收。本轮仅评审和测试，未修改业务代码、发布包或升级现有 Hydro。

## 评审发现

### P1：离页保存会用隐藏基础编辑器的旧值覆盖高级编辑器草稿

位置：`packages/ui-default/templates/problem_detail.html:249`，关联 `packages/ui-default/pages/problem_detail.page.tsx:212`。

基础编辑器无条件注册 `pagehide → save`，其 textarea 在 Monaco 启动后仍保留原值。高级编辑器的 150ms debounce 已保存新代码后，刷新、切题或切回基础模式时，基础编辑器先把旧值写到相同 localStorage 键；随后高级编辑器的 `flush()` 没有待执行任务，不会重新保存。重新打开时优先读取 localStorage，忽略 IDB 的新草稿。

真实 Chrome 复现：基础草稿为 `int main() { return 42; }`，高级编辑器改为 `int main(){return 99;}`，等待 800ms 后切回基础模式，恢复出的代码仍是前者。另用原模板脚本和实际 lodash debounce 的 VM 复现了空字符串覆盖。

建议：明确当前活动编辑器的保存责任；隐藏基础编辑器不再保存旧值，同时在离页时同步保存高级编辑器的当前状态。补充跨编辑器整页导航和刷新回归。

### P1：Monaco 粘贴命令绕过外部剪贴板校验

位置：`packages/ui-default/templates/partials/contest_monitor_client.html:282`。

新增拦截只监听 DOM 键盘、`paste` 和 `beforeinput` 等事件。Monaco 内置 `editor.action.clipboardPasteAction` 在原生 `execCommand('paste')` 不成功时，使用 clipboard service 读取系统剪贴板，再直接调用编辑器的 paste handler。此路径没有触发 DOM paste，未经过 `internalClipboard` 校验。

真实 Chrome、localhost 安全上下文、已允许剪贴板读取：将系统剪贴板设为 `EXTERNAL_FROM_OS_CLIPBOARD`，聚焦 Monaco 并执行上述内置命令；代码从空串变成该外部文本，DOM paste 次数为 0。依赖路径为 `node_modules/monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard.js:200`。本次通过编辑器命令驱动验证；实际右键点击尝试未可靠打开菜单，不计为通过的 UI 场景。

建议：在监控模式下让 Monaco 的粘贴命令也执行相同来源策略，或禁用这个绕过原生事件的入口；不能只依赖 DOM 事件拦截。补测命令面板、右键菜单和快捷键。

### P2：变更文件未通过 ESLint 门禁

对本提交变更的 TS/TSX 文件执行 `eslint --max-warnings=0`，返回 6 个错误、9 个警告。错误位于 `ScratchpadEditorContainer.tsx:252` 的 JSX 字符串括号，以及 `problem_detail.page.tsx:36`、`:37`、`:38`、`:304`、`:307` 的单行语句数。另有缩进、引号和字符串拼接警告。未运行自动修复。

## 验证结果

- `node --test --test-reporter=spec test/contest-assessment-monitor.spec.js test/monitored-exam-restrictions.spec.js`：58/58 通过，使用临时 MongoDB。沙箱内首跑提前退出，允许本地端口后重跑通过。
- `yarn build`：通过。
- `yarn build:ui:production`：通过；仅缺少 Sentry token 的上传提示，无编译失败。
- 变更文件 ESLint：失败，见上。
- Chrome 使用最新源码、刚构建的完整 UI、临时用户/域及临时 MongoDB；不使用现有部署作为最新源码验证结果。
- 基础编辑器真实 HTML 渲染、个人模板隔离、基础草稿刷新恢复、外部 paste 事件拦截、返回提醒与确认、旧提交页重定向、学生读取监考记录被拒、Monaco 初始化、老师读取监控事件均通过。
- HTTP 普通代码提交成功；本地文件上传和预评测文件上传均由服务端以 403 和明确的监控模式提示拒绝。
- 模拟缺少 RegExp `d` 标志支持时，React textarea 降级可编辑，输入同步到 store。
- 高级草稿跨页保存和 Monaco 外部剪贴板命令路径失败，见 P1。

## 验证边界与证据

未执行完整 `yarn test`、全仓 `lint:ci`、真实旧版 Chrome/Edge、操作系统切窗或真实全屏生命周期验收；焦点提醒在 Chrome 中用浏览器焦点设置及页面 blur/focus 事件验证。未接入判题服务验证评测结果。高级编辑器整体模块彻底加载失败和真实浏览器跨题剪贴板交互仍需补测，不能用静态断言代替。

本地完整产物（Git 已忽略）：`doc/test/.local/2026-10-14-monitor-review/`。

- `runtime.cjs` / `runtime.log`：隔离源码服务与临时数据夹具。
- `browser.cjs` / `browser-results.json` / `browser.log`：浏览器与 HTTP 用例；不可靠的菜单点击检查已标记 superseded。
- `clipboard-command.cjs` / `clipboard-command-result.json` / `monaco-external-paste.png`：独立剪贴板命令复现。
- `repro-draft-pagehide.cjs` / `repro-draft-pagehide-result.json`：原模板脚本的草稿覆盖复现。
- `basic-editor.png` / `react-textarea-fallback.png`：基础与降级编辑器截图。

隔离服务结束后停止，临时数据库与服务 profile 随之清理。现有 Docker 容器未升级或重启。
