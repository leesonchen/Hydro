# 课程题目门禁与测评并发修复

评估基线：`00034e66`。本轮只修改源码、测试和本文，不发布或操作部署数据。

## 判断与范围

两项发现均成立，属于此前修复未覆盖的既有问题。

1. `PERM_DEFAULT` 包含 `PERM_EDIT_HOMEWORK_SELF`，原题目入口把这一位单独当作章节门禁绕过权限。真实 HTTP 对照中，默认学生访问被手工禁止的课程题目返回 200，预期为 403。题目详情、提交页和实际提交共用该准备路径。
2. 测评成绩来自独立的测评状态，父课程的 `accept/score` 不随之变化。只保护父课程分数或缓存的 `assessmentResults` 不足以保证授权安全：即使没有第二个课程进度请求，旧请求仍能在判题降分之后新增 `allow:true`；在 journal 已写入、统计尚未写入的中途读取也可能误用旧成绩。

已有合法授权是单向保留的，教师可手工允许、禁止或重置。因此本次阻止的是基于失效读取新增授权，不因后来重评降分撤回已合法提交的授权，也不猜测历史 `allow:true` 的来源并清理数据。

## 最终实现

- 题目门禁绕过要求全局 `EDIT_HOMEWORK`、当前用户归属课程且具有当前 scope 下的 `EDIT_HOMEWORK_SELF`，或明确的 `VIEW_HIDDEN_HOMEWORK`。普通学生的 SELF 位不再绕过门禁。修复后也必须识别旧课程的合法章节编号 0，不能把它当成无绑定。
- 每次课堂测评状态写入在测评文档上登记独立 token，先使父课程状态的 `_assessmentRevision` 变化，再写源状态；结束时再次使父课程读取失效，然后只移除自己的 token。标记保存在测评文档，测评或父课程退课重入不会丢失它，重叠写入也不会提前清除另一操作的标记。
- 测评有未完成写入时，成绩读取返回 `score:null/completed:false`，避免 journal/统计的中间状态用于开放章节。
- 自动开放和进度保存同时比较原入课状态 `_id`、出勤、课程 `accept/score`、测评 revision 和缓存快照。自动开放只填未设置的键，进度更新不覆盖并发的新进度，也不 upsert 入课状态。
- 写入保护覆盖 `updateStatus`、`recalcStatus`、`attend`、`cancelAttend` 和 `setStatus`。普通比赛不写课堂标记；新增字段以 `_` 开头，现有序列化器不会把操作标记加入学生 JSON 响应。

这是适用于 standalone MongoDB 的状态写入协议，不要求启用副本集事务，也不宣称课程结构和配置变更的全库事务快照。底层 collection 的直接维护写入不属于 ContestModel 的协议，不能在有活动请求时绕过上述写入路径。

## 验证

- 原始源码通过 `/tmp` 中的只读源码拦截加载，工作树源码未被来回替换。默认学生 HTTP 门禁、稳定章节门禁以及测评成绩降级的回归在基线上失败；新增的纯操作标记断言不作为独立漏洞复现计数。
- 专项回归：`test/review-security.spec.js`、`test/contest-assessment-monitor.spec.js`、`test/submission-provenance.spec.js`、`test/contest-edit-settings.spec.js`，70/70 通过。覆盖 OI 分数和 ACM 通过数、all/problem/score 前置条件、判题降级、直接状态修改、重算、测评退课重入、撤销提前结束、没有新进度请求的旧授权、中途读取、新父课程入课、重叠写入、手工决策及失败路径。另检查比赛团队及练习记录连接两个回归文件，均通过。
- 真实 Hydro HTTP：默认学生明确禁止和未设置的章节均拒绝详情、提交页及 POST；拒绝不创建记录或任务、不改变课程/题目状态；手工开放可实际提交；owner/maintainer 的合法 SELF、全局编辑和隐藏内容查看权限正常；只读 owner/session scope 不绕过；编号 0 正常执行允许和禁止。
- `test/rating-v2-evidence.spec.ts`：17 项通过，课堂认证与评分证据判断未受影响。
- 修改的 TypeScript 文件 ESLint 无警告，`git diff --check` 通过。
- Hydro 类型检查仍有三处基线错误：`diagnosis.ts` 两处 `seqNoIndent` 类型、`loader.ts` 的 logger `Message.args`。同一命令在基线和修复后输出一致，本轮未新增类型错误。
- 完整课堂反馈 HTTP 套件修复后 29/31，通过项包含本轮门禁回归；剩余两项在原始源码也失败：logger 导出器 `args is not iterable`，以及模板服务初始化失败后 form 错误页从预期 400 变为 500。独立运行本轮两个 HTTP 门禁/章节用例均通过。

临时 MongoDB 使用已有二进制 `/home/leeson/.cache/mongodb-binaries/mongod-x64-ubuntu-8.2.1`，所有实例和 Hydro profile 都是隔离测试数据。

## 失败恢复边界

普通状态写入抛错时，`finally` 完成失效处理并释放自己的标记。若最终失效写入本身失败，或进程在协议中途退出，标记保留，相关测评暂时不能用于自动新增授权；已有授权和教师手工决策不受影响。回归已验证最终失效写入失败不会暴露旧成绩。

不按时间自动清除标记，因为仍在运行的延迟写入可能继续提交。恢复时先确认对应操作已结束且不会再写入，完成源状态核验/重算，然后使父课程 `_assessmentRevision` 变化，最后按实际遗留 token 移除标记，再刷新课程进度。本轮不执行线上恢复或清理。
