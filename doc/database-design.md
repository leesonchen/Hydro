# Hydro 数据库设计文档

## 1. 概述

Hydro 系统采用 MongoDB 作为主要数据库，利用其文档存储特性和灵活的数据结构来满足在线测评系统的复杂需求。数据库设计遵循高性能、可扩展、易维护的原则，支持分片和副本集部署。

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
  _id: number;                    // 用户ID (自增)
  uname: string;                  // 用户名
  unameLower: string;             // 用户名小写 (用于索引)
  mail: string;                   // 邮箱
  mailLower: string;              // 邮箱小写 (用于索引)
  avatar: string;                 // 头像URL
  salt: string;                   // 密码盐
  hash: string;                   // 密码哈希
  hashType: string;               // 哈希类型
  priv: number;                   // 权限位掩码
  regat: Date;                    // 注册时间
  loginat: Date;                  // 最后登录时间
  ip: string[];                   // IP地址记录
  loginip: string;                // 最后登录IP
  tfa?: string;                   // 双因子认证密钥
  authenticators?: Authenticator[]; // WebAuthn认证器
  domains?: string[];             // 所属域列表
  _files?: FileInfo[];            // 文件信息
  
  // 可选字段
  qq?: string;                    // QQ号
  wechat?: string;                // 微信号
  github?: string;                // GitHub用户名
  studentId?: string;             // 学号
  realName?: string;              // 真实姓名
  school?: string;                // 学校
  motto?: string;                 // 座右铭
  bio?: string;                   // 个人简介
  timeZone?: string;              // 时区
  viewLang?: string;              // 界面语言
  codeLang?: string;              // 默认代码语言
  backgroundImage?: string;       // 背景图片URL
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

interface DocumentDoc {
  _id: ObjectId;                  // 文档ID
  domainId: string;               // 所属域
  docType: number;                // 文档类型
  docId: ObjectId | number;       // 文档标识符
  owner: number;                  // 所有者
  content?: string;               // 内容
  title?: string;                 // 标题
  
  // 层级关系
  parentType?: number;            // 父文档类型
  parentId?: ObjectId | number;   // 父文档ID
  
  // 通用属性
  hidden?: boolean;               // 是否隐藏
  sort?: string;                  // 排序字段
  
  // 特定类型字段 (根据docType动态)
  // 题目相关
  pid?: string;                   // 题目编号
  tag?: string[];                 // 标签
  nSubmit?: number;               // 提交数
  nAccept?: number;               // 通过数
  difficulty?: number;            // 难度
  data?: FileInfo[];              // 测试数据
  additional_file?: FileInfo[];   // 附加文件
  config?: string;                // 配置
  maintainer?: number[];          // 维护者
  reference?: ProblemReference;   // 引用关系
  
  // 比赛相关
  beginAt?: Date;                 // 开始时间
  endAt?: Date;                   // 结束时间
  pids?: string[];                // 题目列表
  rule?: string;                  // 比赛规则
  attend?: number[];              // 参赛者
  
  // 训练相关
  dag?: TrainingNode[];           // 训练DAG
  
  // 讨论相关
  pin?: boolean;                  // 是否置顶
  nReply?: number;                // 回复数
  updateAt?: Date;                // 更新时间
  
  // 统计信息
  vote?: number;                  // 投票数
  views?: number;                 // 查看数
  
  // 其他扩展字段
  [key: string]: any;
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

```typescript
interface RecordDoc {
  _id: ObjectId;                  // 记录ID
  domainId: string;               // 域ID
  pid: number;                    // 题目ID
  uid: number;                    // 用户ID
  lang: string;                   // 编程语言
  code: string;                   // 源代码
  
  // 评测状态
  status: number;                 // 评测状态
  score: number;                  // 得分
  time: number;                   // 运行时间 (ms)
  memory: number;                 // 内存使用 (KB)
  
  // 评测详情
  judgeTexts?: string[];          // 评测信息
  compilerTexts?: string[];       // 编译信息
  testCases?: TestCase[];         // 测试用例结果
  subtasks?: Record<number, SubtaskResult>; // 子任务结果
  
  // 评测元数据
  judger?: string;                // 评测机
  judgeAt?: Date;                 // 评测时间
  rejudged?: boolean;             // 是否重测
  
  // 比赛信息
  contest?: ObjectId;             // 比赛ID
  
  // 文件提交
  files?: Record<string, string>; // 文件映射
  
  // 其他
  input?: string;                 // 自定义输入
  hackTarget?: ObjectId;          // Hack目标
  hidden?: boolean;               // 是否隐藏
}

// 记录索引
db.record.createIndex({ domainId: 1, contest: 1, _id: -1 });
db.record.createIndex({ domainId: 1, contest: 1, uid: 1, _id: -1 });
db.record.createIndex({ domainId: 1, contest: 1, pid: 1, _id: -1 });
db.record.createIndex({ domainId: 1, contest: 1, pid: 1, uid: 1, _id: -1 });
db.record.createIndex({ domainId: 1, contest: 1, status: 1, _id: -1 });
db.record.createIndex({ domainId: 1, pid: 1 });
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

### 4.2 任务模型 (task)

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

## 8. 总结

Hydro 数据库设计的核心特点：

1. **统一文档模型**: 使用单一的 `document` 集合存储多种类型的文档，通过 `docType` 区分
2. **灵活的扩展性**: 文档结构允许动态添加字段，适应不同类型的需求
3. **高效的索引策略**: 针对常用查询模式优化的复合索引
4. **规范的命名约定**: 使用小写字段进行索引，提高查询效率
5. **完整的关系管理**: 通过状态集合维护文档间的关系和用户状态

这种设计既保证了数据的一致性和完整性，又提供了良好的查询性能和扩展能力，为 Hydro 系统的稳定运行提供了坚实的数据基础。