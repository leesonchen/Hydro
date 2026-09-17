# 代码评审报告：班级公开成绩榜与多次提交罚分配置

- **评审日期**：2026-09-17
- **评审分支**：`course-v2.1`
- **提交评审范围**：工作区未提交变更（共 3 个文件）
  - [`packages/hydrooj/src/builtin/course-management/model/class.ts`](file:///home/leeson/Hydro/packages/hydrooj/src/builtin/course-management/model/class.ts)
  - [`packages/hydrooj/src/builtin/course-management/handler/class.ts`](file:///home/leeson/Hydro/packages/hydrooj/src/builtin/course-management/handler/class.ts)
  - [`packages/ui-default/templates/domain_class_edit.html`](file:///home/leeson/Hydro/packages/ui-default/templates/domain_class_edit.html)

---

## 1. 变更背景与意图

本组变更旨在为 **班级管理（Course Management）** 补充班级维度的两项关键比赛/课程配置：
1. **公开成绩榜（`publicScoreboard`）**：控制学生端是否可以查阅课程成绩榜；
2. **多次提交罚分（`enablePenalty`）**：控制 IOI 规则课程在多次提交未通过时是否计算罚分。

变更贯穿了**数据模型层（Model）**、**控制器处理层（Handler）**以及**前端模板展示与表单提交层（Template）**，并在班级批量复制课程（`postCopy`）时将这两个配置下发到新创建的课程文档中。

---

## 2. 变更内容与实现质量评估

### 2.1 数据模型层 (`model/class.ts`)
- **接口扩展**：`ClassGDoc` 接口新增可选属性 `publicScoreboard?: boolean` 与 `enablePenalty?: boolean`。
- **默认值与容错**：
  - `listGroup` 中对于 uid 虚拟班级补充了 `publicScoreboard: true` 与 `enablePenalty: true`，避免了空值异常。
  - `updateGroup` 入参增加了 `publicScoreboard = true` 与 `enablePenalty = true` 并写入 `$set`，逻辑清晰。

### 2.2 控制器层 (`handler/class.ts`)
- **GET 数据注入**：
  - 读取已有班级时采用 `extra.gdoc ? extra.gdoc.publicScoreboard !== false : true`，确保历史存量数据平滑向后兼容，默认保持开启。
- **POST 更新接收**：
  - `@param` 装饰器顺序与参数签名列表完全对应，满足框架反射要求。
- **批量复制课程 (`postCopy`)**：
  - 新建课程时从班级文档提取 `classPublicScoreboard` 和 `classEnablePenalty` 并传入 `ContestModel.add`。
  - 保留并扩展了后续的显式 `ContestModel.edit`，有效防止 Hook 或插件覆盖相关配置。

### 2.3 前端模板层 (`domain_class_edit.html`)
- **表单未勾选提交机制**：
  - 每个复选框前置了同名 `<input type="hidden" name="..." value="false">`，解决了原生 HTML 表单中 Checkbox 未勾选时不提交参数导致触发后端默认值（`true`）的经典问题。
  - 与已有的 `course_edit.html` 保持了一致的实现规范。
- **国际化**：
  - 使用了 `{{ _('Public Scoreboard') }}` 和 `{{ _('Enable Penalty') }}`，两项词条均已在 `builtin/course-management/index.ts` 中注册并支持中英文。

---

## 3. 核心问题与潜在隐患清单

### 🔴 缺陷 1【P1 业务语义/数据一致性】：编辑班级时未向已有课程同步配置

- **受影响文件**：[`packages/hydrooj/src/builtin/course-management/handler/class.ts#L650-L674`](file:///home/leeson/Hydro/packages/hydrooj/src/builtin/course-management/handler/class.ts#L650-L674)
- **问题说明**：
  在 `postUpdate` 中，当管理员或教师修改班级并保存时：
  1. 班级文档本身的 `publicScoreboard` 和 `enablePenalty` 被成功持久化；
  2. 但班级下**已存在的关联课程（`tdocs`）**并不会被更新这两项配置（代码中仅更新了 `maintainer` 和时间范围）。
  3. 只有此后在班级中**新增（复制）**的课程才会应用班级的新配置。
- **故障场景**：
  教师在班级编辑页面将“公开成绩”取消勾选并保存，教师预期该班级下所有课程的成绩榜均对学生隐藏。但由于旧课程属性未变，学生依然可以在旧课程详情页正常查阅成绩榜，造成权限与配置的预期割裂。
- **修改建议**：
  - **若需要级联同步**：在更新关联课程的 `editIfAssigned` 中带上新配置：
    ```typescript
    await Promise.all(tdocs.map((t) => ContestModel.editIfAssigned(domainId, t._id, name, {
        publicScoreboard,
        enablePenalty,
        maintainer: mergedTeachers,
    })));
    ```
  - **若仅作为后续课程的默认模板**：建议在前端模板对应勾选框后方添加明确说明（例如：“仅对后续新增课程生效”），避免用户困惑。

---

### 🟡 隐患 2【P2 框架交互边界】：API 直接发送 JSON `false` 时存在默认值覆盖风险

- **受影响文件**：[`packages/hydrooj/src/builtin/course-management/handler/class.ts#L482-L499`](file:///home/leeson/Hydro/packages/hydrooj/src/builtin/course-management/handler/class.ts#L482-L499)
- **机制分析**：
  - 当前基于表单（`application/x-www-form-urlencoded`）提交时，传输值为字符串 `"false"`，属于 truthy 值，因此能正常触发 `Types.Boolean` 的类型转换函数并输出 `false`。
  - 但若外部通过 API 或单元测试以 JSON 格式（`application/json`）向 `postUpdate` 发送 `{ publicScoreboard: false }`：
    框架 `decorators.ts` 的参数校验判断为 `if (!item.isOptional || value)`。由于 `Types.Boolean` 默认 `isOptional = true`，当 `value === false` 时该判断为 `false`，导致参数被置为 `undefined` 并推入参数栈，最终触发了函数签名的默认参数 `publicScoreboard = true`。
- **修改建议**：
  在编写自动化单元测试或提供外部调用时，需注意传参形式（通过表单编码传 `"false"`），或建议未来在框架层优化 `decorators.ts` 对 boolean `false` 与 numeric `0` 的处理。

---

### 🟡 缺陷 3【P3 代码规范】：循环中缺少 ESLint 禁用注释

- **受影响文件**：[`packages/hydrooj/src/builtin/course-management/handler/class.ts#L835`](file:///home/leeson/Hydro/packages/hydrooj/src/builtin/course-management/handler/class.ts#L835)
- **问题说明**：
  运行 ESLint 静态代码检查时产生告警：
  ```text
  835:17  warning  Unexpected `await` inside a loop  no-await-in-loop
  ```
  在 `postCopy` 中，`await ContestModel.edit(...)` 位于 `for (const templateValue of templateIds)` 循环体内。由于课程排期（`nextBaseBeginAt`）和防并发锁刷新依赖串行执行，串行是正确的设计，但需要对该行添加规范的 ESLint 忽略注释。
- **修改建议**：
  ```typescript
  // eslint-disable-next-line no-await-in-loop
  await ContestModel.edit(domainId, newTid, {
      publicScoreboard: classPublicScoreboard,
      enablePenalty: classEnablePenalty,
      ...(Object.keys(newLecture).length || Object.keys(newLectureMeta).length ? {
          lecture: newLecture,
          lectureMeta: newLectureMeta,
      } : {}),
  });
  ```

---

### 🟢 建议 4【P4 可维护性】：`ClassModel.updateGroup` 位置参数重构建议

- **受影响文件**：[`packages/hydrooj/src/builtin/course-management/model/class.ts#L133-L148`](file:///home/leeson/Hydro/packages/hydrooj/src/builtin/course-management/model/class.ts#L133-L148)
- **问题说明**：
  `updateGroup` 方法目前已有 14 个位置参数，且后半部分混合了可选参数（`id?`、`expectedName?`、`editToken?`）与带默认值的参数（`archive = false`、`publicScoreboard = true`、`enablePenalty = true`）。
- **修改建议**：
  位置参数过长在未来维护和新增字段时极易因传参顺序错误产生隐蔽 bug。建议后续版本中考虑重构为结构化参数对象（`ClassUpdateOptions`）。

---

## 4. 评审结论与后续行动建议

| 评审维度 | 状态 | 评估与说明 |
| :--- | :---: | :--- |
| **功能实现** | ✅ 通过 | 班级与课程维度的配置流转打通，默认值与存量兼容妥当 |
| **类型检查** | ✅ 通过 | `tsc --noEmit` 0 错误 |
| **代码规范** | ⚠️ 存在轻微告警 | 存在 1 处循环内 `await` 告警，建议添加注释消除 |
| **产品确认** | 💡 需决策确认 | 请产品/研发团队确认：**修改班级配置时是否需要级联同步给已有历史课程** |
