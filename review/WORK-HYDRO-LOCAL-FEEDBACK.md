# Work／Codex：完成 Hydro 本地课堂反馈

仓库：leesonchen/hydromod  
开发分支：work/hydro-local-feedback-20261005  
目标分支：course-v2.2  
核对基线：01014e9957820d77bc4322438801ce6abdd8d0bc

请继续实现本分支的 H1-H3。保持 Draft PR，不自行合并、发布或部署。

## 先读
根及路径适用的 AGENTS.md、`review/hydro-local-feedback-development-plan-2026-10-05.md`、`packages/hydrooj/src/lib/classroomFeedback.ts`、`test/classroom-feedback.spec.js`，再核对当前课程、班级、作业、权限、路由、CSRF、数据库和模板实现。

## 不可改变的边界
Hydro 独立完成线下反馈的认证、授权、录入、保存、查询、撤销和待复测。保存链路不得调用 AI-EDU，不要求 AI-EDU 账号、密钥、地址、共享身份服务或新增队列组件。

只做“指导过／核对过／需复测”，备注与细项可空，无提交学生也可记录。“核对过”不自动等于掌握，没有记录不等于独立。不得改变判题结果、课程成绩、RP、Rating 或比赛难度。

## 当前真实进度
已有输入契约、本地幂等 writer 和 49 项单元测试；没有 HTTP 路由、真实 MongoDB 适配、业务权限解析或界面。
单元测试和核心 strict/noEmit 检查在 Node 22.16.0＋预装 TypeScript 5.8.3 下通过。仓库声明 TypeScript 6.0.3；全量构建、lint、真实数据库和浏览器尚未验证。

## 实施顺序
H1：复用 Hydro MongoDB，新建独立事件集合和索引，实现业务权限、同源 API、本地查询、追加撤销和复测处理事件。
H2：课程管理内三个快捷动作，无提交学生入口、最近记录、待复测、稳定重试键、清楚的保存状态；再增加记录页预填。
H3：功能开关、真实 MongoDB＋HTTP＋浏览器测试、AI-EDU 不可达测试、备份恢复、性能和常规回归。材料可得条件在主闭环后接入。

主体身份来自 Hydro 会话，核验域、活动、名单、题目、节点和可选 rid。self 权限不是全域教师权限；每次重试也要重新授权。
通过稳定请求键和数据库唯一约束防重复。未获数据库确认不能返回成功；第二次日志、缓存或同步失败不得导致原始事实重复创建。

AI-EDU 消费端、同步平台、AI 分析、线上 IDE 轨迹不在本轮范围。

## 验证与交付
在锁定依赖环境运行 `yarn test:classroom-feedback`，补真实数据库、HTTP、页面测试，再运行 `yarn build`、`yarn test`、`yarn lint:ci`，修改 UI 时运行对应 UI 构建。
覆盖计划第 9 节，无法运行的项目说明原因，不捏造通过。不得擅自修改锁文件或稳定版本，也不得调用发布脚本。
交付代码、测试、计划进度和真实验证结果；功能闭环及集成验证完成前保持 Draft。
