# Course Management Plugin - Design Document

## 文档目的

本文档详细记录 Course Management 插件的架构设计、核心模块、类和接口定义、数据流程等内容，便于后续维护和扩展。

---

## 1. 架构概览

### 1.1 整体设计

```
┌─────────────────────────────────────────────────────────────────┐
│                     HTTP 请求入口                              │
└─────────────────────────┬───────────────────────────────────────┘
                          │
        ┌─────────────────┴─────────────────┐
        │                                   │
   ┌────▼──────────┐             ┌─────────▼────────┐
   │ Course Route  │             │ Class Route      │
   └────┬──────────┘             └─────────┬────────┘
        │                                   │
   ┌────▼──────────────┐          ┌────────▼─────────┐
   │ Handler Layer     │          │ Handler Layer    │
   ├──────────────────┤          ├──────────────────┤
   │ CourseMainHandler │          │ ClassHandler     │
   │ CourseDetailHdlr │          │ ClassEditHandler │
   │ CourseEditHandler │          └──────────────────┘
   │ CourseManageHdlr │
   │ CourseLectureHdl │
   │ CourseFileDownHdl│
   │ CourseScoreboardHdl│
   └────┬──────────────┘
        │
   ┌────▼──────────────┐
   │ Model Layer       │
   ├──────────────────┤
   │ ContestModel     │          ┌──────────────────┐
   │ UserModel        │          │ ClassModel       │
   │ ProblemModel     │          │ CourseRule       │
   │ StorageModel     │          └──────────────────┘
   └────┬──────────────┘
        │
   ┌────▼──────────────┐
   │ Database Layer    │
   ├──────────────────┤
   │ document (课程)   │
   │ user.group (班级) │
   │ problem (题目)    │
   └──────────────────┘
```

### 1.2 核心设计原则

1. **模块化**：将功能分为 Handler（HTTP 处理）、Model（业务逻辑）两层
2. **数据隔离**：课程存储在 `document` 集合，班级存储在 `user.group` 集合
3. **权限管理**：使用 Hydro 的权限系统，细粒度控制访问
4. **灵活性**：支持 DAG 前置条件、自动解锁、多种完成条件

---

## 2. 文件结构

```
packages/course-management/
├── index.ts                          # 插件入口，主要功能注册
├── package.json                      # NPM 包配置
├── README.md                         # 用户文档
├── design.md                         # 本文档
├── model/
│   ├── class.ts                      # 班级模型（ClassModel）
│   └── course.ts                     # 课程规则（courseRule）
├── handler/
│   ├── course.ts                     # 课程相关 7 个 Handler
│   └── class.ts                      # 班级相关 2 个 Handler
├── templates/                        # HTML 模板（14 个）
│   ├── course_main.html              # 课程列表页面
│   ├── course_detail.html            # 课程详情页面
│   ├── course_edit.html              # 课程编辑页面
│   ├── course_lecture.html           # 讲义编辑页面
│   ├── course_manage.html            # 课程管理页面
│   ├── course_sidebar.html           # 课程侧边栏
│   ├── domain_class.html             # 班级列表页面
│   ├── domain_class_edit.html        # 班级编辑页面
│   └── 其他模板...
└── locales/
    └── zh.yaml                       # 中文翻译
```

---

## 3. 核心模块详解

### 3.1 Model 层

#### 3.1.1 ClassModel（班级模型）

**文件**：`model/class.ts`

**职责**：管理班级的 CRUD 操作

```typescript
export interface ClassGDoc {
  _id: ObjectId;
  domainId: string;
  name: string;              // 班级唯一标识（在域内）
  teachers: number[];        // 教师 UID 列表
  students: number[];        // 学生 UID 列表
  uids: number[];            // 所有成员（teachers + students）
  beginAt: Date;             // 班级开始时间
  endAt: Date;               // 班级结束时间
  archive: boolean;          // 是否归档（仅手动归档；用于过滤班级选择）
  class: true;               // 标识为班级（与普通组区分）
}

export const ClassModel = {
  // 列出班级，可选过滤某用户所在的班级
  async listGroup(domainId: string, uid?: number): Promise<ClassGDoc[]>

  // 按 ObjectId 获取班级
  async getGroupById(domainId: string, id: ObjectId): Promise<ClassGDoc | null>

  // 按名称获取班级
  async getGroupByName(domainId: string, name: string): Promise<ClassGDoc | null>

  // 删除班级
  async delGroup(domainId: string, id: ObjectId): void

  // 创建或更新班级
  async updateGroup(
    domainId: string,
    name: string,
    teachers: number[],
    students: number[],
    beginAt: Date,
    endAt: Date,
    archive?: boolean
  ): void
}
```

**关键实现细节**：
- 使用 `user.group` 集合存储班级数据
- 通过 `class: true` 字段区分班级和普通用户组
- 每次更新时调用 `deleteUserCache()` 清除用户缓存
- 归档不做自动化，仅用于 UI 选择/列表过滤
- `listGroup()` 支持按用户过滤，自动添加用户自己作为单人班级

#### 3.1.2 Course Rule（课程规则）

**文件**：`model/course.ts`

**职责**：定义课程的计分规则、成绩统计、排行榜渲染

```typescript
// 接口定义
export interface DagNode {
  _id: number;
  title: string;
  lecture?: string | boolean;
  pids: number[];
  requireNids?: number[];
  completeCondition?: {
    type: 'all' | 'problem' | 'score';
    value?: number;
  };
}

export interface CourseTdoc extends Tdoc {
  rule: 'course';
  dag: DagNode[];
  assign?: string[];
  lecture?: Record<number, string>;
}

// 核心函数
export const courseRule: ContestRule<CourseStatus> = {
  // 统计学生成绩和完成度
  stat(tdoc, journal): {
    score: Record<number, number>;     // {nodeId: totalScore, 0: total}
    accept: Record<number, number>;    // {nodeId: acceptCount, 0: total}
    detail: Record<number, any>;       // 题目详细结果
    progress: number;                  // 0-100
  }

  // 生成成绩板表头
  async scoreboardHeader(config, _, tdoc, pdict): ScoreboardRow

  // 生成成绩板每一行
  async scoreboardRow(config, _, tdoc, pdict, udoc, rank, tsdoc, meta): ScoreboardRow

  // 生成完整成绩板
  async scoreboard(config, _, tdoc, pdict, cursor): [ScoreboardRow[], UserDict]
}
```

**核心算法**：

1. **成绩统计流程**：
```
┌─────────────────────────────────┐
│ 遍历学生所有提交记录 (journal)   │
└──────────────┬──────────────────┘
               │
         ┌─────▼─────┐
         │ 按题目分组  │
         └─────┬─────┘
               │
    ┌──────────▼───────────┐
    │ 取每题最高分的提交     │
    └──────────┬───────────┘
               │
    ┌──────────▼───────────┐
    │ 按章节聚合分数和完成数 │
    └──────────┬───────────┘
               │
    ┌──────────▼───────────┐
    │ 计算总分和完成百分比   │
    └──────────────────────┘
```

2. **排名规则**：
   - 按总分降序排列
   - 总分相同时按完成数（降）排列
   - 完成数相同时按首次完成时间排列

### 3.2 Handler 层

#### 3.2.1 课程 Handler（`handler/course.ts`）

**7 个 Handler 类**：

##### 1. CourseMainHandler
- **路由**：GET `/course`
- **功能**：课程列表展示
- **关键逻辑**：
  - 按班级分组显示课程
  - 支持 `all` 参数查看隐藏课程
  - 自动分类：模板、未分配、活跃、归档

**查询逻辑**：
```typescript
// 查询条件（用户非管理员）
{
  rule: 'course',
  $or: [
    { assign: { $in: groups } },       // 分配给用户的班级
    { assign: { $size: 0 } },          // 未分配的课程
    { assign: null },                  // 新创建的课程
    { assign: { $exists: false } }     // 数据不完整
  ]
}
```

##### 2. CourseDetailHandler
- **路由**：GET `/course/:tid`
- **功能**：课程详情、题目列表、学习进度
- **关键逻辑**：
  - 检查课程分配和权限
  - 自动加入课程（教师用户）
  - 自动解锁可用章节（调用 `updateAllowedNodes`）
  - 渲染题目列表和学生提交记录

**权限检查**：
```typescript
if (tdoc.assign?.length) {
  // 课程已分配，检查用户是否在班级中
  if (!user.own(tdoc) && !Set.intersection(tdoc.assign, user.group).size) {
    throw new NotAssignedError();
  }
}
```

##### 3. CourseEditHandler
- **路由**：GET/POST `/course/create`, `/course/:tid/edit`
- **功能**：创建和编辑课程
- **关键逻辑**：
  - 权限检查（`PERM_CREATE_HOMEWORK` / `PERM_EDIT_HOMEWORK`）
  - DAG 验证和解析（调用 `parseDag`）
  - 模板创建（isTemplate 参数，模板=assign 到 TEACHERS 班级）
  - 仅允许选择未归档班级进行分配
  - 维护者豁免（maintainer 可查看题目/讲义）

**DAG 验证规则**：
- 必须是数组，且非空
- 每个节点的 `_id` 必须唯一
- 每个节点必须有 `title` 和 `pids`（题目必填）
- 所有题目必须存在
- 前置条件 `requireNids` 的节点必须存在
- 完成条件 `completeCondition` 的 type 必须是 'all'/'problem'/'score'

##### 4. CourseManageHandler
- **路由**：GET `/course/:tid/manage`，POST 权限管理
- **功能**：管理课程访问权限
- **API**：
  - `postVisit`：开放/取消学生访问权限
  - `postAllowUser`：开放/取消某用户某章节权限
  - `postAllowLecture`：开放/取消讲义权限

**权限结构**：
```typescript
{
  allow: {
    1: true,   // 章节 ID 1 可访问
    2: false,  // 章节 ID 2 不可访问
  },
  lectureAllow: {
    1: true,   // 讲义可访问
  }
}
```

##### 5. CourseLectureHandler
- **路由**：GET/POST `/course/:tid/lecture/:id`
- **功能**：讲义编辑和文件管理
- **API**：
  - `get`：显示讲义内容
  - `postUpdate`：更新讲义
  - `postUploadFile`：上传文件
  - `postDeleteFiles`：删除文件

**文件存储**：
- 路径格式：`contest/{domainId}/{tid}/public/{filename}`
- 限制：数量上限、总大小上限（来自系统设置）

##### 6. CourseScoreboardHandler
- **路由**：GET `/course/:tid/scoreboard/:id`
- **功能**：成绩板展示和导出
- **API**：
  - `get`：显示成绩板（或跳转导出）
  - `exportScoreboard`：导出为 CSV/HTML

**参数**：
- `:id` - 章节 ID（0 表示全部）
- `:ext` - 导出格式 (csv/html)

##### 7. CourseFileDownloadHandler
- **路由**：GET `/course/:tid/file/:filename`
- **功能**：下载课程文件
- **实现**：使用 StorageModel 获取签名 URL

#### 3.2.2 班级 Handler（`handler/class.ts`）

##### 1. ClassHandler
- **路由**：GET `/domain/class`
- **功能**：班级列表展示
- **实现**：简单调用 `ClassModel.listGroup()`

##### 2. ClassEditHandler
- **路由**：GET/POST `/domain/class/create`, `/domain/class/:id/edit`
- **功能**：班级创建、编辑、删除、课程复制
- **API**：
  - `get`：显示班级编辑表单
  - `postDelete`：删除班级及其所有课程
  - `postUpdate`：创建或更新班级
  - `postCopy`：从模板复制课程到班级

**核心逻辑**：

1. **班级创建/更新**：
```typescript
// 时间段解析
const beginAt = moment.tz(`${beginAtDate} ${beginAtTime}`, userTimeZone);
const endAt = moment.tz(`${endAtDate} ${endAtTime}`, userTimeZone);

// 保存班级
await ClassModel.updateGroup(
  domainId, name, teachers, students,
  beginAt.toDate(), endAt.toDate(), archive
);

// 同时更新所有关联课程的时间
await Promise.all(tdocs.map(t =>
  ContestModel.edit(domainId, t._id, {
    beginAt, endAt, maintainer: teachers
  })
));
```

2. **课程复制流程**：
```
选择模板课程
    ↓
解析模板的 DAG 结构
    ↓
对于每个 DAG 节点的题目：
├─ 如果是系统域，直接使用题目 ID
└─ 如果是其他域：
    ├─ 检查是否已复制过（查找 reference）
    ├─ 如果已复制，使用本地 ID
    └─ 如果未复制，调用 ProblemModel.copy()
    ↓
在本地域创建新课程，关联复制的题目
    ↓
复制文件到本地存储
    ↓
返回新课程信息
```

### 3.3 关键辅助函数

#### 3.3.1 updateAllowedNodes()
**位置**：`handler/course.ts`

**功能**：自动解锁满足条件的章节

```typescript
async function updateAllowedNodes(
  domainId: string,
  tid: ObjectId,
  uid: number,
  tdoc: CourseTdoc,
  tsdoc: any
): Promise<void> {
  const allow = tsdoc?.allow || {};
  let updated = false;

  // 对每个有前置条件的章节
  for (const node of tdoc.dag) {
    if (allow[node._id]) continue;  // 已解锁
    if (!('requireNids' in node)) continue;  // 无前置条件

    // 检查前置条件是否都满足
    const allRequirementsMet = node.requireNids!.every(nid => {
      const reqNode = tdoc.dag.find(n => n._id === nid);
      return checkNodeComplete(tsdoc || {}, reqNode);
    });

    if (allRequirementsMet) {
      allow[node._id] = true;
      updated = true;
    }
  }

  // 保存更新
  if (updated) {
    await ContestModel.setStatus(domainId, tid, uid, {
      allow,
      attend: true
    });
  }
}
```

#### 3.3.2 checkNodeComplete()
**位置**：`handler/course.ts`

**功能**：检查章节是否完成

```typescript
function checkNodeComplete(tsdoc: any, node: DagNode): boolean {
  let acceptCount = 0;
  let totalScore = 0;

  // 收集该章节的所有题目
  for (const pid of node.pids) {
    const records = tsdoc.journal?.filter((j: any) => j.pid === pid) || [];
    if (!records.length) continue;

    const best = records.sort((a: any, b: any) =>
      (b.score || 0) - (a.score || 0)
    )[0];

    totalScore += best.score || 0;
    if (best.status === STATUS.STATUS_ACCEPTED) {
      acceptCount++;
    }
  }

  // 根据完成条件判断
  const cond = node.completeCondition || { type: 'all' };

  switch (cond.type) {
    case 'all':
      return acceptCount === node.pids.length;
    case 'problem':
      return acceptCount >= (cond.value || 0);
    case 'score':
      return totalScore >= (cond.value || 0);
    default:
      return false;
  }
}
```

#### 3.3.3 parseDag()
**位置**：`handler/course.ts`

**功能**：验证和解析 DAG JSON 配置

```typescript
async function parseDag(domainId: string, dagJson: string): Promise<DagNode[]> {
  const result: DagNode[] = [];

  try {
    const dag = JSON.parse(dagJson);

    // 1. 基本验证
    assert(dag instanceof Array, 'dag must be an array');
    assert(dag.length, 'must have at least one node');

    const nodeIds = new Set(dag.map(n => n._id));
    assert(dag.length === nodeIds.size, '_id must be unique');

    // 2. 逐节点验证
    for (const node of dag) {
      assert(node._id, 'each node should have a _id');
      assert(node.title, 'each node should have a title');
      assert(node.pids instanceof Array && node.pids.length,
             'each node must contain at least one problem');

      // 3. 验证完成条件
      if (node.completeCondition) {
        assert(typeof node.completeCondition === 'object');
        assert(['all', 'problem', 'score'].includes(node.completeCondition.type));

        if (node.completeCondition.type === 'all') {
          assert(!node.completeCondition.value,
                 'completeCondition value must not be set for type "all"');
        } else {
          assert(node.completeCondition.value,
                 'completeCondition value must be set');
        }
      }

      // 4. 验证前置条件
      for (const nid of node.requireNids || []) {
        assert(nodeIds.has(nid), `required nid ${nid} not found`);
        assert(Number.isSafeInteger(nid), 'required nid must be a number');
      }

      // 5. 验证和转换题目 ID
      const pids: number[] = [];
      for (const pid of node.pids) {
        const pdoc = await ProblemModel.get(domainId, pid);
        if (!pdoc) throw new ProblemNotFoundError(domainId, pid);
        pids.push(pdoc.docId);
      }

      result.push({
        _id: +node._id,
        title: node.title,
        lecture: node.lecture || false,
        pids: Array.from(new Set(pids)),
        ...(node.requireNids ? { requireNids: Array.from(new Set(node.requireNids)) } : {}),
        completeCondition: node.completeCondition || { type: 'all' },
      });
    }
  } catch (e: any) {
    throw new ValidationError('dag', null,
      e instanceof ProblemNotFoundError ? e : e.message);
  }

  return result;
}
```

---

## 4. 数据流程

### 4.1 学生查看课程流程

```
GET /course/:tid
    ↓
[权限检查] 是否在分配的班级中？
    ├─ 否 → 403 NotAssignedError
    └─ 是 ↓
[自动加入] 教师用户或无状态记录？
    ├─ 是 → 调用 ContestModel.attend()
    └─ 否 ↓
[加载状态] 获取用户的课程状态（tsdoc）
    ↓
[自动解锁] 调用 updateAllowedNodes()
    ├─ 检查前置条件
    ├─ 解锁满足条件的章节
    └─ 保存更新
    ↓
[权限检查] 是否可查看题目列表？
    ├─ 否（未开始 or 未加入） → 返回空题目列表
    └─ 是 ↓
[加载数据]
  ├─ 题目列表（PROJECTION_CONTEST_LIST）
  ├─ 用户提交记录（journal）
  └─ 成绩统计（stat）
    ↓
[渲染] course_detail.html
```

### 4.2 学生提交题目并自动解锁流程

```
POST /record/:rid/detail (提交评测结果)
    ↓
[系统事件] contest/record:accepted or other status
    ↓
[更新课程状态] stat() 重新计算分数和完成数
    ↓
[用户访问课程] GET /course/:tid
    ↓
[updateAllowedNodes] 检查是否有新的章节解锁
    ├─ 新章节 → allow[nodeId] = true
    └─ 无新章节 → 保持原状
    ↓
[渲染] 展示新解锁的章节
```

### 4.3 教师管理课程权限流程

```
GET /course/:tid/manage
    ↓
[权限检查] 是否为课程所有者或编辑者？
    ├─ 否 → 403 ForbiddenError
    └─ 是 ↓
[加载数据]
  ├─ 课程基本信息（tdoc）
  ├─ 学生列表（ClassModel.getGroupByName）
  └─ 所有参与学生的状态（getMultiStatus）
    ↓
[渲染] course_manage.html

POST /course/:tid/manage?action=visit
    ↓
[批量/单个] 为学生开放或取消课程访问权限
    ├─ uid=0 → 批量操作所有学生
    └─ uid>0 → 单个学生
    ↓
[更新数据库] DocumentModel.setStatus() 或 deleteMultiStatus()
```

---

## 5. 数据库设计

### 5.1 课程存储（document 集合）

**表结构**：
```javascript
{
  _id: ObjectId,
  docId: number,              // 递增 ID
  docType: 30,                // TYPE_CONTEST
  domainId: string,

  // 基本信息
  title: string,
  content: string,            // Markdown 内容
  owner: number,              // 创建者 UID

  // 竞赛/课程特定
  rule: 'course',
  beginAt: Date,
  endAt: Date,

  // 课程特定
  dag: [
    {
      _id: number,
      title: string,
      pids: [number],
      requireNids: [number],
      completeCondition: {type, value}
    }
  ],
  assign: [string],           // ['className', 'categoryName?']
  lecture: {nodeId: htmlContent},
  maintainer: [number],       // 维护者 UID
  files: [
    {
      _id: string,
      name: string,
      size: number,
      lastModified: Date,
      etag: string
    }
  ],

  // 元数据
  nSubmit: number,
  nAccept: number,
  pids: [number],             // 所有题目 ID 列表

  // 时间戳
  createdAt: Date,
  updatedAt: Date,
}

// 索引
db.document.createIndex({domainId: 1, docType: 1, rule: 1})
db.document.createIndex({domainId: 1, assign: 1})
db.document.createIndex({owner: 1, domainId: 1})
```

### 5.2 班级存储（user.group 集合）

**表结构**：
```javascript
{
  _id: ObjectId,
  domainId: string,
  name: string,               // 班级名称，在域内唯一

  teachers: [number],         // 教师 UID
  students: [number],         // 学生 UID
  uids: [number],             // teachers ∪ students

  beginAt: Date,
  endAt: Date,
  archive: boolean,           // 是否归档

  class: true,                // 区分班级和普通组
}

// 索引
db.user.group.createIndex({domainId: 1, class: 1})
db.user.group.createIndex({domainId: 1, name: 1})
db.user.group.createIndex({domainId: 1, uids: 1})
```

### 5.3 课程状态存储（document_status 集合）

**表结构**：
```javascript
{
  _id: ObjectId,
  domainId: string,
  docId: number,              // 课程 docId
  uid: number,                // 学生 UID

  // 课程特定状态
  allow: {
    nodeId: boolean           // 章节访问权限
  },
  lectureAllow: {
    nodeId: boolean           // 讲义访问权限
  },

  attend: boolean,            // 是否已加入课程
  startAt: Date,              // 开始学习时间

  // 成绩统计（由 stat() 计算）
  score: {
    0: number,                // 总分
    nodeId: number            // 每个章节的分数
  },
  accept: {
    0: number,                // 总完成题数
    nodeId: number            // 每个章节的完成题数
  },
  progress: number,           // 0-100 完成百分比

  // 详细记录
  detail: {
    problemId: {
      rid: ObjectId,          // 提交记录 ID
      status: number,         // 评测状态
      score: number,          // 得分
      naccept: number         // 尝试次数
    }
  },
  journal: [
    {
      rid: ObjectId,
      pid: number,
      score: number,
      status: number
    }
  ],
}

// 索引
db.document_status.createIndex({domainId: 1, docId: 1, uid: 1}, {unique: true})
db.document_status.createIndex({docId: 1, score: -1, accept: -1})
```

### 5.4 文件存储

**存储路径**：`contest/{domainId}/{tid}/public/{filename}`

**元数据存储**：在 document 的 `files` 数组中

---

## 6. 扩展点

### 6.1 添加新的完成条件

1. 编辑 `model/course.ts` 的 `checkNodeComplete()` 函数
2. 编辑 `handler/course.ts` 的 `parseDag()` 函数的验证逻辑

```typescript
// checkNodeComplete() 中添加新条件
if (node.completeCondition?.type === 'custom') {
  // 自定义逻辑
  return customCheck(tsdoc, node);
}
```

### 6.2 自定义成绩板显示

编辑 `model/course.ts` 中的 `courseRule` 对象：

```typescript
scoreboardHeader(config, _, tdoc, pdict) {
  // 修改表头渲染
}

scoreboardRow(config, _, tdoc, pdict, udoc, rank, tsdoc, meta) {
  // 修改每行的数据格式
}
```

### 6.3 添加新的课程状态字段

1. 更新 `model/course.ts` 的 `CourseStatus` 接口
2. 在 `stat()` 函数中计算新字段
3. 在 `updateAllowedNodes()` 中使用新字段（如需要）

### 6.4 添加新的路由

在 `index.ts` 中添加：

```typescript
ctx.Route('new_route', '/pattern/:param', NewHandler, PERM_REQUIRED);
```

### 6.5 国际化扩展

在 `locales/zh.yaml` 中添加新的翻译键值对，然后在代码中使用 `_('key')` 引用。

---

## 7. 错误处理

### 7.1 常见错误类型

| 错误 | 触发条件 | HTTP 状态 |
|------|---------|----------|
| `ContestNotFoundError` | 课程不存在 | 404 |
| `NotAssignedError` | 用户不在指定班级 | 403 |
| `ValidationError` | DAG 验证失败 | 400 |
| `NotFoundError` | 班级不存在 | 404 |
| `ForbiddenError` | 权限不足 | 403 |
| `BadRequestError` | 请求参数错误 | 400 |
| `ProblemNotFoundError` | 题目不存在 | 404 |

### 7.2 错误处理模式

```typescript
try {
  // 操作逻辑
} catch (e: any) {
  if (e instanceof ProblemNotFoundError) {
    throw new ValidationError('dag', null, e);
  }
  throw new ValidationError('dag', null, e.message);
}
```

---

## 8. 性能优化

### 8.1 数据库查询优化

1. **课程列表查询**：
   - 使用投影（project）减少返回数据量
   - 使用 `$or` 和 `$in` 优化查询条件

2. **班级查询**：
   - 使用复合索引 `{domainId: 1, class: 1}`
   - 缓存班级列表在内存中

### 8.2 缓存策略

1. **用户缓存**：每次更新班级时调用 `deleteUserCache()`
2. **模板列表缓存**：班级编辑页面缓存模板列表

### 8.3 批量操作优化

使用 `Promise.all()` 实现并发操作：

```typescript
await Promise.all(
  students.map(uid => ContestModel.attend(domainId, tid, uid))
);
```

---

## 9. 测试场景

### 9.1 单元测试

- [ ] `updateAllowedNodes()` - 前置条件解锁逻辑
- [ ] `checkNodeComplete()` - 完成条件判断
- [ ] `parseDag()` - DAG 验证
- [ ] `ClassModel.listGroup()` - 班级列表查询

### 9.2 集成测试

- [ ] 学生学习流程（创建、加入、完成、解锁）
- [ ] 教师管理流程（创建、分配、权限管理）
- [ ] 班级复制流程（从模板复制课程到班级）
- [ ] 成绩统计流程（提交、评测、自动解锁）

### 9.3 边界情况

- [ ] 空班级（无学生）
- [ ] 环形前置条件（检测和拒绝）
- [ ] 大规模数据（1000+ 学生）
- [ ] 并发访问（多用户同时提交）

---

## 10. 维护指南

### 10.1 常见问题调试

**问题：班级不显示**
- 检查数据库中 `class: true` 字段
- 检查 `domainId` 是否正确

**问题：课程不显示**
- 检查 `rule: 'course'` 字段
- 检查 `assign` 字段是否包含用户班级
- 检查用户权限

**问题：章节不解锁**
- 检查前置条件逻辑（`checkNodeComplete`）
- 检查学生成绩是否达到条件
- 检查 `allow` 权限字段

### 10.2 升级路径

当升级到新版本时：
1. 检查新增的数据字段是否与旧数据兼容
2. 运行数据迁移脚本（如有）
3. 测试完整的学习流程
4. 检查权限系统是否有变化

### 10.3 代码风格

- 使用 TypeScript 严格模式
- 参数优先使用类型定义而不是 `any`
- 异步函数使用 `async/await` 而不是 Promise
- 错误处理使用 try/catch 和自定义错误类

---

## 11. 相关资源

- [Hydro OJ 文档](https://hydro.js.org/)
- [MongoDB 文档](https://docs.mongodb.com/)
- [TypeScript 文档](https://www.typescriptlang.org/)

---

## 更新历史

- **2024-01-26**: 初始版本，详细记录架构和设计细节
