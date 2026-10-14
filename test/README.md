# 自动化回归测试

本目录保存需要提交的测试源码、集成测试入口、复现脚本和测试夹具。不要将整个 `test/` 加入 `.gitignore`。

- `yarn test`：根 `package.json` 定义的回归测试集合。
- `yarn test:rating-publication` 等 `test:*` 命令：按功能运行；完整入口以 `package.json` 为准。
- 浏览器、容器或 HTTP 集成脚本可能创建数据，先阅读脚本的运行条件及清理逻辑，再选择对应环境执行。
- 本地账号文件 `test/testuser.txt` 与根 `testuser.txt` 均被忽略，不要提交真实账号、密码或会话数据。共享浏览器脚本优先读取根 `testuser.txt`，也可用 `HYDRO_TEST_CREDENTIALS` 指定本地文件。
- 临时输出写入 `test/.local/` 或根 `test-reports/`；团队交接只将精简报告和少量关键图片整理到 `doc/test/`；完整运行 JSON、批量截图和日志继续留在本地。

发布验证、浏览器测试和历史修复结论见 [测试文档](../doc/test/README.md)。
