# HydroOJ 核心系统设计文档

## 1. 概述

HydroOJ 是 Hydro 系统的核心包，包含了在线测评系统的主要业务逻辑。它构建在 Hydro Framework 之上，提供了用户管理、题目管理、比赛系统、评测系统等核心功能。

## 2. 系统架构

### 2.1 模块结构

```
┌─────────────────────────────────────────────────────────────┐
│                      HydroOJ                               │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │   Handler    │  │    Model     │  │   Service    │     │
│  │   Layer      │  │    Layer     │  │    Layer     │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │   Script     │  │     Lib      │  │   Command    │     │
│  │   Layer      │  │    Layer     │  │    Layer     │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 目录结构

```
packages/hydrooj/src/
├── commands/              # 命令行工具
│   ├── addon.ts          # 插件管理命令
│   ├── db.ts             # 数据库管理命令
│   ├── install.ts        # 安装命令
│   └── patch.ts          # 补丁命令
├── entry/                # 入口文件
│   ├── cli.ts            # 命令行入口
│   ├── common.ts         # 公共入口
│   ├── setup.ts          # 安装入口
│   └── worker.ts         # 工作进程入口
├── handler/              # 请求处理器
│   ├── contest.ts        # 比赛处理器
│   ├── problem.ts        # 题目处理器
│   ├── user.ts           # 用户处理器
│   ├── record.ts         # 记录处理器
│   └── ...               # 其他处理器
├── model/                # 数据模型
│   ├── user.ts           # 用户模型
│   ├── problem.ts        # 题目模型
│   ├── contest.ts        # 比赛模型
│   ├── record.ts         # 记录模型
│   └── ...               # 其他模型
├── service/              # 系统服务
│   ├── db.ts             # 数据库服务
│   ├── server.ts         # HTTP 服务
│   ├── storage.ts        # 存储服务
│   └── ...               # 其他服务
├── lib/                  # 工具库
│   ├── mail.ts           # 邮件服务
│   ├── i18n.ts           # 国际化
│   ├── rating.ts         # 评分系统
│   └── ...               # 其他工具
└── script/               # 脚本任务
    ├── rating.ts         # 评分计算
    ├── problemStat.ts    # 题目统计
    └── ...               # 其他脚本
```

## 3. Handler 层设计

### 3.1 Handler 基类

```typescript
class Handler {
  constructor(ctx: Context) {}
  
  // 请求预处理
  async prepare(): Promise<void> {}
  
  // 权限检查
  async checkPermission(): Promise<void> {}
  
  // 参数验证
  async validate(): Promise<void> {}
  
  // 业务处理
  async handle(): Promise<void> {}
  
  // 响应后处理
  async cleanup(): Promise<void> {}
}
```

### 3.2 主要 Handler

#### 3.2.1 用户管理 (user.ts)

```typescript
class UserHandler extends Handler {
  // 用户注册
  @Post('/register')
  @Validate({
    mail: Types.string().email(),
    uname: Types.string().min(3).max(20),
    password: Types.string().min(6)
  })
  async register() {}
  
  // 用户登录
  @Post('/login')
  async login() {}
  
  // 用户详情
  @Get('/:uid')
  async detail() {}
  
  // 修改用户信息
  @Post('/:uid/edit')
  @Auth()
  async edit() {}
}
```

#### 3.2.2 题目管理 (problem.ts)

```typescript
class ProblemHandler extends Handler {
  // 题目列表
  @Get('/list')
  async list() {}
  
  // 题目详情
  @Get('/:pid')
  async detail() {}
  
  // 创建题目
  @Post('/create')
  @Auth(PERM.PROBLEM_CREATE)
  async create() {}
  
  // 编辑题目
  @Post('/:pid/edit')
  @Auth(PERM.PROBLEM_EDIT)
  async edit() {}
  
  // 提交代码
  @Post('/:pid/submit')
  @Auth()
  async submit() {}
}
```

#### 3.2.3 比赛管理 (contest.ts)

```typescript
class ContestHandler extends Handler {
  // 比赛列表
  @Get('/list')
  async list() {}
  
  // 比赛详情
  @Get('/:tid')
  async detail() {}
  
  // 创建比赛
  @Post('/create')
  @Auth(PERM.CONTEST_CREATE)
  async create() {}
  
  // 比赛计分板
  @Get('/:tid/scoreboard')
  async scoreboard() {}
  
  // 参加比赛
  @Post('/:tid/join')
  @Auth()
  async join() {}
}
```

## 4. Model 层设计

### 4.1 数据模型基类

```typescript
abstract class Model {
  static collection: string;
  
  static async get(id: string): Promise<any> {}
  static async getMulti(query: any): Promise<any[]> {}
  static async add(data: any): Promise<string> {}
  static async edit(id: string, data: any): Promise<void> {}
  static async del(id: string): Promise<void> {}
}
```

### 4.2 核心模型

#### 4.2.1 用户模型 (user.ts)

```typescript
interface User {
  _id: number;              // 用户ID
  uname: string;            // 用户名
  mail: string;             // 邮箱
  salt: string;             // 密码盐
  hash: string;             // 密码哈希
  priv: number;             // 权限
  regat: Date;              // 注册时间
  loginat: Date;            // 登录时间
  tfa?: string;             // 双因子认证
  avatar?: string;          // 头像
  bio?: string;             // 个人简介
  school?: string;          // 学校
}

class UserModel extends Model {
  static async getByUname(uname: string): Promise<User> {}
  static async getByMail(mail: string): Promise<User> {}
  static async create(data: Partial<User>): Promise<number> {}
  static async setPassword(uid: number, password: string): Promise<void> {}
  static async checkPassword(uid: number, password: string): Promise<boolean> {}
  static async setPerm(uid: number, perm: number): Promise<void> {}
}
```

#### 4.2.2 题目模型 (problem.ts)

```typescript
interface Problem {
  _id: ObjectId;            // 题目ID
  pid: string;              // 题目编号
  owner: number;            // 题目所有者
  title: string;            // 题目标题
  content: string;          // 题目内容
  nSubmit: number;          // 提交次数
  nAccept: number;          // 通过次数
  tag: string[];            // 题目标签
  hidden: boolean;          // 是否隐藏
  config: ProblemConfig;    // 评测配置
  data: ObjectId[];         // 测试数据
}

interface ProblemConfig {
  timeLimit: number;        // 时间限制
  memoryLimit: number;      // 内存限制
  checker: string;          // 检查器
  testcases: TestCase[];    // 测试用例
}

class ProblemModel extends Model {
  static async getByPid(pid: string): Promise<Problem> {}
  static async create(data: Partial<Problem>): Promise<ObjectId> {}
  static async updateStatus(pid: string): Promise<void> {}
  static async addTestdata(pid: string, file: Buffer): Promise<void> {}
  static async getConfig(pid: string): Promise<ProblemConfig> {}
}
```

#### 4.2.3 比赛模型 (contest.ts)

```typescript
interface Contest {
  _id: ObjectId;            // 比赛ID
  title: string;            // 比赛标题
  content: string;          // 比赛说明
  owner: number;            // 比赛创建者
  beginAt: Date;            // 开始时间
  endAt: Date;              // 结束时间
  pids: string[];           // 题目列表
  attend: number[];         // 参赛用户
  rule: string;             // 赛制
  rated: boolean;           // 是否计分
}

class ContestModel extends Model {
  static async create(data: Partial<Contest>): Promise<ObjectId> {}
  static async attend(tid: ObjectId, uid: number): Promise<void> {}
  static async getStatus(tid: ObjectId, uid: number): Promise<any> {}
  static async getScoreboard(tid: ObjectId): Promise<any[]> {}
  static async canViewCode(tid: ObjectId, uid: number): Promise<boolean> {}
}
```

#### 4.2.4 记录模型 (record.ts)

```typescript
interface Record {
  _id: ObjectId;            // 记录ID
  uid: number;              // 用户ID
  pid: string;              // 题目ID
  domainId: string;         // 域ID
  lang: string;             // 语言
  code: string;             // 代码
  score: number;            // 分数
  status: number;           // 状态
  time: number;             // 时间
  memory: number;           // 内存
  judgeTexts: string[];     // 评测信息
  compilerTexts: string[];  // 编译信息
  testCases: TestCaseResult[]; // 测试用例结果
  judgeAt: Date;            // 评测时间
  rejudged: boolean;        // 是否重测
}

class RecordModel extends Model {
  static async judge(rid: ObjectId): Promise<void> {}
  static async updateStatus(rid: ObjectId, status: any): Promise<void> {}
  static async rejudge(rid: ObjectId): Promise<void> {}
  static async getByUid(uid: number): Promise<Record[]> {}
}
```

## 5. Service 层设计

### 5.1 数据库服务 (db.ts)

```typescript
class DatabaseService {
  private client: MongoClient;
  private db: Db;
  
  async connect(uri: string): Promise<void> {}
  async disconnect(): Promise<void> {}
  
  collection<T>(name: string): Collection<T> {}
  
  // 分页查询
  async paginate<T>(
    collection: string,
    query: any,
    page: number,
    limit: number
  ): Promise<{ docs: T[], total: number }> {}
  
  // 排名查询
  async ranked<T>(
    collection: string,
    query: any,
    sort: any
  ): Promise<T[]> {}
}
```

### 5.2 存储服务 (storage.ts)

```typescript
interface StorageProvider {
  put(path: string, file: Buffer): Promise<void>;
  get(path: string): Promise<Buffer>;
  del(path: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  copy(from: string, to: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

class StorageService {
  private providers: Map<string, StorageProvider> = new Map();
  
  addProvider(name: string, provider: StorageProvider): void {}
  
  async put(bucket: string, path: string, file: Buffer): Promise<void> {}
  async get(bucket: string, path: string): Promise<Buffer> {}
  async del(bucket: string, path: string): Promise<void> {}
}
```

### 5.3 HTTP 服务 (server.ts)

```typescript
class HttpService {
  private app: Koa;
  private router: Router;
  
  async start(port: number): Promise<void> {}
  async stop(): Promise<void> {}
  
  use(middleware: Middleware): void {}
  route(method: string, path: string, handler: Handler): void {}
  
  // WebSocket 支持
  ws(path: string, handler: WebSocketHandler): void {}
}
```

### 5.4 队列服务 (worker.ts)

```typescript
interface Task {
  type: string;
  data: any;
  priority: number;
  retry: number;
}

class WorkerService {
  private queues: Map<string, Queue> = new Map();
  
  createQueue(name: string, options?: QueueOptions): Queue {}
  
  async addTask(queue: string, task: Task): Promise<void> {}
  async process(queue: string, handler: TaskHandler): Promise<void> {}
  
  // 定时任务
  schedule(cron: string, handler: ScheduleHandler): void {}
}
```

## 6. 业务逻辑层

### 6.1 权限系统

```typescript
// 权限定义
const PERM = {
  // 全局权限
  PRIV_USER_PROFILE: 1 << 0,
  PRIV_REGISTER_USER: 1 << 1,
  PRIV_CREATE_DOMAIN: 1 << 2,
  
  // 域权限
  PERM_VIEW: 1 << 0,
  PERM_VIEW_PROBLEM: 1 << 1,
  PERM_SUBMIT_PROBLEM: 1 << 2,
  PERM_CREATE_PROBLEM: 1 << 3,
  PERM_EDIT_PROBLEM: 1 << 4,
};

class PermissionSystem {
  static hasPerm(user: User, perm: number): boolean {}
  static hasPriv(user: User, priv: number): boolean {}
  static check(user: User, perm: number): void {}
}
```

### 6.2 评测系统接口

```typescript
interface JudgeTask {
  rid: ObjectId;            // 记录ID
  pid: string;              // 题目ID
  uid: number;              // 用户ID
  lang: string;             // 语言
  code: string;             // 代码
  config: ProblemConfig;    // 评测配置
  data: Buffer[];           // 测试数据
}

interface JudgeResult {
  status: number;           // 评测状态
  score: number;            // 分数
  time: number;             // 时间
  memory: number;           // 内存
  details: TestCaseResult[]; // 详细结果
  compilerText: string;     // 编译信息
  judgeText: string;        // 评测信息
}

class JudgeService {
  async addTask(task: JudgeTask): Promise<void> {}
  async updateResult(rid: ObjectId, result: JudgeResult): Promise<void> {}
}
```

### 6.3 比赛系统

```typescript
// 比赛规则接口
interface ContestRule {
  calcStatus(record: Record[]): ContestStatus;
  calcRating(contest: Contest, rank: RankData[]): Rating[];
  canViewCode(contest: Contest, uid: number): boolean;
  showScoreboard(contest: Contest): boolean;
}

// ACM 规则
class ACMRule implements ContestRule {
  calcStatus(records: Record[]): ContestStatus {
    // ACM 计分逻辑
  }
}

// OI 规则  
class OIRule implements ContestRule {
  calcStatus(records: Record[]): ContestStatus {
    // OI 计分逻辑
  }
}

// IOI 规则
class IOIRule implements ContestRule {
  calcStatus(records: Record[]): ContestStatus {
    // IOI 计分逻辑
  }
}
```

### 6.4 消息系统

```typescript
interface Message {
  _id: ObjectId;
  from: number;
  to: number;
  title: string;
  content: string;
  flag: number;
  sendAt: Date;
  readAt?: Date;
}

class MessageModel extends Model {
  static async send(from: number, to: number, title: string, content: string): Promise<void> {}
  static async getByUser(uid: number): Promise<Message[]> {}
  static async markRead(mid: ObjectId): Promise<void> {}
  static async del(mid: ObjectId): Promise<void> {}
}
```

## 7. 扩展系统

### 7.1 钩子系统

```typescript
// 钩子定义
interface Hook {
  name: string;
  handler: Function;
  priority: number;
}

class HookSystem {
  private hooks: Map<string, Hook[]> = new Map();
  
  register(event: string, handler: Function, priority = 0): void {}
  unregister(event: string, handler: Function): void {}
  
  async emit(event: string, ...args: any[]): Promise<any> {}
  filter(event: string, data: any): any {}
}

// 常用钩子
- user/login           // 用户登录
- user/register        // 用户注册
- problem/create       // 题目创建
- record/judge         // 开始评测
- contest/create       // 比赛创建
```

### 7.2 插件API

```typescript
// 插件基类
abstract class Plugin {
  constructor(protected ctx: Context) {}
  
  abstract async start(): Promise<void>;
  abstract async stop(): Promise<void>;
  
  // 工具方法
  protected addHandler(handler: Handler): void {}
  protected addModel(model: Model): void {}
  protected addService(service: Service): void {}
}

// 插件示例
class BlogPlugin extends Plugin {
  async start() {
    this.addHandler(BlogHandler);
    this.addModel(BlogModel);
    
    this.ctx.on('user/login', this.onUserLogin);
  }
  
  private onUserLogin = (user: User) => {
    // 处理用户登录事件
  }
}
```

## 8. 配置管理

### 8.1 系统设置

```typescript
interface SystemSettings {
  // 基础设置
  siteName: string;
  siteDescription: string;
  serverHost: string;
  serverPort: number;
  
  // 功能设置
  allowRegister: boolean;
  allowUpload: boolean;
  uploadSizeLimit: number;
  
  // 邮件设置
  mailHost: string;
  mailPort: number;
  mailUser: string;
  mailPassword: string;
  
  // 评测设置
  judgeHost: string;
  judgeSecret: string;
  judgeParallelism: number;
}

class SettingModel extends Model {
  static async get(key: string): Promise<any> {}
  static async set(key: string, value: any): Promise<void> {}
  static async getMany(keys: string[]): Promise<Record<string, any>> {}
}
```

## 9. 国际化

### 9.1 i18n 系统

```typescript
class I18nService {
  private locales: Map<string, Record<string, string>> = new Map();
  
  load(locale: string, messages: Record<string, string>): void {}
  
  translate(locale: string, key: string, ...args: any[]): string {}
  
  // 格式化
  formatDate(locale: string, date: Date): string {}
  formatNumber(locale: string, number: number): string {}
}

// 使用示例
ctx.i18n.translate('zh', 'user.login.success', username);
// 输出: "用户 {username} 登录成功"
```

## 10. 安全机制

### 10.1 输入验证

```typescript
// XSS 防护
function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html);
}

// CSRF 防护
function generateCSRFToken(session: Session): string {}
function validateCSRFToken(token: string, session: Session): boolean {}

// 参数验证
function validateInput(data: any, schema: Schema): ValidationResult {}
```

### 10.2 权限控制

```typescript
// 访问控制
function checkPermission(user: User, resource: string, action: string): boolean {}

// 角色管理
interface Role {
  name: string;
  permissions: string[];
}

class RoleModel extends Model {
  static async getByUser(uid: number): Promise<Role[]> {}
  static async assignRole(uid: number, role: string): Promise<void> {}
}
```

## 11. 总结

HydroOJ 核心系统采用了经典的三层架构设计，通过 Handler、Model、Service 的分层设计实现了良好的代码组织和职责分离。完善的权限系统、扩展机制和安全措施确保了系统的稳定性和可扩展性。模块化的设计使得系统能够适应不同的业务需求，为在线测评系统提供了强大的技术支撑。