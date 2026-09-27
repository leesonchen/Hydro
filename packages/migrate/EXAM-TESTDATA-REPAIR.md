# exam 题源测试数据修复

2026-09-23 的 `exam-export-37018-20260923-p105` 包记录了 62 道被实体化复制的
exam 题，但这些源 exam 文档本身是 `prepare` 引用，`data=[]`。旧导出程序只打包了
exam 域的文件，没有跟随引用打包 `prepare` 的测试数据。因而旧目标中这些题目没有
测试数据，并不表示 37018 的有效题源也没有测试数据。**不要把旧包再做一次完整
`apply`**：它会重新处理用户、比赛、成绩和提交，不能用来补文件。

修复后的 `export` 会把 `prepare` 的有效配置、测试数据、附加文件及物理文件 SHA-256
写进独立快照；新包可用于尚未迁移目标的完整合并。已完成旧合并的目标应使用下述
独立回填命令，只更新这 62 道题的 `config`、`data`、`additional_file`，并新增对应
storage 元数据和文件。P105 继续复用 `exam/9 → contests/3230`，不在回填清单中。

## 前提

- 37018 必须保持停写；只从它导出，不对其执行 `apply` 或 `rollback`。本流程**绝不
  连接 37017 作为写入目标**。
- 恢复本地 `hydro2` 和有效的 37018 只读认证，确认执行环境能访问各自物理存储。
  `hydro2` 的容器名不是数据库名；此前 `local` 配置对应的数据库名是 `hydro`，
  仍需以当前配置核实。
- 保留旧 run 目录中的 `plan.json`、`apply.json`，以及目标库中的已完成
  `exam.migration` 标记。新源包、旧 run 和回填 run 必须是**三个独立目录**。
- 凭据通过仓库外的受限环境文件提供，不要把 URI 密码放入命令行历史或报告。

## 新导出包（37018 只读）

在能读取 37018 MongoDB 和文件存储的环境执行；`--source-storage-root` 必须指向
37018 的真实 `/data/file/hydro`，不是本地 hydro2 的目录：

```sh
node -r @hydrooj/register packages/migrate/bin/exam-migrate.js export \
  --source-uri "$SOURCE_URI" --source-db hydro \
  --source-storage-root "$SOURCE_STORAGE_ROOT" \
  --run-dir migration-runs/exam-export-37018-YYYYMMDDHHMMSS
```

检查新 `manifest.json` 中存在 `materializedProblems` 和
`collections/materialized-problems.jsonl`；逐题清单、文件 SHA-256 和导出异常记录
保存在源包中。导出若报缺失的 `prepare` 文档、storage 元数据或物理文件，应先查明
源端情况，不要编造空文件或关闭检查。旧包缺少这份快照，不能直接用于回填。

## 已合并本地目标的回填

以下命令须在同一个可连接**本地目标** MongoDB 且可访问本地物理存储的环境执行。
`REPAIR_RUN` 不是源包子目录；它的 basename 只用字母、数字、`_` 或 `-`。

```sh
OLD_RUN="$PWD/migration-runs/exam-export-37018-20260923-p105"
NEW_PACKAGE="$PWD/migration-runs/exam-export-37018-<新run-id>"
REPAIR_RUN="$PWD/migration-runs/exam-testdata-<新run-id>"
EXAM_MIGRATE='node -r @hydrooj/register packages/migrate/bin/exam-migrate.js'

$EXAM_MIGRATE testdata-analyze \
  --prior-run-dir "$OLD_RUN" --source-package "$NEW_PACKAGE" \
  --repair-run-dir "$REPAIR_RUN" \
  --target-uri "$TARGET_URI" --target-db hydro
```

`testdata-analyze` 只读取目标，校验旧迁移已完成、源包哈希、62 道候选题的目标
映射及当前题面/空测试数据，生成目标文档指纹和 `planHash`。先人工核对
`$REPAIR_RUN/plan.json` 中 `items` 恰好为 62 道、目标 PID 与旧计划相符、每道
都有测试数据和非空文件清单；数量或题目不符时停止。旧计划的目标 UID/PID 只能用于
这一个已完成的本地目标，不能带到另一库。

经确认后执行零目标写入的预检；`--dry-run` 只会更新回填审计目录：

```sh
PLAN_HASH="$(node -p "require('$REPAIR_RUN/plan.json').planHash")"
$EXAM_MIGRATE testdata-apply \
  --prior-run-dir "$OLD_RUN" --source-package "$NEW_PACKAGE" \
  --repair-run-dir "$REPAIR_RUN" \
  --target-uri "$TARGET_URI" --target-db hydro \
  --target-storage-root "$TARGET_STORAGE_ROOT" \
  --plan-hash "$PLAN_HASH" --dry-run
```

正式回填默认暂停本地 `hydrooj`、执行目标 `mongodump`，再以独立迁移标记和逐文件
清单写入；完成后会二次验证，成功才重启服务。只能在目标已被其他方式隔离时使用
`--no-stop`；`--no-backup` 不用于真实目标。

```sh
$EXAM_MIGRATE testdata-apply \
  --prior-run-dir "$OLD_RUN" --source-package "$NEW_PACKAGE" \
  --repair-run-dir "$REPAIR_RUN" \
  --target-uri "$TARGET_URI" --target-db hydro \
  --target-storage-root "$TARGET_STORAGE_ROOT" \
  --plan-hash "$PLAN_HASH"
```

之后保留整个回填 run（`plan.json`、前像、`apply.json`、备份、审计和
`verify-report.json`），抽查代表性题目的题面、配置、测试点与一条历史提交。
验证不会重判历史提交。若验证失败，保持服务停止；先检查回填清单和日志，必要时用
`testdata-rollback` 加相同目录参数、`--target-storage-root` 和 `--yes` 回滚本轮字段、
storage 元数据及未被改动的本轮文件。不要手工删除旧迁移标记或其他域文件。

完整重新迁移时使用**新包**直接 `analyze`/`apply`，无需再跑回填；完整迁移的 apply
会将快照文件自动实体化，并在复用 P105 前逐文件比对 `contests/3230` 与新包快照的
SHA-256。未重新分析目标、未确认新计划哈希或未通过文件验证，不得进入生产操作。
