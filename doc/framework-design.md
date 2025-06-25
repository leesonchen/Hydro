# Hydro Framework 框架设计文档

## 1. 概述

Hydro Framework 是 Hydro 系统的核心框架层，基于 Cordis 框架构建，提供了插件系统、依赖注入、事件管理等核心功能。框架采用模块化设计，支持热插拔的插件架构。

## 2. 框架架构

### 2.1 核心组件

```
┌─────────────────────────────────────────────────────────────┐
│                    Hydro Framework                         │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │   Plugin     │  │   Context    │  │   Service    │     │
│  │   System     │  │   Manager    │  │   Registry   │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │   Event      │  │   Validator  │  │  Serializer  │     │
│  │   System     │  │   System     │  │   System     │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │   Router     │  │   Error      │  │   Logger     │     │
│  │   System     │  │   Handler    │  │   System     │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 目录结构

```
framework/
├── eslint-config/          # ESLint 配置
│   ├── base.mjs           # 基础配置
│   ├── build.ts           # 构建脚本
│   └── package.json
├── framework/             # 核心框架
│   ├── api.ts            # API 接口定义
│   ├── base.ts           # 基础类定义
│   ├── decorators.ts     # 装饰器
│   ├── error.ts          # 错误处理
│   ├── index.ts          # 框架入口
│   ├── interface.ts      # 接口定义
│   ├── router.ts         # 路由系统
│   ├── serializer.ts     # 序列化系统
│   ├── server.ts         # 服务器实现
│   ├── validator.ts      # 验证系统
│   └── tests/            # 测试文件
└── register/             # 注册系统
    ├── index.js          # 注册器实现
    └── package.json
```

## 3. 核心系统设计

### 3.1 插件系统

#### 3.1.1 插件生命周期

```typescript
interface Plugin {
  name: string;
  version: string;
  dependencies?: string[];
  
  // 生命周期钩子
  setup?(ctx: Context): void;
  start?(ctx: Context): Promise<void>;
  stop?(ctx: Context): Promise<void>;
  dispose?(ctx: Context): void;
}
```

#### 3.1.2 插件管理器

```typescript
class PluginManager {
  private plugins: Map<string, Plugin> = new Map();
  private dependencies: Map<string, string[]> = new Map();
  
  register(plugin: Plugin): void;
  unregister(name: string): void;
  load(name: string): Promise<void>;
  unload(name: string): Promise<void>;
  getDependencies(name: string): string[];
}
```

### 3.2 上下文管理

#### 3.2.1 Context 设计

```typescript
class Context {
  // 服务注册
  service<T>(name: string, service: T): void;
  inject<T>(name: string): T;
  
  // 事件系统
  on<T>(event: string, handler: (data: T) => void): void;
  emit<T>(event: string, data: T): void;
  
  // 配置管理
  config: Config;
  
  // 子上下文
  plugin(name: string): Context;
}
```

#### 3.2.2 依赖注入

- **服务注册**：通过 `service()` 方法注册服务
- **依赖解析**：通过 `inject()` 方法获取依赖
- **生命周期管理**：自动管理服务的创建和销毁
- **循环依赖检测**：检测并处理循环依赖

### 3.3 事件系统

#### 3.3.1 事件架构

```typescript
interface EventSystem {
  // 事件注册
  on(event: string, handler: Function): void;
  once(event: string, handler: Function): void;
  off(event: string, handler: Function): void;
  
  // 事件触发
  emit(event: string, ...args: any[]): void;
  emitAsync(event: string, ...args: any[]): Promise<void>;
  
  // 事件过滤
  filter(event: string, data: any): any;
}
```

#### 3.3.2 事件类型

- **生命周期事件**：`app/start`, `app/stop`, `plugin/load`, `plugin/unload`
- **HTTP 事件**：`request/before`, `request/after`, `response/before`
- **数据库事件**：`db/connect`, `db/disconnect`, `db/query`
- **业务事件**：`user/login`, `problem/create`, `contest/start`

### 3.4 路由系统

#### 3.4.1 路由定义

```typescript
interface Route {
  method: string;
  path: string;
  handler: Handler;
  middleware?: Middleware[];
  options?: RouteOptions;
}

class Router {
  get(path: string, handler: Handler): void;
  post(path: string, handler: Handler): void;
  put(path: string, handler: Handler): void;
  delete(path: string, handler: Handler): void;
  use(middleware: Middleware): void;
}
```

#### 3.4.2 中间件系统

```typescript
interface Middleware {
  (ctx: Context, next: Next): Promise<void>;
}

// 内置中间件
- AuthMiddleware      // 认证中间件
- CorsMiddleware      // 跨域中间件
- RateLimitMiddleware // 限流中间件
- LoggingMiddleware   // 日志中间件
```

### 3.5 验证系统

#### 3.5.1 验证器架构

```typescript
interface Validator {
  validate(data: any, schema: Schema): ValidationResult;
  addRule(name: string, validator: ValidatorFunction): void;
  createSchema(definition: SchemaDefinition): Schema;
}
```

#### 3.5.2 验证规则

```typescript
// 基础类型验证
Types.string()
Types.number()
Types.boolean()
Types.array()
Types.object()

// 复合验证
Types.string().min(3).max(20).pattern(/^[a-zA-Z0-9]+$/)
Types.array().items(Types.string())
Types.object().keys({
  name: Types.string().required(),
  age: Types.number().min(0).max(150)
})
```

### 3.6 序列化系统

#### 3.6.1 序列化器接口

```typescript
interface Serializer {
  serialize(data: any, options?: SerializeOptions): string;
  deserialize(str: string, options?: DeserializeOptions): any;
  supports(format: string): boolean;
}
```

#### 3.6.2 支持格式

- **JSON**：标准 JSON 格式
- **YAML**：人类可读的数据序列化标准
- **XML**：扩展标记语言
- **Binary**：二进制格式

### 3.7 错误处理

#### 3.7.1 错误类型

```typescript
class HydroError extends Error {
  code: number;
  type: string;
  params: any[];
}

// 具体错误类型
class ValidationError extends HydroError {}
class PermissionError extends HydroError {}
class NotFoundError extends HydroError {}
class SystemError extends HydroError {}
```

#### 3.7.2 错误处理策略

- **全局错误处理器**：捕获未处理的异常
- **错误日志记录**：记录错误详情和堆栈信息
- **用户友好消息**：转换技术错误为用户可理解的消息
- **错误恢复机制**：尝试从错误中恢复

## 4. 装饰器系统

### 4.1 装饰器类型

```typescript
// 类装饰器
@Handler('problem')
class ProblemHandler extends BaseHandler {}

// 方法装饰器
@Get('/list')
@Auth()
@Validate({
  page: Types.number().default(1),
  limit: Types.number().max(100).default(20)
})
async list(ctx: Context) {}

// 参数装饰器
async getUser(@Param('id') id: string) {}
```

### 4.2 内置装饰器

- **@Handler**：标记处理器类
- **@Get/@Post/@Put/@Delete**：HTTP 方法装饰器
- **@Auth**：认证装饰器
- **@Validate**：验证装饰器
- **@Cache**：缓存装饰器
- **@RateLimit**：限流装饰器

## 5. 服务注册

### 5.1 服务接口

```typescript
interface Service {
  name: string;
  dependencies?: string[];
  start?(): Promise<void>;
  stop?(): Promise<void>;
}
```

### 5.2 核心服务

- **DatabaseService**：数据库服务
- **StorageService**：存储服务
- **CacheService**：缓存服务
- **MessageService**：消息服务
- **ScheduleService**：定时任务服务

## 6. 配置管理

### 6.1 配置结构

```typescript
interface Config {
  // 服务器配置
  server: {
    host: string;
    port: number;
    ssl?: SSLConfig;
  };
  
  // 数据库配置
  database: {
    uri: string;
    options?: DatabaseOptions;
  };
  
  // 插件配置
  plugins: Record<string, any>;
}
```

### 6.2 配置加载

- **环境变量**：从环境变量读取配置
- **配置文件**：支持 JSON、YAML 格式
- **命令行参数**：支持命令行覆盖
- **动态配置**：运行时修改配置

## 7. 日志系统

### 7.1 日志级别

```typescript
enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
  TRACE = 4
}
```

### 7.2 日志器接口

```typescript
interface Logger {
  error(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  info(message: string, ...args: any[]): void;
  debug(message: string, ...args: any[]): void;
  trace(message: string, ...args: any[]): void;
}
```

## 8. 测试支持

### 8.1 测试框架

- **单元测试**：Jest 测试框架
- **集成测试**：Supertest HTTP 测试
- **覆盖率**：Istanbul 代码覆盖率
- **Mock 支持**：自动 Mock 生成

### 8.2 测试工具

```typescript
// 测试上下文
class TestContext extends Context {
  mock<T>(service: string, implementation: T): void;
  restore(service: string): void;
  clear(): void;
}

// 测试装饰器
@Test('should create user')
async testCreateUser() {}
```

## 9. 性能优化

### 9.1 优化策略

- **懒加载**：按需加载插件和模块
- **缓存机制**：缓存频繁访问的数据
- **连接池**：复用数据库连接
- **异步处理**：避免阻塞操作

### 9.2 监控指标

- **响应时间**：API 响应时间统计
- **内存使用**：内存使用情况监控
- **CPU 使用率**：CPU 使用率监控
- **错误率**：错误发生率统计

## 10. 扩展机制

### 10.1 插件开发

```typescript
// 插件定义
export default class MyPlugin {
  constructor(private ctx: Context) {}
  
  async start() {
    // 插件启动逻辑
  }
  
  async stop() {
    // 插件停止逻辑
  }
}
```

### 10.2 API 扩展

- **Handler 扩展**：添加新的请求处理器
- **Service 扩展**：注册新的服务
- **中间件扩展**：添加自定义中间件
- **验证器扩展**：添加自定义验证规则

## 11. 总结

Hydro Framework 提供了一个强大而灵活的插件化架构，支持模块化开发和热插拔功能。通过完善的依赖注入、事件系统、路由管理等核心功能，框架能够支撑复杂的在线测评系统需求。良好的扩展机制使得系统能够适应不同的业务场景和未来的发展需求。