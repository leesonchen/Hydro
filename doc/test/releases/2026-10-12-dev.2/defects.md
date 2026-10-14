# 普通课程编辑误判为模板

原测试版本：Hydro `5.0.7-dev.2` / UI `4.58.5-dev.2`。UI `4.58.5-dev.4` 已修复，见[修复与 13 项浏览器回归报告](../../fixes/2026-10-12-course-template/system-test-report.md)。

复现：打开普通课程编辑页，班级分配原为空，直接点击普通 Update。前端将分配误填为 `teachers`，后端返回 400「不能分配课程给 teachers 组」。

页面含“另存为模板”按钮 `button[name="isTemplate"]`。前端用同名元素是否存在来判断当前是否为模板；普通 Update 并未提交模板操作，但初始化已改写班级分配。后端拒绝普通课程分配到 teachers 的校验符合预期。

原对照发布包的编译 bundle、模板及后端均存在该链路，因此这是此前已存在的问题。历史包清单、哈希与截图保存在本地归档；源码回归以 [course-template-state.spec.js](../../../../test/course-template-state.spec.js) 为入口。

修复使用模板编辑页专用隐藏标记识别状态。后续验证应覆盖普通保存不改变模板状态和分配、显式另存为模板创建独立模板、已有模板 Update 保留分类，以及班级复制测评实例隔离。
