# 独立缺陷诊断：普通课程编辑误判为模板

**状态：** 目标版本为已发布 `hydrooj 5.0.7-dev.2` / UI `4.58.5-dev.2`。保留的浏览器证据包括校准阶段截图 [COUR-01.png](evidence/attempts/02-browser-fixture-calibration/screenshots/COUR-01.png) 和最终截图 [COUR-01.png](evidence/screenshots/COUR-01.png)：普通课程编辑保存时返回 400，提示不能分配给 `teachers`。此文件保留原版本诊断，并在末尾链接后续修复与浏览器回归报告。

## 诊断

普通课程编辑页同时包含“保存为模板”按钮。该按钮以 `name="isTemplate"` 标记，但只有点击它提交时才代表将本次操作保存为模板。模板和普通编辑页在 previous、current 两个 UI 包的 `templates/course_edit.html` 中都具有这个按钮。

两个发布版的编译 bundle 都包含相同的前端判断：查询 ``$('[name="isTemplate"]')`` 后以元素是否存在作为 `isTemplate`，而不是读取本次提交的按钮值。普通编辑页上该按钮也存在，所以初始化赋班级控件时会把空的 `assign` 填成 `teachers`。普通“Update”提交不带 `isTemplate=true`，后端于是按普通课程处理；previous 与 current 的 `hydrooj/src/builtin/course-management/handler/course.ts` 都拒绝 `!isTemplate && assign.includes('teachers')`，最终返回 400。

## 归因

**这是 previous 发布版已存在的问题，不是 dev.2 引入的回归。** previous 编译包 `@hydrooj/ui-default/public/default-api_ts.a6362b.chunk.js` 已含同一 `[name="isTemplate"]` 存在性判断和 `assign` 设为 `teachers` 的逻辑；previous `course_edit.html` 已有普通编辑页的“Save as Template”按钮；previous 后端也已有上述 400 防护。current bundle、模板和后端保留相同逻辑。

包内 SHA-256 可在 [release-comparison.json](evidence/release-comparison.json) 对应 `files` 清单核对：previous UI bundle `33a5dd48129dba2e22710d49ff02c814a2944e68e503dbd1ac69ef166a416b1e`、current UI bundle `9b69c6b8bdec8a95b967cbcfb10252b78b801692a697b16a8688a5d8a3e0f94a`；previous/current `templates/course_edit.html` 分别为 `a7300ea0d0ba78f7656d3021a4d6577ac87bd4ea4551cb28886acc07904a3a9d` / `b56ee4a2778eb10cfdc74527ca2679976d37a54a0f0fa9a323e3501133095e11`；previous/current 后端 `course.ts` 分别为 `81446bf45d80d66423c77834f5df0d57a4e6838f096c45f3541be8c368914b4a` / `2e84a352956ea3db144cc98fcd2a908e46000443be6781b9a537a337e15834e2`。已对两个发布目录中的对应 default-api bundle 做只读 Node 检索，命中逻辑一致；并逐个读取 bundle、模板和后端文件计算 SHA-256，结果与 inventory JSON 中的值一致。bundle 哈希不同是整包差异，不能单凭哈希推断该代码段不同。

`pages/course_edit.page.ts` 的可读源码也呈现相同判断，但 UI 包清单没有该 `pages/` 源文件；历史归因采用 previous 发布 bundle 本身的检索结果，不依赖当前工作树源码推断。

## 建议修复方向

模板与普通课程应由本次明确提交的操作决定，而不是由页面上是否存在某个按钮决定。前端可读取实际 submitter 的 `name/value`，或让模板操作提交独立、无歧义的标记；普通 Update 不应因 Save as Template 按钮存在而把 `assign` 改为 `teachers`。保持后端拒绝普通课程分配到 `teachers` 的校验，避免把前端误判转成持久数据问题。

验证建议：普通编辑页加载后确认空分配仍为空，普通 Update 成功且不会变成模板；明确点击 Save as Template 时才创建模板；已是模板的编辑仍正确回显模板类别并可保存。以上是建议用例，不代表已经执行。

## 后续修复验证

已在 UI `4.58.5-dev.4` 修复模板状态误判，并完成 13 项相关浏览器回归；见 [修复报告](../../fixes/2026-10-12-course-template/system-test-report.md)。本文件中的 dev.2 失败及前一版归因保留为原发布证据。
