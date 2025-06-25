# UI-Default 前端系统设计文档

## 1. 概述

UI-Default 是 Hydro 系统的默认前端界面，采用现代化的前端技术栈构建。系统基于 React + TypeScript 开发，使用 Stylus 进行样式管理，支持主题切换、国际化、响应式设计等特性。

## 2. 技术架构

### 2.1 技术栈

```
┌─────────────────────────────────────────────────────────────┐
│                   Frontend Stack                           │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │    React     │  │  TypeScript  │  │   Stylus     │     │
│  │  Components  │  │    Types     │  │   Styles     │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │   Webpack    │  │    Monaco     │  │   WebSocket  │     │
│  │   Builder    │  │   Editor     │  │   Client     │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │    PJAX      │  │    i18n      │  │   Service    │     │
│  │  Navigation  │  │  Support     │  │   Worker     │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 目录结构

```
packages/ui-default/
├── api.ts                    # API 接口定义
├── backendlib/              # 后端库
│   ├── builder.ts           # 构建器
│   ├── markdown-it-*.ts     # Markdown 扩展
│   ├── markdown.js          # Markdown 处理
│   ├── misc.ts              # 工具函数
│   └── template.ts          # 模板引擎
├── build/                   # 构建配置
├── common/                  # 公共样式
│   ├── color.inc.styl       # 颜色变量
│   ├── common.inc.styl      # 公共样式
│   ├── easing.inc.styl      # 动画缓动
│   ├── functions.inc.styl   # 样式函数
│   ├── rem.inc.styl         # REM 单位
│   └── variables.inc.styl   # 全局变量
├── components/              # 组件库
├── constant/                # 常量定义
├── locales/                 # 国际化文件
├── misc/                    # 工具模块
├── pages/                   # 页面组件
├── static/                  # 静态资源
├── templates/               # HTML 模板
├── theme/                   # 主题样式
└── utils/                   # 工具函数
```

## 3. 组件系统设计

### 3.1 组件架构

```typescript
// 基础组件接口
interface BaseComponent {
  props: Record<string, any>;
  state?: Record<string, any>;
  refs?: Record<string, HTMLElement>;
  
  render(): JSX.Element | string;
  mount?(): void;
  unmount?(): void;
  update?(props: any): void;
}

// DOM 组件基类
class DOMComponent implements BaseComponent {
  constructor(public element: HTMLElement) {}
  
  $<T extends HTMLElement>(selector: string): T | null {
    return this.element.querySelector(selector);
  }
  
  $$<T extends HTMLElement>(selector: string): NodeListOf<T> {
    return this.element.querySelectorAll(selector);
  }
  
  on(event: string, handler: EventListener): void {
    this.element.addEventListener(event, handler);
  }
  
  off(event: string, handler: EventListener): void {
    this.element.removeEventListener(event, handler);
  }
}
```

### 3.2 核心组件

#### 3.2.1 自动完成组件 (autocomplete/)

```typescript
interface AutoCompleteProps {
  data: any[];
  value?: string;
  placeholder?: string;
  multiple?: boolean;
  searchFunction?: (query: string) => Promise<any[]>;
  renderItem?: (item: any) => string;
  onSelect?: (item: any) => void;
}

class AutoComplete extends React.Component<AutoCompleteProps> {
  private input: HTMLInputElement;
  private dropdown: HTMLElement;
  private filteredData: any[] = [];
  
  componentDidMount() {
    this.setupEventListeners();
  }
  
  handleInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const query = e.target.value;
    
    if (this.props.searchFunction) {
      this.filteredData = await this.props.searchFunction(query);
    } else {
      this.filteredData = this.props.data.filter(item =>
        item.toString().toLowerCase().includes(query.toLowerCase())
      );
    }
    
    this.updateDropdown();
  }
  
  render() {
    return (
      <div className="autocomplete">
        <input
          ref={el => this.input = el}
          type="text"
          placeholder={this.props.placeholder}
          onChange={this.handleInput}
        />
        <div className="autocomplete__dropdown" ref={el => this.dropdown = el}>
          {this.filteredData.map((item, index) => (
            <div
              key={index}
              className="autocomplete__item"
              onClick={() => this.selectItem(item)}
            >
              {this.props.renderItem ? this.props.renderItem(item) : item}
            </div>
          ))}
        </div>
      </div>
    );
  }
}
```

#### 3.2.2 Monaco 编辑器 (monaco/)

```typescript
interface MonacoEditorProps {
  language: string;
  value?: string;
  theme?: string;
  options?: monaco.editor.IStandaloneEditorConstructionOptions;
  onChange?: (value: string) => void;
}

class MonacoEditor extends React.Component<MonacoEditorProps> {
  private editor: monaco.editor.IStandaloneCodeEditor;
  private container: HTMLDivElement;
  
  async componentDidMount() {
    // 动态加载 Monaco Editor
    await this.loadMonaco();
    
    this.editor = monaco.editor.create(this.container, {
      language: this.props.language,
      value: this.props.value || '',
      theme: this.props.theme || 'vs-dark',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      automaticLayout: true,
      ...this.props.options,
    });
    
    // 监听内容变化
    this.editor.onDidChangeModelContent(() => {
      const value = this.editor.getValue();
      this.props.onChange?.(value);
    });
  }
  
  private async loadMonaco() {
    if (typeof monaco !== 'undefined') return;
    
    // 动态导入 Monaco
    const monacoModule = await import('monaco-editor');
    (window as any).monaco = monacoModule;
  }
  
  getValue(): string {
    return this.editor?.getValue() || '';
  }
  
  setValue(value: string): void {
    this.editor?.setValue(value);
  }
  
  render() {
    return (
      <div
        ref={el => this.container = el}
        className="monaco-editor-container"
        style={{ height: '400px' }}
      />
    );
  }
}
```

#### 3.2.3 Scratchpad 组件 (scratchpad/)

```typescript
interface ScratchpadState {
  code: string;
  language: string;
  input: string;
  output: string;
  isRunning: boolean;
  records: Record[];
}

class Scratchpad extends React.Component<{}, ScratchpadState> {
  state: ScratchpadState = {
    code: '',
    language: 'cpp',
    input: '',
    output: '',
    isRunning: false,
    records: [],
  };
  
  handleSubmit = async () => {
    this.setState({ isRunning: true });
    
    try {
      const response = await fetch('/api/problem/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pid: this.props.pid,
          lang: this.state.language,
          code: this.state.code,
        }),
      });
      
      const result = await response.json();
      this.addRecord(result);
      
    } catch (error) {
      this.showError(error.message);
    } finally {
      this.setState({ isRunning: false });
    }
  }
  
  handlePretest = async () => {
    this.setState({ isRunning: true });
    
    try {
      const response = await fetch('/api/problem/pretest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lang: this.state.language,
          code: this.state.code,
          input: this.state.input,
        }),
      });
      
      const result = await response.json();
      this.setState({ output: result.output });
      
    } catch (error) {
      this.setState({ output: `Error: ${error.message}` });
    } finally {
      this.setState({ isRunning: false });
    }
  }
  
  render() {
    return (
      <div className="scratchpad">
        <div className="scratchpad__toolbar">
          <LanguageSelect
            value={this.state.language}
            onChange={lang => this.setState({ language: lang })}
          />
          <button onClick={this.handlePretest} disabled={this.state.isRunning}>
            预测试
          </button>
          <button onClick={this.handleSubmit} disabled={this.state.isRunning}>
            提交
          </button>
        </div>
        
        <div className="scratchpad__content">
          <div className="scratchpad__editor">
            <MonacoEditor
              language={this.state.language}
              value={this.state.code}
              onChange={code => this.setState({ code })}
            />
          </div>
          
          <div className="scratchpad__data">
            <div className="scratchpad__input">
              <h4>输入</h4>
              <textarea
                value={this.state.input}
                onChange={e => this.setState({ input: e.target.value })}
                placeholder="输入测试数据..."
              />
            </div>
            
            <div className="scratchpad__output">
              <h4>输出</h4>
              <pre>{this.state.output}</pre>
            </div>
          </div>
        </div>
        
        <div className="scratchpad__records">
          <h4>提交记录</h4>
          <RecordList records={this.state.records} />
        </div>
      </div>
    );
  }
}
```

## 4. 页面系统设计

### 4.1 页面架构

```typescript
// 页面基类
abstract class BasePage {
  protected $element: JQuery;
  protected pageName: string;
  
  constructor(element: HTMLElement) {
    this.$element = $(element);
    this.pageName = this.constructor.name;
  }
  
  // 页面生命周期
  async beforeMount(): Promise<void> {}
  async mount(): Promise<void> {}
  async beforeUnmount(): Promise<void> {}
  async unmount(): Promise<void> {}
  
  // 事件处理
  protected bindEvents(): void {}
  protected unbindEvents(): void {}
  
  // 工具方法
  protected $<T extends HTMLElement>(selector: string): JQuery<T> {
    return this.$element.find(selector);
  }
}
```

### 4.2 主要页面

#### 4.2.1 题目详情页 (problem_detail.page.tsx)

```typescript
interface ProblemDetailState {
  problem: Problem;
  loading: boolean;
  showSolution: boolean;
  userStatus?: UserProblemStatus;
}

class ProblemDetailPage extends React.Component<{}, ProblemDetailState> {
  state: ProblemDetailState = {
    problem: null,
    loading: true,
    showSolution: false,
  };
  
  async componentDidMount() {
    await this.loadProblem();
    await this.loadUserStatus();
  }
  
  private async loadProblem() {
    try {
      const response = await fetch(`/api/problem/${window.UiContext.pid}`);
      const problem = await response.json();
      this.setState({ problem, loading: false });
    } catch (error) {
      this.setState({ loading: false });
      throw error;
    }
  }
  
  private async loadUserStatus() {
    if (!window.UserContext.uid) return;
    
    try {
      const response = await fetch(`/api/problem/${window.UiContext.pid}/status`);
      const userStatus = await response.json();
      this.setState({ userStatus });
    } catch (error) {
      console.error('Failed to load user status:', error);
    }
  }
  
  render() {
    const { problem, loading, userStatus } = this.state;
    
    if (loading) {
      return <div className="loader">加载中...</div>;
    }
    
    return (
      <div className="problem-detail">
        <div className="problem-detail__header">
          <h1 className="problem-detail__title">
            {problem.pid}. {problem.title}
          </h1>
          
          <div className="problem-detail__meta">
            <span>时间限制: {problem.config.timeLimit}ms</span>
            <span>内存限制: {problem.config.memoryLimit}MB</span>
            <span>提交: {problem.nSubmit}</span>
            <span>通过: {problem.nAccept}</span>
          </div>
        </div>
        
        <div className="problem-detail__content">
          <div className="problem-statement"
               dangerouslySetInnerHTML={{ __html: problem.content }} />
          
          {userStatus?.canViewSolution && (
            <div className="problem-solutions">
              <h3>题解</h3>
              <SolutionList pid={problem.pid} />
            </div>
          )}
        </div>
        
        <div className="problem-detail__sidebar">
          <ProblemActions
            problem={problem}
            userStatus={userStatus}
          />
          
          <ProblemStats
            problem={problem}
          />
          
          <TagList tags={problem.tag} />
        </div>
      </div>
    );
  }
}
```

#### 4.2.2 比赛主页 (contest_main.page.ts)

```typescript
class ContestMainPage extends BasePage {
  private contestList: Contest[] = [];
  private filters = {
    rule: '',
    status: '',
    keyword: '',
  };
  
  async mount() {
    await this.loadContests();
    this.bindEvents();
    this.initializeFilters();
  }
  
  private async loadContests() {
    try {
      const response = await fetch('/api/contest/list?' + new URLSearchParams({
        page: '1',
        limit: '20',
        ...this.filters,
      }));
      
      const data = await response.json();
      this.contestList = data.contests;
      this.updateContestList();
    } catch (error) {
      console.error('Failed to load contests:', error);
    }
  }
  
  private bindEvents() {
    // 搜索功能
    this.$('.contest-search__input').on('input', 
      debounce(this.handleSearch.bind(this), 300)
    );
    
    // 筛选功能
    this.$('.contest-filter__rule').on('change', this.handleFilterChange.bind(this));
    this.$('.contest-filter__status').on('change', this.handleFilterChange.bind(this));
    
    // 参加比赛
    this.$('.contest-list').on('click', '.contest-item__join', this.handleJoinContest.bind(this));
  }
  
  private handleSearch(event: Event) {
    const input = event.target as HTMLInputElement;
    this.filters.keyword = input.value;
    this.loadContests();
  }
  
  private handleFilterChange(event: Event) {
    const select = event.target as HTMLSelectElement;
    const filterType = select.dataset.filter;
    this.filters[filterType] = select.value;
    this.loadContests();
  }
  
  private async handleJoinContest(event: Event) {
    event.preventDefault();
    
    const button = event.target as HTMLButtonElement;
    const tid = button.dataset.tid;
    
    try {
      const response = await fetch(`/api/contest/${tid}/join`, {
        method: 'POST',
      });
      
      if (response.ok) {
        window.location.href = `/contest/${tid}`;
      } else {
        const error = await response.json();
        throw new Error(error.message);
      }
    } catch (error) {
      alert(`参加比赛失败: ${error.message}`);
    }
  }
  
  private updateContestList() {
    const container = this.$('.contest-list');
    container.empty();
    
    this.contestList.forEach(contest => {
      const item = this.renderContestItem(contest);
      container.append(item);
    });
  }
  
  private renderContestItem(contest: Contest): string {
    const status = this.getContestStatus(contest);
    const canJoin = status === 'upcoming' || status === 'running';
    
    return `
      <div class="contest-item" data-tid="${contest._id}">
        <div class="contest-item__header">
          <h3 class="contest-item__title">
            <a href="/contest/${contest._id}">${contest.title}</a>
          </h3>
          <span class="contest-item__status contest-item__status--${status}">
            ${this.getStatusText(status)}
          </span>
        </div>
        
        <div class="contest-item__meta">
          <span>开始时间: ${formatDate(contest.beginAt)}</span>
          <span>结束时间: ${formatDate(contest.endAt)}</span>
          <span>参赛人数: ${contest.attend.length}</span>
          <span>赛制: ${contest.rule}</span>
        </div>
        
        <div class="contest-item__actions">
          ${canJoin ? `
            <button class="contest-item__join btn btn--primary" data-tid="${contest._id}">
              参加比赛
            </button>
          ` : ''}
          <a href="/contest/${contest._id}" class="btn btn--secondary">
            查看详情
          </a>
        </div>
      </div>
    `;
  }
}
```

## 5. 构建系统设计

### 5.1 Webpack 配置

```typescript
// build/webpack.config.js
const path = require('path');
const webpack = require('webpack');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const OptimizeCSSAssetsPlugin = require('optimize-css-assets-webpack-plugin');
const TerserPlugin = require('terser-webpack-plugin');

module.exports = (env, argv) => {
  const isDev = argv.mode === 'development';
  
  return {
    entry: {
      hydro: './entry.js',
      theme: './theme/default.js',
    },
    
    output: {
      path: path.resolve(__dirname, '../static'),
      filename: isDev ? '[name].js' : '[name]-[contenthash:8].js',
      chunkFilename: isDev ? '[name].chunk.js' : '[name].[contenthash:8].chunk.js',
      publicPath: '/static/',
    },
    
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          use: [
            {
              loader: 'ts-loader',
              options: {
                transpileOnly: isDev,
                configFile: 'tsconfig.ui.json',
              },
            },
          ],
          exclude: /node_modules/,
        },
        {
          test: /\.styl$/,
          use: [
            isDev ? 'style-loader' : MiniCssExtractPlugin.loader,
            'css-loader',
            {
              loader: 'stylus-loader',
              options: {
                stylusOptions: {
                  paths: [path.resolve(__dirname, '../')],
                  import: ['common/common.inc.styl'],
                },
              },
            },
          ],
        },
        {
          test: /\.(png|jpg|gif|svg|woff|woff2|eot|ttf)$/,
          use: [
            {
              loader: 'file-loader',
              options: {
                name: '[name].[hash:8].[ext]',
                outputPath: 'assets/',
              },
            },
          ],
        },
      ],
    },
    
    plugins: [
      new webpack.DefinePlugin({
        'process.env.NODE_ENV': JSON.stringify(argv.mode),
      }),
      
      new MiniCssExtractPlugin({
        filename: isDev ? '[name].css' : '[name]-[contenthash:8].css',
        chunkFilename: isDev ? '[name].chunk.css' : '[name].[contenthash:8].chunk.css',
      }),
      
      new webpack.optimize.SplitChunksPlugin({
        chunks: 'all',
        cacheGroups: {
          vendor: {
            test: /[\\/]node_modules[\\/]/,
            name: 'vendors',
            chunks: 'all',
          },
        },
      }),
    ],
    
    optimization: {
      minimizer: [
        new TerserPlugin({
          terserOptions: {
            compress: {
              drop_console: !isDev,
            },
          },
        }),
        new OptimizeCSSAssetsPlugin(),
      ],
    },
    
    resolve: {
      extensions: ['.ts', '.tsx', '.js', '.jsx'],
      alias: {
        '@': path.resolve(__dirname, '../'),
      },
    },
    
    devtool: isDev ? 'source-map' : false,
  };
};
```

### 5.2 构建脚本

```typescript
// build/main.ts
import { build } from './builder';

interface BuildOptions {
  production?: boolean;
  dev?: boolean;
  https?: boolean;
  iconfont?: boolean;
}

export default async function main(options: BuildOptions = {}) {
  // 生成图标字体
  if (options.iconfont) {
    await generateIconFont();
  }
  
  // 开发模式
  if (options.dev) {
    return await startDevServer(options);
  }
  
  // 生产构建
  if (options.production) {
    return await buildProduction();
  }
  
  // 默认构建
  return await buildDevelopment();
}

async function generateIconFont() {
  const webfontsGenerator = require('webfonts-generator');
  
  const icons = glob.sync('./misc/icons/*.svg');
  
  await new Promise((resolve, reject) => {
    webfontsGenerator({
      files: icons,
      dest: './static/',
      fontName: 'hydro-icons',
      css: false,
      html: false,
      types: ['woff', 'woff2', 'eot', 'ttf'],
    }, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

async function startDevServer(options: BuildOptions) {
  const webpack = require('webpack');
  const WebpackDevServer = require('webpack-dev-server');
  
  const config = require('./webpack.config')({}, { mode: 'development' });
  const compiler = webpack(config);
  
  const devServerOptions = {
    contentBase: path.join(__dirname, '../static'),
    hot: true,
    open: false,
    port: 8080,
    https: options.https,
    overlay: true,
    stats: 'minimal',
  };
  
  const server = new WebpackDevServer(compiler, devServerOptions);
  
  return new Promise((resolve, reject) => {
    server.listen(8080, 'localhost', (err) => {
      if (err) reject(err);
      else {
        console.log('Dev server running at http://localhost:8080');
        resolve(server);
      }
    });
  });
}
```

## 6. 样式系统设计

### 6.1 样式架构

```stylus
// common/common.inc.styl

// 变量定义
@import 'variables.inc.styl'
@import 'color.inc.styl'
@import 'functions.inc.styl'
@import 'easing.inc.styl'

// 基础样式
@import 'typography.styl'
@import 'grid.styl'
@import 'section.styl'

// 工具类
.clearfix
  &::after
    content ''
    display table
    clear both

.sr-only
  position absolute
  width 1px
  height 1px
  padding 0
  margin -1px
  overflow hidden
  clip rect(0, 0, 0, 0)
  border 0

// 响应式断点
mobile-break = 768px
tablet-break = 1024px
desktop-break = 1200px

media-mobile()
  @media screen and (max-width: mobile-break)
    {block}

media-tablet()
  @media screen and (min-width: (mobile-break + 1)) and (max-width: tablet-break)
    {block}

media-desktop()
  @media screen and (min-width: (tablet-break + 1))
    {block}
```

### 6.2 组件样式

```stylus
// components/button/button.styl

.btn
  display inline-block
  padding rem(8px) rem(16px)
  border 1px solid transparent
  border-radius rem(4px)
  font-size rem(14px)
  font-weight 500
  line-height 1.5
  text-align center
  text-decoration none
  cursor pointer
  transition all 0.2s ease-in-out
  user-select none
  
  &:hover:not(:disabled)
    transform translateY(-1px)
    box-shadow 0 2px 8px rgba(0, 0, 0, 0.1)
  
  &:active:not(:disabled)
    transform translateY(0)
  
  &:disabled
    opacity 0.6
    cursor not-allowed
  
  // 变体
  &--primary
    background-color $primary-color
    color white
    
    &:hover:not(:disabled)
      background-color darken($primary-color, 10%)
  
  &--secondary
    background-color transparent
    color $primary-color
    border-color $primary-color
    
    &:hover:not(:disabled)
      background-color $primary-color
      color white
  
  &--danger
    background-color $danger-color
    color white
    
    &:hover:not(:disabled)
      background-color darken($danger-color, 10%)
  
  // 尺寸
  &--small
    padding rem(4px) rem(8px)
    font-size rem(12px)
  
  &--large
    padding rem(12px) rem(24px)
    font-size rem(16px)
  
  // 块级按钮
  &--block
    display block
    width 100%
```

### 6.3 主题系统

```stylus
// theme/dark.styl

:root
  // 基础颜色
  --text-color: #e4e6ea
  --bg-color: #18191a
  --border-color: #3a3b3c
  
  // 主题色
  --primary-color: #1877f2
  --secondary-color: #42b883
  --success-color: #10b981
  --warning-color: #f59e0b
  --danger-color: #ef4444
  
  // 背景色
  --bg-primary: #242526
  --bg-secondary: #3a3b3c
  --bg-tertiary: #4e4f50
  
  // 代码高亮
  --code-bg: #282c34
  --code-text: #abb2bf

// 暗色主题样式
[data-theme="dark"]
  background-color var(--bg-color)
  color var(--text-color)
  
  .card
    background-color var(--bg-primary)
    border-color var(--border-color)
  
  .form-control
    background-color var(--bg-secondary)
    border-color var(--border-color)
    color var(--text-color)
    
    &:focus
      border-color var(--primary-color)
      box-shadow 0 0 0 2px rgba(24, 119, 242, 0.2)
  
  .btn--secondary
    border-color var(--border-color)
    color var(--text-color)
    
    &:hover:not(:disabled)
      background-color var(--bg-secondary)
```

## 7. 国际化系统

### 7.1 i18n 架构

```typescript
// utils/i18n.ts

interface I18nData {
  [key: string]: string | I18nData;
}

class I18nManager {
  private locale: string = 'zh';
  private data: Map<string, I18nData> = new Map();
  private fallbackLocale = 'en';
  
  setLocale(locale: string): void {
    this.locale = locale;
    document.documentElement.lang = locale;
  }
  
  loadData(locale: string, data: I18nData): void {
    this.data.set(locale, data);
  }
  
  translate(key: string, ...args: any[]): string {
    const value = this.getValue(key, this.locale) || 
                  this.getValue(key, this.fallbackLocale) || 
                  key;
    
    return this.interpolate(value, args);
  }
  
  private getValue(key: string, locale: string): string | null {
    const data = this.data.get(locale);
    if (!data) return null;
    
    const keys = key.split('.');
    let current: any = data;
    
    for (const k of keys) {
      if (typeof current !== 'object' || !(k in current)) {
        return null;
      }
      current = current[k];
    }
    
    return typeof current === 'string' ? current : null;
  }
  
  private interpolate(template: string, args: any[]): string {
    return template.replace(/\{(\d+)\}/g, (match, index) => {
      const argIndex = parseInt(index, 10);
      return args[argIndex] !== undefined ? String(args[argIndex]) : match;
    });
  }
}

// 全局实例
export const i18n = new I18nManager();

// 简化接口
export function t(key: string, ...args: any[]): string {
  return i18n.translate(key, ...args);
}
```

### 7.2 语言文件

```yaml
# locales/zh.yaml
nav:
  home: 首页
  problem: 题库
  contest: 比赛
  training: 训练
  discuss: 讨论
  ranking: 排名

problem:
  title: 题目
  difficulty: 难度
  time_limit: 时间限制
  memory_limit: 内存限制
  submit: 提交
  test: 自测
  solution: 题解
  statistics: 统计

contest:
  title: 比赛
  status:
    upcoming: 即将开始
    running: 进行中
    ended: 已结束
  join: 参加比赛
  scoreboard: 排行榜

user:
  login: 登录
  register: 注册
  logout: 登出
  profile: 个人资料
  settings: 设置
```

## 8. 状态管理

### 8.1 全局状态

```typescript
// utils/state.ts

interface GlobalState {
  user: User | null;
  theme: 'light' | 'dark';
  locale: string;
  notifications: Notification[];
  loading: boolean;
}

class StateManager {
  private state: GlobalState = {
    user: null,
    theme: 'light',
    locale: 'zh',
    notifications: [],
    loading: false,
  };
  
  private listeners: Set<() => void> = new Set();
  
  getState(): GlobalState {
    return { ...this.state };
  }
  
  setState(partial: Partial<GlobalState>): void {
    this.state = { ...this.state, ...partial };
    this.notifyListeners();
  }
  
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    
    return () => {
      this.listeners.delete(listener);
    };
  }
  
  private notifyListeners(): void {
    this.listeners.forEach(listener => listener());
  }
}

export const stateManager = new StateManager();
```

### 8.2 React 状态管理

```typescript
// utils/hooks.ts

import { useState, useEffect } from 'react';

export function useGlobalState<K extends keyof GlobalState>(
  key: K
): [GlobalState[K], (value: GlobalState[K]) => void] {
  const [value, setValue] = useState(() => stateManager.getState()[key]);
  
  useEffect(() => {
    const unsubscribe = stateManager.subscribe(() => {
      setValue(stateManager.getState()[key]);
    });
    
    return unsubscribe;
  }, [key]);
  
  const setGlobalValue = (newValue: GlobalState[K]) => {
    stateManager.setState({ [key]: newValue } as Partial<GlobalState>);
  };
  
  return [value, setGlobalValue];
}

export function useApi<T>(
  url: string,
  options?: RequestInit
): [T | null, boolean, Error | null] {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  
  useEffect(() => {
    let cancelled = false;
    
    const fetchData = async () => {
      try {
        setLoading(true);
        setError(null);
        
        const response = await fetch(url, options);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const result = await response.json();
        
        if (!cancelled) {
          setData(result);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };
    
    fetchData();
    
    return () => {
      cancelled = true;
    };
  }, [url, JSON.stringify(options)]);
  
  return [data, loading, error];
}
```

## 9. 性能优化

### 9.1 代码分割

```typescript
// utils/lazyload.ts

interface LazyComponentOptions {
  loading?: React.ComponentType;
  error?: React.ComponentType<{ error: Error }>;
}

export function lazyComponent<T extends React.ComponentType<any>>(
  importFunc: () => Promise<{ default: T }>,
  options: LazyComponentOptions = {}
): React.ComponentType {
  return React.lazy(() => 
    importFunc().catch(error => {
      console.error('Failed to load component:', error);
      return { default: options.error || DefaultErrorComponent };
    })
  );
}

// 使用示例
const MonacoEditor = lazyComponent(
  () => import('./components/monaco/MonacoEditor'),
  {
    loading: () => <div>Loading editor...</div>,
    error: ({ error }) => <div>Failed to load editor: {error.message}</div>,
  }
);
```

### 9.2 虚拟滚动

```typescript
// components/VirtualList.tsx

interface VirtualListProps<T> {
  items: T[];
  itemHeight: number;
  containerHeight: number;
  renderItem: (item: T, index: number) => React.ReactNode;
}

export function VirtualList<T>({
  items,
  itemHeight,
  containerHeight,
  renderItem,
}: VirtualListProps<T>) {
  const [scrollTop, setScrollTop] = useState(0);
  
  const startIndex = Math.floor(scrollTop / itemHeight);
  const endIndex = Math.min(
    startIndex + Math.ceil(containerHeight / itemHeight) + 1,
    items.length
  );
  
  const visibleItems = items.slice(startIndex, endIndex);
  
  const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
  };
  
  return (
    <div
      style={{ height: containerHeight, overflow: 'auto' }}
      onScroll={handleScroll}
    >
      <div style={{ height: items.length * itemHeight, position: 'relative' }}>
        {visibleItems.map((item, index) => (
          <div
            key={startIndex + index}
            style={{
              position: 'absolute',
              top: (startIndex + index) * itemHeight,
              height: itemHeight,
              width: '100%',
            }}
          >
            {renderItem(item, startIndex + index)}
          </div>
        ))}
      </div>
    </div>
  );
}
```

## 10. 安全机制

### 10.1 XSS 防护

```typescript
// utils/sanitize.ts

import DOMPurify from 'dompurify';

export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'u', 'strike',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'ul', 'ol', 'li',
      'a', 'img',
      'pre', 'code',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
    ],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class'],
    ALLOW_DATA_ATTR: false,
  });
}

export function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
```

### 10.2 CSRF 防护

```typescript
// utils/csrf.ts

class CSRFProtection {
  private token: string | null = null;
  
  constructor() {
    this.token = this.getTokenFromMeta();
  }
  
  private getTokenFromMeta(): string | null {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') : null;
  }
  
  getToken(): string | null {
    return this.token;
  }
  
  setToken(token: string): void {
    this.token = token;
  }
  
  attachToRequest(options: RequestInit = {}): RequestInit {
    if (!this.token) return options;
    
    const headers = new Headers(options.headers);
    headers.set('X-CSRF-Token', this.token);
    
    return {
      ...options,
      headers,
    };
  }
}

export const csrf = new CSRFProtection();

// 增强 fetch
const originalFetch = window.fetch;
window.fetch = (input: RequestInfo, init?: RequestInit) => {
  return originalFetch(input, csrf.attachToRequest(init));
};
```

## 11. 总结

UI-Default 前端系统采用了现代化的技术栈和架构设计，通过组件化、模块化的开发方式实现了良好的代码组织和维护性。完善的构建系统、样式系统、国际化支持和性能优化策略确保了用户体验的流畅性。安全机制的集成保障了系统的安全性，而丰富的工具函数和钩子系统为后续的功能扩展提供了良好的基础。