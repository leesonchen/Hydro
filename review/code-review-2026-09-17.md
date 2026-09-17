# 代码评审报告：未提交变更与安全性评估

- **评审日期**：2026-09-17
- **评审分支**：`course-v2.1`
- **提交评审范围**：工作区与暂存区所有未提交变更文件（4 个修改文件，1 个新增测试文件）

---

## 1. 评审范围与文件清单

### 本地未提交变更
- [`packages/hydrooj/src/model/contest.ts`](file:///home/leeson/Hydro/packages/hydrooj/src/model/contest.ts)：针对 `RULES[tdoc.rule]` 增加可选链操作符（`?.`），用于兼容未注册规则（如 `course`）时的调用，防止未定义属性异常。
- [`packages/hydrooj/src/commands/upgrade.ts`](file:///home/leeson/Hydro/packages/hydrooj/src/commands/upgrade.ts)：捕获更新脚本 `chmodSync` 异常并添加警告提示；为 `targetPackage` 增加字符集校验正则；记录环境变量指定脚本的使用日志。
- [`packages/hydrooj/src/commands/config.ts`](file:///home/leeson/Hydro/packages/hydrooj/src/commands/config.ts)：`updateEnvFileKey` 增加键名合法性校验与换行符（CRLF）清洗；`config` CLI 命令增加原型链敏感键名黑名单拦截（`__proto__`、`constructor`、`prototype`）。
- [`packages/hydrooj/src/handler/problem.ts`](file:///home/leeson/Hydro/packages/hydrooj/src/handler/problem.ts)：`ProblemFilesHandler.postSyncCopiedProblems` 对传入的 `targets` 数组进行最大 100 项切片截断与类型清洗。
- [`test/review-fixes.spec.js`](file:///home/leeson/Hydro/test/review-fixes.spec.js)：新增 Node.js 原生测试用例，覆盖 `contest.ts` 的规则访问容错及 `config.ts` 的安全防护。

---

## 2. 核心风险与缺陷详情

### 缺陷 1【P0 紧急安全漏洞】：`contest.ts` 权限判断逻辑发生“默认放行 (Fail-Open)”，导致隐藏榜单限制被直接穿透

- **受影响文件**：[`packages/hydrooj/src/model/contest.ts#L1124-L1157`](file:///home/leeson/Hydro/packages/hydrooj/src/model/contest.ts#L1124-L1157)
- **代码片段**：
  ```typescript
  export function canShowRecord(this: { user: User }, tdoc: Tdoc, allowPermOverride = true) {
      if (!canAccessContestResults(this.user, tdoc, allowPermOverride)) return false;
      if (!RULES[tdoc.rule]?.showRecord || RULES[tdoc.rule].showRecord(tdoc, new Date())) return true;
      if (allowPermOverride && canViewHiddenScoreboard.call(this, tdoc)) return true;
      return false;
  }

  export function canShowSelfRecord(this: { user: User }, tdoc: Tdoc, allowPermOverride = true) {
      if (!canAccessContestResults(this.user, tdoc, allowPermOverride)) return false;
      if (!RULES[tdoc.rule]?.showSelfRecord || RULES[tdoc.rule].showSelfRecord(tdoc, new Date())) return true;
      if (allowPermOverride && canViewHiddenScoreboard.call(this, tdoc)) return true;
      return false;
  }

  export function canShowScoreboard(this: { user: User }, tdoc: Tdoc, allowPermOverride = true) {
      if (!RULES[tdoc.rule]?.showScoreboard || RULES[tdoc.rule].showScoreboard(tdoc, new Date())) return true;
      if (allowPermOverride && canViewHiddenScoreboard.call(this, tdoc)) return true;
      return false;
  }
  ```

- **隐患机制与故障场景**：
  1. **Fail-Open 设计隐患**：在内置比赛规则（如 `oi`, `strictioi`, `ledo`）中，排行榜与提交记录的开放条件由规则函数自行校验，其中包含了 `!tdoc.keepScoreboardHidden`（非隐藏）和时间判断（如已结束 `now > tdoc.endAt`）。
  2. 当 `tdoc.rule` 为 `'course'` 且插件未提前将规则注入到 `RULES`、或对于任何未显式实现 `showScoreboard` / `showRecord` 的扩展规则时，`RULES[tdoc.rule]?.showScoreboard` 的值为 `undefined`。
  3. 取反后：`!RULES[tdoc.rule]?.showScoreboard` 直接求值为 **`true`**，导致 `if` 条件立即命中并无条件执行 `return true`。
  4. **权限完全穿透**：即使比赛/课程在数据库中明确配置了 `keepScoreboardHidden: true`，且当前登录用户为普通学生（无任何查看隐藏榜单的权限），`canShowScoreboard` 依然会直接返回 `true`！
  5. **前后端表现割裂**：在 `canShowProblemStatus` 中，未登录用户（`user === null`）会被 `!tdoc.keepScoreboardHidden` 拦截（不可见），而普通登录用户反而因为调用了 `canShowRecord` 触发了此缺陷被直接放行（可见），造成严重的越权信息泄漏。

- **修改建议**：
  - 权限判定必须遵循**默认拒绝（Fail-Closed）**原则，显式前置检查 `keepScoreboardHidden`：
  ```typescript
  export function canShowScoreboard(this: { user: User }, tdoc: Tdoc, allowPermOverride = true) {
      // 1. 若配置了隐藏榜单，非特权用户无条件拦截
      if (tdoc.keepScoreboardHidden && (!allowPermOverride || !canViewHiddenScoreboard.call(this, tdoc))) {
          return false;
      }
      // 2. 若规则已实现，由规则决定（如时间窗要求）
      if (RULES[tdoc.rule]?.showScoreboard) {
          return RULES[tdoc.rule].showScoreboard(tdoc, new Date());
      }
      // 3. 规则缺失时的安全降级：有特权则放行；无特权必须已开始且非隐藏
      if (allowPermOverride && canViewHiddenScoreboard.call(this, tdoc)) return true;
      return !tdoc.keepScoreboardHidden && (!tdoc.beginAt || new Date() > tdoc.beginAt);
  }
  ```

---

### 缺陷 2【P1 严重安全风险】：`upgrade.ts` 包名过滤正则过宽，存在选项注入（Argument Injection）隐患

- **受影响文件**：[`packages/hydrooj/src/commands/upgrade.ts#L123-L129`](file:///home/leeson/Hydro/packages/hydrooj/src/commands/upgrade.ts#L123-L129)
- **代码片段**：
  ```typescript
  const pkg = targetPackage.trim();
  if (!/^[a-zA-Z0-9@_./-]+$/.test(pkg)) {
      logger.error(`非法包名参数: ${targetPackage}`);
      process.exitCode = 1;
      return;
  }
  scriptArgs.push(pkg);
  ```

- **隐患机制与故障场景**：
  1. **选项注入（Argument Injection）**：正则 `/^[a-zA-Z0-9@_./-]+$/` 允许以连字符 `-` 或 `--` 开头的字符串通过（例如 `--help`、`-i`、`--dry-run`、`--eval` 等）。
  2. 当执行 `hydrooj upgrade --targetPackage="--evil-flag"` 时，该参数被当作位置参数追加到 `scriptArgs` 中：
     `install-dev-from-private-npm.sh update --evil-flag`。
  3. 当 Shell 脚本或 npm 在解析该位置参数时，会将其当成命令行选项而非包名进行解析，可能导致参数混淆甚至执行未预期的内部子命令分支。
  4. **路径穿越隐患**：该正则允许包含 `..` 和连续 `/`，可能导致形如 `../../local/path` 的非常规路径逃逸检查。

- **修改建议**：
  - 严格限制包名格式，遵循 npm 包名规范（支持可选 scope、包名和可选版本号号段），且显式拒绝以连字符开头或包含连续点号：
  ```typescript
  const pkg = targetPackage.trim();
  const NPM_PACKAGE_REGEX = /^(@[a-zA-Z0-9~-][a-zA-Z0-9._~-]*\/)?[a-zA-Z0-9~-][a-zA-Z0-9._~-]*(?:@[a-zA-Z0-9_.~^>=<-]+)?$/;
  if (pkg.startsWith('-') || pkg.includes('..') || !NPM_PACKAGE_REGEX.test(pkg)) {
      logger.error(`非法包名参数: ${targetPackage}`);
      process.exitCode = 1;
      return;
  }
  ```
  - 同时排查 `options.rollback`（[L113](file:///home/leeson/Hydro/packages/hydrooj/src/commands/upgrade.ts#L113)）与 `options.packages`（[L132](file:///home/leeson/Hydro/packages/hydrooj/src/commands/upgrade.ts#L132)），对来自 CLI 的输入参数做同样的防注入与白名单校验。

---

## 3. 次要缺陷与规范建议（P2）

### 建议 1：`problem.ts` 中的 `targets` 数组类型清洗需排除嵌套数组
- **受影响文件**：[`packages/hydrooj/src/handler/problem.ts#L1068-L1070`](file:///home/leeson/Hydro/packages/hydrooj/src/handler/problem.ts#L1068-L1070)
- **说明**：在 JavaScript 中，`typeof [] === 'object'` 成立。如果外部传入 `targets: [ [ "domain", "pid" ] ]`，嵌套数组将绕过 `typeof t === 'object'` 过滤并进入属性比较环节，虽然访问 `t.domainId` 会得到 `undefined` 不会引发系统崩溃，但语义上不够严谨。
- **优化方案**：
  ```typescript
  const targets = Array.isArray(rawTargets)
      ? rawTargets.slice(0, 100).filter((t) => t && (typeof t === 'string' || (typeof t === 'object' && !Array.isArray(t))))
      : null;
  ```

### 建议 2：`config.ts` 导出工具方法的校验对称性与原型链防御增强
- **受影响文件**：[`packages/hydrooj/src/commands/config.ts#L52-L111`](file:///home/leeson/Hydro/packages/hydrooj/src/commands/config.ts#L52-L111)
- **说明**：
  1. `updateEnvFileKey` 增加了 `^[A-Za-z_][A-Za-z0-9_]*$` 正则校验，但同为导出函数的 `removeEnvFileKey` 仍未校验 key，建议保持防御对称性。
  2. `FORBIDDEN_KEYS` 原型链检查建议对 key 进行 `trim()` 处理后比对。
  3. `sanitizedValue` 去除换行符能防范 CRLF 注入，但如果配置值包含 `#`（注释符）或空格，写入无引号包裹的 `.env` 行可能会在后续读取时产生歧义，后续可考虑规范化引号转义。

---

## 4. 测试用例评估与质量改进 (`test/review-fixes.spec.js`)

- **良好实践**：
  - 测试采用 Node.js 原生 `node:test` 配合 `typescript.transpileModule` + `node:vm` 沙箱运行，不依赖外部大型测试框架，执行耗时极低（~400ms）。
  - 成功覆盖了 CRLF 换行清洗、`updateEnvFileKey` 异常抛出、`config set` 原型键拦截等用例。

- **必须补充的测试场景**：
  1. **隐藏榜单越权回归测试**：在现有测试中，仅断言了 `assert.doesNotThrow`，未断言 `fakeUser`（无权限用户）访问 `hiddenCourseDoc` 时的返回值。由于前述 Fail-Open 缺陷，当前实际上返回了 `true`。应补充安全断言：
     ```javascript
     assert.equal(
         canShowScoreboard.call({ user: fakeUser }, hiddenCourseDoc),
         false,
         '无特殊权限的普通用户绝不可查看设置了 keepScoreboardHidden 的课程榜单'
     );
     ```
  2. **包名参数注入测试**：对 `upgrade.ts` 增加针对 `-f`、`--eval`、`../../path` 等恶意参数拦截的单元测试。

---

## 5. 修复实施代码参考

### 5.1 `packages/hydrooj/src/model/contest.ts` 修复参考
```typescript
function canAccessContestResults(user: User, tdoc: Tdoc, allowPermOverride = true) {
    if (!canAccessAssignedContest(user, tdoc)
        && (!allowPermOverride || !canViewHiddenScoreboard.call({ user }, tdoc))) return false;
    // 若未显式定义 hidden，默认按公开比赛处理（保留原有逻辑）
    if (!RULES[tdoc.rule]?.hidden) return true;
    if (user.own(tdoc)
        || user.hasPerm(PERM.PERM_VIEW_HIDDEN_CONTEST)
        || user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK)
        || user.hasPerm(PERM.PERM_VIEW_HOMEWORK_HIDDEN_SCOREBOARD)
        || user.hasPerm(PERM.PERM_EDIT_HOMEWORK)
        || user.hasPerm(PERM.PERM_EDIT_HOMEWORK_SELF)) return true;
    return !!tdoc.assign?.length && canAccessAssignedContest(user, tdoc);
}

export function canShowRecord(this: { user: User }, tdoc: Tdoc, allowPermOverride = true) {
    if (!canAccessContestResults(this.user, tdoc, allowPermOverride)) return false;
    if (RULES[tdoc.rule]?.showRecord) return RULES[tdoc.rule].showRecord(tdoc, new Date());
    if (allowPermOverride && canViewHiddenScoreboard.call(this, tdoc)) return true;
    return !tdoc.keepScoreboardHidden && (!tdoc.beginAt || new Date() > tdoc.beginAt);
}

export function canShowSelfRecord(this: { user: User }, tdoc: Tdoc, allowPermOverride = true) {
    if (!canAccessContestResults(this.user, tdoc, allowPermOverride)) return false;
    if (RULES[tdoc.rule]?.showSelfRecord) return RULES[tdoc.rule].showSelfRecord(tdoc, new Date());
    if (allowPermOverride && canViewHiddenScoreboard.call(this, tdoc)) return true;
    return !tdoc.keepScoreboardHidden && (!tdoc.beginAt || new Date() > tdoc.beginAt);
}

export function canShowScoreboard(this: { user: User }, tdoc: Tdoc, allowPermOverride = true) {
    if (tdoc.keepScoreboardHidden && (!allowPermOverride || !canViewHiddenScoreboard.call(this, tdoc))) return false;
    if (RULES[tdoc.rule]?.showScoreboard) return RULES[tdoc.rule].showScoreboard(tdoc, new Date());
    if (allowPermOverride && canViewHiddenScoreboard.call(this, tdoc)) return true;
    return !tdoc.keepScoreboardHidden && (!tdoc.beginAt || new Date() > tdoc.beginAt);
}
```

### 5.2 `packages/hydrooj/src/commands/upgrade.ts` 修复参考
```typescript
        if (targetPackage) {
            const pkg = targetPackage.trim();
            const NPM_PKG_REGEX = /^(@[a-zA-Z0-9~-][a-zA-Z0-9._~-]*\/)?[a-zA-Z0-9~-][a-zA-Z0-9._~-]*(?:@[a-zA-Z0-9_.~^>=<-]+)?$/;
            if (pkg.startsWith('-') || pkg.includes('..') || !NPM_PKG_REGEX.test(pkg)) {
                logger.error(`非法包名参数: ${targetPackage}`);
                process.exitCode = 1;
                return;
            }
            scriptArgs.push(pkg);
        }
```
