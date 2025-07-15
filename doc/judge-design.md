# HydroJudge 评测系统设计文档

## 1. 概述

HydroJudge 是 Hydro 系统的分布式评测引擎，负责代码编译、运行和结果评判。系统采用沙箱技术确保安全性，支持多种编程语言和题目类型，具有高并发处理能力和分布式部署特性。

## 2. 系统架构

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                   HydroJudge System                        │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │   Daemon     │  │   Task       │  │   Cache      │     │
│  │   Process    │  │   Queue      │  │   Manager    │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │   Compiler   │  │   Sandbox    │  │   Checker    │     │
│  │   System     │  │   Runtime    │  │   System     │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │   Language   │  │   Judge      │  │   Result     │     │
│  │   Manager    │  │   Engine     │  │   Reporter   │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 目录结构

```
packages/hydrojudge/src/
├── cache.ts              # 缓存管理
├── cases.ts              # 测试用例处理
├── checkers.ts           # 检查器管理
├── compile.ts            # 编译系统
├── config.ts             # 配置管理
├── daemon.ts             # 守护进程
├── error.ts              # 错误定义
├── flow.ts               # 评测流程
├── index.ts              # 主入口
├── info.ts               # 系统信息
├── interface.ts          # 接口定义
├── log.ts                # 日志系统
├── sandbox.ts            # 沙箱接口
├── signals.ts            # 信号处理
├── task.ts               # 任务管理
├── terminal.ts           # 终端支持
├── testlib.ts            # TestLib 支持
├── utils.ts              # 工具函数
├── hosts/                # 主机适配器
│   ├── builtin.ts        # 内置主机
│   ├── hydro.ts          # Hydro 主机
│   └── vj4.ts            # VJ4 兼容
├── judge/                # 评测引擎
│   ├── communication.ts  # 通信题
│   ├── default.ts        # 传统题
│   ├── generate.ts       # 数据生成
│   ├── hack.ts           # Hack 题
│   ├── index.ts          # 引擎入口
│   ├── interactive.ts    # 交互题
│   ├── interface.ts      # 引擎接口
│   ├── objective.ts      # 客观题
│   ├── run.ts            # 运行题
│   └── submit_answer.ts  # 提交答案题
└── sandbox/              # 沙箱系统
    ├── client.ts         # 沙箱客户端
    └── interface.ts      # 沙箱接口
```

## 3. 核心组件设计

### 3.1 守护进程 (daemon.ts)

```typescript
class JudgeDaemon {
  private hosts: Map<string, Host> = new Map();
  private queue: TaskQueue;
  private cache: CacheManager;
  
  async start(): Promise<void> {
    // 初始化沙箱
    await this.initializeSandbox();
    
    // 连接主机
    await this.connectHosts();
    
    // 启动任务处理循环
    await this.startTaskLoop();
  }
  
  async stop(): Promise<void> {
    // 停止任务处理
    this.stopTaskLoop();
    
    // 断开主机连接
    await this.disconnectHosts();
    
    // 清理资源
    await this.cleanup();
  }
  
  private async processTask(task: JudgeTask): Promise<void> {
    try {
      const result = await this.judge(task);
      await this.reportResult(task.rid, result);
    } catch (error) {
      await this.reportError(task.rid, error);
    }
  }
}
```

### 3.2 任务管理 (task.ts)

```typescript
interface JudgeTask {
  rid: string;              // 记录ID
  pid: string;              // 题目ID
  uid: number;              // 用户ID
  lang: string;             // 编程语言
  code: string;             // 源代码
  config: ProblemConfig;    // 题目配置
  data: TestData[];         // 测试数据
  priority: number;         // 优先级
  type: TaskType;           // 任务类型
}

interface JudgeResult {
  status: JudgeStatus;      // 评测状态
  score: number;            // 得分
  time: number;             // 执行时间
  memory: number;           // 内存使用
  details: CaseResult[];    // 测试点详情
  compilerText: string;     // 编译信息
  judgeText: string;        // 评测信息
}

class TaskManager {
  private queue: Priority<JudgeTask>;
  private processing: Set<string> = new Set();
  
  async addTask(task: JudgeTask): Promise<void> {}
  async getTask(): Promise<JudgeTask | null> {}
  async completeTask(rid: string): Promise<void> {}
  async cancelTask(rid: string): Promise<void> {}
  
  getQueueStatus(): QueueStatus {}
}
```

### 3.3 编译系统 (compile.ts)

```typescript
interface Language {
  name: string;             // 语言名称
  ext: string;              // 文件扩展名
  compile?: CompileConfig;  // 编译配置
  execute: ExecuteConfig;   // 执行配置
  highlight: string;        // 语法高亮
  monaco: string;           // Monaco 编辑器语言
  comment: string;          // 注释语法
}

interface CompileConfig {
  compiler: string;         // 编译器路径
  flags: string[];          // 编译选项
  timeout: number;          // 编译超时
  memoryLimit: number;      // 内存限制
  output: string;           // 输出文件名
}

class CompileSystem {
  private languages: Map<string, Language> = new Map();
  
  async compile(
    lang: string,
    code: string,
    target: string,
    options?: CompileOptions
  ): Promise<CompileResult> {
    const language = this.languages.get(lang);
    if (!language?.compile) {
      // 解释型语言，无需编译
      return { success: true };
    }
    
    // 写入源代码文件
    await fs.writeFile(`${target}.${language.ext}`, code);
    
    // 执行编译
    const result = await this.sandbox.run({
      executable: language.compile.compiler,
      args: this.buildCompileArgs(language, target),
      time: language.compile.timeout,
      memory: language.compile.memoryLimit,
      workingDirectory: path.dirname(target),
    });
    
    return this.processCompileResult(result);
  }
  
  private buildCompileArgs(language: Language, target: string): string[] {
    return language.compile.flags
      .map(flag => flag.replace('${target}', target))
      .map(flag => flag.replace('${source}', `${target}.${language.ext}`));
  }
}
```

### 3.4 沙箱系统 (sandbox.ts)

```typescript
interface SandboxConfig {
  executable: string;       // 可执行文件
  args: string[];           // 命令行参数
  env: Record<string, string>; // 环境变量
  time: number;             // 时间限制 (ms)
  memory: number;           // 内存限制 (MB)
  stackMemory?: number;     // 栈内存限制 (MB)
  addressSpace?: number;    // 地址空间限制 (MB)
  processes?: number;       // 进程数限制
  stdin?: string;           // 标准输入文件
  stdout?: string;          // 标准输出文件
  stderr?: string;          // 标准错误文件
  workingDirectory: string; // 工作目录
  copyIn?: Record<string, Buffer>; // 输入文件
  copyOut?: string[];       // 输出文件
}

interface SandboxResult {
  status: RunStatus;        // 运行状态
  exitCode: number;         // 退出码
  time: number;             // 执行时间
  memory: number;           // 内存使用
  files: Record<string, Buffer>; // 输出文件
}

class SandboxClient {
  private endpoint: string;
  
  async run(config: SandboxConfig): Promise<SandboxResult> {
    const response = await fetch(`${this.endpoint}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    
    if (!response.ok) {
      throw new Error(`Sandbox error: ${response.statusText}`);
    }
    
    return await response.json();
  }
  
  async version(): Promise<string> {
    const response = await fetch(`${this.endpoint}/version`);
    return await response.text();
  }
}
```

## 4. 评测引擎设计

### 4.1 评测流程 (flow.ts)

```typescript
class JudgeFlow {
  async judge(task: JudgeTask): Promise<JudgeResult> {
    // 1. 预处理
    await this.prepare(task);
    
    // 2. 编译代码
    const compileResult = await this.compile(task);
    if (!compileResult.success) {
      return this.createCompileErrorResult(compileResult);
    }
    
    // 3. 获取测试数据
    const testData = await this.getTestData(task);
    
    // 4. 执行评测
    const judgeResult = await this.executeJudge(task, testData);
    
    // 5. 后处理
    await this.cleanup(task);
    
    return judgeResult;
  }
  
  private async executeJudge(
    task: JudgeTask,
    testData: TestData[]
  ): Promise<JudgeResult> {
    const judgeType = this.getJudgeType(task.config.type);
    const judge = new judgeType();
    
    return await judge.judge(task, testData);
  }
}
```

### 4.2 传统题评测 (judge/default.ts)

```typescript
class DefaultJudge implements Judge {
  async judge(task: JudgeTask, testData: TestData[]): Promise<JudgeResult> {
    const results: CaseResult[] = [];
    let totalScore = 0;
    let maxTime = 0;
    let maxMemory = 0;
    
    for (const testCase of testData) {
      const result = await this.judgeCase(task, testCase);
      results.push(result);
      
      totalScore += result.score;
      maxTime = Math.max(maxTime, result.time);
      maxMemory = Math.max(maxMemory, result.memory);
      
      // 如果WA/TLE/MLE等，可以选择继续或停止
      if (this.shouldStop(result.status)) {
        break;
      }
    }
    
    return {
      status: this.getOverallStatus(results),
      score: totalScore,
      time: maxTime,
      memory: maxMemory,
      details: results,
      compilerText: '',
      judgeText: '',
    };
  }
  
  private async judgeCase(
    task: JudgeTask,
    testCase: TestCase
  ): Promise<CaseResult> {
    // 运行用户程序
    const runResult = await this.sandbox.run({
      executable: './solution',
      stdin: testCase.input,
      stdout: '/tmp/output',
      time: task.config.timeLimit,
      memory: task.config.memoryLimit,
    });
    
    if (runResult.status === RunStatus.TIME_LIMIT_EXCEEDED) {
      return { status: JudgeStatus.TLE, score: 0, time: runResult.time, memory: runResult.memory };
    }
    
    if (runResult.status === RunStatus.MEMORY_LIMIT_EXCEEDED) {
      return { status: JudgeStatus.MLE, score: 0, time: runResult.time, memory: runResult.memory };
    }
    
    if (runResult.status === RunStatus.RUNTIME_ERROR) {
      return { status: JudgeStatus.RE, score: 0, time: runResult.time, memory: runResult.memory };
    }
    
    // 检查答案
    const checkResult = await this.checkAnswer(
      testCase.output,
      runResult.files['/tmp/output'],
      task.config.checker
    );
    
    return {
      status: checkResult.correct ? JudgeStatus.AC : JudgeStatus.WA,
      score: checkResult.score,
      time: runResult.time,
      memory: runResult.memory,
      checkerText: checkResult.message,
    };
  }
}
```

### 4.3 交互题评测 (judge/interactive.ts)

```typescript
class InteractiveJudge implements Judge {
  async judge(task: JudgeTask, testData: TestData[]): Promise<JudgeResult> {
    const results: CaseResult[] = [];
    
    for (const testCase of testData) {
      const result = await this.judgeInteractive(task, testCase);
      results.push(result);
    }
    
    return this.combineResults(results);
  }
  
  private async judgeInteractive(
    task: JudgeTask,
    testCase: TestCase
  ): Promise<CaseResult> {
    // 创建命名管道进行通信
    const pipe1 = '/tmp/pipe1';
    const pipe2 = '/tmp/pipe2';
    
    await fs.mkfifo(pipe1);
    await fs.mkfifo(pipe2);
    
    try {
      // 启动用户程序
      const userProcess = this.sandbox.start({
        executable: './solution',
        stdin: pipe1,
        stdout: pipe2,
        time: task.config.timeLimit,
        memory: task.config.memoryLimit,
      });
      
      // 启动交互器
      const interactorProcess = this.sandbox.start({
        executable: './interactor',
        args: [testCase.input, testCase.output],
        stdin: pipe2,
        stdout: pipe1,
      });
      
      // 等待程序结束
      const [userResult, interactorResult] = await Promise.all([
        userProcess.wait(),
        interactorProcess.wait(),
      ]);
      
      // 分析结果
      return this.analyzeInteractiveResult(userResult, interactorResult);
      
    } finally {
      await fs.unlink(pipe1);
      await fs.unlink(pipe2);
    }
  }
}
```

### 4.4 客观题评测 (judge/objective.ts)

```typescript
interface ObjectiveConfig {
  questions: Question[];
}

interface Question {
  type: 'single' | 'multiple' | 'fill';
  id: string;
  answers: string[];
  score: number;
}

class ObjectiveJudge implements Judge {
  async judge(task: JudgeTask, testData: TestData[]): Promise<JudgeResult> {
    const config: ObjectiveConfig = JSON.parse(task.config.objective);
    const userAnswers = JSON.parse(task.code);
    
    let totalScore = 0;
    const details: CaseResult[] = [];
    
    for (const question of config.questions) {
      const userAnswer = userAnswers[question.id];
      const result = this.judgeQuestion(question, userAnswer);
      
      details.push({
        id: question.id,
        status: result.correct ? JudgeStatus.AC : JudgeStatus.WA,
        score: result.score,
        time: 0,
        memory: 0,
      });
      
      totalScore += result.score;
    }
    
    return {
      status: totalScore === config.questions.reduce((sum, q) => sum + q.score, 0) 
        ? JudgeStatus.AC : JudgeStatus.WA,
      score: totalScore,
      time: 0,
      memory: 0,
      details,
      compilerText: '',
      judgeText: '',
    };
  }
  
  private judgeQuestion(question: Question, userAnswer: any): QuestionResult {
    switch (question.type) {
      case 'single':
        return {
          correct: question.answers.includes(userAnswer),
          score: question.answers.includes(userAnswer) ? question.score : 0,
        };
      
      case 'multiple':
        const userSet = new Set(userAnswer);
        const correctSet = new Set(question.answers);
        const correct = userSet.size === correctSet.size && 
          [...userSet].every(ans => correctSet.has(ans));
        return {
          correct,
          score: correct ? question.score : 0,
        };
      
      case 'fill':
        // 支持多个正确答案
        return {
          correct: question.answers.some(ans => 
            this.compareAnswer(ans, userAnswer)
          ),
          score: question.answers.some(ans => 
            this.compareAnswer(ans, userAnswer)
          ) ? question.score : 0,
        };
      
      default:
        return { correct: false, score: 0 };
    }
  }
}
```

## 5. 检查器系统

### 5.1 检查器接口 (checkers.ts)

```typescript
interface Checker {
  check(
    input: Buffer,
    output: Buffer,
    answer: Buffer,
    config?: any
  ): Promise<CheckResult>;
}

interface CheckResult {
  correct: boolean;
  score: number;
  message: string;
}

class CheckerManager {
  private checkers: Map<string, Checker> = new Map();
  
  register(name: string, checker: Checker): void {}
  
  async check(
    checkerName: string,
    input: Buffer,
    output: Buffer,
    answer: Buffer,
    config?: any
  ): Promise<CheckResult> {
    const checker = this.checkers.get(checkerName);
    if (!checker) {
      throw new Error(`Unknown checker: ${checkerName}`);
    }
    
    return await checker.check(input, output, answer, config);
  }
}
```

### 5.2 内置检查器

```typescript
// 行检查器
class LineChecker implements Checker {
  async check(input: Buffer, output: Buffer, answer: Buffer): Promise<CheckResult> {
    const outputLines = output.toString().trim().split('\n');
    const answerLines = answer.toString().trim().split('\n');
    
    if (outputLines.length !== answerLines.length) {
      return {
        correct: false,
        score: 0,
        message: 'Line count mismatch',
      };
    }
    
    for (let i = 0; i < outputLines.length; i++) {
      if (outputLines[i].trim() !== answerLines[i].trim()) {
        return {
          correct: false,
          score: 0,
          message: `Line ${i + 1} mismatch`,
        };
      }
    }
    
    return { correct: true, score: 100, message: 'Accepted' };
  }
}

// 浮点数检查器
class FloatChecker implements Checker {
  async check(
    input: Buffer,
    output: Buffer,
    answer: Buffer,
    config = { precision: 1e-9 }
  ): Promise<CheckResult> {
    const outputNum = parseFloat(output.toString().trim());
    const answerNum = parseFloat(answer.toString().trim());
    
    if (isNaN(outputNum) || isNaN(answerNum)) {
      return {
        correct: false,
        score: 0,
        message: 'Invalid number format',
      };
    }
    
    const diff = Math.abs(outputNum - answerNum);
    const correct = diff <= config.precision || 
      diff <= Math.abs(answerNum) * config.precision;
    
    return {
      correct,
      score: correct ? 100 : 0,
      message: correct ? 'Accepted' : `Difference: ${diff}`,
    };
  }
}

// TestLib 检查器
class TestLibChecker implements Checker {
  async check(
    input: Buffer,
    output: Buffer,
    answer: Buffer,
    config: { checker: string }
  ): Promise<CheckResult> {
    // 编译检查器
    const checkerPath = await this.compileChecker(config.checker);
    
    // 运行检查器
    const result = await this.sandbox.run({
      executable: checkerPath,
      args: ['/tmp/input', '/tmp/output', '/tmp/answer'],
      copyIn: {
        '/tmp/input': input,
        '/tmp/output': output,
        '/tmp/answer': answer,
      },
      time: 5000,
      memory: 256,
    });
    
    return this.parseTestLibResult(result);
  }
}
```

## 6. 缓存系统

### 6.1 缓存管理 (cache.ts)

```typescript
interface CacheItem {
  key: string;
  data: Buffer;
  size: number;
  accessTime: number;
  createTime: number;
}

class CacheManager {
  private cache: Map<string, CacheItem> = new Map();
  private totalSize = 0;
  private maxSize: number;
  
  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }
  
  async get(key: string): Promise<Buffer | null> {
    const item = this.cache.get(key);
    if (!item) return null;
    
    item.accessTime = Date.now();
    return item.data;
  }
  
  async set(key: string, data: Buffer): Promise<void> {
    // 检查是否需要清理缓存
    while (this.totalSize + data.length > this.maxSize) {
      this.evictLRU();
    }
    
    const item: CacheItem = {
      key,
      data,
      size: data.length,
      accessTime: Date.now(),
      createTime: Date.now(),
    };
    
    this.cache.set(key, item);
    this.totalSize += data.length;
  }
  
  private evictLRU(): void {
    let oldest: CacheItem | null = null;
    
    for (const item of this.cache.values()) {
      if (!oldest || item.accessTime < oldest.accessTime) {
        oldest = item;
      }
    }
    
    if (oldest) {
      this.cache.delete(oldest.key);
      this.totalSize -= oldest.size;
    }
  }
}
```

### 6.2 测试数据缓存

```typescript
class TestDataCache {
  private cache: CacheManager;
  private downloadQueue: Map<string, Promise<Buffer>> = new Map();
  
  async getTestData(pid: string, version: string): Promise<Buffer> {
    const key = `testdata:${pid}:${version}`;
    
    // 检查缓存
    let data = await this.cache.get(key);
    if (data) return data;
    
    // 检查是否正在下载
    let downloadPromise = this.downloadQueue.get(key);
    if (downloadPromise) {
      return await downloadPromise;
    }
    
    // 开始下载
    downloadPromise = this.downloadTestData(pid, version);
    this.downloadQueue.set(key, downloadPromise);
    
    try {
      data = await downloadPromise;
      await this.cache.set(key, data);
      return data;
    } finally {
      this.downloadQueue.delete(key);
    }
  }
  
  private async downloadTestData(pid: string, version: string): Promise<Buffer> {
    // 从主机下载测试数据
    const response = await fetch(`/api/problem/${pid}/data?version=${version}`);
    return Buffer.from(await response.arrayBuffer());
  }
}
```

## 7. 主机适配器

### 7.1 Hydro 主机 (hosts/hydro.ts)

```typescript
class HydroHost implements Host {
  private endpoint: string;
  private token: string;
  
  async connect(): Promise<void> {
    // 建立 WebSocket 连接
    this.ws = new WebSocket(`${this.endpoint}/judge/conn`);
    
    this.ws.on('message', (data) => {
      const message = JSON.parse(data);
      this.handleMessage(message);
    });
    
    // 发送认证信息
    this.send({ type: 'auth', token: this.token });
  }
  
  async getTask(): Promise<JudgeTask | null> {
    return new Promise((resolve) => {
      this.send({ type: 'fetch-task' });
      this.taskResolver = resolve;
    });
  }
  
  async reportProgress(rid: string, progress: JudgeProgress): Promise<void> {
    this.send({
      type: 'update-status',
      rid,
      status: progress,
    });
  }
  
  async reportResult(rid: string, result: JudgeResult): Promise<void> {
    this.send({
      type: 'finish',
      rid,
      result,
    });
  }
  
  private handleMessage(message: any): void {
    switch (message.type) {
      case 'task':
        if (this.taskResolver) {
          this.taskResolver(message.task);
          this.taskResolver = null;
        }
        break;
      
      case 'ping':
        this.send({ type: 'pong' });
        break;
    }
  }
}
```

## 8. 性能优化

### 8.1 并行处理

```typescript
class ParallelJudge {
  private maxParallel: number;
  private semaphore: Semaphore;
  
  constructor(maxParallel: number) {
    this.maxParallel = maxParallel;
    this.semaphore = new Semaphore(maxParallel);
  }
  
  async judge(task: JudgeTask): Promise<JudgeResult> {
    await this.semaphore.acquire();
    
    try {
      return await this.doJudge(task);
    } finally {
      this.semaphore.release();
    }
  }
  
  async judgeMultiple(tasks: JudgeTask[]): Promise<JudgeResult[]> {
    const promises = tasks.map(task => this.judge(task));
    return await Promise.all(promises);
  }
}
```

### 8.2 资源管理

```typescript
class ResourceManager {
  private cpuUsage = 0;
  private memoryUsage = 0;
  private diskUsage = 0;
  
  async monitorResources(): Promise<void> {
    setInterval(async () => {
      this.cpuUsage = await this.getCPUUsage();
      this.memoryUsage = await this.getMemoryUsage();
      this.diskUsage = await this.getDiskUsage();
      
      // 报告资源使用情况
      this.reportResourceUsage();
      
      // 调整并发数
      this.adjustConcurrency();
    }, 10000);
  }
  
  private adjustConcurrency(): void {
    if (this.cpuUsage > 0.8) {
      // 降低并发数
      this.reduceConcurrency();
    } else if (this.cpuUsage < 0.5) {
      // 增加并发数
      this.increaseConcurrency();
    }
  }
}
```

## 9. 错误处理

### 9.1 错误类型 (error.ts)

```typescript
enum JudgeErrorType {
  COMPILE_ERROR = 'CompileError',
  RUNTIME_ERROR = 'RuntimeError',
  TIME_LIMIT_EXCEEDED = 'TimeLimitExceeded',
  MEMORY_LIMIT_EXCEEDED = 'MemoryLimitExceeded',
  OUTPUT_LIMIT_EXCEEDED = 'OutputLimitExceeded',
  SYSTEM_ERROR = 'SystemError',
  CHECKER_ERROR = 'CheckerError',
}

class JudgeError extends Error {
  constructor(
    public type: JudgeErrorType,
    message: string,
    public details?: any
  ) {
    super(message);
  }
}
```

### 9.2 错误恢复

```typescript
class ErrorRecovery {
  async handleError(error: JudgeError, task: JudgeTask): Promise<JudgeResult> {
    switch (error.type) {
      case JudgeErrorType.SYSTEM_ERROR:
        // 系统错误，重试
        if (task.retryCount < 3) {
          task.retryCount++;
          return await this.retryTask(task);
        }
        break;
      
      case JudgeErrorType.CHECKER_ERROR:
        // 检查器错误，使用默认检查器
        return await this.useDefaultChecker(task);
      
      default:
        // 其他错误，直接返回错误结果
        return this.createErrorResult(error);
    }
  }
}
```

## 10. 监控和日志

### 10.1 评测监控

```typescript
class JudgeMonitor {
  private metrics = {
    tasksProcessed: 0,
    averageTime: 0,
    errorRate: 0,
    queueSize: 0,
  };
  
  recordTask(task: JudgeTask, result: JudgeResult, duration: number): void {
    this.metrics.tasksProcessed++;
    this.updateAverageTime(duration);
    
    if (result.status === JudgeStatus.SYSTEM_ERROR) {
      this.recordError();
    }
  }
  
  getMetrics(): JudgeMetrics {
    return { ...this.metrics };
  }
  
  async exportMetrics(): Promise<void> {
    // 导出到 Prometheus 等监控系统
  }
}
```

### 10.2 日志系统

```typescript
class JudgeLogger {
  async logTask(task: JudgeTask): Promise<void> {
    logger.info('Judge task started', {
      rid: task.rid,
      pid: task.pid,
      uid: task.uid,
      lang: task.lang,
    });
  }
  
  async logResult(rid: string, result: JudgeResult): Promise<void> {
    logger.info('Judge task completed', {
      rid,
      status: result.status,
      score: result.score,
      time: result.time,
      memory: result.memory,
    });
  }
  
  async logError(rid: string, error: Error): Promise<void> {
    logger.error('Judge task failed', {
      rid,
      error: error.message,
      stack: error.stack,
    });
  }
}
```

## 11. 总结

HydroJudge 评测系统采用了模块化的设计架构，通过沙箱技术保证安全性，支持多种题目类型和编程语言。分布式的设计使得系统具有良好的扩展性和容错能力。完善的缓存机制和性能优化策略确保了高并发场景下的稳定运行。监控和日志系统提供了全面的运行状态跟踪，便于系统维护和问题排查。