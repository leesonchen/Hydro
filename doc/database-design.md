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
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │    Config    │  │    Router    │  │   Monitor    │     │
│  │   Servers    │  │   (mongos)   │  │   System     │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 数据库连接配置

```typescript
// src/service/db.ts
interface DatabaseConfig {
  uri: string;
  options: {
    useNewUrlParser: boolean;
    useUnifiedTopology: boolean;
    maxPoolSize: number;
    minPoolSize: number;
    maxIdleTimeMS: number;
    serverSelectionTimeoutMS: number;
    socketTimeoutMS: number;
    family: number;
    bufferMaxEntries: number;
    retryWrites: boolean;
    readPreference: string;
    writeConcern: {
      w: number | string;
      j: boolean;
      wtimeout: number;
    };
  };
}

class DatabaseService {
  private client: MongoClient;
  private db: Db;
  
  async connect(config: DatabaseConfig): Promise<void> {
    this.client = new MongoClient(config.uri, config.options);
    await this.client.connect();
    this.db = this.client.db();
    
    // 创建索引
    await this.createIndexes();
    
    // 设置变更流
    await this.setupChangeStreams();
  }
  
  private async createIndexes(): Promise<void> {
    // 用户集合索引
    await this.db.collection('user').createIndexes([
      { key: { uname: 1 }, unique: true },
      { key: { mail: 1 }, unique: true },
      { key: { loginat: -1 } },
      { key: { regat: -1 } },
    ]);
    
    // 题目集合索引
    await this.db.collection('problem').createIndexes([
      { key: { pid: 1, domainId: 1 }, unique: true },
      { key: { owner: 1 } },
      { key: { tag: 1 } },
      { key: { nAccept: -1 } },
      { key: { difficulty: 1 } },
    ]);
    
    // 记录集合索引
    await this.db.collection('record').createIndexes([
      { key: { uid: 1, pid: 1 } },
      { key: { uid: 1, _id: -1 } },
      { key: { pid: 1, _id: -1 } },
      { key: { contest: 1, uid: 1 } },
      { key: { judgeAt: -1 } },
      { key: { status: 1 } },
    ]);
  }
}
```

## 3. 核心数据模型

### 3.1 用户模型 (user)

```typescript
interface User {
  _id: number;                    // 用户ID (自增)
  uname: string;                  // 用户名 (唯一)
  mail: string;                   // 邮箱 (唯一)
  salt: string;                   // 密码盐
  hash: string;                   // 密码哈希 (bcrypt)
  priv: number;                   // 全局权限位掩码
  regat: Date;                    // 注册时间
  loginat: Date;                  // 最后登录时间
  loginip: string;                // 最后登录IP
  gravatar: string;               // Gravatar邮箱
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
  avatar?: string;                // 头像URL
  backgroundImage?: string;       // 背景图片URL
  tfa?: string;                   // 双因子认证密钥
  lostPassMailSentAt?: Date;      // 找回密码邮件发送时间
  changeMailToken?: string;       // 修改邮箱令牌
  newMail?: string;               // 新邮箱
  rp: number;                     // RP值 (Rating Points)
  ratingHistory: RatingChange[];  // Rating历史记录
  badge: string[];                // 徽章列表
  level?: number;                 // 用户等级
  exp?: number;                   // 经验值
  
  // 统计数据
  nSubmit: number;                // 总提交数
  nAccept: number;                // 总通过数
  nLike: number;                  // 获赞数
  nProblem: number;               // 创建题目数
  
  // 社交功能
  followers: number[];            // 关注者列表
  following: number[];            // 关注的用户列表
  
  // 权限和角色
  domainRoles: Record<string, string[]>; // 域内角色
}

interface RatingChange {
  domainId: string;
  contestId: ObjectId;
  before: number;
  after: number;
  date: Date;
  rank: number;
}

// 索引定义
const userIndexes = [
  { key: { uname: 1 }, unique: true },
  { key: { mail: 1 }, unique: true },
  { key: { loginat: -1 } },
  { key: { regat: -1 } },
  { key: { rp: -1 } },
  { key: { nAccept: -1 } },
  { key: { school: 1 } },
  { key: { 'ratingHistory.domainId': 1, 'ratingHistory.date': -1 } },
];
```

### 3.2 题目模型 (problem)

```typescript
interface Problem {
  _id: ObjectId;                  // 题目ID
  domainId: string;               // 所属域
  pid: string;                    // 题目编号 (域内唯一)
  owner: number;                  // 题目创建者
  title: string;                  // 题目标题
  content?: string;               // 题目内容 (HTML/Markdown)
  
  // 题目配置
  config: ProblemConfig;
  
  // 统计信息
  nSubmit: number;                // 提交次数
  nAccept: number;                // 通过次数
  
  // 元数据
  tag: string[];                  // 标签
  hidden: boolean;                // 是否隐藏
  difficulty?: number;            // 难度 (1-10)
  source?: string;                // 题目来源
  
  // 时间戳
  createAt: Date;                 // 创建时间
  updateAt: Date;                 // 更新时间
  
  // 维护者
  maintainer: number[];           // 维护者列表
  
  // 数据文件
  data: ObjectId[];               // 测试数据文件ID列表
  additional_file: ObjectId[];    // 附加文件ID列表
  
  // 统计和分析
  stats?: ProblemStats;           // 题目统计
  solution?: ObjectId[];          // 题解ID列表
}

interface ProblemConfig {
  type: 'default' | 'interactive' | 'submit_answer' | 'objective' | 'communication';
  
  // 资源限制
  timeLimit: number;              // 时间限制 (ms)
  memoryLimit: number;            // 内存限制 (MB)
  
  // 评测配置
  checker?: string;               // 检查器名称
  checker_type?: 'default' | 'testlib' | 'syzoj' | 'hustoj';
  validator?: string;             // 验证器
  interactor?: string;            // 交互器
  
  // 子任务配置
  subtasks?: Subtask[];
  
  // 语言限制
  langs?: string[];               // 允许的语言
  
  // 特殊配置
  filename?: string;              // 文件名 (文件IO)
  detail?: boolean;               // 是否显示详细信息
  
  // 客观题配置
  objective?: ObjectiveConfig;
}

interface Subtask {
  id: number;
  score: number;
  time?: number;
  memory?: number;
  cases: TestCase[];
  type?: 'sum' | 'min' | 'mul';
  dependency?: number[];
}

interface TestCase {
  input: string;
  output: string;
  id?: number;
  score?: number;
}

interface ObjectiveConfig {
  questions: ObjectiveQuestion[];
}

interface ObjectiveQuestion {
  type: 'single' | 'multiple' | 'fill';
  content: string;
  answers: string[];
  score: number;
}

interface ProblemStats {
  ac: number[];                   // 各个分数段通过人数
  difficulty: number;             // 计算出的难度
  
  // 语言统计
  langStats: Record<string, {
    ac: number;
    total: number;
    avgTime: number;
    avgMemory: number;
  }>;
  
  // 时间分布
  timeDistribution: number[];
  
  // 标签相关性
  tagRelevance: Record<string, number>;
}

// 索引定义
const problemIndexes = [
  { key: { domainId: 1, pid: 1 }, unique: true },
  { key: { owner: 1 } },
  { key: { tag: 1 } },
  { key: { nAccept: -1 } },
  { key: { difficulty: 1 } },
  { key: { createAt: -1 } },
  { key: { hidden: 1, domainId: 1 } },
  
  // 全文搜索
  { key: { title: 'text', content: 'text', tag: 'text' } },
];
```

### 3.3 提交记录模型 (record)

```typescript
interface Record {
  _id: ObjectId;                  // 记录ID
  domainId: string;               // 所属域
  pid: string;                    // 题目ID
  uid: number;                    // 用户ID
  
  // 提交信息
  lang: string;                   // 编程语言
  code: string;                   // 源代码
  
  // 评测状态
  status: number;                 // 评测状态
  score: number;                  // 得分
  time: number;                   // 运行时间 (ms)
  memory: number;                 // 内存使用 (KB)
  
  // 评测详情
  judgeTexts: string[];           // 评测信息
  compilerTexts: string[];        // 编译信息
  testCases: TestCaseResult[];    // 测试用例结果
  
  // 时间戳
  _id: ObjectId;                  // 创建时间 (从ObjectId获取)
  judgeAt?: Date;                 // 评测时间
  
  // 比赛信息
  contest?: ObjectId;             // 比赛ID
  
  // 其他信息
  rejudged: boolean;              // 是否重测过
  hackData?: HackData;            // Hack数据
  judger?: number;                // 评测机ID
  hidden: boolean;                // 是否隐藏
  input?: string;                 // 自定义输入 (pretest)
  
  // 代码分析
  codeLength: number;             // 代码长度
  complexity?: CodeComplexity;    // 代码复杂度分析
}

interface TestCaseResult {
  id: number;
  status: number;
  score: number;
  time: number;
  memory: number;
  message?: string;
}

interface HackData {
  input: string;
  output?: string;
  hacker: number;
  hackAt: Date;
  success: boolean;
}

interface CodeComplexity {
  cyclomatic: number;             // 圈复杂度
  cognitive: number;              // 认知复杂度
  lines: number;                  // 代码行数
  maintainabilityIndex: number;   // 可维护性指数
}

// 索引定义
const recordIndexes = [
  { key: { uid: 1, _id: -1 } },
  { key: { pid: 1, _id: -1 } },
  { key: { domainId: 1, pid: 1, uid: 1 } },
  { key: { contest: 1, uid: 1 } },
  { key: { contest: 1, pid: 1, uid: 1 } },
  { key: { judgeAt: -1 } },
  { key: { status: 1 } },
  { key: { lang: 1 } },
  { key: { score: -1 } },
  { key: { time: 1 } },
  { key: { memory: 1 } },
  
  // 复合索引
  { key: { domainId: 1, contest: 1, uid: 1, pid: 1 } },
  { key: { domainId: 1, status: 1, _id: -1 } },
];
```

### 3.4 比赛模型 (contest)

```typescript
interface Contest {
  _id: ObjectId;                  // 比赛ID
  domainId: string;               // 所属域
  title: string;                  // 比赛标题
  content: string;                // 比赛说明
  
  // 时间安排
  beginAt: Date;                  // 开始时间
  endAt: Date;                    // 结束时间
  duration?: number;              // 持续时间 (ms)
  
  // 题目配置
  pids: string[];                 // 题目列表
  
  // 比赛规则
  rule: string;                   // 比赛规则 (ACM/OI/IOI/LEDO)
  ruleConfig?: ContestRuleConfig; // 规则配置
  
  // 参赛设置
  attend: number[];               // 参赛用户
  allowViewCode: boolean;         // 允许查看代码
  allowViewData: boolean;         // 允许查看测试数据
  
  // 权限设置
  maintainer: number[];           // 维护者
  owner: number;                  // 创建者
  
  // 显示设置
  penaltyShow: boolean;           // 显示罚时
  timeDisplay: string;            // 时间显示格式
  lockAt?: Date;                  // 封榜时间
  unlockAt?: Date;                // 解封时间
  
  // 比赛状态
  rated: boolean;                 // 是否计分
  finished?: boolean;             // 是否结束
  
  // 报名设置
  autoAccept: boolean;            // 自动接受报名
  password?: string;              // 比赛密码
  
  // 统计信息
  nAccept: number;                // 总通过数
  nSubmit: number;                // 总提交数
  nParticipants: number;          // 参赛人数
  
  // 扩展字段
  assign?: string[];              // 指定题目
  balloon?: BalloonConfig;        // 气球配置
  clarification?: Clarification[]; // 澄清问题
}

interface ContestRuleConfig {
  // ACM 规则配置
  penaltyTime?: number;           // 罚时 (分钟)
  
  // OI 规则配置
  showScore?: boolean;            // 显示分数
  
  // IOI 规则配置
  submitLimit?: Record<string, number>; // 提交限制
  
  // LEDO 规则配置
  enableHack?: boolean;           // 启用Hack
  hackTime?: number;              // Hack时间
}

interface BalloonConfig {
  enable: boolean;
  colors: Record<string, string>; // 题目对应颜色
}

interface Clarification {
  _id: ObjectId;
  question: string;
  answer?: string;
  uid: number;
  replied: boolean;
  createAt: Date;
  replyAt?: Date;
}

// 索引定义
const contestIndexes = [
  { key: { domainId: 1, beginAt: -1 } },
  { key: { domainId: 1, endAt: -1 } },
  { key: { owner: 1 } },
  { key: { attend: 1 } },
  { key: { rule: 1 } },
  { key: { rated: 1 } },
];
```

### 3.5 域模型 (domain)

```typescript
interface Domain {
  _id: string;                    // 域ID (字符串)
  owner: number;                  // 域主
  name: string;                   // 域名称
  abbr?: string;                  // 域简称
  bulletin?: string;              // 公告
  
  // 权限设置
  roles: Record<string, DomainRole>; // 角色定义
  
  // 功能设置
  settings: DomainSettings;
  
  // 统计信息
  nUser: number;                  // 用户数
  nProblem: number;               // 题目数
  nContest: number;               // 比赛数
  nDiscussion: number;            // 讨论数
  
  // 时间戳
  createAt: Date;                 // 创建时间
  updateAt: Date;                 // 更新时间
  
  // 外观设置
  avatar?: string;                // 域头像
  backgroundImage?: string;       // 背景图片
  css?: string;                   // 自定义CSS
  
  // 联系信息
  contact?: DomainContact;
}

interface DomainRole {
  permissions: string[];          // 权限列表
  displayName: string;            // 显示名称
  color?: string;                 // 角色颜色
}

interface DomainSettings {
  // 注册设置
  allowRegister: boolean;         // 允许注册
  registerWithCode: boolean;      // 需要邀请码注册
  
  // 比赛设置
  allowCreateContest: boolean;    // 允许创建比赛
  contestDefaultRule: string;     // 默认比赛规则
  
  // 题目设置
  allowCreateProblem: boolean;    // 允许创建题目
  problemDefaultHidden: boolean;  // 题目默认隐藏
  
  // 界面设置
  language: string;               // 默认语言
  timeZone: string;               // 时区
  
  // 邮件设置
  smtp?: SMTPConfig;              // SMTP配置
  
  // 存储设置
  storageQuota: number;           // 存储配额 (MB)
  
  // 评测设置
  judges: string[];               // 评测机列表
}

interface DomainContact {
  qq?: string;
  wechat?: string;
  email?: string;
  website?: string;
  github?: string;
}

interface SMTPConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  secure: boolean;
  from: string;
}

// 索引定义
const domainIndexes = [
  { key: { owner: 1 } },
  { key: { createAt: -1 } },
  { key: { nUser: -1 } },
];
```

## 4. 辅助数据模型

### 4.4 消息模型 (message)

```typescript
interface Message {
  _id: ObjectId;                  // 消息ID
  from: number;                   // 发送者
  to: number;                     // 接收者
  title: string;                  // 消息标题
  content: string;                // 消息内容
  
  // 状态标志
  flag: number;                   // 消息标志位
  
  // 时间戳
  sendAt: Date;                   // 发送时间
  readAt?: Date;                  // 读取时间
  
  // 类型
  type: 'user' | 'system' | 'notification';
  
  // 扩展数据
  extra?: Record<string, any>;
}

// 消息标志位定义
const MESSAGE_FLAG = {
  READ: 1 << 0,                   // 已读
  STARRED: 1 << 1,                // 星标
  DELETED: 1 << 2,                // 已删除
  ALERT: 1 << 3,                  // 警告
} as const;

// 索引定义
const messageIndexes = [
  { key: { to: 1, sendAt: -1 } },
  { key: { from: 1, sendAt: -1 } },
  { key: { to: 1, flag: 1 } },
];
```

### 4.2 文件存储模型 (file)

```typescript
interface GridFSFile {
  _id: ObjectId;                  // 文件ID
  length: number;                 // 文件大小
  chunkSize: number;              // 块大小
  uploadDate: Date;               // 上传时间
  filename: string;               // 文件名
  metadata: FileMetadata;         // 元数据
}

interface FileMetadata {
  owner: number;                  // 文件所有者
  domainId: string;               // 所属域
  type: 'problem' | 'user' | 'contest' | 'misc'; // 文件类型
  
  // 文件信息
  originalName: string;           // 原始文件名
  mimeType: string;               // MIME类型
  encoding?: string;              // 编码
  
  // 权限设置
  public: boolean;                // 是否公开
  etag?: string;                  // ETag
  
  // 关联信息
  linkedTo?: string;              // 关联的对象ID
  
  // 处理状态
  processed?: boolean;            // 是否已处理
  thumbnail?: ObjectId;           // 缩略图ID
}

// 索引定义
const fileIndexes = [
  { key: { 'metadata.owner': 1 } },
  { key: { 'metadata.domainId': 1 } },
  { key: { 'metadata.type': 1 } },
  { key: { uploadDate: -1 } },
];
```

### 4.3 讨论模型 (discussion)

```typescript
interface Discussion {
  _id: ObjectId;                  // 讨论ID
  domainId: string;               // 所属域
  parentType: 'problem' | 'contest' | 'training' | 'general'; // 父类型
  parentId: string;               // 父对象ID
  
  // 内容
  title: string;                  // 讨论标题
  content: string;                // 讨论内容
  
  // 作者信息
  owner: number;                  // 发起者
  
  // 状态
  pin: boolean;                   // 是否置顶
  highlight: boolean;             // 是否高亮
  lock: boolean;                  // 是否锁定
  
  // 统计
  nReply: number;                 // 回复数
  nView: number;                  // 浏览数
  
  // 时间戳
  updateAt: Date;                 // 最后更新时间
  
  // 反应系统
  react: Record<string, number[]>; // 表情反应
  
  // 标签
  node: string;                   // 讨论节点
  
  // 最后回复
  lastReply?: {
    uid: number;
    at: Date;
    floor: number;
  };
}

interface DiscussionReply {
  _id: ObjectId;                  // 回复ID
  parent: ObjectId;               // 父讨论ID
  content: string;                // 回复内容
  owner: number;                  // 回复者
  ip: string;                     // IP地址
  
  // 回复关系
  reply?: ObjectId;               // 回复的回复ID
  floor: number;                  // 楼层号
  
  // 状态
  deleted: boolean;               // 是否删除
  
  // 反应系统
  react: Record<string, number[]>; // 表情反应
  
  // 历史记录
  history?: ReplyHistory[];       // 编辑历史
}

interface ReplyHistory {
  content: string;
  editAt: Date;
  editBy: number;
}

// 索引定义
const discussionIndexes = [
  { key: { domainId: 1, parentType: 1, parentId: 1 } },
  { key: { owner: 1, updateAt: -1 } },
  { key: { pin: -1, updateAt: -1 } },
  { key: { node: 1, updateAt: -1 } },
  
  // 全文搜索
  { key: { title: 'text', content: 'text' } },
];

const replyIndexes = [
  { key: { parent: 1, floor: 1 } },
  { key: { owner: 1, _id: -1 } },
];
```

### 4.4 系统设置模型 (system)

```typescript
interface SystemSetting {
  _id: string;                    // 设置键名
  value: any;                     // 设置值
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'; // 值类型
  
  // 元数据
  description?: string;           // 描述
  category?: string;              // 分类
  
  // 权限
  public: boolean;                // 是否公开
  
  // 时间戳
  updateAt: Date;                 // 更新时间
  updateBy: number;               // 更新者
}

// 常用系统设置
const SYSTEM_SETTINGS = {
  // 基础设置
  'server.name': 'Hydro',
  'server.url': 'https://hydro.ac',
  'server.contact': 'admin@hydro.ac',
  
  // 注册设置
  'user.allowRegister': true,
  'user.defaultPerm': 1,
  'user.quotaSize': 1024,
  
  // 邮件设置
  'smtp.host': '',
  'smtp.port': 587,
  'smtp.user': '',
  'smtp.pass': '',
  'smtp.from': '',
  
  // 评测设置
  'judge.parallelism': 2,
  'judge.cacheSize': 1024,
  'judge.tmpfsSize': 512,
  
  // 安全设置
  'security.rateLimit': 100,
  'security.sessionTimeout': 3600,
  'security.passwordMinLength': 6,
} as const;

// 索引定义
const systemIndexes = [
  { key: { category: 1 } },
  { key: { public: 1 } },
  { key: { updateAt: -1 } },
];
```

## 5. 任务和队列模型

### 5.1 任务模型 (task)

```typescript
interface Task {
  _id: ObjectId;                  // 任务ID
  type: string;                   // 任务类型
  
  // 任务数据
  executeAfter: Date;             // 执行时间
  priority: number;               // 优先级 (0-10)
  
  // 任务内容
  args: any[];                    // 参数
  
  // 状态跟踪
  status: 'waiting' | 'running' | 'success' | 'fail' | 'skipped';
  
  // 重试机制
  retry: number;                  // 已重试次数
  maxRetry: number;               // 最大重试次数
  
  // 时间记录
  assignAt?: Date;                // 分配时间
  startAt?: Date;                 // 开始时间
  endAt?: Date;                   // 结束时间
  
  // 结果
  result?: any;                   // 执行结果
  error?: string;                 // 错误信息
  
  // 元数据
  domainId?: string;              // 所属域
  uid?: number;                   // 关联用户
}

// 任务类型定义
const TASK_TYPE = {
  JUDGE: 'judge',                 // 评测任务
  RATING: 'rating',               // 评分计算
  PROBLEM_STAT: 'problem.stat',   // 题目统计
  USER_STAT: 'user.stat',         // 用户统计
  SEND_MAIL: 'send.mail',         // 发送邮件
  IMPORT_PROBLEM: 'import.problem', // 导入题目
  EXPORT_CONTEST: 'export.contest', // 导出比赛
  BACKUP: 'backup',               // 备份
} as const;

// 索引定义
const taskIndexes = [
  { key: { type: 1, executeAfter: 1 } },
  { key: { status: 1, priority: -1 } },
  { key: { assignAt: 1 } },
  { key: { domainId: 1, type: 1 } },
];
```

### 5.2 评测队列模型 (judge_queue)

```typescript
interface JudgeTask {
  _id: ObjectId;                  // 队列任务ID
  rid: ObjectId;                  // 记录ID
  
  // 优先级
  priority: number;               // 优先级
  
  // 任务数据
  domainId: string;
  pid: string;
  uid: number;
  lang: string;
  code: string;
  config: any;                    // 评测配置
  data: ObjectId[];               // 测试数据
  
  // 状态
  status: 'waiting' | 'fetched' | 'compiling' | 'judging' | 'done' | 'error';
  judge?: string;                 // 评测机ID
  
  // 时间戳
  createAt: Date;
  fetchAt?: Date;
  endAt?: Date;
  
  // 进度
  progress?: JudgeProgress;
}

interface JudgeProgress {
  status: string;
  progress: number;               // 进度百分比
  case?: number;                  // 当前测试点
  total?: number;                 // 总测试点数
  message?: string;               // 进度消息
}

// 索引定义
const judgeQueueIndexes = [
  { key: { status: 1, priority: -1, createAt: 1 } },
  { key: { judge: 1, status: 1 } },
  { key: { rid: 1 }, unique: true },
];
```

## 6. 统计和分析模型

### 6.1 统计模型 (stat)

```typescript
interface DomainStat {
  _id: string;                    // 统计ID (domain:date)
  domainId: string;               // 域ID
  date: Date;                     // 统计日期
  
  // 用户统计
  user: {
    total: number;                // 总用户数
    active: number;               // 活跃用户数 (30天内)
    new: number;                  // 新注册用户数
  };
  
  // 题目统计
  problem: {
    total: number;                // 总题目数
    public: number;               // 公开题目数
    solved: number;               // 已解决题目数
  };
  
  // 提交统计
  record: {
    total: number;                // 总提交数
    accept: number;               // 通过数
    today: number;                // 今日提交数
  };
  
  // 比赛统计
  contest: {
    total: number;                // 总比赛数
    running: number;              // 进行中的比赛数
    finished: number;             // 已结束的比赛数
  };
  
  // 语言统计
  language: Record<string, {
    count: number;                // 使用次数
    accept: number;               // 通过次数
  }>;
}

interface UserStat {
  _id: number;                    // 用户ID
  domainId: string;               // 域ID
  
  // 基础统计
  nSubmit: number;                // 总提交数
  nAccept: number;                // 通过数
  nProblem: number;               // 解决的题目数
  
  // 最近活动
  recentSubmit: Date;             // 最近提交时间
  recentLogin: Date;              // 最近登录时间
  
  // 技能统计
  skills: {
    implementation: number;        // 实现能力
    math: number;                 // 数学能力
    dp: number;                   // 动态规划
    graph: number;                // 图论
    dataStructure: number;        // 数据结构
    string: number;               // 字符串
  };
  
  // 难度分布
  difficultyDistribution: number[]; // 各难度题目通过数
  
  // 时间分布
  submitTime: number[];           // 24小时提交分布
  
  // 语言偏好
  preferredLang: string;
  
  // 更新时间
  updateAt: Date;
}

// 索引定义
const statIndexes = [
  { key: { domainId: 1, date: -1 } },
  { key: { _id: 1, domainId: 1 } },
  { key: { updateAt: -1 } },
];
```

### 6.2 日志模型 (oplog)

```typescript
interface OperationLog {
  _id: ObjectId;                  // 日志ID
  
  // 操作信息
  type: string;                   // 操作类型
  operation: string;              // 具体操作
  
  // 操作者
  uid: number;                    // 操作用户
  ip: string;                     // IP地址
  ua: string;                     // User Agent
  
  // 操作对象
  target: {
    type: string;                 // 目标类型
    id: string;                   // 目标ID
  };
  
  // 操作详情
  before?: any;                   // 操作前状态
  after?: any;                    // 操作后状态
  
  // 时间戳
  at: Date;                       // 操作时间
  
  // 域信息
  domainId: string;               // 所属域
  
  // 额外信息
  extra?: Record<string, any>;
}

// 操作类型定义
const OPERATION_TYPE = {
  USER: 'user',                   // 用户操作
  PROBLEM: 'problem',             // 题目操作
  CONTEST: 'contest',             // 比赛操作
  RECORD: 'record',               // 记录操作
  DOMAIN: 'domain',               // 域操作
  SYSTEM: 'system',               // 系统操作
} as const;

// 索引定义
const oplogIndexes = [
  { key: { at: -1 } },
  { key: { uid: 1, at: -1 } },
  { key: { domainId: 1, at: -1 } },
  { key: { type: 1, at: -1 } },
  { key: { 'target.type': 1, 'target.id': 1, at: -1 } },
];
```

## 7. 数据库优化策略

### 7.1 分片策略

```typescript
// 分片配置
const shardingConfig = {
  // 用户数据按用户ID分片
  user: {
    shardKey: { _id: 1 },
    chunks: [
      { min: { _id: MinKey }, max: { _id: 100000 } },
      { min: { _id: 100000 }, max: { _id: 200000 } },
      { min: { _id: 200000 }, max: { _id: MaxKey } },
    ],
  },
  
  // 记录数据按时间和域分片
  record: {
    shardKey: { domainId: 1, _id: 1 },
    chunks: [
      { min: { domainId: MinKey, _id: MinKey }, max: { domainId: 'system', _id: MaxKey } },
      { min: { domainId: 'system', _id: MinKey }, max: { domainId: MaxKey, _id: MaxKey } },
    ],
  },
  
  // 日志数据按时间分片
  oplog: {
    shardKey: { at: 1 },
    chunks: [
      { min: { at: new Date('2023-01-01') }, max: { at: new Date('2023-07-01') } },
      { min: { at: new Date('2023-07-01') }, max: { at: new Date('2024-01-01') } },
      { min: { at: new Date('2024-01-01') }, max: { at: new Date() } },
    ],
  },
};
```

### 7.2 索引优化

```typescript
// 复合索引优化
const optimizedIndexes = {
  // 记录查询优化
  record: [
    // 用户提交记录查询
    { key: { uid: 1, domainId: 1, _id: -1 } },
    
    // 题目提交记录查询
    { key: { domainId: 1, pid: 1, _id: -1 } },
    
    // 比赛提交记录查询
    { key: { contest: 1, uid: 1, pid: 1 } },
    
    // 状态筛选查询
    { key: { domainId: 1, status: 1, _id: -1 } },
    
    // 排名查询
    { key: { domainId: 1, contest: 1, uid: 1, score: -1, time: 1 } },
  ],
  
  // 用户查询优化
  user: [
    // 用户名查询
    { key: { uname: 1 }, unique: true },
    
    // 邮箱查询
    { key: { mail: 1 }, unique: true },
    
    // 排名查询
    { key: { rp: -1, _id: 1 } },
    
    // 学校查询
    { key: { school: 1, rp: -1 } },
  ],
  
  // 题目查询优化
  problem: [
    // 域内题目查询
    { key: { domainId: 1, hidden: 1, _id: -1 } },
    
    // 标签查询
    { key: { domainId: 1, tag: 1, hidden: 1 } },
    
    // 难度查询
    { key: { domainId: 1, difficulty: 1, hidden: 1 } },
    
    // 通过率排序
    { key: { domainId: 1, nAccept: -1, hidden: 1 } },
  ],
};
```

### 7.3 查询优化

```typescript
// 分页查询优化
class OptimizedQuery {
  // 使用游标分页替代偏移分页
  async paginateWithCursor<T>(
    collection: string,
    query: any,
    options: {
      limit: number;
      cursor?: ObjectId;
      sort?: any;
    }
  ): Promise<{ docs: T[], nextCursor?: ObjectId }> {
    const { limit, cursor, sort = { _id: -1 } } = options;
    
    if (cursor) {
      query._id = { $lt: cursor };
    }
    
    const docs = await this.db.collection(collection)
      .find(query)
      .sort(sort)
      .limit(limit + 1)
      .toArray();
    
    const hasMore = docs.length > limit;
    if (hasMore) docs.pop();
    
    return {
      docs,
      nextCursor: hasMore ? docs[docs.length - 1]._id : undefined,
    };
  }
  
  // 聚合查询优化
  async getContestRanking(contestId: ObjectId): Promise<any[]> {
    return await this.db.collection('record').aggregate([
      // 匹配比赛记录
      { $match: { contest: contestId } },
      
      // 按用户和题目分组
      {
        $group: {
          _id: { uid: '$uid', pid: '$pid' },
          bestScore: { $max: '$score' },
          bestTime: { $min: '$time' },
          submitCount: { $sum: 1 },
          firstAccept: {
            $min: {
              $cond: [
                { $eq: ['$status', 1] },
                '$_id',
                null
              ]
            }
          }
        }
      },
      
      // 按用户重新分组
      {
        $group: {
          _id: '$_id.uid',
          problems: {
            $push: {
              pid: '$_id.pid',
              score: '$bestScore',
              time: '$bestTime',
              submitCount: '$submitCount',
              firstAccept: '$firstAccept'
            }
          },
          totalScore: { $sum: '$bestScore' },
          totalTime: { $sum: '$bestTime' }
        }
      },
      
      // 排序
      {
        $sort: {
          totalScore: -1,
          totalTime: 1,
          _id: 1
        }
      },
      
      // 添加排名
      {
        $setWindowFields: {
          sortBy: { totalScore: -1, totalTime: 1, _id: 1 },
          output: {
            rank: { $rank: {} }
          }
        }
      }
    ]).toArray();
  }
}
```

## 8. 数据备份和恢复

### 8.1 备份策略

```typescript
class BackupService {
  // 增量备份
  async incrementalBackup(since: Date): Promise<void> {
    const oplog = this.db.db('local').collection('oplog.rs');
    
    const changes = await oplog.find({
      ts: { $gte: new Timestamp(since.getTime() / 1000, 0) }
    }).toArray();
    
    const backupData = {
      timestamp: new Date(),
      type: 'incremental',
      since,
      changes,
    };
    
    await this.saveBackup(backupData);
  }
  
  // 全量备份
  async fullBackup(): Promise<void> {
    const collections = await this.db.listCollections().toArray();
    const backupData: any = {
      timestamp: new Date(),
      type: 'full',
      data: {},
    };
    
    for (const collection of collections) {
      const name = collection.name;
      const data = await this.db.collection(name).find({}).toArray();
      backupData.data[name] = data;
    }
    
    await this.saveBackup(backupData);
  }
  
  // 恢复数据
  async restore(backupId: string): Promise<void> {
    const backup = await this.loadBackup(backupId);
    
    if (backup.type === 'full') {
      await this.restoreFromFull(backup);
    } else {
      await this.restoreFromIncremental(backup);
    }
  }
  
  private async restoreFromFull(backup: any): Promise<void> {
    for (const [collectionName, data] of Object.entries(backup.data)) {
      const collection = this.db.collection(collectionName);
      
      // 清空集合
      await collection.deleteMany({});
      
      // 插入数据
      if (Array.isArray(data) && data.length > 0) {
        await collection.insertMany(data);
      }
    }
  }
}
```

### 8.2 数据迁移

```typescript
class MigrationService {
  private migrations: Migration[] = [];
  
  // 注册迁移
  registerMigration(migration: Migration): void {
    this.migrations.push(migration);
    this.migrations.sort((a, b) => a.version - b.version);
  }
  
  // 执行迁移
  async migrate(): Promise<void> {
    const currentVersion = await this.getCurrentVersion();
    
    for (const migration of this.migrations) {
      if (migration.version > currentVersion) {
        console.log(`Running migration ${migration.version}: ${migration.description}`);
        
        await migration.up(this.db);
        await this.updateVersion(migration.version);
        
        console.log(`Migration ${migration.version} completed`);
      }
    }
  }
  
  // 回滚迁移
  async rollback(targetVersion: number): Promise<void> {
    const currentVersion = await this.getCurrentVersion();
    
    for (let i = this.migrations.length - 1; i >= 0; i--) {
      const migration = this.migrations[i];
      
      if (migration.version <= currentVersion && migration.version > targetVersion) {
        console.log(`Rolling back migration ${migration.version}`);
        
        if (migration.down) {
          await migration.down(this.db);
        }
        
        await this.updateVersion(migration.version - 1);
      }
    }
  }
}

interface Migration {
  version: number;
  description: string;
  up: (db: Db) => Promise<void>;
  down?: (db: Db) => Promise<void>;
}

// 示例迁移
const migration_001: Migration = {
  version: 1,
  description: 'Add rating history to users',
  
  async up(db: Db) {
    await db.collection('user').updateMany(
      { ratingHistory: { $exists: false } },
      { $set: { ratingHistory: [] } }
    );
    
    await db.collection('user').createIndex({ 'ratingHistory.date': -1 });
  },
  
  async down(db: Db) {
    await db.collection('user').updateMany(
      {},
      { $unset: { ratingHistory: 1 } }
    );
    
    await db.collection('user').dropIndex({ 'ratingHistory.date': -1 });
  },
};
```

## 9. 总结

Hydro 数据库设计采用了 MongoDB 的文档存储优势，通过合理的数据模型设计、索引优化、分片策略等技术手段，构建了一个高性能、可扩展的数据存储系统。完善的备份恢复机制和数据迁移工具确保了数据的安全性和系统的可维护性。灵活的数据结构设计为系统的功能扩展提供了良好的基础支撑。