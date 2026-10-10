# Hydro 练习评分远端修复本地复验

- 日期：2026-10-10；分支：`work/rating-all-data-shadow`。
- 拉取后的验证基线：`9f86fc37222d4e0f031180ad53d17c897a39d6f2`，开始时工作区干净且与 `origin` 一致。
- 独立评审范围：`f80f3a26` 至上述基线及本轮修复，包含管理员权限、配置部分更新、写入租约状态、模板、回归测试与 CI 工作流。

最新远端修复经本地复验通过；初次发现的 Lint 与测试失败已修复。此结论覆盖现有依赖环境中的检查、构建和测试，不代表远端 GitHub Actions 已成功，也不代表真实未来预测效果已获验证。

## 发现与修复

| 问题 | 复现证据 | 本轮处理 |
| --- | --- | --- |
| CI Lint 的零警告门禁失败 | `store.ts` 与配置脚本各有一行超过 150 字符；初轮 `yarn lint:ci` 退出 1 | 拆开快照计数字段、缩短配置脚本说明，保持原行为 |
| 中断快照 Mongo 用例未选中模拟记录 | 初轮 17/18 通过；用例先保存当前快照，再插入 `capturedAt=Date.now()-10000+1` 的记录；按时间降序读取时得到 `complete` | 以真实旧 run 的 `capturedAt+1` 明确模拟后续写入，验证无租约、有效租约和过期租约时的状态，并断言旧有效指针不变 |
| 新增 Mongo 测试未通过独立静态检查 | 默认 CI 不编译或 Lint `test/`；字符串 run ID 在未声明类型的 Mongo collection 上产生两处 TS2322，文件末尾还有一处 `padded-blocks` | 与现有 run 测试一致声明 `collection<any>`，移除多余空行；独立类型检查与 Lint 通过 |

额外补充实际入口回归：

- 真正执行 Schemastery 校验后，省略 `excludedUids` 保留旧配置，显式 `[]` 清空；null、字符串、零、非整数、数组内字符串和不安全整数均拒绝，整个原配置保持不变。
- sudo 会话除了代入普通学生，还覆盖代入后仍拥有管理员权限的身份；课程和作业试用 URL 均为 403，课程页面不显示试用导航。
- 只有系统管理权限、没有隐藏题目权限的账号不能选择隐藏题目，列表也不暴露它；拥有相应题目权限的管理员仍可读取。测试结束恢复账号权限和题目状态。

## 核对的契约

| 不变量 | 实际保护 |
| --- | --- |
| 配置部分更新不清空其他字段 | configure 在校验后只 `$set` 显式提供的字段；排除名单去重排序并保存 checksum |
| 试用只允许管理员本人会话且显式开启 | `PRIV_EDIT_SYSTEM`、会话 UID 一致、无 `sudoUid`、域级 `adminTrial`；旧 `teacherTrial` 不授权 |
| 管理权限不扩大域或题目可见性 | 保留通用 HTTP 层的域可见权限检查和 `problem.canViewBy`；没有绕过权限的新增入口 |
| 中断／失败不替换有效 R/D | 保存写入者 `leaseToken`；只对 `writing` 的最近运行检查租约，读取仍使用完整活动 run；状态诊断不写数据库 |
| 旧评分、提交和排名保持原契约 | 影子集合独立，Mongo 回归断言源记录与旧用户／题目字段未被改变，既有比赛与练习回归通过 |

独立评审及本轮修复后的复核未发现明确可行动的 P0–P2。域可见性是既有访问前提；`PRIV_EDIT_SYSTEM` 单独不保证访问所有私有域，未把它改成全域权限。

## 实际验证

| 命令 | 最终结果 |
| --- | --- |
| `yarn lint:ci` | 退出 0；零警告 |
| `yarn build` | 退出 0；已重新编译最新 Hydro 源码 |
| `yarn test:practice-rating:integration` | 退出 0；Mongo 集成 18/18、预测验证 6/6，无跳过或取消 |
| `node --test test/classroom-feedback-entry.js` | 退出 0；独立 HTTP／真实模板 29/29，无跳过或取消 |
| `yarn test:practice-rating` | 退出 0；提取器 28/28、联合 1PL 10/10 |
| `yarn test` | 退出 0；19 批共 367/367，末批 HTTP 67/67，无跳过或取消 |
| `yarn build:ui:iconfont` | 退出 0 |
| `yarn build:ui:production:webpack` | 退出 0；生产 UI 编译成功 |
| 新增 Mongo 测试的独立 ESLint、TypeScript 检查 | 退出 0；补足默认 CI 不覆盖 `test/` 的检查 |
| `git diff --check` | 通过 |

环境：Node 22.16.0、Yarn 4.14.1；Mongo 测试使用已缓存的 MongoDB 8.2.1 和独立 `MongoMemoryServer`。初次沙箱运行因端口监听 `EPERM` 在 before hook 失败，未执行用例；获准后在隔离实例运行，未连接业务数据库。完整测试通过仓库的隔离预加载文件运行：

```bash
CI=true MONGOMS_SYSTEM_BINARY=/home/leeson/.cache/mongodb-binaries/mongod-x64-ubuntu-8.2.1 \
  yarn test:practice-rating:integration
CI=true MONGOMS_SYSTEM_BINARY=/home/leeson/.cache/mongodb-binaries/mongod-x64-ubuntu-8.2.1 \
  node --test test/classroom-feedback-entry.js
CI=true MONGOMS_SYSTEM_BINARY=/home/leeson/.cache/mongodb-binaries/mongod-x64-ubuntu-8.2.1 \
  NODE_OPTIONS=--require=/home/leeson/Hydro/test/classroom-feedback-test-isolate.cjs yarn test
yarn exec eslint test/practice-rating-integration.spec.ts --max-warnings=0
yarn exec tsc --ignoreConfig --noEmit --skipLibCheck --target es2022 \
  --module preserve --moduleResolution bundler --esModuleInterop --strict false --types node \
  test/practice-rating-integration.spec.ts
```

生产 UI 构建缺少 Sentry token，因此提示不创建 release、不上传 source map；构建本身成功。未重装依赖、发布软件包、升级安装实例、合并或部署。

额外的全文件 `eslint test/classroom-feedback.integration.js --max-warnings=0` 仍退出 1：8 个错误、32 个警告。使用 `git show 9f86fc37:test/classroom-feedback.integration.js` 和当前文件分别送入同一 ESLint 配置，按规则、严重度和诊断文本对账，结果完全一致；均位于本轮新增用例之外。该文件不在默认 `lint:ci` 范围内。本轮记录此既有问题，没有为通过额外检查而改写无关测试。

临时日志：`/tmp/hydro-rating-remote-verify-{build,lint,integration,http,test,iconfont,ui,extra-lint,extra-types}.log`；最终 Lint／类型构建另存同前缀的 `{lint,build}-final.log`，初轮失败另存 `integration-sandbox.log` 与 `integration-initial.log`。HTTP 文件额外 Lint 对账见同前缀的 `http-lint-{baseline,current}.json`。这些日志没有加入版本控制；构建生成的根 `tsconfig.json` 恢复原内容。

真实未来作答、M3-03 独立模拟、安装环境受控试用和 `cpptrain` 超过 20 万条记录的完整处理方案仍待完成。此前逐域只读试算结论见[模拟反馈报告](practice-rating-local-simulation-feedback-2026-10-10.md)，本轮没有把训练内复算当成未来预测效果。
