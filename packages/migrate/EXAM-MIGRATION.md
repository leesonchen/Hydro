# exam 域审计迁移

`exam-migrate` 是一个只从源库读取、把源数据固化成不可变包，再对目标库执行受保护写入的工具。它不会调用 Hydro 的写 API，也不会写源 MongoDB。

## 1. 导出（源端停写）

先让生产 Hydro 停止写入，再在仓库根目录执行：

```sh
node -r @hydrooj/register packages/migrate/bin/exam-migrate.js export \
  --source-uri "$SOURCE_MONGO_URI" \
  --source-db hydro \
  --source-storage-root /srv/hydro-storage \
  --run-dir migration-runs/exam-export-YYYYMMDD
```

导出目录权限为 `0700`，其中用户集合可能包含 Hydro 密码凭据；命令日志只记录脱敏参数，不能把 URI、哈希或 Token 复制到工单。`manifest.json`、逐集合 JSONL（Mongo Extended JSON）、文件包、文件 SHA-256、缺失/排除文件清单和 `audit.jsonl` 都属于同一不可变包。个人文件不进入包；生产中声明但缺失的文件会进入排除报告。

## 2. 目标分析（只读 dry-run）

```sh
node -r @hydrooj/register packages/migrate/bin/exam-migrate.js analyze \
  --package migration-runs/exam-export-YYYYMMDD \
  --target-uri "$TARGET_MONGO_URI" \
  --target-db hydro2
```

`plan.json` 保存目标指纹、身份判定、题目复用/实体化判定、ObjectId 和存储路径映射、预期数量、排除报告和 `planHash`。用户身份顺序固定为：已确认映射、`unameLower`、规范化有效邮箱（`@test.com` 无效）、新用户。计划中的 27 组人工映射、12 组用户名冲突、8 个健康题目引用和悬空 `test`/`oler` 引用规则都可审计。

题目复用会额外记录源/目标测试文件名差异；差异只进入审计，不参与同题判定。

人工确认 `planHash` 后，必须在 apply 命令中原样携带它。重新分析目标会得到新的目标指纹和新的哈希，不得把本地 UID 直接带到另一套真实环境。

## 3. 应用与验证

正式应用前确认 MongoDB 在线，然后执行：

```sh
node -r @hydrooj/register packages/migrate/bin/exam-migrate.js apply \
  --package migration-runs/exam-export-YYYYMMDD \
  --target-uri "$TARGET_MONGO_URI" \
  --target-db hydro2 \
  --target-storage-root /srv/hydro2-storage \
  --plan-hash SHA256_FROM_PLAN
```

apply 会在写入前重新校验迁移包哈希、目标指纹、`exam` 域不存在、存储路径不会覆盖既有文件，并默认执行 `mongodump` 和 `pm2 stop hydrooj`。应用期间按“用户/system 成员 → 域/成员/组 → 题目 → 文件 → 比赛/题解/答疑 → 提交/历史/统计 → 状态”分阶段记录；提交附件按 exam 记录实际引用的 `submission/<uid>/<id>` 路径重写 UID。阶段失败会保留停止状态和回滚清单。`--no-stop`、`--no-backup` 只允许隔离的演练环境使用。

apply 成功后会在服务仍停止时自动运行 verify；验证失败时不会自动启动服务。验证成功才会执行 `pm2 start hydrooj`。

单独验证：

```sh
node -r @hydrooj/register packages/migrate/bin/exam-migrate.js verify \
  --package migration-runs/exam-export-YYYYMMDD \
  --target-uri "$TARGET_MONGO_URI" --target-db hydro2 \
  --target-storage-root /srv/hydro2-storage
```

验证报告检查集合数量、UID/PID/TID/RID 和嵌套父对象、`prepare`/悬空 `test` 引用、文件 SHA-256、榜单/状态/统计/重测历史引用及用户名/邮箱唯一性。不会重判历史提交。

## 4. 回滚

回滚需要明确确认，并默认暂停本地服务：

```sh
node -r @hydrooj/register packages/migrate/bin/exam-migrate.js rollback \
  --package migration-runs/exam-export-YYYYMMDD \
  --target-uri "$TARGET_MONGO_URI" --target-db hydro2 \
  --target-storage-root /srv/hydro2-storage --yes
```

回滚只删除本次应用清单中的文档和物理文件，最后移除迁移标记；目标中原有用户资料不会被覆盖或删除。若阶段失败，先检查 `apply.json` 和 `audit.jsonl`，再按同一命令回滚。

迁移包和审计目录被 `.gitignore` 排除，仓库只提交工具、测试和本手册。
