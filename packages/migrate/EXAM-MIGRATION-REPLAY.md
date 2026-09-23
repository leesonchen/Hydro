# exam 迁移重跑交接记录

这份记录用于目标 `hydro2` 恢复（或重建）后快速重做 exam 迁移。它和
[`EXAM-MIGRATION.md`](./EXAM-MIGRATION.md) 配套使用：前者记录本次已确认的
中间决策和如何保留运行产物，后者是命令的完整安全说明。

## 当前待执行规则（覆盖旧演练中的身份映射）

旧 run 目录中的身份统计和 27 组人工/用户名映射只是历史审计，不能用于下一次
分析或 apply。当前规则已经写入 `exam.ts`：允许非 `@test.com` 邮箱在 trim+小写后
完全相同的账号合并；另有 8 个明确列出的源 UID，仅在 `@test.com` 邮箱和用户名都完全
相同时合并。不按一般用户名合并，也不使用已取消的 27 组人工映射或 12 组用户名冲突
映射。其余账号创建为 `<源用户名>_exam`，密码凭据仍从源包复制；若邮箱为未获确认的
`@test.com`、已被目标占用、重复或无效，则写入逐 UID 唯一的 `@invalid.exam` 占位邮箱，
并在 `plan.json` 中保留源邮箱。

这 8 个例外源 UID 为：`270, 298, 314, 334, 415, 523, 600, 1204`。

## 2026-09-23 最新本地重跑

源为 37018 `hydro`，目标为本地 `hydro2` 的 `hydro` 数据库；37017 全程未写入。
审计目录为 `migration-runs/exam-export-37018-20260923-p105/`，其中保留新源包、
目标完整备份、计划、逐阶段日志、机器验证、逐账户/比赛/题目合并报告和网页核验。

- `packageHash`: `552a35d62d2e55862303ffaa9c721a61b00a3681f90793c5af47ecdd5a706dcd`
- `planHash`: `e2b21ca936148ed8e97ac6d2e9f0d7ff6b07d1c70fb88573e6001c310847a664`
- apply 前目标指纹: `bb90356bb91455ee55d507cbec5e5061b2a02b62cc4378e47c79b8b03bb77b38`
- 身份判定：296 个邮箱合并（含 8 个已确认的 `@test.com` 例外），591 个新建；
  无人工/用户名合并，新建用户名均带 `_exam`。
- 题目：91 道实体复制、14 道引用、10 道复用；11 场比赛复制。P105 明确复用原有
  `exam/9 → contests/3230`，没有新建 `exam/105`。源 `prepare/88` 与目标
  `contests/3230` 各有 40 个测试文件，题面相同，40 个文件的 SHA-256 逐一相同。
- 结果报告按完整引用链统计最终题源的测试文件元数据。例如 `E2512T13` 通过
  `exam → cpptrain/AT7 → yizhong/AT7` 获得 48 个文件；报告中的文件数不是
  物理哈希核验结果。分析阶段现会拒绝链中缺失、指向 `prepare`/`test` 或循环的引用。
  本轮报告初版定位 exam 包装题有误且只看一层引用，曾误报 5 道引用题“缺失”；最终报告已重生成，
  数据库中的题目和成绩未因此更改。
- P105 的 48 条提交、29 条题目状态、2 条统计均映射到 PID 9；原 `exam/9` 的
  ObjectId 未改变。`verify-report.json` 为 `ok: true`，0 个错误，检查了 110,713 项
  引用和 788 个导入文件；总计插入 30,912 条文档。
- 网页抽查：exam 首页、P9 详情、代表性提交正常。11 场迁入比赛的榜单中，10 场
  HTTP 200 且行数与状态数一致；秋季插班测试的 144 条状态也在库中，但源比赛原本
  设置 `keepScoreboardHidden: true`，因此榜单 HTTP 403，属预期可见性规则。
  `/d/exam/` 是可用首页；无尾斜杠的 `/d/exam` 在登录后为 404。
- 新导出包相较 9 月 22 日包，exam 业务集合和文件清单未变化；3 个源用户的
  `loginat` 发生变化，其中 1 个还更新了密码凭据。正式迁移前应再次确认源端停写，
  以新的不可变源包为准。详细结果见该 run 的 `merge-summary.md` 和
  `browser-regression.json`。

## 37018 中需要补充导出测试数据的题目

源包中 115 道题里，有 30 道自身带测试数据；以下 62 道是“实体化复制但源题目
没有 `data`/`additional_file` 文件”的题目。如果生产 37018 上这些题目实际有
测试数据，请先按下列**生产 PID**导出，再导入当前环境；表中的目标 PID 是上一轮
目标备份快照的映射，正式恢复后仍以新生成的 `plan.json` 为准。

| 生产 PID 范围 | 数量 | 上一轮目标 PID | 题目/备注 |
| --- | ---: | --- | --- |
| `P2–P10` | 9 | `117–125` | 攀爬、运算、找零、烤串、线段、火车、方程、擦除、数位 |
| `P15–P17` | 3 | `130–132` | A ~ 金属熔炼、B ~ 战线的补给、C ~ 战线的密码 |
| `P18–P26` | 9 | `18–26` | D ~ 奇数的试炼至 L ~ 龙与虎的约定 |
| `P30–P42` | 13 | `30–42` | 最长公共子串至 8.密码 |
| `C250801–C250813` | 13 | 原 PID | a–m |
| `E2512T01–E2512T12` | 12 | 原 PID | AtCoder 煎饼至涂色 |
| `E2512T14–E2512T16` | 3 | 原 PID | 排列、黑白格子、相邻合并 |
| **合计** | **62** |  |  |

不需要从 37018 补文件的无测试数据题目包括：`P11–P14`、`P27–P29`、
`E2512T13` 以及 `P101–P104`、`P106–P115`；这些题目按已确认的健康引用或
目标已有题目复用，不会从源端复制测试数据。导入前应保留题面、配置和测试文件
的 SHA-256，避免把其他域的同名题覆盖到 `exam`。

`P105` 不在上表：源题通过 `prepare/88` 取得 40 个测试文件，本地 `exam/9`
通过 `contests/3230` 取得同样的 40 个文件。2026-09-23 已逐文件确认 SHA-256
相同，因此本地重跑直接复用 `exam/9`；以后更换目标库时必须重新核对引用和文件，
否则显式复用规则应拒绝执行。

## 2026-09-22 历史模拟：37018 → 本地 hydro2

2026-09-22 的最后一次模拟已完成，源为停写的 37018 `hydro` 数据库，目标为本地
`hydro2` 容器的 `local` 配置。37017 全程没有写操作。完整审计目录为
`migration-runs/exam-export-37018-20260922-final/`；它包含源包、目标备份、计划、
阶段清单、验证报告、逐账户/比赛/题目合并报告和浏览器回归记录。

- `packageHash`: `d1a395fb76daa79dbb2c9ec89b918f2cf8ffac5a20314bd8248d8aa8fcc82019`
- `planHash`: `fd189a81270a3da9f5034a1a7c037d6f50a7b500a502c8b3957e8d07fc6271a6`
- apply 前目标指纹: `128f29879ff5022210896c6729486b9b2b30ca49cb5a397a4ef1a3d0d56e3612`
- 验证: `verify-report.json` 为 `ok: true`，0 个错误，引用检查 110,531 项，文件校验 788 项

源清单为 887 个用户、850 个 exam 成员、2 个用户组、115 道题、14 篇题解、11 场比赛、
8,526 条状态、12,987 条提交、4,555 条统计和 1,882 条重测历史。应用阶段共插入
30,784 条文档，阶段计数依次为 `users=1060`、`domain=842`、`problems=106`、
`storage=788`、`related-documents=40`、`records=19424`、`statuses=8524`。

身份判定为人工 27、用户名 199、用户名冲突按用户名 12、有效邮箱 119、新建 530；题目
处理为 `copy=92`、`reference=14`、`reuse=9`；11 场比赛均复制。完整逐条结果见
[`merge-summary.md`](../../migration-runs/exam-export-37018-20260922-final/merge-summary.md)
和同目录的 `merge-report.json`（报告 SHA-256 见 `merge-report.sha256`）。

报告还明确列出 2 个成绩自然键碰撞（源 UID `1695,2242` 合并到目标 UID `1970` 的题目
状态，以及源 UID `2097,2098` 合并到目标 UID `1465` 的比赛状态）；这是同一目标账号的
身份别名合并，不是未检查的导入失败。

重复执行保护也已验证：原计划因目标指纹变化拒绝；在临时副本更新为当前指纹后，命中
已完成的 `exam.migration` 标记并以“已经执行或正在执行”拒绝，目标未产生重复文档。
容器内 MongoDB、Caddy、sandbox 和 `hydrooj` 均在线；完整目标备份保存在该 run 的
`backup/` 下。浏览器回归记录在 `browser-regression.json`：未登录路由均正确跳转到
exam 登录页且控制台/页面错误为 0，但恢复库不接受 `testuser.md` 中的旧密码，所以认证
后的成绩表、题目详情和比赛榜单仍需用有效账号补测；未为此修改任何账户或业务数据。

## 更早的 37017 历史模拟

- 本轮使用 37017 生产环境的不可变源包
  `migration-runs/exam-export-37017-20260922-r2/`；针对恢复后的本地
  `hydro2` 目标生成的分析、应用和验证产物位于
  `migration-runs/exam-export-37017-20260922-r3/`，使用了 `--merge-existing`。
- `packageHash`：`7a6c3ac59522b67b9413607b8693939f7263d4df7732045a8e6784cdf4a70dd2`。
  最终 `planHash`：`e1fb98451be57c5dd87589299c922fb61e6940b0e262fa969227a58e88f4a147`。
  本地目标分析指纹：`f772e2f8f205b19a03802c2cd66056971b26bea38aa7d07e3324b57dc9ad0da3`。
- 旧计划因目标指纹变化被安全拒绝，未产生写入；重新 `analyze` 后才完成 dry-run、
  apply 和 verify。旧计划与本轮命令记录均保留在各自审计目录中。
- 最终 `verify-report.json` 为 `ok: true`：675 项引用检查、7 个比赛附件的容器内
  SHA-256 已单独抽查、用户名/有效邮箱重复均为 0；本地 `hydrooj` 已重新启动。
  本轮生产环境仍未执行任何写操作。
- 已通过：exam 纯测试、dry-run、正式 apply/verify，以及 exam 首页、题目、比赛入口
  和成绩表页面抽查；测试账号登录成功，浏览器控制台错误为 0。

## 历史迁移输入（仅用于复核，不替代包内计数）

以下数字来自旧演练的需求确认，身份规则已被上文的新策略取代。真正 apply 前，以导出包
的 `manifest.json` 和新生成的 `plan.json` 为准；如果数量不同，应停止并重新分析原因。

| 项目 | 已确认数量/规则 |
| --- | --- |
| exam 关联用户 | 871 |
| exam 域成员 | 850 |
| 用户组 | 2 |
| 题目 | 115 |
| 题解 | 14 |
| 比赛 | 11 |
| 答疑 | 25 |
| 提交 | 12,987 |
| 用户身份 | 27 组人工映射；用户名侧共 207 组（含 12 组冲突）；有效邮箱 116 组；新建 521 人 |
| 题目判定 | 8 个确认引用，107 个实体化 |
| 私有用户文件 | 声明 89 个，其中 50 个源端缺失；均不迁移并记录到排除报告 |

本轮 37017 合并后的目标计数（以 `verify-report.json` 为准）：4,082 个用户、18 个
exam 成员、19 个文档、37 条状态、63 条提交、31 条统计和 7 条存储元数据；目标原有
exam 数据均保留。源端 19 个用户中新增 3 个目标用户，新增 8 个 exam 成员；17 道题
和 2 场比赛均安全复用，没有重复创建。

源包清单为 19 个用户、18 个域成员、17 道题、2 场比赛、46 条提交、37 条状态、22
条统计和 7 个比赛附件。计划、应用和验证的精确阶段计数以本轮 `r3/plan.json`、
`r3/apply.json` 和 `r3/verify-report.json` 为准，不要把旧 20260921 演练的计数带入
新的目标分析。

下面的两组用户映射仅是历史 run 的审计资料，当前代码中的同名导出常量已置空，
不得在下一次迁移中恢复使用。当前身份策略和 8 个健康题目引用由
`packages/migrate/exam.ts` 的 `CONFIRMED_DECISIONS` 记录；目标 UID、ObjectId、存储
ID 和 `planHash` 必须由恢复后的目标重新 `analyze` 生成。

为便于人工复核，本轮确认值如下（箭头左侧为源 UID/PID，右侧为目标 UID/PID）：

```text
（历史人工用户映射，已取消）1558→2047, 1605→2381, 1632→3859, 1682→1514, 1716→2553,
1888→2927, 1996→595, 2013→3781, 2106→3494, 2110→3520, 2121→3480,
2124→3510, 2142→3529, 2144→3492, 2146→3507, 2147→3500, 2151→3503,
2156→3464, 2159→3482, 2160→3479, 2170→3513, 2172→3486, 2177→3616,
2208→3676, 2242→1970, 2257→3564, 2310→2992

（历史用户名冲突映射，已取消）1383→3919, 1450→2363, 1582→3525,
1583→3398, 1623→3117, 1649→2837, 1665→4020, 1765→2574,
1810→2544, 1933→2972, 2100→3040, 2236→2862

健康题目引用：P11→oler/1, P12→oler/2, P13→oler/3, P14→oler/4,
P27→yizhong/417, P28→yizhong/418, P29→yizhong/419, P72→yizhong/480
```

## 必须保留的中间产物

把整个 `migration-runs/<run-id>/` 当作一个不可变审计包保留，不要只留下
`plan.json`。至少包括：

| 文件/目录 | 用途 |
| --- | --- |
| `manifest.json`、`package.sha256` | 源包清单、源包哈希和集合计数 |
| `collections/`、`files/` | EJSON 数据和文件内容；缺一不可 |
| `plan.json` | 某一次目标数据库分析的身份、题目、ObjectId、存储映射和 `planHash` |
| `commands.jsonl`、`audit.jsonl` | 脱敏命令记录和逐阶段审计事件 |
| `apply.json` | 停服、备份、阶段、插入清单和文件清单 |
| `verify-report.json`、`verify-summary.txt` | 机器验证结果和人工摘要 |
| `rollback.json`、`backup/` | 回滚结果和 apply 前的目标 `mongodump`（若 apply 已执行） |

包内可能有密码哈希，目录/文件权限由工具设置为 `0700/0600`。包不能提交 Git、
不能上传到普通工单，也不能把 Mongo URI、密码哈希或 Token 写入命令记录。

建议在安全位置做一份带校验和的离线副本（路径按实际环境替换）：

```sh
RUN_DIR="$PWD/migration-runs/<run-id>"
ARCHIVE="/secure/migration-archive/<run-id>.tar.zst"
mkdir -p "$(dirname "$ARCHIVE")"
tar --zstd --xattrs --acls -cf "$ARCHIVE" -C "$(dirname "$RUN_DIR")" "$(basename "$RUN_DIR")"
sha256sum "$ARCHIVE" > "$ARCHIVE.sha256"
```

恢复副本时先确认目标目录是本次迁移目录，再限制权限；不要解压到生产源目录：

```sh
mkdir -p migration-runs
tar --zstd -xf /secure/migration-archive/<run-id>.tar.zst -C migration-runs
chmod -R go-rwx migration-runs/<run-id>
```

如果这个源包曾经在同一目标库上 apply，不能只换工作目录并复制旧
`manifest.json`：其中的 `runId` 不变，目标 `exam.migration` 的完成标记仍会拒绝
重复执行。保留旧目录作为历史审计，优先从停写的 37018 重新 `export` 到**全新
run-id**（本轮采用 `exam-export-37018-20260923-p105`），再分析目标。若源端不可读，
现有工具没有安全的“仅更换 run-id”命令；不要手工改 manifest 或删除完成标记来绕过。

## 目标库恢复后的最短重跑流程

下面的 `RUN_DIR` 和 URI 为占位符。`hydro2` 是**容器名**，其本轮实际 MongoDB
名称是 `hydro`，容器内物理存储根为 `/data/file/hydro`。凭据建议在仓库外的
`0600` 环境文件中提供，避免写进 shell 历史或本记录。

```sh
export RUN_DIR="$PWD/migration-runs/<run-id>"
export TARGET_URI='mongodb://<目标凭据>@<目标主机>/'
export TARGET_DB='hydro'
export TARGET_STORAGE_ROOT='/data/file/hydro' # 容器内路径，不是宿主机路径
export EXAM_MIGRATE='node -r @hydrooj/register packages/migrate/bin/exam-migrate.js'
```

以下 `analyze` 可在能连接本地 MongoDB 的宿主机运行，但 `apply`、`verify`、`rollback`
必须在能访问同一物理存储根和 `pm2` 的执行环境运行。对当前 `hydro2`，应先将本轮
包与迁移工具暂存到容器内独立的 `/tmp/<run-id>/` 路径；不要在宿主机用
`/data/file/hydro` 执行 apply。本轮实际采用：容器内 `pm2 stop hydrooj` → 冻结后
重新 analyze → 容器内 dry-run → 容器内带 `mongodump` 的 apply（`--no-stop`，因为
服务已手动停止）→ verify/report → 容器内 `pm2 start hydrooj` → 复制容器审计产物
回本地 run 目录。具体脱敏命令见本轮 `commands.jsonl`；`--no-stop` 绝不能用于仍
在线写入的目标。

1. **确认代码和包。** 工作区应包含迁移工具；检查 `manifest.json` 的 `packageHash`
   与 `package.sha256` 相同，并确认包目录中的 `collections/`、`files/` 没有被改动。
   如果源端仍可读但没有包，先按手册的 `export` 命令重新导出；源端必须先停写。

2. **重新分析恢复后的目标。** 即使旧 `plan.json` 仍在，也必须重新执行 analyze；
   恢复数据库会改变目标指纹，旧计划不能直接 apply：

   ```sh
   $EXAM_MIGRATE analyze \
     --package "$RUN_DIR" \
     --target-uri "$TARGET_URI" --target-db "$TARGET_DB" \
     --merge-existing
   ```

   审阅 `plan.json` 的 `targetBefore`、`identities`、`problems`、`storage`、
   `expectedCounts`、`excludedFiles` 和 `excludedDocuments`。合并模式下
   `targetBefore.examDomainExists` 应为 true；确认目标没有意外的存储路径占用，
   且 8 个健康引用题和 P105→`exam/9` 复用仍有效；P105 的目标引用实体 40 个文件
   必须与源 `prepare/88` 逐文件核对 SHA-256。

3. **记录新的检查点。** 把以下四个值抄入本次运行的交接单或变更记录；不要把
   旧目标的值带到恢复后的数据库：

   ```sh
   node -e "const p=require(process.argv[1]); console.log(JSON.stringify({runId:p.runId,packageHash:p.packageHash,planHash:p.planHash,targetBeforeHash:p.targetBefore.hash},null,2))" "$RUN_DIR/plan.json"
   ```

   | 检查点 | 值 |
   | --- | --- |
   | `runId` | `<从 manifest/plan 复制>` |
   | `packageHash` | `<从 manifest 复制>` |
   | `targetBefore.hash` | `<从本次 plan 复制>` |
   | `planHash` | `<人工审阅后确认>` |

4. **先做无写入预检。** 仍需提供目标存储根目录，因为包中包含需要校验的文件；
   预检不会写业务集合，也不会停服务：

   ```sh
   PLAN_HASH="$(node -p "require('$RUN_DIR/plan.json').planHash")"
   $EXAM_MIGRATE apply \
     --package "$RUN_DIR" \
     --target-uri "$TARGET_URI" --target-db "$TARGET_DB" \
     --target-storage-root "$TARGET_STORAGE_ROOT" \
     --plan-hash "$PLAN_HASH" --merge-existing --dry-run --no-stop --no-backup
   ```

5. **正式 apply。** 确认 MongoDB 在线、本地 `hydrooj` 可以短暂停止，并确认
   `PLAN_HASH` 是刚才审阅的值。默认流程会 `pm2 stop hydrooj`、做目标
   `mongodump`，按阶段写入，并在 verify 成功后才 `pm2 start hydrooj`：

   ```sh
   $EXAM_MIGRATE apply \
     --package "$RUN_DIR" \
     --target-uri "$TARGET_URI" --target-db "$TARGET_DB" \
     --target-storage-root "$TARGET_STORAGE_ROOT" \
     --plan-hash "$PLAN_HASH" --merge-existing
   ```

6. **保留结果并抽查。** 保存 `apply.json`、`verify-report.json`、
   `verify-summary.txt` 和 `audit.jsonl`；验证报告为 `ok: true` 后再检查 exam 首页、
   题目详情、比赛榜单和代表性提交。历史提交只校验引用和统计，不重判。

7. **阶段失败或验证失败。** 保持服务停止，先查看 `apply.json` 和 `audit.jsonl`。
   不要手工删除用户或按域批量清理；确认目标仍是本次 run 后，再执行：

   ```sh
   $EXAM_MIGRATE rollback \
     --package "$RUN_DIR" \
     --target-uri "$TARGET_URI" --target-db "$TARGET_DB" \
     --target-storage-root "$TARGET_STORAGE_ROOT" --yes
   ```

   回滚只使用 `apply.json` 中本轮成功插入的文档和文件清单；回滚完成后保留整个
   审计目录，再恢复或重新分析目标库。

## 以后再次重跑的判定规则

- **同一个源包可以复用，旧目标计划不能复用。** 每次目标库恢复、重建或内容变化
  后都要重新 `analyze`，重新人工确认 `planHash`。
- **包哈希变化立即停止。** 不要编辑 `collections/`、`files/` 或 `manifest.json`；
  如果源数据变了，生成一个新的 run-id 和新的不可变包。
- **同一 run-id 的迁移标记或路径碰撞时停止。** `--merge-existing` 要求目标已有
  exam 域；旧 run-id 的历史标记可以保留，但本次 run-id 不得碰撞。先验证是否有本次
  run 的残留，通过 `rollback` 或目标备份恢复处理，不能手工删除标记绕过保护。
- **真实环境必须重新做身份和题目分析。** 本地目标 UID、ObjectId、存储 ID、
  `targetBefore.hash` 都不可带到另一套环境；只复用源包和代码中已确认的判定规则。
- **P105 文件校验尚未自动化。** 当前 `analyze` 只确认目标引用实体有 40 条文件
  元数据；`verify` 只校验本轮新导入的文件，不校验复用题目的既有物理文件。正式
  `apply` 前必须重新从 37018 读取 `prepare/88`，逐一核对文件名、物理存在性与
  SHA-256 是否等于目标 `contests/3230`，并把 40 项校验结果保存到新 run 审计目录。
  当前不可变源包不含 `prepare/88` 的物理文件（它在 exam 域之外），因此需保持
  37018 及其文件存储可读，或提前单独归档这 40 个源文件和哈希。更换目标库时
  不能沿用本轮的“40/40 相同”结论；未完成这项校验不得上线。
