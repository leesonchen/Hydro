# exam 迁移重跑交接记录

这份记录用于目标 `hydro2` 恢复（或重建）后快速重做 exam 迁移。它和
[`EXAM-MIGRATION.md`](./EXAM-MIGRATION.md) 配套使用：前者记录本次已确认的
中间决策和如何保留运行产物，后者是命令的完整安全说明。

## 当前轮次的真实状态

- 本轮源包为 `migration-runs/exam-export-20260921-0915/`，已在恢复后的
  `hydro2` 目标上以 `--merge-existing` 完成应用和验证。
- `packageHash`：`7ac89c9ab75dd07ee739930420b8cd90a4d379ed5fea54649155945618db1387`。
  最终 `planHash`：`aa55b7b570755294533a4811ded0a0e865d226bd7ef209940aa202bbe4c658ae`。
  目标分析指纹：`b44e3ca25697f4ac8b4afefbd3bf786cfb9c927d3eac9cb3c1ab0af1addca45f`。
- 第一次 apply 因源端 10 条孤立答疑的父比赛不存在而验证失败，已按清单完整回滚；
  修正为审计排除后第二次 apply 成功。两次过程均保留在 `audit.jsonl`。
- 最终 `verify-report.json` 为 `ok: true`、引用检查 98,975 项、文件检查 788 项、
  用户名/有效邮箱重复均为 0；`hydrooj` 已重新启动。
- 通过的检查：TypeScript 构建、exam 纯测试、exam 文件 ESLint、dry-run、正式
  apply/verify、exam 首页/题目/比赛入口 HTTP 抽查。完整 `npm test` 的两个失败属于
  既有测试，与本迁移无关：`Exports files from referenced problems using source-domain
  permissions` 和 `Does not expose hidden OI results through global problem status views`。

## 已确认的迁移输入（用于复核，不替代包内计数）

以下数字来自本次迁移需求确认。真正 apply 前，以导出包的 `manifest.json` 和新生成
的 `plan.json` 为准；如果数量不同，应停止并重新分析原因。

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

本轮合并后的目标计数（以 `verify-report.json` 为准）：4,576 用户、849 个 exam
成员、2 个用户组、159 个文档（117 题、13 场比赛、14 篇题解、15 条有父对象的
答疑）、12,993 条提交、8,532 条状态、4,559 条统计、1,882 条历史和 795 条存储
元数据。原有 17 道题、2 场比赛、6 条提交和 8 条状态均保留。

计划判定为 530 个新用户、4 个精确身份别名、15 个题目复用、8 个健康外部引用、
92 个题目实体化；生产 11 场比赛均因题目集合或时间与本地对象不完全相同而新增。
10 条源端父比赛缺失的答疑记录写入 `plan.json.excludedDocuments`，未导入。

确认的用户映射、12 组用户名冲突、8 个健康题目引用和 `@test.com` 规则都已经是
代码中的唯一来源：

- `packages/migrate/exam.ts` 的 `CONFIRMED_USER_MAP`
- `packages/migrate/exam.ts` 的 `USERNAME_CONFLICT_MAP`
- `packages/migrate/exam.ts` 的 `CONFIRMED_DECISIONS`

不要为了适配恢复后的本地 UID 修改这些常量。目标 UID、ObjectId、存储 ID 和
`planHash` 必须由恢复后的目标重新 `analyze` 生成。

为便于人工复核，本轮确认值如下（箭头左侧为源 UID/PID，右侧为目标 UID/PID）：

```text
人工用户：1558→2047, 1605→2381, 1632→3859, 1682→1514, 1716→2553,
1888→2927, 1996→595, 2013→3781, 2106→3494, 2110→3520, 2121→3480,
2124→3510, 2142→3529, 2144→3492, 2146→3507, 2147→3500, 2151→3503,
2156→3464, 2159→3482, 2160→3479, 2170→3513, 2172→3486, 2177→3616,
2208→3676, 2242→1970, 2257→3564, 2310→2992

用户名冲突（用户名优先）：1383→3919, 1450→2363, 1582→3525,
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

如果这个源包曾经在另一份目标库上尝试过 apply，不要直接在旧目录上覆盖
`plan.json`、`apply.json` 或 `backup/`。先把旧目录作为历史审计副本保留，再建立一个
新的工作目录，只复制不可变源包内容：

```sh
SOURCE_PACKAGE="$PWD/migration-runs/<old-run-id>"
RUN_DIR="$PWD/migration-runs/<old-run-id>-rerun-YYYYMMDD"
test ! -e "$RUN_DIR" || { echo "工作目录已存在，停止以避免覆盖" >&2; exit 1; }
install -d -m700 "$RUN_DIR"
cp -a "$SOURCE_PACKAGE/manifest.json" "$SOURCE_PACKAGE/package.sha256" "$RUN_DIR/"
cp -a "$SOURCE_PACKAGE/collections" "$SOURCE_PACKAGE/files" "$RUN_DIR/"
```

不要修改复制后的 `manifest.json` 或 `package.sha256`；它们仍代表同一个源包，新的
目标分析会在这个目录生成新的 `plan.json`、命令记录和验证报告。

## 目标库恢复后的最短重跑流程

下面的 `RUN_DIR`、URI 和存储根目录均为占位符。凭据建议在仓库外的 `0600` 环境
文件中提供，避免写进 shell 历史或本记录。

```sh
export RUN_DIR="$PWD/migration-runs/<run-id>"
export TARGET_URI='mongodb://<目标凭据>@<目标主机>/'
export TARGET_DB='hydro2'
export TARGET_STORAGE_ROOT='/srv/hydro2-storage'
export EXAM_MIGRATE='node -r @hydrooj/register packages/migrate/bin/exam-migrate.js'
```

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
   且 8 个引用题目仍为健康实体。

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
- **目标出现 exam 域、迁移标记或路径碰撞时停止。** 先验证是否是本次 run 的残留，
  通过 `rollback` 或目标备份恢复处理，不能用 `--no-stop`/手工删除绕过保护。
- **真实环境必须重新做身份和题目分析。** 本地目标 UID、ObjectId、存储 ID、
  `targetBefore.hash` 都不可带到另一套环境；只复用源包和代码中已确认的判定规则。
