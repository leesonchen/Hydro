# Hydro 发布与浏览器系统测试

## 日期与比赛设置修复

本轮测试时，hydro部署为后端`5.0.7-dev.2` / UI `4.58.5-dev.5`。24项相关代码/构建测试和18项浏览器回归全部通过；此处记录的是该轮测试的版本快照。

- [修复与浏览器报告](fixes/2026-10-13-course-datetime/system-test-report.md)
- [Release note](fixes/2026-10-13-course-datetime/release-notes.md)
- [18项逐项结果](fixes/2026-10-13-course-datetime/evidence/browser-results.json)


## UI dev.4 课程模板状态修复记录

前一轮修复使用 `hydrooj 5.0.7-dev.2` / UI `4.58.5-dev.4`。后续修复普通课程误判模板的问题，原 dev.2 发布测试结果保留为历史证据。

- [修复与浏览器回归报告](fixes/2026-10-12-course-template/system-test-report.md)
- [修复版 Release note](fixes/2026-10-12-course-template/release-notes.md)
- [针对性用例计划](fixes/2026-10-12-course-template/test-cases.json)


## 原 dev.2 发布测试

目标容器为 `hydro`，地址为 `http://localhost:8082`，现有 `exam` 域采用只读检查；写入用例使用独立临时域。

| 包 | 升级前实际安装 | 本次实际安装 |
| --- | --- | --- |
| hydrooj | 5.0.7-dev.1 | 5.0.7-dev.2 |
| @hydrooj/ui-default | 4.58.4-dev.41 | 4.58.5-dev.2 |

- [Release note](releases/2026-10-12-dev.2/release-notes.md)
- [系统测试报告](releases/2026-10-12-dev.2/system-test-report.md)
- [53 项系统用例](releases/2026-10-12-dev.2/test-cases.json)
- [最终逐项结果及重测来源](releases/2026-10-12-dev.2/evidence/browser-results.json)
- [课程普通编辑的遗留缺陷](releases/2026-10-12-dev.2/defects.md)
- [全部临时域清理核验](releases/2026-10-12-dev.2/evidence/final-cleanup-verification.json)

最终共 53 项：51 通过、1 失败、1 因账号能力阻塞。浏览器用例为 51 项，其中 49 通过；另有 2 项通过的认证 CLI 补充检查。初次驱动与夹具校准不计入最终统计，其观察与重测证据保留在 `evidence/attempts/`。

失败项是普通课程编辑返回 400 的遗留问题；两个发布包均存在相同触发逻辑。本轮保持被测发布版本不变，未修改产品代码。阻塞项是普通消息的空输入发送测试，给定的两名测试用户均没有普通全站发信权限；内容反馈及其独立回复权限已通过浏览器验证，授权的测试消息已清理。

## 后续复用

使用 `$hydro-release-system-test`。已安装的个人 skill 位于 `~/.codex/skills/hydro-release-system-test/`，仓库保留 [skill 源文件](skills/hydro-release-system-test/SKILL.md)。

在仓库根目录运行脚本。下面的 `<run>`、容器名和发布目录需替换为下一次实际环境，不要直接以 Git 日期作为发布基线。

```bash
node doc/test/scripts/compare-releases.cjs \
  --container hydro \
  --previous /root/.hydro/dev-releases/<previous> \
  --current /root/.hydro/dev-releases/<current> \
  --out doc/test/releases/<run>/evidence/release-comparison.json

node doc/test/scripts/browser-system-test.cjs \
  --container hydro \
  --cases doc/test/releases/<run>/test-cases.json \
  --out doc/test/releases/<run>/evidence

node doc/test/scripts/extra-course-test.cjs \
  --container hydro \
  --out doc/test/releases/<run>/evidence/extra-course

node doc/test/scripts/generate-report.cjs --run doc/test/releases/<run>
```

浏览器脚本默认使用根目录 `testuser.txt` 的本地标签账号，并屏蔽 Chrome 对外网的访问。可通过 `HYDRO_TEST_BASE_URL`、`HYDRO_TEST_DOMAIN`、`HYDRO_TEST_CREDENTIALS`、`HYDRO_TEST_CHROME` 指定环境。它依赖仓库现有 Node 模块、Docker 权限、Chrome 和正常运行的判题服务；本次验证环境为 Node 22、Chrome 141。

只有已得到真实消息发送授权时才给主脚本增加 `--allow-feedback`。`--only ID,ID` 用于针对性重测，须带上前置用例并使用独立输出路径；合并最终结果时保留证据相对路径，不能用未执行的 `skipped` 项覆盖原结果。模板保存/复制由额外脚本执行，应将其计划与结果并入矩阵后再生成报告。

脚本不会自动发布或升级。开发版发布与更新继续遵守根目录 [AGENTS.md](../../AGENTS.md)。
