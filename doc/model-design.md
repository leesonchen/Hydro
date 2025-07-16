# Hydro Model 层设计文档

## 1. 概述

Hydro 系统的 Model 层采用统一的文档数据库抽象设计，基于 MongoDB 提供类型安全的数据访问接口。Model 层负责业务逻辑封装、数据验证、缓存管理和权限控制，是系统的核心数据访问层。

## 2. 设计原则

### 2.1 统一的数据访问接口

```typescript
// 所有模型都继承自统一的基础类
export abstract class Model {
    protected static coll: Collection;
    
    @ArgMethod
    static async get(id: ObjectId): Promise<any>;
    
    @ArgMethod
    static async add(data: any): Promise<ObjectId>;
    
    @ArgMethod
    static async set(id: ObjectId, data: any): Promise<void>;
}
```

### 2.2 类型安全的泛型设计

```typescript
// 文档类型映射
export interface DocType {
    [TYPE_PROBLEM]: ProblemDoc;
    [TYPE_CONTEST]: Tdoc;
    [TYPE_DISCUSSION]: DiscussionDoc;
    [TYPE_TRAINING]: TrainingDoc;
    [TYPE_HOMEWORK]: HomeworkDoc;
}

// 泛型数据访问
export function get<T extends keyof DocType>(
    domainId: string, 
    docType: T, 
    docId: ObjectId
): Promise<DocType[T]>;
```

### 2.3 事件驱动架构

```typescript
// 事件总线集成
export class ModelBase {
    static async emit(event: string, ...args: any[]): Promise<void> {
        await bus.emit(event, ...args);
    }
    
    static async parallel(event: string, ...args: any[]): Promise<any[]> {
        return await bus.parallel(event, ...args);
    }
}
```

## 3. 核心模型架构

### 3.1 用户模型 (UserModel)

**文件位置**：`packages/hydrooj/src/model/user.ts`

#### 数据结构

```typescript
export interface UserDoc {
    _id: number;                    // 用户ID
    uname: string;                  // 用户名
    unameLower: string;             // 用户名小写
    mail: string;                   // 邮箱
    mailLower: string;              // 邮箱小写
    salt: string;                   // 密码盐
    hash: string;                   // 密码哈希
    hashType: 'bcrypt' | 'hydro';   // 哈希类型
    priv: number;                   // 全局权限
    regat: Date;                    // 注册时间
    loginat: Date;                  // 最后登录时间
    loginip: string;                // 最后登录IP
    tfa?: string;                   // 双因子认证
    avatar?: string;                // 头像URL
    // ...其他字段
}
```

#### 核心方法

```typescript
export class UserModel extends ModelBase {
    // 用户创建
    @ArgMethod
    static async create(
        mail: string,
        uname: string,
        password: string,
        uid?: number,
        regip?: string,
        priv?: number,
        avatar?: string
    ): Promise<number>;
    
    // 用户获取
    @ArgMethod
    static async getById(domainId: string, uid: number): Promise<UserDoc>;
    
    @ArgMethod
    static async getByUname(domainId: string, uname: string): Promise<UserDoc>;
    
    @ArgMethod
    static async getByEmail(domainId: string, mail: string): Promise<UserDoc>;
    
    // 密码管理
    @ArgMethod
    static async setPassword(uid: number, password: string): Promise<void>;
    
    @ArgMethod
    static async verifyPassword(uid: number, password: string): Promise<boolean>;
    
    // 权限管理
    @ArgMethod
    static async setRole(domainId: string, uid: number, role: string): Promise<void>;
    
    @ArgMethod
    static hasPriv(udoc: UserDoc, priv: number): boolean;
    
    @ArgMethod
    static hasPerm(udoc: UserDoc, perm: number): boolean;
}
```

#### 缓存策略

```typescript
// 多键缓存系统
const userCache = new LRU<string, UserDoc>({
    max: 10000,
    ttl: 5 * 60 * 1000, // 5分钟
});

// 缓存键生成
function getUserCacheKey(type: 'id' | 'name' | 'mail', value: string, domainId: string): string {
    return `${type}/${value}/${domainId}`;
}

// 缓存失效机制
bus.on('user/update', (uid: number) => {
    // 删除相关缓存
    userCache.forEach((value, key) => {
        if (key.includes(`/${uid}/`)) {
            userCache.delete(key);
        }
    });
});
```

#### 安全控制

```typescript
// 邮箱规范化处理
function handleMailLower(mail: string): string {
    const [n, d] = mail.trim().toLowerCase().split('@');
    const [name] = n.split('+');
    return `${name.replace(/\./g, '')}@${d === 'googlemail.com' ? 'gmail.com' : d}`;
}

// 密码哈希升级
static async verifyPassword(uid: number, password: string): Promise<boolean> {
    const udoc = await UserModel.getById('system', uid);
    if (!udoc) return false;
    
    const result = await pwhash.verify(password, udoc.hash, udoc.salt);
    
    // 自动升级旧的哈希算法
    if (result && udoc.hashType !== 'hydro') {
        await UserModel.setPassword(uid, password);
    }
    
    return result;
}
```

### 3.2 文档模型 (DocumentModel)

**文件位置**：`packages/hydrooj/src/model/document.ts`

#### 统一文档类型系统

```typescript
export const TYPE_PROBLEM = 10;
export const TYPE_PROBLEM_SOLUTION = 11;
export const TYPE_DISCUSSION = 21;
export const TYPE_DISCUSSION_REPLY = 22;
export const TYPE_CONTEST = 30;
export const TYPE_TRAINING = 40;
export const TYPE_HOMEWORK = 60;

export interface DocumentDoc {
    _id: ObjectId;
    domainId: string;
    docType: number;
    docId: ObjectId | number;
    owner: number;
    title?: string;
    content?: string;
    
    // 层级关系
    parentType?: number;
    parentId?: ObjectId | number;
    
    // 状态管理
    hidden?: boolean;
    sort?: string;
    
    // 时间戳
    updateAt?: Date;
    
    // 扩展字段
    [key: string]: any;
}
```

#### 核心方法

```typescript
export class DocumentModel extends ModelBase {
    // 文档操作
    @ArgMethod
    static async add<T extends keyof DocType>(
        domainId: string,
        docType: T,
        docId: ObjectId | number,
        owner: number,
        doc: Partial<DocType[T]>
    ): Promise<ObjectId>;
    
    @ArgMethod
    static async get<T extends keyof DocType>(
        domainId: string,
        docType: T,
        docId: ObjectId | number
    ): Promise<DocType[T]>;
    
    @ArgMethod
    static async set<T extends keyof DocType>(
        domainId: string,
        docType: T,
        docId: ObjectId | number,
        doc: Partial<DocType[T]>
    ): Promise<void>;
    
    @ArgMethod
    static async getMulti<T extends keyof DocType>(
        domainId: string,
        docType: T,
        query?: any
    ): Cursor<DocType[T]>;
    
    // 数组字段操作
    @ArgMethod
    static async push<T extends keyof DocType>(
        domainId: string,
        docType: T,
        docId: ObjectId | number,
        key: string,
        value: any
    ): Promise<void>;
    
    @ArgMethod
    static async pull<T extends keyof DocType>(
        domainId: string,
        docType: T,
        docId: ObjectId | number,
        key: string,
        value: any
    ): Promise<void>;
    
    // 状态管理
    @ArgMethod
    static async getStatus<T extends keyof DocType>(
        domainId: string,
        docType: T,
        docId: ObjectId | number,
        uid: number
    ): Promise<any>;
    
    @ArgMethod
    static async setStatus<T extends keyof DocType>(
        domainId: string,
        docType: T,
        docId: ObjectId | number,
        uid: number,
        status: any
    ): Promise<void>;
}
```

#### 状态管理系统

```typescript
// 文档状态集合
export interface DocumentStatusDoc {
    _id: ObjectId;
    domainId: string;
    docType: number;
    docId: ObjectId | number;
    uid: number;
    
    // 状态信息
    status?: number;
    score?: number;
    rid?: ObjectId;
    rp?: number;
    accept?: number;
    time?: number;
    
    // 扩展字段
    enroll?: boolean;
    journal?: JournalEntry[];
    detail?: any;
}

// 状态操作
export class DocumentStatusModel {
    @ArgMethod
    static async set(
        domainId: string,
        docType: number,
        docId: ObjectId | number,
        uid: number,
        status: Partial<DocumentStatusDoc>
    ): Promise<void>;
    
    @ArgMethod
    static async get(
        domainId: string,
        docType: number,
        docId: ObjectId | number,
        uid: number
    ): Promise<DocumentStatusDoc>;
}
```

### 3.3 题目模型 (ProblemModel)

**文件位置**：`packages/hydrooj/src/model/problem.ts`

#### 数据结构

```typescript
export interface ProblemDoc extends DocumentDoc {
    docType: 10;
    pid: string;                    // 题目编号
    title: string;                  // 题目标题
    content: string;                // 题目内容
    owner: number;                  // 创建者
    
    // 题目属性
    tag: string[];                  // 标签
    hidden: boolean;                // 是否隐藏
    nSubmit: number;                // 提交数
    nAccept: number;                // 通过数
    difficulty: number;             // 难度
    
    // 文件管理
    data: FileInfo[];               // 测试数据
    additional_file: FileInfo[];    // 附加文件
    
    // 配置信息
    config: string;                 // 配置文件内容
    
    // 维护者
    maintainer: number[];           // 维护者列表
    
    // 引用关系
    reference?: ProblemReference;   // 引用的题目
    
    // 统计信息
    stats?: any;                    // 统计数据
}
```

#### 核心方法

```typescript
export class ProblemModel extends ModelBase {
    // 题目操作
    @ArgMethod
    static async add(
        domainId: string,
        pid: string,
        title: string,
        content: string,
        owner: number,
        tag: string[] = [],
        hidden = false
    ): Promise<ObjectId>;
    
    @ArgMethod
    static async get(
        domainId: string,
        pid: string,
        uid?: number
    ): Promise<ProblemDoc>;
    
    @ArgMethod
    static async edit(
        domainId: string,
        pid: string,
        doc: Partial<ProblemDoc>
    ): Promise<void>;
    
    @ArgMethod
    static async del(domainId: string, pid: string): Promise<void>;
    
    // 配置管理
    @ArgMethod
    static async getConfig(domainId: string, pid: string): Promise<ProblemConfig>;
    
    @ArgMethod
    static async updateConfig(
        domainId: string,
        pid: string,
        config: ProblemConfig
    ): Promise<void>;
    
    // 数据管理
    @ArgMethod
    static async addTestdata(
        domainId: string,
        pid: string,
        name: string,
        data: Buffer
    ): Promise<void>;
    
    @ArgMethod
    static async delTestdata(
        domainId: string,
        pid: string,
        name: string
    ): Promise<void>;
    
    // 统计更新
    @ArgMethod
    static async updateStatus(
        domainId: string,
        pid: string,
        uid: number,
        rid: ObjectId,
        status: number,
        score: number
    ): Promise<void>;
    
    // 导入导出
    @ArgMethod
    static async import(
        domainId: string,
        pid: string,
        data: Buffer,
        filename: string
    ): Promise<void>;
    
    @ArgMethod
    static async export(
        domainId: string,
        pids: string[]
    ): Promise<Buffer>;
}
```

#### 排序算法

```typescript
// 题目排序算法
function sortable(source: string, namespaces: Record<string, string> = {}): string {
    const [namespace, pid] = source.includes('-') ? source.split('-') : ['default', source];
    return ((namespaces[namespace] || namespace) + '-' + pid)
        .replace(/(\d+)/g, (str) => (str.length >= 6 ? str : ('0'.repeat(6 - str.length) + str)));
}

// 题目列表排序
@ArgMethod
static getMulti(
    domainId: string,
    query: any = {},
    projection: any = {}
): Cursor<ProblemDoc> {
    return DocumentModel.getMulti(domainId, TYPE_PROBLEM, query, projection)
        .sort('sort', 1);
}
```

### 3.4 比赛模型 (ContestModel)

**文件位置**：`packages/hydrooj/src/model/contest.ts`

#### 比赛规则系统

```typescript
// 比赛规则接口
export interface ContestRule<T = any> {
    TEXT: string;
    
    check(args: any): any;
    statusSort(a: any, b: any): number;
    showScoreboard(tdoc: Tdoc, now: Date): boolean;
    showRecord(tdoc: Tdoc, now: Date): boolean;
    stat(tdoc: Tdoc, journal: JournalEntry[]): any;
    scoreboard(isExport: boolean, _, tdoc: Tdoc, rankedTsdocs: any[], udict: any, pdict: any): any;
    ranked(tdoc: Tdoc, cursor: Cursor<any>): Cursor<any>;
    applyProjection: (tdoc: Tdoc, tsdoc: any) => any;
}

// 规则注册
export const RULES: ContestRules = {
    acm: ACMRule,
    oi: OIRule,
    homework: HomeworkRule,
    ioi: IOIRule,
    ledo: LEDORule,
    strictioi: StrictIOIRule,
};

// 规则构建器
export function buildContestRule<T>(
    def: Optional<ContestRule<T>, 'applyProjection'>
): ContestRule<T> {
    return {
        applyProjection: (tdoc, tsdoc) => tsdoc,
        ...def,
    };
}
```

#### 核心方法

```typescript
export class ContestModel extends ModelBase {
    // 比赛操作
    @ArgMethod
    static async add(
        domainId: string,
        title: string,
        content: string,
        owner: number,
        rule: string,
        beginAt: Date,
        endAt: Date,
        pids: string[] = [],
        options: any = {}
    ): Promise<ObjectId>;
    
    @ArgMethod
    static async get(domainId: string, tid: ObjectId): Promise<Tdoc>;
    
    @ArgMethod
    static async edit(
        domainId: string,
        tid: ObjectId,
        doc: Partial<Tdoc>
    ): Promise<void>;
    
    // 状态判断
    @ArgMethod
    static isNew(tdoc: Tdoc, now = new Date()): boolean {
        return now < tdoc.beginAt;
    }
    
    @ArgMethod
    static isOngoing(tdoc: Tdoc, now = new Date()): boolean {
        return tdoc.beginAt <= now && now < tdoc.endAt;
    }
    
    @ArgMethod
    static isDone(tdoc: Tdoc, now = new Date()): boolean {
        return now >= tdoc.endAt;
    }
    
    // 参赛管理
    @ArgMethod
    static async attend(domainId: string, tid: ObjectId, uid: number): Promise<void>;
    
    @ArgMethod
    static async unattend(domainId: string, tid: ObjectId, uid: number): Promise<void>;
    
    // 排行榜
    @ArgMethod
    static async getStatus(
        domainId: string,
        tid: ObjectId,
        uid: number
    ): Promise<any>;
    
    @ArgMethod
    static async setStatus(
        domainId: string,
        tid: ObjectId,
        uid: number,
        status: any
    ): Promise<void>;
    
    @ArgMethod
    static async getScoreboard(
        domainId: string,
        tid: ObjectId,
        isExport = false,
        page = 1,
        isPublic = false
    ): Promise<any>;
}
```

### 3.5 记录模型 (RecordModel)

**文件位置**：`packages/hydrooj/src/model/record.ts`

#### 数据结构

```typescript
export interface RecordDoc {
    _id: ObjectId;
    domainId: string;
    pid: number;
    uid: number;
    lang: string;
    code: string;
    
    // 评测结果
    status: number;
    score: number;
    time: number;
    memory: number;
    
    // 评测详情
    judgeTexts?: string[];
    compilerTexts?: string[];
    testCases?: TestCase[];
    subtasks?: Record<number, SubtaskResult>;
    
    // 元数据
    judger?: string;
    judgeAt?: Date;
    rejudged?: boolean;
    
    // 比赛信息
    contest?: ObjectId;
    
    // 其他
    input?: string;
    files?: Record<string, string>;
    hackTarget?: ObjectId;
    hidden?: boolean;
}
```

#### 核心方法

```typescript
export class RecordModel extends ModelBase {
    // 记录操作
    @ArgMethod
    static async add(
        domainId: string,
        pid: number,
        uid: number,
        lang: string,
        code: string,
        addTask = true,
        contest?: ObjectId,
        input?: string,
        files?: Record<string, string>
    ): Promise<ObjectId>;
    
    @ArgMethod
    static async get(domainId: string, rid: ObjectId): Promise<RecordDoc>;
    
    @ArgMethod
    static async judge(domainId: string, rid: ObjectId, priority = 0): Promise<void>;
    
    @ArgMethod
    static async rejudge(domainId: string, rid: ObjectId): Promise<void>;
    
    // 优先级算法
    @ArgMethod
    static async submissionPriority(uid: number, base = 0): Promise<number> {
        // 获取用户最近提交记录
        const timeRecent = await RecordModel.getMulti('system', {
            uid,
            _id: { $gt: ObjectId.createFromTime(Date.now() / 1000 - 600) }, // 最近10分钟
        }).toArray();
        
        // 计算等待中的提交数量
        const pending = timeRecent.filter(i => [
            STATUS.STATUS_WAITING,
            STATUS.STATUS_FETCHED,
            STATUS.STATUS_COMPILING,
            STATUS.STATUS_JUDGING,
        ].includes(i.status)).length;
        
        // 计算平均耗时
        const avgTime = sum(timeRecent.map(i => i.time || 0)) / timeRecent.length || 0;
        
        // 动态调整优先级
        return Math.max(
            base - 10000,
            base - (pending * 1000 + 1) * (avgTime / 10000 + 1)
        );
    }
    
    // 统计更新
    @ArgMethod
    static async updateStatus(
        domainId: string,
        rid: ObjectId,
        status: number,
        score: number,
        time: number,
        memory: number
    ): Promise<void>;
    
    // 代码分析
    @ArgMethod
    static async stat(): Promise<any>;
}
```

#### 判题任务管理

```typescript
// 判题任务队列
export class JudgeTask {
    @ArgMethod
    static async add(
        domainId: string,
        rid: ObjectId,
        priority = 0,
        config: any = {}
    ): Promise<void> {
        const record = await RecordModel.get(domainId, rid);
        if (!record) throw new RecordNotFoundError(rid);
        
        const priority = await RecordModel.submissionPriority(record.uid, priority);
        
        await TaskModel.add({
            type: 'judge',
            domainId,
            rid,
            pid: record.pid,
            uid: record.uid,
            lang: record.lang,
            code: record.code,
            data: config.data,
            priority,
        });
    }
    
    @ArgMethod
    static async get(domainId: string, rid: ObjectId): Promise<JudgeTask>;
    
    @ArgMethod
    static async update(
        domainId: string,
        rid: ObjectId,
        progress: any
    ): Promise<void>;
}
```

### 3.6 域模型 (DomainModel)

**文件位置**：`packages/hydrooj/src/model/domain.ts`

#### 数据结构

```typescript
export interface DomainDoc {
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
}

export interface DomainUserDoc {
    _id: ObjectId;
    domainId: string;
    uid: number;
    role?: string;
    rp?: number;
    rank?: number;
    displayName?: string;
    school?: string;
    
    // 扩展字段
    [key: string]: any;
}
```

#### 核心方法

```typescript
export class DomainModel extends ModelBase {
    // 域操作
    @ArgMethod
    static async add(
        id: string,
        owner: number,
        name: string,
        bulletin?: string
    ): Promise<void>;
    
    @ArgMethod
    static async get(id: string): Promise<DomainDoc>;
    
    @ArgMethod
    static async edit(id: string, doc: Partial<DomainDoc>): Promise<void>;
    
    @ArgMethod
    static async del(id: string): Promise<void>;
    
    // 用户管理
    @ArgMethod
    static async joinDomain(
        domainId: string,
        uid: number,
        role?: string
    ): Promise<void>;
    
    @ArgMethod
    static async leaveDomain(domainId: string, uid: number): Promise<void>;
    
    @ArgMethod
    static async setUserRole(
        domainId: string,
        uid: number,
        role: string
    ): Promise<void>;
    
    @ArgMethod
    static async getUserInDomain(
        domainId: string,
        uid: number
    ): Promise<DomainUserDoc>;
    
    // 权限管理
    @ArgMethod
    static async setUserPermission(
        domainId: string,
        uid: number,
        perm: number
    ): Promise<void>;
    
    @ArgMethod
    static async getUserPermission(
        domainId: string,
        uid: number
    ): Promise<number>;
    
    // 排名系统
    @ArgMethod
    static async updateUserRP(
        domainId: string,
        uid: number,
        rp: number
    ): Promise<void>;
    
    @ArgMethod
    static getRanking(domainId: string): Cursor<DomainUserDoc>;
}
```

#### 加入机制

```typescript
// 加入方式
export class DomainJoinMethod {
    static JOIN_METHOD_NONE = 0;      // 不允许加入
    static JOIN_METHOD_ALL = 1;       // 允许所有人加入
    static JOIN_METHOD_CODE = 2;      // 需要邀请码
    static JOIN_METHOD_RANGE = 3;     // IP段限制
}

// 加入设置
export interface DomainJoinSettings {
    method: number;
    code?: string;
    range?: string[];
    role?: string;
}

// 加入逻辑
@ArgMethod
static async join(
    domainId: string,
    uid: number,
    code?: string,
    ip?: string
): Promise<void> {
    const ddoc = await DomainModel.get(domainId);
    if (!ddoc) throw new DomainNotFoundError(domainId);
    
    const { join } = ddoc;
    if (!join || join.method === DomainJoinMethod.JOIN_METHOD_NONE) {
        throw new ForbiddenError('Domain join disabled');
    }
    
    if (join.method === DomainJoinMethod.JOIN_METHOD_CODE) {
        if (code !== join.code) {
            throw new InvalidTokenError('Invalid join code');
        }
    }
    
    if (join.method === DomainJoinMethod.JOIN_METHOD_RANGE) {
        if (!ip || !join.range?.some(range => ipInRange(ip, range))) {
            throw new ForbiddenError('IP not in allowed range');
        }
    }
    
    await DomainModel.joinDomain(domainId, uid, join.role);
}
```

## 4. 辅助模型

### 4.1 消息模型 (MessageModel)

```typescript
export interface MessageDoc {
    _id: ObjectId;
    from: number;
    to: number;
    title: string;
    content: string;
    flag: number;
    sendAt: Date;
    readAt?: Date;
}

export class MessageModel extends ModelBase {
    @ArgMethod
    static async send(
        from: number,
        to: number,
        title: string,
        content: string,
        flag = 0
    ): Promise<ObjectId>;
    
    @ArgMethod
    static async get(uid: number, mid: ObjectId): Promise<MessageDoc>;
    
    @ArgMethod
    static async getByUser(uid: number): Cursor<MessageDoc>;
    
    @ArgMethod
    static async setRead(uid: number, mid: ObjectId): Promise<void>;
    
    @ArgMethod
    static async del(uid: number, mid: ObjectId): Promise<void>;
}
```

### 4.2 任务模型 (TaskModel)

```typescript
export interface TaskDoc {
    _id: ObjectId;
    type: string;
    subType?: string;
    priority: number;
    executeAfter?: Date;
    
    // 任务数据
    [key: string]: any;
}

export class TaskModel extends ModelBase {
    @ArgMethod
    static async add(doc: Partial<TaskDoc>): Promise<ObjectId>;
    
    @ArgMethod
    static async get(id: ObjectId): Promise<TaskDoc>;
    
    @ArgMethod
    static async getFirst(query: any): Promise<TaskDoc>;
    
    @ArgMethod
    static async del(id: ObjectId): Promise<void>;
    
    @ArgMethod
    static async count(query: any): Promise<number>;
}
```

### 4.3 系统设置模型 (SystemModel)

```typescript
export interface SystemDoc {
    _id: string;
    value: any;
}

export class SystemModel extends ModelBase {
    @ArgMethod
    static async get(key: string): Promise<any>;
    
    @ArgMethod
    static async set(key: string, value: any): Promise<void>;
    
    @ArgMethod
    static async del(key: string): Promise<void>;
    
    @ArgMethod
    static async getMany(keys: string[]): Promise<Record<string, any>>;
    
    @ArgMethod
    static async setMany(settings: Record<string, any>): Promise<void>;
}
```

## 5. 性能优化策略

### 5.1 缓存机制

```typescript
// 分层缓存系统
export class CacheManager {
    private static userCache = new LRU<string, UserDoc>({
        max: 10000,
        ttl: 5 * 60 * 1000, // 5分钟
    });
    
    private static domainCache = new LRU<string, DomainDoc>({
        max: 1000,
        ttl: 60 * 60 * 1000, // 1小时
    });
    
    private static problemCache = new LRU<string, ProblemDoc>({
        max: 5000,
        ttl: 10 * 60 * 1000, // 10分钟
    });
    
    // 智能缓存失效
    static invalidateUser(uid: number): void {
        this.userCache.forEach((value, key) => {
            if (key.includes(`/${uid}/`)) {
                this.userCache.delete(key);
            }
        });
    }
    
    static invalidateDomain(domainId: string): void {
        this.domainCache.delete(domainId);
    }
}
```

### 5.2 数据库优化

```typescript
// 索引优化
export class IndexManager {
    static async createIndexes(): Promise<void> {
        // 用户索引
        await db.collection('user').createIndex({ unameLower: 1 }, { unique: true });
        await db.collection('user').createIndex({ mailLower: 1 }, { unique: true });
        
        // 文档索引
        await db.collection('document').createIndex({ 
            domainId: 1, docType: 1, docId: 1 
        }, { unique: true });
        
        // 记录索引
        await db.collection('record').createIndex({ 
            domainId: 1, contest: 1, uid: 1, _id: -1 
        });
        
        // 状态索引
        await db.collection('document.status').createIndex({ 
            domainId: 1, docType: 1, docId: 1, uid: 1 
        }, { unique: true });
    }
}
```

### 5.3 查询优化

```typescript
// 分页优化
export class PaginationOptimizer {
    static async getPaginatedResults<T>(
        collection: string,
        query: any,
        page: number,
        limit: number,
        sort: any = { _id: -1 }
    ): Promise<{ docs: T[], hasMore: boolean }> {
        const skip = (page - 1) * limit;
        
        const docs = await db.collection(collection)
            .find(query)
            .sort(sort)
            .skip(skip)
            .limit(limit + 1)
            .toArray();
        
        const hasMore = docs.length > limit;
        if (hasMore) docs.pop();
        
        return { docs, hasMore };
    }
}
```

## 6. 安全控制

### 6.1 权限验证

```typescript
// 权限检查装饰器
export function RequirePermission(perm: number) {
    return function(target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        const originalMethod = descriptor.value;
        
        descriptor.value = async function(...args: any[]) {
            const ctx = this as any;
            if (!ctx.user || !UserModel.hasPerm(ctx.user, perm)) {
                throw new PermissionError(perm);
            }
            return originalMethod.apply(this, args);
        };
        
        return descriptor;
    };
}

// 所有者检查
export function RequireOwnership(getOwner: (args: any[]) => number) {
    return function(target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        const originalMethod = descriptor.value;
        
        descriptor.value = async function(...args: any[]) {
            const ctx = this as any;
            const owner = getOwner(args);
            
            if (ctx.user._id !== owner && !UserModel.hasPriv(ctx.user, PRIV.PRIV_ADMIN)) {
                throw new ForbiddenError();
            }
            
            return originalMethod.apply(this, args);
        };
        
        return descriptor;
    };
}
```

### 6.2 数据验证

```typescript
// 输入验证
export class InputValidator {
    static validateEmail(email: string): boolean {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(email);
    }
    
    static validateUsername(username: string): boolean {
        const usernameRegex = /^[a-zA-Z0-9_-]{3,20}$/;
        return usernameRegex.test(username);
    }
    
    static sanitizeContent(content: string): string {
        // 清理HTML和脚本
        return content.replace(/<script[^>]*>.*?<\/script>/gi, '');
    }
}
```

### 6.3 数据脱敏

```typescript
// 敏感数据过滤
export class DataSanitizer {
    static sanitizeUser(user: UserDoc, viewer?: UserDoc): Partial<UserDoc> {
        const sanitized: Partial<UserDoc> = {
            _id: user._id,
            uname: user.uname,
            avatar: user.avatar,
            regat: user.regat,
        };
        
        // 只有用户自己或管理员可以看到敏感信息
        if (viewer && (viewer._id === user._id || UserModel.hasPriv(viewer, PRIV.PRIV_ADMIN))) {
            sanitized.mail = user.mail;
            sanitized.loginat = user.loginat;
            sanitized.priv = user.priv;
        }
        
        return sanitized;
    }
    
    static sanitizeRecord(record: RecordDoc, viewer?: UserDoc): Partial<RecordDoc> {
        const sanitized: Partial<RecordDoc> = {
            _id: record._id,
            pid: record.pid,
            uid: record.uid,
            lang: record.lang,
            status: record.status,
            score: record.score,
            time: record.time,
            memory: record.memory,
        };
        
        // 代码只有作者或管理员可以查看
        if (viewer && (viewer._id === record.uid || UserModel.hasPriv(viewer, PRIV.PRIV_ADMIN))) {
            sanitized.code = record.code;
            sanitized.judgeTexts = record.judgeTexts;
            sanitized.compilerTexts = record.compilerTexts;
        }
        
        return sanitized;
    }
}
```

## 7. 扩展机制

### 7.1 插件接口

```typescript
// 模型扩展接口
export interface ModelExtension {
    name: string;
    version: string;
    
    // 扩展方法
    extend(model: typeof ModelBase): void;
    
    // 生命周期钩子
    onLoad?(): Promise<void>;
    onUnload?(): Promise<void>;
}

// 扩展注册
export class ModelExtensionRegistry {
    private static extensions: Map<string, ModelExtension> = new Map();
    
    static register(extension: ModelExtension): void {
        this.extensions.set(extension.name, extension);
        extension.extend(ModelBase);
    }
    
    static unregister(name: string): void {
        const extension = this.extensions.get(name);
        if (extension && extension.onUnload) {
            extension.onUnload();
        }
        this.extensions.delete(name);
    }
}
```

### 7.2 钩子系统

```typescript
// 模型钩子
export class ModelHooks {
    // 用户钩子
    static async onUserCreate(uid: number, udoc: UserDoc): Promise<void> {
        await bus.emit('user/create', uid, udoc);
    }
    
    static async onUserUpdate(uid: number, udoc: UserDoc): Promise<void> {
        await bus.emit('user/update', uid, udoc);
    }
    
    // 题目钩子
    static async onProblemCreate(domainId: string, pid: string, pdoc: ProblemDoc): Promise<void> {
        await bus.emit('problem/create', domainId, pid, pdoc);
    }
    
    static async onProblemUpdate(domainId: string, pid: string, pdoc: ProblemDoc): Promise<void> {
        await bus.emit('problem/update', domainId, pid, pdoc);
    }
    
    // 记录钩子
    static async onRecordChange(domainId: string, rid: ObjectId, rdoc: RecordDoc): Promise<void> {
        await bus.emit('record/change', domainId, rid, rdoc);
    }
}
```

## 8. 总结

Hydro 的 Model 层设计体现了现代 Web 应用的最佳实践：

1. **统一的数据访问接口**：通过 DocumentModel 提供统一的文档操作接口
2. **类型安全**：使用 TypeScript 泛型确保编译时类型检查
3. **性能优化**：多级缓存、智能索引、分页优化
4. **安全控制**：权限验证、数据脱敏、输入验证
5. **可扩展性**：插件接口、钩子系统、事件驱动架构
6. **业务逻辑封装**：将复杂的业务逻辑封装在模型层
7. **数据一致性**：通过事务和锁机制保证数据一致性

这种设计使得 Hydro 系统具有良好的可维护性、可扩展性和性能表现，为构建复杂的在线测评系统提供了坚实的基础。