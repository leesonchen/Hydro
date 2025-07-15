# Hydro 插件系统设计文档

## 1. 概述

Hydro 插件系统是基于 Cordis 框架构建的可扩展架构，允许开发者通过插件的方式扩展系统功能。插件系统支持热插拔、依赖管理、生命周期管理等特性，为 Hydro 系统提供了强大的扩展能力。

## 2. 插件架构

### 2.1 插件系统架构图

```
┌─────────────────────────────────────────────────────────────┐
│                  Plugin Architecture                       │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │   Plugin     │  │   Context    │  │   Service    │     │
│  │   Manager    │  │   Injection  │  │   Registry   │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │  Lifecycle   │  │   Event      │  │   Config     │     │
│  │   Manager    │  │   System     │  │   Manager    │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │  Dependency  │  │   Asset      │  │   API        │     │
│  │   Resolver   │  │   Manager    │  │   Registry   │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 插件目录结构

```
packages/                    # 官方插件包
├── blog/                   # 博客插件
├── center/                 # 控制中心插件
├── elastic/                # 搜索插件
├── fps-importer/           # FPS导入插件
├── geoip/                  # 地理位置插件
├── import-qduoj/           # QDUOJ导入插件
├── login-with-github/      # GitHub登录插件
├── migrate/                # 数据迁移插件
├── onlyoffice/             # 在线办公插件
├── prom-client/            # 监控插件
├── sonic/                  # 搜索引擎插件
├── telegram/               # Telegram登录插件
└── vjudge/                 # 虚拟评测插件

plugins/                    # 第三方插件
└── custom-plugin/          # 自定义插件

modules/                    # 模块包
└── custom-module/          # 自定义模块
```

## 3. 插件开发规范

### 3.1 插件基本结构

```typescript
// 插件主文件 index.ts
import { Context } from '@hydrooj/framework';

export interface PluginConfig {
  enable: boolean;
  apiKey?: string;
  endpoint?: string;
}

export const name = 'example-plugin';
export const version = '1.0.0';

export function apply(ctx: Context, config: PluginConfig) {
  if (!config.enable) return;
  
  // 插件初始化逻辑
  ctx.on('ready', async () => {
    console.log('Example plugin started');
  });
  
  // 注册服务
  ctx.plugin(ExampleService, config);
  
  // 注册路由
  ctx.plugin(ExampleHandler);
  
  // 注册定时任务
  ctx.cron('0 0 * * *', async () => {
    // 每日任务
  });
}

// package.json
{
  "name": "@hydrooj/example-plugin",
  "version": "1.0.0",
  "main": "index.ts",
  "dependencies": {
    "@hydrooj/framework": "^1.0.0"
  },
  "peerDependencies": {
    "hydrooj": "^4.0.0"
  },
  "hydro": {
    "type": "plugin",
    "dependencies": ["@hydrooj/ui-default"]
  }
}
```

### 3.2 插件配置系统

```typescript
// config.ts
import { Schema } from '@hydrooj/framework';

export interface Config {
  enable: boolean;
  apiKey: string;
  timeout: number;
  features: {
    autoSync: boolean;
    cache: boolean;
  };
}

export const configSchema: Schema<Config> = Schema.object({
  enable: Schema.boolean().default(true).description('是否启用插件'),
  apiKey: Schema.string().required().description('API密钥'),
  timeout: Schema.number().default(5000).description('请求超时时间(ms)'),
  features: Schema.object({
    autoSync: Schema.boolean().default(true).description('自动同步'),
    cache: Schema.boolean().default(true).description('启用缓存'),
  }).description('功能配置'),
});

// 在插件中使用配置
export function apply(ctx: Context, config: Config) {
  // 配置验证
  const validatedConfig = configSchema.validate(config);
  
  // 使用配置
  if (validatedConfig.features.autoSync) {
    ctx.setInterval(() => {
      // 自动同步逻辑
    }, 60000);
  }
}
```

### 3.3 服务注册

```typescript
// services/ExampleService.ts
export class ExampleService {
  constructor(private ctx: Context, private config: Config) {}
  
  async start() {
    this.ctx.logger.info('ExampleService started');
  }
  
  async stop() {
    this.ctx.logger.info('ExampleService stopped');
  }
  
  async processData(data: any): Promise<any> {
    // 业务逻辑
    return data;
  }
}

// 在插件中注册服务
export function apply(ctx: Context, config: Config) {
  ctx.plugin(ExampleService, config);
  
  // 在其他地方使用服务
  ctx.on('ready', () => {
    const exampleService = ctx.get('ExampleService');
    exampleService.processData({ test: 'data' });
  });
}
```

## 4. 官方插件分析

### 4.1 博客插件 (blog/)

```typescript
// packages/blog/index.ts
export interface BlogConfig {
  enable: boolean;
  postsPerPage: number;
  allowAnonymous: boolean;
}

export function apply(ctx: Context, config: BlogConfig) {
  // 注册数据模型
  ctx.model.extend('Blog', {
    _id: { type: 'ObjectId' },
    title: { type: 'String', required: true },
    content: { type: 'String', required: true },
    author: { type: 'Number', required: true },
    tags: [{ type: 'String' }],
    createdAt: { type: 'Date', default: Date.now },
    updatedAt: { type: 'Date', default: Date.now },
    published: { type: 'Boolean', default: false },
    views: { type: 'Number', default: 0 },
  });
  
  // 注册处理器
  ctx.Route('blog', '/blog', BlogHandler);
  
  // 注册权限
  ctx.addPermission('BLOG_CREATE', 'Create blog posts');
  ctx.addPermission('BLOG_EDIT', 'Edit blog posts');
  ctx.addPermission('BLOG_DELETE', 'Delete blog posts');
}

class BlogHandler extends Handler {
  @Get('/list')
  async list() {
    const { page = 1, limit = 10 } = this.request.query;
    
    const blogs = await ctx.model.Blog.paginate(
      { published: true },
      { page, limit, sort: { createdAt: -1 } }
    );
    
    this.response.body = blogs;
  }
  
  @Get('/:id')
  async detail() {
    const blog = await ctx.model.Blog.findById(this.request.params.id);
    if (!blog) throw new NotFoundError('Blog not found');
    
    // 增加浏览量
    await ctx.model.Blog.updateOne(
      { _id: blog._id },
      { $inc: { views: 1 } }
    );
    
    this.response.body = blog;
  }
  
  @Post('/create')
  @Auth(PERM.BLOG_CREATE)
  @Validate({
    title: Types.string().required(),
    content: Types.string().required(),
    tags: Types.array().items(Types.string()),
    published: Types.boolean().default(false),
  })
  async create() {
    const blog = await ctx.model.Blog.create({
      ...this.request.body,
      author: this.user._id,
    });
    
    this.response.body = blog;
  }
}
```

### 4.2 GitHub 登录插件 (login-with-github/)

```typescript
// packages/login-with-github/index.ts
export interface GitHubConfig {
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
  scope: string[];
}

export function apply(ctx: Context, config: GitHubConfig) {
  if (!config.clientId || !config.clientSecret) {
    ctx.logger.warn('GitHub OAuth not configured');
    return;
  }
  
  // 注册 OAuth 提供者
  ctx.oauth.register('github', {
    displayName: 'GitHub',
    icon: 'github',
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userUrl: 'https://api.github.com/user',
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    scope: config.scope.join(' '),
    
    // 用户信息映射
    mapUser: (profile: GitHubProfile) => ({
      id: profile.id.toString(),
      username: profile.login,
      email: profile.email,
      avatar: profile.avatar_url,
      displayName: profile.name || profile.login,
    }),
  });
  
  // 处理 OAuth 回调
  ctx.Route('github-oauth', '/oauth/github/callback', GitHubOAuthHandler);
}

class GitHubOAuthHandler extends Handler {
  @Get('')
  async callback() {
    const { code, state } = this.request.query;
    
    if (!code) {
      throw new BadRequestError('Missing authorization code');
    }
    
    try {
      // 交换访问令牌
      const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code,
        }),
      });
      
      const tokenData = await tokenResponse.json();
      
      // 获取用户信息
      const userResponse = await fetch('https://api.github.com/user', {
        headers: {
          'Authorization': `token ${tokenData.access_token}`,
          'User-Agent': 'Hydro-OAuth',
        },
      });
      
      const userData = await userResponse.json();
      
      // 处理用户登录/注册
      const user = await this.processOAuthUser('github', userData);
      
      // 设置会话
      await this.session.login(user._id);
      
      this.response.redirect = this.request.query.redirect_uri || '/';
      
    } catch (error) {
      ctx.logger.error('GitHub OAuth error:', error);
      throw new SystemError('OAuth authentication failed');
    }
  }
}
```

### 4.3 VJudge 插件 (vjudge/)

```typescript
// packages/vjudge/index.ts
export interface VJudgeConfig {
  enable: boolean;
  proxies: Record<string, ProxyConfig>;
  rateLimit: {
    requests: number;
    period: number;
  };
}

interface ProxyConfig {
  endpoint: string;
  username?: string;
  password?: string;
  headers?: Record<string, string>;
}

export function apply(ctx: Context, config: VJudgeConfig) {
  if (!config.enable) return;
  
  // 注册 VJudge 服务
  ctx.plugin(VJudgeService, config);
  
  // 注册处理器
  ctx.Route('vjudge', '/vjudge', VJudgeHandler);
  
  // 注册题目导入钩子
  ctx.on('problem/import', async (data) => {
    if (data.source.startsWith('vjudge:')) {
      const [platform, problemId] = data.source.split(':').slice(1);
      return await ctx.vjudge.fetchProblem(platform, problemId);
    }
  });
}

class VJudgeService {
  private fetchers: Map<string, PlatformFetcher> = new Map();
  private rateLimiters: Map<string, RateLimiter> = new Map();
  
  constructor(private ctx: Context, private config: VJudgeConfig) {}
  
  async start() {
    // 初始化平台抓取器
    this.fetchers.set('codeforces', new CodeforcesFetcher(this.config.proxies.codeforces));
    this.fetchers.set('uoj', new UOJFetcher(this.config.proxies.uoj));
    this.fetchers.set('luogu', new LuoguFetcher(this.config.proxies.luogu));
    
    // 初始化速率限制器
    for (const platform of this.fetchers.keys()) {
      this.rateLimiters.set(platform, new RateLimiter(
        this.config.rateLimit.requests,
        this.config.rateLimit.period
      ));
    }
  }
  
  async fetchProblem(platform: string, problemId: string): Promise<Problem> {
    const fetcher = this.fetchers.get(platform);
    if (!fetcher) {
      throw new Error(`Unsupported platform: ${platform}`);
    }
    
    const rateLimiter = this.rateLimiters.get(platform);
    await rateLimiter.acquire();
    
    try {
      return await fetcher.fetchProblem(problemId);
    } catch (error) {
      this.ctx.logger.error(`VJudge fetch error [${platform}:${problemId}]:`, error);
      throw error;
    }
  }
  
  async submitSolution(platform: string, problemId: string, solution: Solution): Promise<Submission> {
    const fetcher = this.fetchers.get(platform);
    if (!fetcher) {
      throw new Error(`Unsupported platform: ${platform}`);
    }
    
    return await fetcher.submitSolution(problemId, solution);
  }
}

abstract class PlatformFetcher {
  constructor(protected config: ProxyConfig) {}
  
  abstract fetchProblem(problemId: string): Promise<Problem>;
  abstract submitSolution(problemId: string, solution: Solution): Promise<Submission>;
  
  protected async request(url: string, options: RequestInit = {}): Promise<Response> {
    const headers = {
      'User-Agent': 'Hydro-VJudge/1.0',
      ...this.config.headers,
      ...options.headers,
    };
    
    return await fetch(url, {
      ...options,
      headers,
    });
  }
}
```

## 5. 插件生命周期

### 5.1 生命周期钩子

```typescript
export function apply(ctx: Context, config: Config) {
  // 插件加载时
  ctx.on('ready', async () => {
    console.log('Plugin ready');
  });
  
  // 插件启动时
  ctx.on('before-start', async () => {
    // 初始化资源
  });
  
  // 插件运行时
  ctx.on('start', async () => {
    // 启动服务
  });
  
  // 插件停止前
  ctx.on('before-stop', async () => {
    // 清理资源
  });
  
  // 插件停止时
  ctx.on('stop', async () => {
    // 停止服务
  });
  
  // 插件卸载时
  ctx.on('dispose', () => {
    // 清理回调
  });
}
```

### 5.2 依赖管理

```typescript
// package.json 中的依赖配置
{
  "hydro": {
    "type": "plugin",
    "dependencies": [
      "@hydrooj/ui-default",  // 必需的插件依赖
      "mongodb@^4.0.0"        // 必需的包依赖
    ],
    "optionalDependencies": [
      "@hydrooj/elastic"      // 可选依赖
    ],
    "conflicts": [
      "@hydrooj/legacy-auth"  // 冲突的插件
    ]
  }
}

// 在插件中检查依赖
export function apply(ctx: Context, config: Config) {
  // 检查必需依赖
  if (!ctx.has('ui-default')) {
    throw new Error('UI-Default plugin is required');
  }
  
  // 检查可选依赖
  if (ctx.has('elastic')) {
    // 启用 Elasticsearch 功能
    ctx.plugin(ElasticIntegration);
  }
  
  // 检查冲突
  if (ctx.has('legacy-auth')) {
    ctx.logger.warn('Legacy auth plugin may conflict with this plugin');
  }
}
```

## 6. 插件通信机制

### 6.1 事件系统

```typescript
// 发布事件
export function apply(ctx: Context) {
  ctx.on('user/login', async (user) => {
    // 用户登录时触发
    await ctx.emit('my-plugin/user-login', user);
  });
  
  // 监听事件
  ctx.on('problem/create', async (problem) => {
    // 题目创建时的处理逻辑
    console.log('New problem created:', problem.title);
  });
  
  // 过滤器
  ctx.filter('problem/render', (content, problem) => {
    // 处理题目内容
    return content.replace(/\[formula\]/g, '<span class="formula">');
  });
  
  // 中间件
  ctx.middleware('api', async (ctx, next) => {
    // API 请求中间件
    const start = Date.now();
    await next();
    const duration = Date.now() - start;
    ctx.logger.info(`API request took ${duration}ms`);
  });
}
```

### 6.2 服务间通信

```typescript
// 服务注册
class NotificationService {
  private subscribers: Map<string, Function[]> = new Map();
  
  subscribe(event: string, callback: Function) {
    if (!this.subscribers.has(event)) {
      this.subscribers.set(event, []);
    }
    this.subscribers.get(event).push(callback);
  }
  
  async notify(event: string, data: any) {
    const callbacks = this.subscribers.get(event) || [];
    await Promise.all(callbacks.map(cb => cb(data)));
  }
}

// 在插件中使用服务
export function apply(ctx: Context) {
  ctx.service('notification', NotificationService);
  
  // 在其他插件中使用
  const notification = ctx.inject('notification');
  
  notification.subscribe('user-action', (data) => {
    console.log('User action:', data);
  });
  
  await notification.notify('user-action', { action: 'login', user });
}
```

## 7. 插件配置界面

### 7.1 配置表单生成

```typescript
// config-ui.ts
export function createConfigUI(schema: Schema): ConfigUI {
  return {
    render: (config: any) => {
      const form = document.createElement('form');
      
      for (const [key, field] of Object.entries(schema.properties)) {
        const group = createFormGroup(key, field, config[key]);
        form.appendChild(group);
      }
      
      return form;
    },
    
    validate: (data: any) => {
      return schema.validate(data);
    },
    
    serialize: (form: HTMLFormElement) => {
      const formData = new FormData(form);
      const config = {};
      
      for (const [key, value] of formData.entries()) {
        config[key] = value;
      }
      
      return config;
    },
  };
}

function createFormGroup(key: string, field: SchemaField, value: any): HTMLElement {
  const group = document.createElement('div');
  group.className = 'form-group';
  
  const label = document.createElement('label');
  label.textContent = field.description || key;
  label.setAttribute('for', key);
  
  const input = createInput(key, field, value);
  
  if (field.required) {
    label.classList.add('required');
  }
  
  group.appendChild(label);
  group.appendChild(input);
  
  return group;
}
```

### 7.2 动态配置加载

```typescript
// 插件配置管理
class PluginConfigManager {
  private configs: Map<string, any> = new Map();
  
  async loadConfig(pluginName: string): Promise<any> {
    const config = await ctx.model.Setting.get(`plugin.${pluginName}`);
    this.configs.set(pluginName, config);
    return config;
  }
  
  async saveConfig(pluginName: string, config: any): Promise<void> {
    await ctx.model.Setting.set(`plugin.${pluginName}`, config);
    this.configs.set(pluginName, config);
    
    // 触发配置更新事件
    await ctx.emit('plugin/config-updated', { pluginName, config });
  }
  
  getConfig(pluginName: string): any {
    return this.configs.get(pluginName);
  }
  
  // 监听配置变化
  onConfigChange(pluginName: string, callback: (config: any) => void) {
    ctx.on('plugin/config-updated', ({ pluginName: name, config }) => {
      if (name === pluginName) {
        callback(config);
      }
    });
  }
}
```

## 8. 插件安全机制

### 8.1 权限控制

```typescript
// 插件权限定义
export const permissions = {
  'plugin.manage': 'Manage plugins',
  'plugin.install': 'Install plugins',
  'plugin.configure': 'Configure plugins',
} as const;

// 权限检查装饰器
function RequirePermission(permission: string) {
  return function(target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    
    descriptor.value = async function(...args: any[]) {
      if (!this.user.hasPermission(permission)) {
        throw new PermissionError(`Permission ${permission} required`);
      }
      
      return await originalMethod.apply(this, args);
    };
  };
}

class PluginHandler extends Handler {
  @RequirePermission('plugin.install')
  async install() {
    // 安装插件逻辑
  }
  
  @RequirePermission('plugin.configure')
  async configure() {
    // 配置插件逻辑
  }
}
```

### 8.2 沙箱隔离

```typescript
// 插件沙箱
class PluginSandbox {
  private context: any;
  
  constructor(private pluginName: string) {
    this.context = this.createSandboxContext();
  }
  
  private createSandboxContext() {
    return {
      // 允许的全局对象
      console: {
        log: (...args) => ctx.logger.info(`[${this.pluginName}]`, ...args),
        error: (...args) => ctx.logger.error(`[${this.pluginName}]`, ...args),
        warn: (...args) => ctx.logger.warn(`[${this.pluginName}]`, ...args),
      },
      
      // 受限的 require
      require: (module: string) => {
        if (this.isAllowedModule(module)) {
          return require(module);
        }
        throw new Error(`Module ${module} is not allowed`);
      },
      
      // 插件 API
      ctx: this.createPluginAPI(),
    };
  }
  
  private isAllowedModule(module: string): boolean {
    const allowedModules = [
      'lodash',
      'moment',
      'crypto',
      'path',
      'url',
    ];
    
    return allowedModules.includes(module) || module.startsWith('@hydrooj/');
  }
  
  execute(code: string): any {
    const vm = require('vm');
    return vm.runInNewContext(code, this.context, {
      timeout: 5000,
      filename: `plugin-${this.pluginName}.js`,
    });
  }
}
```

## 9. 插件市场

### 9.1 插件包管理

```typescript
interface PluginPackage {
  name: string;
  version: string;
  description: string;
  author: string;
  homepage?: string;
  repository?: string;
  keywords: string[];
  dependencies: Record<string, string>;
  hydro: {
    type: 'plugin' | 'theme' | 'module';
    compatibility: string;
    permissions?: string[];
  };
}

class PluginMarket {
  private registry: Map<string, PluginPackage[]> = new Map();
  
  async search(query: string): Promise<PluginPackage[]> {
    const results: PluginPackage[] = [];
    
    for (const packages of this.registry.values()) {
      for (const pkg of packages) {
        if (this.matchesQuery(pkg, query)) {
          results.push(pkg);
        }
      }
    }
    
    return results.sort((a, b) => b.version.localeCompare(a.version));
  }
  
  async install(packageName: string, version?: string): Promise<void> {
    const pkg = await this.resolvePackage(packageName, version);
    
    // 检查兼容性
    if (!this.isCompatible(pkg)) {
      throw new Error('Plugin is not compatible with current Hydro version');
    }
    
    // 下载并安装
    await this.downloadPackage(pkg);
    await this.extractPackage(pkg);
    await this.installDependencies(pkg);
    
    // 注册插件
    await this.registerPlugin(pkg);
  }
  
  async uninstall(packageName: string): Promise<void> {
    // 检查依赖
    const dependents = await this.findDependents(packageName);
    if (dependents.length > 0) {
      throw new Error(`Cannot uninstall: ${dependents.join(', ')} depend on this plugin`);
    }
    
    // 停止插件
    await ctx.plugin.stop(packageName);
    
    // 删除文件
    await this.removePackageFiles(packageName);
    
    // 注销插件
    await this.unregisterPlugin(packageName);
  }
}
```

### 9.2 插件更新机制

```typescript
class PluginUpdater {
  async checkUpdates(): Promise<UpdateInfo[]> {
    const installed = await this.getInstalledPlugins();
    const updates: UpdateInfo[] = [];
    
    for (const plugin of installed) {
      const latest = await this.getLatestVersion(plugin.name);
      if (semver.gt(latest.version, plugin.version)) {
        updates.push({
          name: plugin.name,
          currentVersion: plugin.version,
          latestVersion: latest.version,
          changelog: latest.changelog,
        });
      }
    }
    
    return updates;
  }
  
  async updatePlugin(name: string, version?: string): Promise<void> {
    const current = await this.getPluginInfo(name);
    const target = version || await this.getLatestVersion(name);
    
    // 备份当前版本
    await this.backupPlugin(current);
    
    try {
      // 停止插件
      await ctx.plugin.stop(name);
      
      // 下载新版本
      await this.downloadPackage(target);
      
      // 安装新版本
      await this.installPackage(target);
      
      // 迁移配置
      await this.migrateConfig(current, target);
      
      // 启动插件
      await ctx.plugin.start(name);
      
    } catch (error) {
      // 回滚到备份版本
      await this.rollbackPlugin(current);
      throw error;
    }
  }
}
```

## 10. 插件开发工具

### 10.1 插件脚手架

```typescript
// CLI 工具
class PluginGenerator {
  async create(name: string, options: GeneratorOptions): Promise<void> {
    const template = await this.loadTemplate(options.template || 'basic');
    const targetDir = path.join(process.cwd(), name);
    
    // 创建目录结构
    await this.createDirectory(targetDir);
    
    // 生成文件
    for (const file of template.files) {
      const content = await this.renderTemplate(file.template, {
        name,
        ...options,
      });
      
      await fs.writeFile(
        path.join(targetDir, file.path),
        content,
        'utf8'
      );
    }
    
    // 安装依赖
    if (options.install) {
      await this.installDependencies(targetDir);
    }
    
    console.log(`Plugin ${name} created successfully!`);
  }
  
  private async renderTemplate(template: string, data: any): Promise<string> {
    const handlebars = require('handlebars');
    const compiled = handlebars.compile(template);
    return compiled(data);
  }
}

// 使用示例
const generator = new PluginGenerator();
await generator.create('my-plugin', {
  template: 'handler',
  author: 'Your Name',
  description: 'My awesome plugin',
  install: true,
});
```

### 10.2 开发服务器

```typescript
class PluginDevServer {
  private watchers: Map<string, FSWatcher> = new Map();
  
  async start(pluginPath: string): Promise<void> {
    // 监听文件变化
    const watcher = chokidar.watch(pluginPath, {
      ignored: /node_modules/,
      persistent: true,
    });
    
    watcher.on('change', async (filePath) => {
      console.log(`File changed: ${filePath}`);
      await this.reloadPlugin(pluginPath);
    });
    
    this.watchers.set(pluginPath, watcher);
    
    // 启动插件
    await this.loadPlugin(pluginPath);
  }
  
  async reloadPlugin(pluginPath: string): Promise<void> {
    try {
      // 清除 require 缓存
      this.clearRequireCache(pluginPath);
      
      // 重新加载插件
      await ctx.plugin.reload(path.basename(pluginPath));
      
      console.log('Plugin reloaded successfully');
    } catch (error) {
      console.error('Plugin reload failed:', error);
    }
  }
  
  private clearRequireCache(pluginPath: string): void {
    Object.keys(require.cache).forEach(id => {
      if (id.startsWith(pluginPath)) {
        delete require.cache[id];
      }
    });
  }
}
```

## 11. 总结

Hydro 插件系统通过完善的架构设计和丰富的 API 支持，为系统提供了强大的扩展能力。插件开发者可以通过标准化的接口和工具轻松开发功能丰富的插件。完善的生命周期管理、依赖解析、安全机制等特性确保了插件系统的稳定性和安全性。插件市场和开发工具的支持进一步降低了插件开发和使用的门槛，促进了 Hydro 生态系统的发展。