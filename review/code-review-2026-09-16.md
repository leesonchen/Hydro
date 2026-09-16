# 代码评审报告：未提交变更与近期提交风险评估

- **评审日期**：2026-09-16
- **评审分支**：`course-v2.1`
- **提交评审范围**：
  - 最近提交：`19037d01` ~ `eab048d8`（2026-09-14 至 2026-09-15）
  - 本地未提交修改：工作区与暂存区所有变更文件

---

## 1. 评审范围与文件清单

### 1.1 本地未提交变更
- [`install-dev-from-private-npm.sh`](file:///home/leeson/work/Hydro/install-dev-from-private-npm.sh)：增量发布（`RELEASE_INCREMENTAL_INSTALL`）机制，放宽未勾选 `hydrooj` 时的维护命令二进制校验。
- [`install/maintenance.md`](file:///home/leeson/work/Hydro/install/maintenance.md)：维护模式文档更新，补充持久化调度器说明与延时限制。
- [`packages/hydrooj/bin/hydro-maintenance.js`](file:///home/leeson/work/Hydro/packages/hydrooj/bin/hydro-maintenance.js)：新增持久化 PM2 维护调度器、Node.js 定时器上限检查、健康检查 `AbortController` 超时控制。
- [`packages/hydrooj/bin/hydrooj.js`](file:///home/leeson/work/Hydro/packages/hydrooj/bin/hydrooj.js)：主入口处以 detached 形式拉起维护对齐进程。
- [`packages/ui-default/components/maintenance/maintenance.page.ts`](file:///home/leeson/work/Hydro/packages/ui-default/components/maintenance/maintenance.page.ts)：前端轮询与倒计时定时器初始化逻辑微调。
- [`packages/ui-default/service-worker.ts`](file:///home/leeson/work/Hydro/packages/ui-default/service-worker.ts)：Service Worker 缓存分版本命名（`precache-${VERSION}`）与激活时清理旧版本缓存。

### 1.2 最近两天已提交记录
- `eab048d8`（2026-09-15）：`feat: add maintenance mode support`
- `201146fe`（2026-09-15）：`fix: close problem and course review findings`（归档 `ai-translation` 插件、记录评测生成测试数据元数据、清理无讲义时的解锁规则）
- `a5fc5096` / `1a8c8cc0` / `d1e901a0` / `ebaa949e`（2026-09-15）：AI 翻译插件路由及权限修复（已被后续提交归档）
- `78739b6d`（2026-09-15）：`fix(ui): hide lecture unlock fields without a lecture`
- `2b82e754`（2026-09-15）：`fix(problem): track metadata for all authenticated edits`
- `9a79e3fb`（2026-09-15）：`fix(problem): export files from referenced sources`
- `5a0796cb`（2026-09-14）：`fix: preserve problem metadata when copying`
- `19037d01`（2026-09-14）：`feat: track problem and lecture edit metadata`

---

## 2. 核心风险与缺陷详情

### 缺陷 1【P0 紧急】：`hydrooj.js` 盲目派生子进程，引发脱管僵尸轮询与定时器惊群
- **受影响文件**：[`packages/hydrooj/bin/hydrooj.js#L14-L24`](file:///home/leeson/work/Hydro/packages/hydrooj/bin/hydrooj.js#L14-L24)
- **代码片段**：
  ```javascript
  const maintenanceScript = path.join(packageBasedir, 'bin', 'hydro-maintenance.js');
  if (fs.existsSync(maintenanceScript)) {
      try {
          const reconciler = childProcess.spawn(process.execPath, [maintenanceScript, 'reconcile'], {
              detached: true,
              stdio: 'ignore',
          });
          reconciler.on('error', () => undefined);
          reconciler.unref();
      } catch (e) { }
  }
  ```
- **隐患机制与故障场景**：
  1. `hydrooj.js` 是全部 Hydro CLI 命令（如 `hydrooj --help`、`hydrooj cli`、定期 cron 任务、运维指令等）的通用入口。
  2. 只要执行任意一条 `hydrooj` 命令，便会无条件通过 `spawn` 派生一个完全脱离 PM2 监管的后台独立 Node 进程。
  3. **预告期的进程泄漏**：如果管理员发布了预告（例如 `--in 2h`），在预告生效前的 2 小时内，任何一次 CLI 调用都会创建一个进入 `while (true)` 轮询循环的子进程。若 2 小时内执行了多次命令，系统中将堆积大量未被监控的僵尸 Node 进程，持续占用 CPU 与内存。
  4. **到期瞬间惊群争锁**：当设定时间到达时，所有堆积的子进程同时被唤醒争抢文件排他锁，造成严重的锁竞争与错误日志报警。
  5. **非预告期的性能浪费**：即使状态为 `inactive`，每次短命 CLI 启动也会开销数十毫秒与内存去初始化一个独立的 Node 运行时。
- **修改建议**：
  - 在 spawn 之前，**必须先同步检查** `maintenance.json` 是否存在且状态确实为 `"scheduled"`。
  - 更优雅的做法：仅在 Hydro 作为常驻服务（Daemon / Service）启动时注册定时检查，短命 CLI 入口禁止拉起后台轮询子进程。

---

### 缺陷 2【P0 紧急】：维护模式停机顺序颠倒，底层数据库先于业务服务关闭
- **受影响文件**：
  - [`packages/hydrooj/bin/hydro-maintenance.js#L27`](file:///home/leeson/work/Hydro/packages/hydrooj/bin/hydro-maintenance.js#L27)
  - [`packages/hydrooj/bin/hydro-maintenance.js#L431-L437`](file:///home/leeson/work/Hydro/packages/hydrooj/bin/hydro-maintenance.js#L431-L437)
- **代码片段**：
  ```javascript
  const serviceOrder = ['mongodb', 'hydro-sandbox', 'hydrojudge', 'hydrooj'];
  // ...
  async function activate(id, message) {
      // ...
      const failures = [];
      for (const name of services) {
          try {
              run(pm2Path(), ['stop', name], { stdio: 'inherit' });
          } catch (e) {
              failures.push(`${name}: ${e.message}`);
          }
      }
  ```
- **隐患机制与故障场景**：
  - `services` 数组严格按照 `serviceOrder` 正序排列：`['mongodb', 'hydro-sandbox', 'hydrojudge', 'hydrooj']`。
  - 在停机时，代码采用正序循环：**第一个停止的是 `mongodb`，最后一个才停止 `hydrooj`**。
  - 当 MongoDB 被切断时，`hydrooj`（Web 服务）与 `hydrojudge`（判题守护进程）仍在对外服务或处理存量连接，这会导致瞬间产生大量数据库连接断开异常（`MongoServerSelectionError` / Unhandled Promise Rejection），引发判题记录状态异常、在途请求崩溃及潜在的写丢失风险。
- **修改建议**：
  - 停机操作必须严格按依赖关系**逆序停止**，恢复时按**正序启动**：
  ```javascript
  // 停机：先停业务上层，再停基础设施
  for (const name of [...services].reverse()) {
      try {
          run(pm2Path(), ['stop', name], { stdio: 'inherit' });
      } ...
  }
  ```

---

### 缺陷 3【P1 重要】：引用题目权限误杀：学生无法下载讲义、交互头文件等公开附件
- **受影响文件**：
  - [`packages/hydrooj/src/handler/problem.ts#L84-L108`](file:///home/leeson/work/Hydro/packages/hydrooj/src/handler/problem.ts#L84-L108)
  - [`packages/hydrooj/src/handler/problem.ts#L487-L498`](file:///home/leeson/work/Hydro/packages/hydrooj/src/handler/problem.ts#L487-L498)
  - [`packages/hydrooj/src/handler/problem.ts#L1010-L1015`](file:///home/leeson/work/Hydro/packages/hydrooj/src/handler/problem.ts#L1010-L1015)
  - [`packages/hydrooj/src/handler/problem.ts#L1278-L1287`](file:///home/leeson/work/Hydro/packages/hydrooj/src/handler/problem.ts#L1278-L1287)
- **代码片段**：
  ```typescript
  async function getProblemFileSource(pdoc: ProblemDoc, udoc: User): Promise<ProblemFileSource | null> {
      // ...
      const sourceUser = await user.getById(domainId, udoc._id, udoc.scope);
      const canView = !!sourceUser && problem.canViewBy(sourcePdoc, sourceUser);
      return {
          domainId,
          pdoc: sourcePdoc,
          user: sourceUser,
          canRead: canView && !!sourceUser && (sourceUser.own(sourcePdoc)
              || sourceUser.hasPriv(PRIV.PRIV_READ_PROBLEM_DATA)
              || sourceUser.hasPerm(PERM.PERM_READ_PROBLEM_DATA)),
      };
  }
  ```
- **隐患机制与故障场景**：
  1. 在非引用题目中：`testdata`（机密评测数据）需要 `PERM_READ_PROBLEM_DATA` 权限；而 `additional_file`（题面 PDF、样例包、交互题头文件 `grader.h` 等）普通学生只需具有题目查看权限（`PERM_VIEW_PROBLEM`）即可自由下载。
  2. 但在 commit `9a79e3fb` 中，跨域引用题目的 `additional_file` 与 `testdata` 被一刀切地绑定到了 `canRead` 上，且要求用户必须在**源域（Source Domain）**具有 `PERM_READ_PROBLEM_DATA` 权限。
  3. 当教师将题库域（或系统公共域）的题目引用到班级或比赛中时，普通学生在源题库域中绝不会拥有该特权。导致学生在详情页看不见 `additional_file`，在附件下载接口中直接触发 `403 PermissionError`。
  4. 交互题因为缺少头文件、大样例题目因为缺少下载包，学生将完全无法在本地进行代码调试。
- **修改建议**：
  - 解耦 `testdata` 与 `additional_file` 的跨域权限校验。
  - 引用题目的 `additional_file` 只需校验用户在当前域（Target Domain）具有题目的正常查看权限即可放行下载；仅机密 `testdata` 才严格要求源域的高危读取权限。

---

### 缺陷 4【P1 重要】：维护恢复（`turnOff`）遗漏清理 PM2 调度器，导致死进程常驻
- **受影响文件**：[`packages/hydrooj/bin/hydro-maintenance.js#L502-L536`](file:///home/leeson/work/Hydro/packages/hydrooj/bin/hydro-maintenance.js#L502-L536)
- **隐患机制与故障场景**：
  1. 发布预告后，[`ensureScheduler()`](file:///home/leeson/work/Hydro/packages/hydrooj/bin/hydro-maintenance.js#L310-L321) 创建了 PM2 任务 `hydro-maintenance-scheduler`。
  2. 倒计时结束，任务自动激活维护模式并退出，状态变为 `stopped`。
  3. 管理员在维护结束后执行 `hydro-maintenance off` 恢复系统。在 [`turnOff()`](file:///home/leeson/work/Hydro/packages/hydrooj/bin/hydro-maintenance.js#L502-L536) 中，代码仅在 `state.state === 'scheduled'` 时调用了 `stopScheduler()`；而面对 `state.state === 'active'` 恢复的场景，**完全未调用 `stopScheduler()`**。
  4. 紧接着执行了 `run(pm2Path(), ['save'])`，导致已废弃的 `hydro-maintenance-scheduler` 被永久写入 `~/.pm2/dump.pm2`。后续操作系统重启或执行 `pm2 resurrect` 时，该废弃进程会被错误拉起。
- **修改建议**：
  - 在 [`turnOff()`](file:///home/leeson/work/Hydro/packages/hydrooj/bin/hydro-maintenance.js#L502-L536) 恢复逻辑的最后统一调用 `await stopScheduler()`，无论维护前是 `scheduled` 还是 `active`。

---

### 缺陷 5【P2 中等】：排他锁创建非原子，毫秒级竞态导致死锁或误删目录
- **受影响文件**：
  - [`packages/hydrooj/bin/hydro-maintenance.js#L97-L124`](file:///home/leeson/work/Hydro/packages/hydrooj/bin/hydro-maintenance.js#L97-L124)
  - [`install-dev-from-private-npm.sh#L42-L76`](file:///home/leeson/work/Hydro/install-dev-from-private-npm.sh#L42-L76)
- **隐患机制与故障场景**：
  - 锁采用了“先 `mkdir(lockDir)`，再在目录下创建 `owner` 文件”的两步流程。
  - 当进程 A 刚执行完 `mkdir(lockDir)`，尚未来得及写入 `owner` 文件的微秒窗口内，进程 B 尝试 `mkdir` 失败（`EEXIST`）进入 `catch` 分支，读取 `owner` 触发 `ENOENT`。
  - 此时进程 B 会直接将该锁视为死锁，并执行：
    ```javascript
    await fsp.unlink(lockOwnerFile).catch(() => undefined);
    await fsp.rmdir(lockDir).catch(() => undefined);
    ```
  - 这导致进程 A 刚建好的目录被进程 B 强行删除，进程 A 写入失败崩溃；随后进程 B 在第二次重试中抢占锁，破坏了排他锁的基本语义。
- **修改建议**：
  - 捕获到 `ENOENT` 时切忌立即 `rmdir`，应增加短时等待（如 `sleep(100)`）后二次确认。
  - 或直接采用基于单个文件的原子排他创建 `fsp.open(lockFile, 'wx')` 代替两阶段目录锁。

---

### 缺陷 6【P2 中等】：前端维护横幅遮挡顶部导航栏，缺少布局安全边距
- **受影响文件**：
  - [`packages/ui-default/components/maintenance/maintenance.page.styl#L1-L19`](file:///home/leeson/work/Hydro/packages/ui-default/components/maintenance/maintenance.page.styl#L1-L19)
  - [`packages/ui-default/components/maintenance/maintenance.page.ts#L27-L37`](file:///home/leeson/work/Hydro/packages/ui-default/components/maintenance/maintenance.page.ts#L27-L37)
- **隐患机制与故障场景**：
  - 横幅使用了 `position: fixed; top: 0; left: 0; z-index: 10000; width: 100%`。
  - Hydro 站点原生的全局导航栏（`.nav`）位于页面顶部（高度约 50px）。横幅生成时直接 `document.body.prepend(banner)`，但未给页面 `body` 增加动态 `padding-top` 偏移量。
  - 横幅弹出后直接遮挡住导航菜单项、站点 Logo 与个人头像按钮，且未提供关闭按钮，导致在窄屏与移动端界面下顶部核心功能无法点击。
- **修改建议**：
  - 将横幅样式改为 `position: sticky; top: 0` 随文档流自然撑开页面；或在 `ensureBanner()` 时动态设置 `document.body.style.paddingTop` 并在 `removeBanner()` 时还原。

---

### 缺陷 7【P3 优化】：Service Worker 缺少维护页面直通规则及 ESLint 规范问题
- **受影响文件**：[`packages/ui-default/service-worker.ts#L26`](file:///home/leeson/work/Hydro/packages/ui-default/service-worker.ts#L26), [`packages/ui-default/service-worker.ts#L99-L111`](file:///home/leeson/work/Hydro/packages/ui-default/service-worker.ts#L99-L111)
- **隐患机制**：
  1. `/maintain.html` 路径满足 `shouldCachePath` 的 `.html` 规则，容易被 Service Worker 写入 `precache` 存储，脱离维护期后若从 SW 缓存读取可能产生混淆。
  2. 轮询请求 `/maintenance.json?_=` 虽然通过时间戳避免了 HTTP 缓存命中，但在 Service Worker 拦截下每次轮询都会执行一次 `cache.put()`，在长时间驻留页面下会产生无意义的客户端缓存膨胀。
  3. `service-worker.ts` 第 26 行在 `initConfig` 声明前进行了调用，导致 CI 静态检查报 `ts/no-use-before-define` 错误。
- **修改建议**：
  - 在 Service Worker 的过滤规则中显式排除 `/maintenance.json` 与 `/maintain.html`。
  - 调整函数声明顺序修复静态检查错误。

---

## 3. 设计亮点与良好实践

1. **编辑元数据平滑兼容历史数据**：
   题目与讲义的 `editor` / `updateAt` 元数据在展示时均具备完善的回退机制（降级至 `owner` 与 `_id.getTimestamp()`），对存量历史数据完全兼容。
2. **MongoDB 嵌套键原子写入讲义**：
   讲义内容与元数据采用 `lecture.${id}` 和 `lectureMeta.${id}` 嵌套键原子写入，避免了多章节并发编辑时整块覆盖丢失的问题。
3. **Caddy 维护路由热注入与自动回滚**：
   在 `hydro-maintenance setup` 中，修改 Caddyfile 前自动生成时间戳备份，并在 `caddy validate` 或 `caddy reload` 失败时自动恢复并重新加载原配置，具备较好的防御性。
4. **前端文本防注入安全**：
   维护横幅内容使用 `textContent` 赋值，严格杜绝了潜在的存储型 XSS 风险。

---

## 4. 修复优先级建议清单

| 序号 | 问题项 | 模块 | 优先级 |
| :--- | :--- | :--- | :--- |
| 1 | 移除 `hydrooj.js` 顶部的无条件 `spawn`，防止脱管僵尸进程泄漏 | 运行入口 / 进程模型 | **P0（紧急）** |
| 2 | 将 `activate()` 的停机服务顺序调整为逆序，确保上层业务先于数据库退出 | 维护命令 / 稳定性 | **P0（紧急）** |
| 3 | 解耦引用题目的 `additional_file` 与 `testdata` 权限检查，恢复公开附件下载 | 题目服务 / 班级作业 | **P1（重要）** |
| 4 | 在 `turnOff()` 恢复成功后补充 `await stopScheduler()` 清理常驻 PM2 任务 | 维护命令 / PM2 管理 | **P1（重要）** |
| 5 | 排他锁增加重试延时，消除两阶段目录创建与删除的竞态窗口 | 运维脚本 / 互斥锁 | **P2（中等）** |
| 6 | 维护横幅样式调整，避免遮挡顶栏操作菜单 | 前端 UI / 用户体验 | **P2（中等）** |
| 7 | Service Worker 排除维护页面缓存并修复声明顺序规范错误 | 离线缓存 / 静态规范 | **P3（优化）** |
