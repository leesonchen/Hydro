# 积分队列与时间历史布局修复

2026-10-13 完成修复，发布 Hydro `5.0.7-dev.7` / UI `4.58.5-dev.8`。发布前积分回归 105/105、Hydro TypeScript 编译通过，部署后 30 项浏览器与 CLI 补充用例全部通过。覆盖及限制见[发布复测报告](../../releases/2026-10-13-rating-queue-fix/system-test-report.md)。

## 评分任务长期排队

触发：管理员保存 V2 目标后点击“重算并应用”，任务持续 queued。模型先等待数据库索引初始化，再监听只触发一次的 `app/started`；事件可能在监听注册前已触发，导致 worker 永远没有注册该任务处理器。

修复：worker 与 timer 服务可用时立即注册处理器和恢复机制；CLI 跳过自动消费，仅主实例恢复任务，处理器及定时器随注入作用域卸载。回归测试延迟索引初始化并提前触发启动事件，验证真实 worker 能取出任务、完成运行并更新生效指针；另覆盖恢复、重载、定时器释放及实例边界。

实现：[rating-publication.ts](../../../../packages/hydrooj/src/model/rating-publication.ts)。回归：[rating-publication-runtime.spec.ts](../../../../test/rating-publication-runtime.spec.ts)。

## 删除域后遗留评分任务

原始及恢复创建的 schedule 缺少 `domainId`，常规域删除不能匹配。两个入口现保存域标识；删除域时，先按域或该域 run ID 删除评分任务，再删除 run，也清理缺少域标识的旧格式任务。

Mongo 回归和真实浏览器域删除确认：所属新旧任务移除，其他域的评分任务和其他任务类型保留；CLI 的域删除钩子有效。

## 时间修改记录文字重叠

复现：编辑比赛或课堂测试结束时间，保存后展开时间修改记录。通用 `.help-text` 的负上边距使提示文字与标题重叠。修复仅将历史提示段落设为 `margin-top: 0`，见 [contest_time_history.html](../../../../packages/ui-default/templates/partials/contest_time_history.html)。

| 视口宽度 | 修复前重叠 | 修复后重叠 |
| --- | ---: | ---: |
| 1500px | 8px | 0px |
| 800px | 8px | 0px |
| 375px | 6.5px | 0px |

以上为真实 Chrome 中的源码模板预览测量；部署后另在 1500px / 375px 下验证比赛和课堂测试，无文字重叠或横向溢出。

关键对照：[桌面修复前](../../assets/history-layout/desktop-before.png)、[桌面修复后](../../assets/history-layout/desktop-after.png)、[窄屏课堂修复后](../../assets/history-layout/mobile-after.png)。

复现脚本：[布局预览](history-layout-browser.cjs)。运行条件及归档约定见[测试目录说明](../../README.md)。完整截图、测量 JSON、日志和健康快照保存在本地归档；精简报告保留验证结论及其适用范围。
