# 0a22f79 评审意见核验与修复

评审基线：`0a22f79f11c443ac8aa9adcbc605918bb520f68d`，开始时工作区干净。输入：`C:\Users\leeson\Downloads\hydromod-review-0a22f79.md`。本轮只处理该报告中的七项问题，不发布、推送或操作部署数据。

## 逐项判断

| 意见 | 判断与证据 | 本轮处理 |
| --- | --- | --- |
| R1 / P1 | 有效。原始源码副本上，完整缓存预热后的只读 Bearer HTTP 请求错误返回 200。用户名、邮件、列表也会预热同一缓存。 | 缓存完整权限的基础用户，每次按当前 scope 返回独立视图，私有用户仍按视图 scope 创建。保持缓存别名与失效机制。 |
| R2 / P1 | 有效。课程详情、讲义、题目关联课程响应会携带整个 `lecture`。框架 JSON 序列化不提供材料授权。 | 在课程插件公共响应出口投影所有嵌套课程文档，非管理者移除完整 `lecture` / `lectureMeta`；当前已授权讲义仍以单独 `lecture` 返回。不修改原数据库对象，保留未改变对象和序列化字典身份。 |
| R3 / P1 | 有效。原始源码上学生附件上传、删除均能通过。存储层的 uid 是操作记录。 | 正文、上传、删除使用相同 owner/maintainer + SELF 或全局 EDIT 检查，并在任何写入前执行。同名上传替换元数据，数量/大小限制扣除旧文件。 |
| R4 / P2 | 有效。SELF 位本身无归属语义，而且默认用户权限包含 SELF，影响并不限于教师。 | 收紧课程访问绕过、讲义编辑/阅读、学生名单、下载、成绩板与导出。班级教师的课堂反馈权限继续由现有反馈授权决定。旧 HTTP 测试中无关 SELF、未入课学生成绩板 200 的预期改为 403；正式入课学生仍可看公开成绩板。 |
| R5 / P2 | 有效。真实临时 MongoDB 的屏障交错复现教师 deny 被覆盖、退课状态重建、重新入课状态与判题进度被旧请求覆盖。 | 自动开放逐节点条件更新，仅填尚未设置的 `allow`，不写 attend、不 upsert；状态 `_id` 绑定原入课实例，accept/进度/测评快照条件保护派生值。详情页的 startAt 自动写也禁止 upsert。 |
| R6 / P2 | 有效。原始模板在 0/100/200ms 切换丢第三个事件。 | 可见性、焦点、全屏按相邻状态去重，所有真正转换保留。离散粘贴事件逐次入队，仍沿用既有 120 条队列上限。 |
| R7 / P2 | 有效，但属于诊断口径问题，未证明公开 RP 污染或 Practice Rating 前瞻验证有同一缺陷。 | 保留算法，`calibrationHeldOut` 改为 `calibrationDiagnostic`，明确 `independentPredictionValidation:false`、全量难度拟合、斜率样本与不可估计数量；修正操作指南、历史报告与函数注释。该诊断不能作为样本外性能证据。 |

七项均接受；没有为未经证实的扩展影响添加修复。报告中的 CI failure 未作为代码缺陷接受，因为没有失败步骤证据。

## 不变量与写入方复核

| 不变量 | 相关写入方 / 出口 | 保护方式 |
| --- | --- | --- |
| 请求权限受当前 session scope 限制 | ID / name / mail / list 缓存预热、用户中间件、private 视图 | 共享基础对象不接收 session scope；调用者视图独立 |
| 未开放讲义不进入学生响应 | 课程详情、讲义、参考代码、成绩板、题目/题解钩子、嵌套关联列表 | 公共 after 钩子在专用响应注入后投影；已授权正文独立返回 |
| 附件写入必须具有课程管理权限 | 正文、上传、删除 | 统一归属检查先于存储和课程更新 |
| 撤销优先于旧的自动进度请求 | 手工 allow/deny/reset、cancelAttend/attend、判题统计、updateAllowedNodes、详情 startAt | 原状态身份 + 现值条件；逐节点更新；禁止自动 upsert |
| 状态转换不会被一秒去抖丢失 | 浏览器状态事件、发送重试、服务端配对 | 相邻状态去重，沿用事件身份与 ACK |

从原始基线复核全部最终改动，未发现本轮范围内仍需处理的 P0–P2 问题。

## 验证

- 新回归先在 `/tmp` 的固定提交源码副本上运行：只读权限、课程内容出口、附件权限、SELF、四种并发交错和三种亚秒状态切换均复现错误；用于新投影函数的测试在基线上不存在，不计为缺陷复现。
- `node --test test/review-security.spec.js test/contest-assessment-monitor.spec.js`：缓存/HTTP Bearer、附件角色矩阵、投影身份、MongoDB 屏障交错；客户端快速转换接入真实服务端事件模型，验证第二段 30000ms 时长、重试、重复事件，以及既有队列溢出和导航恢复。
- 真实 Hydro HTTP 回归新增到 `test/classroom-feedback.integration.js`：课程详情、JSON/noTemplate、开放讲义、题目附带课程与普通题目关联列表不包含唯一未开放内容标记；关闭讲义和无关 SELF 编辑返回 403；教师合法编辑正常；未授权附件 POST 无可见数据库/存储副作用。
- `NODE_OPTIONS=--require=/home/leeson/Hydro/test/classroom-feedback-test-isolate.cjs yarn test`：完整测试使用隔离 profile、临时 MongoDB，包含真实 Hydro HTTP。
- `yarn lint:ci`、`yarn build`、`yarn build:ui:production:webpack`、`git diff --check`。

限制：没有部署、远端 CI 或真实浏览器运行；监考使用执行原模板的可控浏览器 harness 与真实 MongoDB 服务端配对。历史评分数值未重新计算，独立预测验证需另行设计训练/验证隔离。队列超过既有 120 条上限时仍按原策略丢弃最旧事件；本轮解决的是上限内状态转换被去抖丢失的问题。

工作区没有需要排除的既有改动。
