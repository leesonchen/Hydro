# Hydro 数据库设计文档

## 1. 概述

Hydro 系统采用 MongoDB 作为主要数据库，利用其文档存储特性和灵活的数据结构来满足在线测评系统的复杂需求。数据库设计遵循高性能、可扩展、易维护的原则，支持分片和副本集部署。

### 1.1 实际数据库规模

基于 **2025-10-23** 的数据库导出分析：

- **数据库名称**: hydro
- **集合总数**: 24个
- **文档总数**: 874,108个
- **导出工具版本**: MongoDB Schema Export Tool v1.0.0

### 1.2 主要集合统计

| 集合名称 | 文档数量 | 索引数量 | 描述 |
|---------|---------|---------|------|
| record | 382,033 | 9 | 提交记录（最大集合） |
| document.status | 188,551 | 6 | 文档状态 |
| storage | 128,969 | 4 | 存储信息 |
| record.stat | 142,050 | 5 | 提交统计 |
| document | 9,561 | 14 | 文档（索引最多） |
| message | 7,633 | 3 | 消息 |
| user | 2,607 | 3 | 用户信息 |
| oauth | 2,589 | 2 | OAuth认证 |
| record.history | 2,438 | 2 | 提交历史 |
| token | 866 | 3 | 访问令牌 |
| domain.user | 6,162 | 3 | 域用户 |
| oplog | 425 | 1 | 操作日志 |
| system | 107 | 1 | 系统配置 |
| user.group | 71 | 3 | 用户组 |
| discussion.history | 15 | 1 | 讨论历史 |
| schedule | 10 | 2 | 调度任务 |
| domain | 20 | 2 | 域管理 |
| status | 1 | 2 | 状态信息 |

> **注意**: 以下6个集合为空集合（0文档），但保留索引结构：task, blacklist, type_game, event, opcount, vuser

## 2. 数据库架构

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                    MongoDB Cluster                         │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │   Primary    │  │  Secondary   │  │  Secondary   │     │
│  │   Replica    │  │   Replica    │  │   Replica    │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │   Shard 1    │  │   Shard 2    │  │   Shard 3    │     │
│  │   (Hot Data) │  │ (Warm Data)  │  │ (Cold Data)  │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
└─────────────────────────────────────────────────────────────┘
```

## 3. 核心数据模型

### 3.1 用户模型 (user / vuser)

```typescript
interface UserDoc {
  _id: Long;                      // 用户ID (样例数据：0)
  uname: string;                  // 用户名 (样例数据： "Guest")
  unameLower: string;             // 用户名小写 (样例数据： "guest")
  mail: string;                   // 邮箱 (样例数据： "Guest@hydro.local")
  mailLower: string;              // 邮箱小写 (样例数据： "guest@hydro.local")
  avatar: string;                 // 头像URL (样例数据： "gravatar:Guest@hydro.local")
  salt: string;                   // 密码盐
  hash: string;                   // 密码哈希
  hashType: string;               // 哈希类型 (样例数据： "hydro")
  priv: number;                   // 权限位掩码 (样例数据： 8)
  regat: Date;                    // 注册时间 (样例数据： "2022-11-23T12:44:07.518Z")
  loginat: Date;                  // 最后登录时间 (样例数据： "2025-10-21T01:14:58.398Z")
  ip: string[];                   // IP地址记录数组 (样例数据： ["127.0.0.1", "183.209.44.55", ...])
  loginip: string;                // 最后登录IP (样例数据： "116.147.251.141")
}

// 用户索引
db.user.createIndex({ unameLower: 1 }, { unique: true });
db.user.createIndex({ mailLower: 1 }, { unique: true });
```

### 3.2 文档模型 (document)

Hydro 使用统一的 `document` 集合存储各种类型的文档，通过 `docType` 字段区分不同类型：

```typescript
// 文档类型常量
const TYPE_PROBLEM = 10;           // 题目
const TYPE_PROBLEM_SOLUTION = 11;  // 题解
const TYPE_DISCUSSION = 21;        // 讨论
const TYPE_DISCUSSION_REPLY = 22;  // 讨论回复
const TYPE_CONTEST = 30;           // 比赛
const TYPE_TRAINING = 40;          // 训练

// 文件信息接口
interface FileInfo {
  _id: string;                    // 文件ID (样例数据： "2.out")
  name: string;                   // 文件名 (样例数据： "2.out")
  size: number;                   // 文件大小 (样例数据： 2)
  lastModified: string;           // 最后修改时间 (样例数据： "2022-11-23T12:44:07.649Z")
  etag: string;                   // ETag (样例数据： "L2RhdGEvZmlsZS9oeWRyby80OGYvQUViaXdDc2FyRF9ETWoybDlSZHg3Lm91dA==")
}

interface DocumentDoc {
  _id: ObjectId;                  // 文档ID (样例数据： "637e159734a5c6121aa14901")
  domainId: string;               // 所属域 (样例数据： "system")
  docType: number;                // 文档类型 (样例数据： 10)
  docId: number;                  // 文档标识符 (样例数据： 1)
  owner: number;                  // 所有者 (样例数据： 1)
  content: string;                // 内容 (样例数据：JSON字符串格式的多语言内容)
  title: string;                  // 标题 (样例数据： "A+B Problem")

  // 通用属性
  hidden: boolean;                // 是否隐藏 (样例数据： false)
  sort: string;                   // 排序字段 (样例数据： "P001000")
  assign: any[];                  // 分配 (样例数据： [])

  // 题目相关字段
  pid: string;                    // 题目编号 (样例数据： "P1000")
  tag: string[];                  // 标签 (样例数据： ["系统测试"])
  nSubmit: number;                // 提交数 (样例数据： 7)
  nAccept: number;                // 通过数 (样例数据： 4)
  data: FileInfo[];               // 测试数据 (样例数据：包含5个文件的数组)
  config: string;                 // 配置 (样例数据： "time: 1s\nmemory: 64m\n")
  stats: Object;                  // 统计信息 (样例数据： { "AC": 4, "WA": 0, ... })
}

// 文档索引
db.document.createIndex({ domainId: 1, docType: 1, docId: 1 }, { unique: true });
db.document.createIndex({ domainId: 1, docType: 1, owner: 1, docId: -1 });
db.document.createIndex({ domainId: 1, docType: 1, sort: 1, docId: 1 });
db.document.createIndex({ domainId: 1, docType: 1, "$**": "text" });
db.document.createIndex({ domainId: 1, docType: 1, hidden: 1, docId: -1 });
```

### 3.3 文档状态模型 (document.status)

```typescript
interface DocumentStatusDoc {
  _id: ObjectId;                  // 状态ID
  domainId: string;               // 域ID
  docType: number;                // 文档类型
  docId: ObjectId | number;       // 文档ID
  uid: number;                    // 用户ID
  
  // 状态信息
  status?: number;                // 状态码
  score?: number;                 // 得分
  rid?: ObjectId;                 // 相关记录ID
  rp?: number;                    // RP值
  accept?: number;                // 通过数
  time?: number;                  // 时间
  
  // 扩展字段
  enroll?: boolean;               // 是否注册
  journal?: JournalEntry[];       // 日志
  detail?: any;                   // 详细信息
}

// 文档状态索引
db['document.status'].createIndex({ domainId: 1, docType: 1, docId: 1, uid: 1 }, { unique: true });
db['document.status'].createIndex({ domainId: 1, docType: 1, docId: 1, score: -1 });
db['document.status'].createIndex({ domainId: 1, docType: 1, docId: 1, accept: -1, time: 1 });
```

### 3.4 提交记录模型 (record)

#### 3.4.1 主记录表 (record)

`record` 表存储当前活跃的提交记录，包含完整的提交信息和评测结果：

```typescript
// 测试用例结果接口（基于实际数据库结构）
interface TestCase {
  id: number;                     // 测试用例ID
  subtaskId: number;              // 子任务ID
  status: number;                 // 测试状态 (1: 通过, other: 失败)
  score: number;                  // 测试得分
  time: number;                   // 测试用时 (ms, Double类型，如 1.576899)
  memory: number;                 // 内存使用 (KB)
  message: string;                // 评测信息/错误消息
}

interface RecordDoc {
  _id: ObjectId;                  // 记录ID (样例数据： "637e159734a5c6121aa14909")
  domainId: string;               // 域ID (样例数据： "system")
  pid: number;                    // 题目ID (样例数据： 1)
  uid: number;                    // 用户ID (样例数据： 1)
  lang: string;                   // 编程语言 (样例数据： "cc")
  code: string;                   // 源代码

  // 评测状态
  status: number;                 // 评测状态 (样例数据： 0)
  score: number;                  // 得分 (样例数据： 0)
  time: number;                   // 总运行时间 (样例数据： 0)
  memory: number;                 // 内存使用 (样例数据： 0)

  // 评测详情
  judgeTexts: string[];           // 评测信息数组 (样例数据： [])
  compilerTexts: string[];        // 编译信息数组 (样例数据： [])
  testCases: TestCase[];          // 测试用例结果数组

  // 评测元数据
  judger: number | null;          // 评测机ID (样例数据： null)
  judgeAt: Date | null;           // 评测完成时间 (样例数据： null)
  rejudged: boolean;              // 是否重测 (样例数据： false)
}

// 测试用例结果样例数据（来自现有文档）：
/*
{
  "id": 2,                         // 测试用例ID
  "subtaskId": 1,                  // 子任务ID
  "status": 1,                     // 测试状态：1=通过
  "score": 50,                     // 测试得分
  "time": 1.576899,                // 测试用时(毫秒)
  "memory": 376,                   // 测试内存
  "message": ""                    // 评测消息
}
*/
```

#### 3.4.2 历史记录表 (record.history)

`record.history` 表存储重测时的历史评测结果，用于保存重测前的评测信息：

```typescript
interface RecordHistoryDoc {
  _id: ObjectId;                  // 历史记录ID
  rid: ObjectId;                  // 关联的主记录ID

  // 评测结果信息 (继承自 RecordJudgeInfo)
  score: number;                  // 得分
  memory: number;                 // 内存使用 (KB)
  time: number;                   // 运行时间 (ms)
  judgeTexts: string[];           // 评测信息
  compilerTexts: string[];        // 编译信息
  testCases: TestCase[];          // 测试用例结果
  judger: number;                 // 评测机ID
  judgeAt: Date;                  // 评测时间
  status: number;                 // 评测状态
  subtasks?: Record<number, SubtaskResult>; // 子任务结果
}
```

#### 3.4.3 统计记录表 (record.stat)

`record.stat` 表存储通过题目的统计信息，用于排行榜和性能统计：

```typescript
interface RecordStatDoc {
  _id: ObjectId;                  // 统计记录ID (与主记录ID相同)
  domainId: string;               // 域ID
  pid: number;                    // 题目ID
  uid: number;                    // 用户ID
  time: number;                   // 最佳运行时间
  memory: number;                 // 最佳内存使用
  length: number;                 // 代码长度
  lang: string;                   // 编程语言
}
```

#### 3.4.4 表间关系和使用场景

**record vs record.history 的主要区别：**

1. **数据范围**：
   - `record`：包含完整的提交信息（代码、用户信息等）+ 评测结果
   - `record.history`：仅保存评测结果信息，不包含源代码等提交信息

2. **生命周期**：
   - `record`：当前活跃的记录，会被更新和重测
   - `record.history`：历史快照，一旦创建不会修改

3. **使用目的**：
   - `record`：主要的查询和展示数据源
   - `record.history`：审计跟踪，允许查看重测前的结果

**record.history 的使用时机：**

1. **重测操作 (Rejudge)**：
   - 当管理员或系统触发重测时，在 `record.reset()` 函数中被调用
   - 保存重测前的完整评测结果到历史表
   - 清空当前记录的评测结果，重新开始评测流程

2. **批量重测**：
   - 题目配置更新后，批量重测相关提交
   - 每个被重测的记录都会在历史表中保留评测快照

3. **历史记录查询**：
   - 用户可以查看提交的历史评测结果
   - 通过 `rev` 参数访问特定历史版本

**数据流程：**

```typescript
// 重测时的数据流转
async reset(domainId: string, rid: ObjectId, isRejudge: boolean) {
  // 1. 查找当前已完成的记录
  const rdocs = await RecordModel.coll.find({
    _id: { $in: rids },
    judgeAt: { $exists: true, $ne: null }
  }).toArray();

  // 2. 将评测结果保存到历史表
  if (rdocs.length) {
    await RecordModel.collHistory.insertMany(rdocs.map((rdoc) => ({
      ...pick(rdoc, [
        'compilerTexts', 'judgeTexts', 'testCases', 'subtasks',
        'score', 'time', 'memory', 'status', 'judgeAt', 'judger',
      ]),
      rid: rdoc._id,           // 关联到主记录
      _id: new ObjectId(),     // 新的历史记录ID
    })));
  }

  // 3. 重置主记录的评测状态
  return RecordModel.update(domainId, rid, resetData);
}
```

#### 3.4.5 索引策略

```javascript
// 主记录表索引
db.record.createIndex({ domainId: 1, contest: 1, _id: -1 });
db.record.createIndex({ domainId: 1, contest: 1, uid: 1, _id: -1 });
db.record.createIndex({ domainId: 1, contest: 1, pid: 1, _id: -1 });
db.record.createIndex({ domainId: 1, contest: 1, pid: 1, uid: 1, _id: -1 });
db.record.createIndex({ domainId: 1, contest: 1, status: 1, _id: -1 });
db.record.createIndex({ domainId: 1, pid: 1 });

// 历史记录表索引
db.record.history.createIndex({ rid: 1, _id: -1 });

// 统计记录表索引
db.record.stat.createIndex({ domainId: 1, pid: 1, uid: 1, _id: -1 });
db.record.stat.createIndex({ domainId: 1, pid: 1, uid: 1, time: 1 });
db.record.stat.createIndex({ domainId: 1, pid: 1, uid: 1, memory: 1 });
db.record.stat.createIndex({ domainId: 1, pid: 1, uid: 1, length: 1 });
```

### 3.5 域模型 (domain)

```typescript
interface DomainDoc {
  _id: string;                    // 域ID
  lower: string;                  // 域ID小写
  owner: number;                  // 域主
  name?: string;                  // 域名称
  bulletin?: string;              // 公告
  roles?: Record<string, string>; // 角色权限映射
  avatar?: string;                // 头像
  host?: string[];                // 主机列表
  isTrusted?: boolean;            // 是否可信
  namespaces?: Record<string, string>; // 命名空间
  join?: DomainJoinSettings;      // 加入设置
  
  // 其他配置
  [key: string]: any;
}

// 域用户关系
interface DomainUserDoc {
  _id: ObjectId;                  // 记录ID
  domainId: string;               // 域ID
  uid: number;                    // 用户ID
  role?: string;                  // 角色
  rp?: number;                    // RP值
  rank?: number;                  // 排名
  
  // 其他信息
  [key: string]: any;
}

// 域索引
db.domain.createIndex({ lower: 1 }, { unique: true });
db['domain.user'].createIndex({ domainId: 1, uid: 1 }, { unique: true });
db['domain.user'].createIndex({ domainId: 1, rp: -1, uid: 1 });
```

## 4. 辅助数据模型

### 4.1 消息模型 (message)

```typescript
interface MessageDoc {
  _id: ObjectId;                  // 消息ID
  from: number;                   // 发送者
  to: number;                     // 接收者
  title: string;                  // 消息标题
  content: string;                // 消息内容
  flag: number;                   // 消息标志位
  sendAt: Date;                   // 发送时间
  readAt?: Date;                  // 阅读时间
  
  // 扩展字段
  [key: string]: any;
}

// 消息索引
db.message.createIndex({ to: 1, _id: -1 });
db.message.createIndex({ from: 1, _id: -1 });
```

### 4.2 域用户关系模型 (domain.user)

```typescript
interface DomainUserDoc {
  _id: ObjectId;                  // 记录ID
  domainId: string;               // 域ID
  uid: number;                    // 用户ID
  role?: string;                  // 角色
  rp?: number;                    // RP值
  rank?: number;                  // 排名

  // 扩展字段
  [key: string]: any;
}

// 域用户索引
db['domain.user'].createIndex({ domainId: 1, uid: 1 }, { unique: true });
db['domain.user'].createIndex({ domainId: 1, rp: -1, uid: 1 });
```

### 4.3 OAuth认证模型 (oauth)

```typescript
interface OAuthDoc {
  _id: ObjectId;                  // OAuth记录ID
  uid: number;                    // 用户ID
  platform: string;               // 平台名称
  platformUid: string;            // 平台用户ID
  accessToken?: string;            // 访问令牌
  refreshToken?: string;           // 刷新令牌

  // 扩展字段
  [key: string]: any;
}

// OAuth索引
db.oauth.createIndex({ uid: 1, platform: 1 });
db.oauth.createIndex({ platform: 1, platformUid: 1 });
```

### 4.4 存储模型 (storage)

```typescript
interface StorageDoc {
  _id: ObjectId;                  // 存储ID
  path: string;                   // 文件路径
  size: number;                   // 文件大小
  lastModified: Date;             // 最后修改时间
  etag?: string;                  // ETag
  autoDelete?: Date;              // 自动删除时间
  link?: string;                  // 链接

  // 元数据
  [key: string]: any;
}

// 存储索引
db.storage.createIndex({ path: 1 });
db.storage.createIndex({ path: 1, autoDelete: 1 });
db.storage.createIndex({ link: 1 });
```

### 4.5 令牌模型 (token)

```typescript
interface TokenDoc {
  _id: ObjectId;                  // 令牌ID
  uid: number;                    // 用户ID
  tokenType: string;              // 令牌类型
  token: string;                  // 令牌值
  expireAt: Date;                 // 过期时间
  updateAt: Date;                 // 更新时间

  // 扩展字段
  [key: string]: any;
}

// 令牌索引
db.token.createIndex({ token: 1 });
db.token.createIndex({ uid: 1, tokenType: 1 });
db.token.createIndex({ expireAt: -1 });
```

### 4.6 系统配置模型 (system)

```typescript
interface SystemDoc {
  _id: string;                    // 配置键
  value: any;                     // 配置值

  // 扩展字段
  [key: string]: any;
}

// 系统配置索引
db.system.createIndex({ _id: 1 }, { unique: true });
```

### 4.7 调度任务模型 (schedule)

```typescript
interface ScheduleDoc {
  _id: ObjectId;                  // 调度ID
  type: string;                   // 任务类型
  subType?: string;               // 子类型
  priority: number;               // 优先级
  executeAfter?: Date;            // 执行时间

  // 任务数据
  [key: string]: any;
}

// 调度任务索引
db.schedule.createIndex({ type: 1, subType: 1, priority: -1 });
db.schedule.createIndex({ executeAfter: 1 });
```

### 4.8 状态信息模型 (status)

```typescript
interface StatusDoc {
  _id: ObjectId;                  // 状态ID
  key: string;                    // 状态键
  value: any;                     // 状态值
  updateAt: Date;                 // 更新时间

  // 扩展字段
  [key: string]: any;
}

// 状态信息索引
db.status.createIndex({ key: 1 });
db.status.createIndex({ updateAt: -1 });
```

### 4.9 任务模型 (task)

```typescript
interface TaskDoc {
  _id: ObjectId;                  // 任务ID
  type: string;                   // 任务类型
  subType?: string;               // 子类型
  priority: number;               // 优先级
  executeAfter?: Date;            // 执行时间
  
  // 任务数据
  [key: string]: any;
}

// 任务索引
db.task.createIndex({ type: 1, subType: 1, priority: -1 });
```

### 4.3 存储模型 (storage)

```typescript
interface StorageDoc {
  _id: ObjectId;                  // 存储ID
  path: string;                   // 文件路径
  size: number;                   // 文件大小
  lastModified: Date;             // 最后修改时间
  etag?: string;                  // ETag
  autoDelete?: Date;              // 自动删除时间
  link?: string;                  // 链接
  
  // 元数据
  [key: string]: any;
}

// 存储索引
db.storage.createIndex({ path: 1 });
db.storage.createIndex({ path: 1, autoDelete: 1 });
db.storage.createIndex({ link: 1 });
```

### 4.4 其他辅助集合

```typescript
// 黑名单
interface BlacklistDoc {
  _id: ObjectId;
  ip: string;
  expireAt: Date;
}

// 事件
interface EventDoc {
  _id: ObjectId;
  type: string;
  data: any;
  expire: Date;
}

// OAuth
interface OAuthDoc {
  _id: ObjectId;
  uid: number;
  platform: string;
  platformUid: string;
  accessToken?: string;
  refreshToken?: string;
}

// 系统设置
interface SystemDoc {
  _id: string;                    // 设置键
  value: any;                     // 设置值
}

// 令牌
interface TokenDoc {
  _id: ObjectId;
  uid: number;
  tokenType: string;
  token: string;
  expireAt: Date;
  updateAt: Date;
}

// 用户组
interface UserGroupDoc {
  _id: ObjectId;
  domainId: string;
  name: string;
  uids: number[];
}
```

## 5. 索引策略

### 5.1 性能优化索引

```javascript
// 用户集合
db.user.createIndex({ unameLower: 1 }, { unique: true });
db.user.createIndex({ mailLower: 1 }, { unique: true });

// 文档集合
db.document.createIndex({ domainId: 1, docType: 1, docId: 1 }, { unique: true });
db.document.createIndex({ domainId: 1, docType: 1, owner: 1, docId: -1 });
db.document.createIndex({ domainId: 1, docType: 1, sort: 1, docId: 1 });
db.document.createIndex({ domainId: 1, docType: 1, "$**": "text" });
db.document.createIndex({ domainId: 1, docType: 1, hidden: 1, docId: -1 });

// 记录集合
db.record.createIndex({ domainId: 1, contest: 1, _id: -1 });
db.record.createIndex({ domainId: 1, contest: 1, uid: 1, _id: -1 });
db.record.createIndex({ domainId: 1, contest: 1, pid: 1, _id: -1 });
db.record.createIndex({ domainId: 1, contest: 1, status: 1, _id: -1 });
```

### 5.2 分片策略

```javascript
// 记录集合按域分片
sh.shardCollection("hydro.record", { domainId: 1, _id: 1 });

// 文档集合按域分片
sh.shardCollection("hydro.document", { domainId: 1, docType: 1, docId: 1 });
```

## 6. 数据生命周期管理

### 6.1 TTL索引

```javascript
// 临时状态自动过期
db.status.createIndex({ updateAt: 1 }, { expireAfterSeconds: 62400 });

// 事件自动过期
db.event.createIndex({ expire: 1 });

// 黑名单自动过期
db.blacklist.createIndex({ expireAt: -1 });

// 令牌自动过期
db.token.createIndex({ expireAt: -1 });
```

### 6.2 数据归档

```javascript
// 历史记录归档
db.record.aggregate([
  { $match: { _id: { $lt: ObjectId("...") } } },
  { $out: "record.archive" }
]);
```

## 7. 查询优化

### 7.1 常用查询模式

```javascript
// 获取用户提交记录
db.record.find({ domainId: "system", uid: 1 }).sort({ _id: -1 });

// 获取题目列表
db.document.find({ domainId: "system", docType: 10, hidden: false }).sort({ docId: -1 });

// 获取比赛排名
db['document.status'].find({ domainId: "system", docType: 30, docId: ObjectId("...") }).sort({ score: -1, time: 1 });
```

### 7.2 聚合查询

```javascript
// 统计题目通过情况
db.record.aggregate([
  { $match: { domainId: "system", status: 1 } },
  { $group: { _id: "$pid", count: { $sum: 1 } } },
  { $sort: { count: -1 } }
]);
```

## 8. 实际使用模式分析

### 8.1 高频读写集合

基于实际数据规模分析：

1. **record (382,033文档)**: 最活跃的集合，存储所有提交记录
   - 写入频率高：每次用户提交都会创建新记录
   - 查询频率高：用户查看历史记录、排名统计
   - 更新频率中等：评测状态变化时更新

2. **document.status (188,551文档)**: 状态跟踪，更新频繁
   - 实时更新：评测状态、得分变化
   - 高并发访问：排行榜、进度查询

3. **storage (128,969文档)**: 文件存储，访问频繁
   - 读写平衡：文件上传和下载
   - 内容管理：测试数据、附件存储

### 8.2 数据关联关系

实际数据关联模式：
- **用户 ↔ 提交记录**: 平均每个用户约147个提交记录
- **题目 ↔ 提交记录**: 平均每个题目约40个提交记录
- **用户 ↔ 文档状态**: 用户与各种文档的状态跟踪关系
- **域 ↔ 用户**: 域用户关系记录

### 8.3 性能优化建议

基于实际数据规模的建议：

1. **索引优化**:
   - `record`集合的9个索引已经很好地支持了多维度查询
   - `document`集合的14个索引优化了复杂的题目检索需求
   - 考虑对`record.status`按时间分区以提高查询性能

2. **查询模式优化**:
   - 基于用户ID的查询（`uid`）：高频，已优化
   - 基于题目ID的查询（`pid`）：高频，已优化
   - 基于时间的范围查询：考虑添加时间分区索引
   - 状态过滤查询：已通过复合索引优化

3. **数据分布特征**:
   - 历史数据占比较大（`record`, `record.stat`共计524,083文档，约60%）
   - 活跃用户数据相对较小（`user`, `oauth`共计5,196文档，约0.6%）
   - 文档内容数据适中（`document`, `document.status`共计198,112文档，约23%）

### 8.4 数据增长趋势

1. **快速增长集合**:
   - `record`: 与用户提交量直接相关，线性增长
   - `document.status`: 随提交量同步增长
   - `storage`: 文件和测试数据累积

2. **稳定增长集合**:
   - `user`: 用户注册增长
   - `document`: 题目和内容增长
   - `oauth`: 第三方认证绑定

3. **缓存友好集合**:
   - `domain`, `system`: 配置数据，变更频率低
   - `user.group`: 用户组织结构，相对稳定

### 8.5 维护建议

1. **定期维护**:
   - 历史数据归档：考虑将超过1年的`record`历史数据归档
   - 索引优化：定期监控索引使用效率
   - 存储清理：清理过期的`token`、`blacklist`等临时数据

2. **性能监控**:
   - 关注`record`集合的写入性能
   - 监控`document.status`的查询延迟
   - 跟踪`storage`的存储空间使用

### 8.6 AI-EDU项目集成建议

基于Hydro数据库结构，为AI-EDU项目提供以下集成建议：

1. **核心数据同步**:
   - 优先同步`user`, `record`, `document`三个核心集合
   - 使用`domainId`字段进行数据隔离
   - 建立`uid`到AI-EDU用户ID的映射关系

2. **实时数据流**:
   - 监听`record`集合的变化，实时获取提交状态
   - 订阅`document.status`更新，跟踪用户进度
   - 利用`message`集合进行系统通知

3. **性能考虑**:
   - 建立本地缓存减少对Hydro数据库的直接查询
   - 使用批量操作处理大量数据同步
   - 考虑读写分离，AI-EDU主要使用只读权限

## 9. 总结

Hydro 数据库设计的核心特点：

1. **统一文档模型**: 使用单一的 `document` 集合存储多种类型的文档，通过 `docType` 区分
2. **灵活的扩展性**: 文档结构允许动态添加字段，适应不同类型的需求
3. **高效的索引策略**: 针对常用查询模式优化的复合索引
4. **规范的命名约定**: 使用小写字段进行索引，提高查询效率
5. **完整的关系管理**: 通过状态集合维护文档间的关系和用户状态
6. **实际规模验证**: 基于真实的874,108文档数据验证了设计的有效性

这种设计既保证了数据的一致性和完整性，又提供了良好的查询性能和扩展能力，为 Hydro 系统的稳定运行提供了坚实的数据基础，同时也为 AI-EDU 项目的集成提供了可靠的数据来源。