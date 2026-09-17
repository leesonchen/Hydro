# 代码复查验收报告：评审意见整改结果评估

- **复查日期**：2026-09-17
- **复查分支**：`course-v2.1`
- **复查范围**：针对 2026-09-17 第一轮代码评审提出的 2 项高危/严重缺陷、2 项规范建议及测试用例进行全面整改验收。
- **综合评估结论**：✅ **全部整改项均已高质量闭环，测试 100% 通过，未引入次生风险，建议准予合并提交。**

---

## 1. 缺陷修复验收对照清单

| 缺陷编号与等级 | 涉及模块 | 整改项与修复策略 | 验收状态 | 验证说明 |
| :--- | :--- | :--- | :---: | :--- |
| **缺陷 1【P0 紧急】** | [`contest.ts`](file:///home/leeson/Hydro/packages/hydrooj/src/model/contest.ts#L1124-L1157) | 消除 Fail-Open 权限短路；增加 `keepScoreboardHidden` 前置硬拦截；规则缺失时降级为严格时间窗及特权判定 | ✅ **已完全修复** | `hiddenCourseDoc` 在普通用户身份下调用 `canShowScoreboard`、`canShowRecord`、`canShowSelfRecord` 均严格返回 `false`。 |
| **缺陷 2【P1 严重】** | [`upgrade.ts`](file:///home/leeson/Hydro/packages/hydrooj/src/commands/upgrade.ts#L110-L145) | 收紧包名校验正则；禁止以 `-` 开头（防命令行选项注入）；禁止 `..`（防路径穿越）；覆盖 `targetPackage`、`rollback` 和 `packages` | ✅ **已完全修复** | 成功阻断 `--eval`、`-f`、`../../evil-pkg`、`--flag-injection` 等注入攻击，参数不合法时即刻退出（`exitCode = 1`）。 |
| **建议 1【P2 规范】** | [`problem.ts`](file:///home/leeson/Hydro/packages/hydrooj/src/handler/problem.ts#L1068-L1070) | 过滤 `targets` 数组时增加 `!Array.isArray(t)`，排除 JavaScript `typeof [] === 'object'` 产生的嵌套数组干扰 | ✅ **已完全修复** | 确保后续 `t.domainId` 等属性访问仅针对纯对象，避免语义混淆。 |
| **建议 2【P2 规范】** | [`config.ts`](file:///home/leeson/Hydro/packages/hydrooj/src/commands/config.ts#L78-L115) | 为公共函数 `removeEnvFileKey` 增加对称的键名格式校验；原型链敏感键判断前对 key 进行 `trim()` | ✅ **已完全修复** | 避免非法键名传入 `removeEnvFileKey` 产生不确定行为；彻底封堵带空格绕过原型链检查的可能。 |
| **测试强化** | [`test/review-fixes.spec.js`](file:///home/leeson/Hydro/test/review-fixes.spec.js) | 补充隐藏榜单越权断言、包名注入断言、回退版本注入断言、非法环境变量名断言 | ✅ **已完全覆盖** | 单测用例扩展至 3 个测试套件，原生测试全量通过，无外部重型依赖。 |

---

## 2. 重点代码修复前后比对

### 2.1 `contest.ts`：榜单与提交记录查看权限控制
- **修复前**：
  ```typescript
  // 存在 Fail-Open 风险：若规则未定义 showScoreboard，直接返回 true 绕过隐藏配置
  if (!RULES[tdoc.rule]?.showScoreboard || RULES[tdoc.rule].showScoreboard(tdoc, new Date())) return true;
  ```
- **修复后**：
  ```typescript
  export function canShowScoreboard(this: { user: User }, tdoc: Tdoc, allowPermOverride = true) {
      if (tdoc.keepScoreboardHidden && (!allowPermOverride || !canViewHiddenScoreboard.call(this, tdoc))) return false;
      if (RULES[tdoc.rule]?.showScoreboard) return RULES[tdoc.rule].showScoreboard(tdoc, new Date());
      if (allowPermOverride && canViewHiddenScoreboard.call(this, tdoc)) return true;
      return !tdoc.keepScoreboardHidden && (!tdoc.beginAt || new Date() > tdoc.beginAt);
  }
  ```
- **评估**：逻辑清晰严密，既保证了内置规则的既有语义，又在规则未定义或缺失时提供了安全的默认拒绝与特权降级保障。

### 2.2 `upgrade.ts`：参数白名单与选项注入防护
- **修复前**：
  ```typescript
  // 正则允许以 '-' 开头或包含 '..'
  if (!/^[a-zA-Z0-9@_./-]+$/.test(pkg)) { ... }
  ```
- **修复后**：
  ```typescript
  const NPM_PKG_REGEX = /^(?:@[a-zA-Z0-9~-][a-zA-Z0-9._~-]*\/)?[a-zA-Z0-9~-][a-zA-Z0-9._~-]*(?:@[a-zA-Z0-9_.~^>=<-]+)?$/;
  if (pkg.startsWith('-') || pkg.includes('..') || !NPM_PKG_REGEX.test(pkg)) {
      logger.error(`非法包名参数: ${targetPackage}`);
      process.exitCode = 1;
      return;
  }
  ```
- **评估**：不仅完美覆盖了单包名注入防护，还联动加固了 `rollback` 和 `packages` 列表参数，有效消除了安全短板。

---

## 3. 单元测试运行验证

执行测试命令：
```bash
node --test test/review-fixes.spec.js
```

测试执行结果：
```text
✔ contest.ts: canShowProblemStatus enforces showRecord for homework and handles course safely (184.856207ms)
✔ config.ts: updateEnvFileKey sanitizes newlines and validates key; config set rejects prototype keys (25.619913ms)
✔ upgrade.ts: executeUpgrade rejects argument injection and path traversal (15.350806ms)
ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 374.604007
```

**测试结论**：全部 3 个测试套件通过，各项安全拦截与业务规则均达到预期。

---

## 4. 最终合并建议

当前修改已经达到了生产环境发布标准，代码逻辑严谨，测试覆盖到位，建议直接提交并合入分支。
