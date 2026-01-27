# @hydrooj/userlist - 设计文档

## 目录

- [架构概览](#架构概览)
- [文件结构](#文件结构)
- [核心模块](#核心模块)
- [数据流](#数据流)
- [权限模型](#权限模型)
- [扩展机制](#扩展机制)

## 架构概览

### 设计原则

1. **模块化**: 将用户管理功能分离为独立的处理器，便于维护和测试
2. **权限驱动**: 所有操作都严格检查权限
3. **服务端渲染**: 使用 Nunjucks 模板进行服务端渲染，无需重型前端框架
4. **可配置**: 通过配置项实现灵活的权限和行为定制

### 整体结构

```
@hydrooj/userlist
├── index.ts              # 插件主入口，路由和 UI 注册
├── handler/              # HTTP 请求处理器
│   ├── user.ts           # 用户列表、编辑、批量操作
│   ├── bulkimport.ts     # 域级批量导入
│   └── import.ts         # 系统级用户导入
├── templates/userlist/   # Nunjucks 模板文件（全部放在 userlist 命名空间下）
│   ├── users.html        # 用户列表页面
│   ├── user_edit.html    # 用户编辑页面
│   ├── partial_user_edit.html      # 用户编辑表单（可复用）
│   ├── manage_user_import.html     # 用户导入页面
│   ├── domain_bulk_import.html     # 域级批量导入页面
│   └── partial_users_list.html     # 用户列表（可复用）
├── locales/              # 国际化文件
│   └── zh.yaml           # 中文翻译
├── package.json          # 包配置
├── README.md             # 功能说明
└── DESIGN.md             # 本文件
```

## 文件结构详解

### index.ts - 插件入口

**职责**:
- 定义插件配置方案 (`Config`)
- 实现 `apply()` 函数进行模块初始化
- 注册所有路由和 UI 注入点

**关键代码段**:

```typescript
export const name = 'userlist';

export const Config = Schema.object({
    banMode: Schema.union(['allPrivilege', 'noLogin']).default('allPrivilege'),
});

export async function apply(ctx: Context, config: typeof Config) {
    // 1. 加载国际化翻译
    ctx.i18n.load('zh', { /* 翻译映射 */ });

    // 2. 设置配置
    setBanMode(config.banMode);

    // 3. 注册系统设置项
    ctx.inject(['setting'], (c) => { /* 设置项 */ });

    // 4. 注册路由
    ctx.Route('manage_users_list', '/manage/users', UserListHandler);
    // ... 其他路由

    // 5. 注册 UI 注入点
    ctx.injectUI('DomainManage', 'domain_users_list', { /* 选项 */ });

    // 6. 检测可选依赖
    ctx.inject(['store'], (c) => { /* store 相关功能 */ });
    ctx.inject(['ysr'], (c) => { /* ysr 相关功能 */ });
}
```

**配置项说明**:

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `banMode` | enum | `allPrivilege` | 封禁方式 |

**系统设置项**:

| 设置键 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `user-list.defaultFields` | text | `_id,uname,mail,displayName,school,studentId,phone,domains` | 默认显示字段 |
| `user-list.admin` | text | 空 | 用户列表管理员 UID（逗号分隔） |
| `user-list.import` | text | 空 | 用户导入权限 UID（逗号分隔） |

### handler/user.ts - 用户列表和编辑

#### 类: UserBaseHandler (基类)

```typescript
export class UserBaseHandler extends Handler {
    async __prepare(args: { domainId: string }) {
        // 权限检查逻辑
        // 1. 如果有 YSR 插件，检查 PERM_VIEW_HOMEWORK_HIDDEN_SCOREBOARD
        // 2. 如果是系统域，检查系统级权限
        // 3. 否则，检查域管理权限
    }

    hasSystemPriv(): boolean {
        // 检查用户是否为系统管理员或在 user-list.admin 中
    }

    checkSystemWidePerm(level = 'admin'): void {
        // 检查系统级权限
    }
}
```

**权限检查逻辑流程**:

```
if (hasYsr && !hasStore) {
    checkPerm(PERM_VIEW_HOMEWORK_HIDDEN_SCOREBOARD)
} else if (domainId === 'system') {
    checkSystemWidePerm()
} else {
    checkPerm(PERM_EDIT_DOMAIN)
}
```

#### 类: UserListHandler (用户列表)

**端点**: `GET /manage/users`

**参数**:

```typescript
interface UserListParams {
    uidOrName?: string;         // 用户 ID、用户名或邮箱
    school?: string;            // 学校名称（正则）
    studentId?: string;         // 学号（前缀匹配）
    phone?: string;             // 手机号（正则）
    loginAt?: string;           // 登录时间范围（1d/7d/30d 以及 -1d/-7d/-30d）
    banStatus?: 'banned' | 'active';  // 封禁状态
    group?: string;             // 用户组名称
    page?: number;              // 页码（默认 1）
    sortBy?: string;            // 排序字段（默认 _id）
    sortOrder?: 'asc' | 'desc'; // 排序方向（默认 asc）
}
```

**业务逻辑**:

1. **权限检查** (`__prepare`): 使用 `@requireSudo` 和权限检查
2. **构建查询过滤器** (`filter`):
   - 基础: `_id > 1` (排除系统用户)
   - 域过滤: 根据 `domainId` 过滤用户
   - 搜索: 支持正则表达式搜索
   - 时间范围: 基于 `loginat` 字段
   - 封禁状态: 通过 `priv` 位字段检查
   - 用户组: 通过 `group` 过滤

3. **数据查询**:
   - 获取用户 UID 列表（分页）
   - 获取用户详细信息 (`udict`)
   - 获取用户域关联 (`domainUsers`)
   - 获取 GeoIP 信息 (`loginipDict`)
   - 获取域映射 (`ddict`)

4. **响应结构**:

```typescript
response.body = {
    hasSystemWidePerm: boolean;           // 是否有系统权限
    routerName: string;                   // 当前路由名
    settings: SettingModel[];             // 设置项列表
    defaultFields: string;                // 默认显示字段
    page_name: string;                    // 页面名称
    groups: Array<{name, uids}>;          // 用户组列表

    // 查询结果
    uids: number[];                       // 用户 ID 列表
    udict: Record<number, UserDoc>;       // 用户信息映射
    loginipDict: Record<number, {ip, geoip}>;  // 登录 IP 映射
    userDomainMap: Record<number, string[]>;   // 用户-域映射
    ddict: Record<string, string>;        // 域名映射

    // 筛选条件回显
    filterUidOrName: string;
    filterSchool: string;
    filterStudentId: string;
    filterPhone: string;
    filterLoginAt: string;
    banStatus: string;
    group: string;

    // 分页信息
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
}
```

#### 类: UserEditHandler (用户编辑)

**端点**: `GET/POST /manage/user/:uid/edit` 或 `GET/POST /d/{domain}/manage/user/:uid/edit`

**子方法**:

1. **`prepare(uid)`**: 加载待编辑的用户文档

2. **`get()`**: 返回编辑页面
   - 显示用户基本信息
   - 如果是系统级编辑，显示该用户在各域中的信息

3. **`post()`**: 更新用户信息
   - 解析用户设置（类型转换、验证）
   - 调用 `UserModel.setById()` 更新

4. **`postResetPassword(uid, password)`**: 重置密码
   - 调用 `UserModel.setPassword()`

5. **`postSetDisplayname(uid, displayName, targetDomain)`**: 设置显示名
   - 调用 `DomainModel.setUserInDomain()`

6. **`postSetUsername(uid, uname)`**: 修改用户名
   - 需要系统级权限
   - 调用 `UserModel.setUname()`

7. **`postSetInfo(uid, realname, mail, phone)`**: 修改用户信息
   - 需要系统级权限
   - 分别调用 `UserModel.setById()` 更新各字段

8. **`postSetRoleInDomain(uid, targetDomain, role)`**: 设置域角色
   - 调用 `DomainModel.setUserRole()`

9. **`postBan(uid)`**: 封禁用户
   - 根据 `banMode` 决定实现方式
   - `allPrivilege`: 移除所有权限
   - `noLogin`: 只移除登录权限

10. **`postLogout(uid)`**: 强制登出
    - 调用 `TokenModel.delByUid()` 清除所有 Token

#### 类: UserBatchOperationHandler (批量操作)

**端点**: `POST /manage/users/batch_operation`

**需要权限**: `PRIV_EDIT_SYSTEM`

**支持操作**:

```typescript
interface BatchOperationRequest {
    operation: 'reset_password' | 'logout' | 'ban' | 'unban';
    uids: number[];
    password?: string;  // 仅 reset_password 需要
}
```

**实现逻辑**:

- **`reset_password`**: 循环调用 `UserModel.setPassword()` 为每个用户设置密码
- **`logout`**: 循环调用 `TokenModel.delByUid()` 清除 Token
- **`ban`**: 根据 `banMode` 批量封禁用户
- **`unban`**: 根据 `banMode` 批量解封用户

#### 类: DisplayNameSetHandler (显示名 API)

**端点**: `POST /d/{domain}/set_displayname` (需要 store)

**参数**:

```typescript
interface DisplayNameSetParams {
    uid: number;
    displayName: string;
}
```

**实现**:

```typescript
async all(domainId: string, uid: number, displayName: string) {
    await DomainModel.setUserInDomain(domainId, uid, { displayName });
    this.response.body = { ok: 1 };
}
```

### handler/import.ts - 系统级用户导入

#### 类: SystemUserImportHandler

**端点**: `GET/POST /manage/users/import`

**子方法**:

1. **`prepare()`**: 权限检查
   - 如果有 store: 检查 `PERM_EDIT_DOMAIN`
   - 否则: 检查系统级导入权限或系统管理员

2. **`get()`**: 返回导入页面

3. **`post(usersText, draft)`**: 处理导入请求
   - **验证步骤**:
     - 解析每一行数据（支持 Tab 或逗号分隔）
     - 验证邮箱、用户名、密码格式
     - 检查邮箱/用户名是否已存在
     - 检查邮箱域名限制（非系统管理员只能用 `@{uid}.hydro.local`）
     - 验证扩展数据（JSON 格式）

   - **预览模式** (`draft=true`):
     - 返回验证结果和预览数据，不创建用户

   - **提交模式** (`draft=false`):
     - 如果有 store: 添加到购物车（付费功能）
     - 否则: 直接调用 `bulkCreateUsers()` 创建用户

#### 函数: bulkCreateUsers

```typescript
async function bulkCreateUsers(
    ctx: any,
    domainId: string,
    users: any[],
    groupMap: Record<string, string[]>,
): Promise<string[]>  // 返回错误信息数组
```

**流程**:

1. **创建用户**:
   - 调用 `UserModel.create()` 创建用户
   - 设置用户显示名（域级）
   - 设置用户信息（学校、学号、所属域）
   - 将用户加入导入域
   - 触发 `user/import/create` 事件

2. **设置用户组**:
   - 获取已存在的用户组
   - 合并新用户和现有用户
   - 调用 `UserModel.updateGroup()` 更新

3. **错误处理**:
   - 捕获创建过程中的异常
   - 收集错误信息供前端显示

#### 函数: registerStorePurchaseHandler

```typescript
export function registerStorePurchaseHandler(ctx: any) {
    ctx.on('store/purchase', async (buyer, type, args) => {
        if (type !== 'bulk_create_user') return;
        // 调用 bulkCreateUsers 完成创建
        // 发送系统消息告知用户结果
    });
}
```

### handler/bulkimport.ts - 域级批量导入

#### 类: BulkImportHandler

**端点**: `GET/POST /d/{domain}/domain/bulk_import`

**子方法**:

1. **`get()`**: 返回导入页面

2. **`postGroup(users, draft)`**: 批量设置角色和用户组
   - **解析**:
     - 格式: `用户名, 角色, 用户组`
     - 支持按用户名/UID/邮箱查找用户

   - **验证**:
     - 验证角色是否存在
     - 验证用户组名称格式

   - **执行**:
     - 如果 `draft=false`, 调用 `DomainModel.setUserRole()` 设置角色
     - 调用 `UserModel.updateGroup()` 更新用户组

3. **`postPassword(users, draft)`**: 批量修改密码
   - **需要权限**: `PRIV_EDIT_SYSTEM`
   - **格式**: `用户名, 新密码`
   - **执行**: 调用 `UserModel.setPassword()` 更新密码

## 核心模块

### 数据流向图

```
HTTP Request
    ↓
Handler.__prepare() - 权限检查
    ↓
Handler.get/post() - 业务处理
    ├─ 查询数据 (MongoDB)
    ├─ 验证输入
    ├─ 调用 Model 更新
    └─ 构建响应
    ↓
Template 渲染 (Nunjucks)
    ↓
HTTP Response
```

### 关键依赖

**从 hydrooj 导入的类和函数**:

```typescript
// 处理器基类
Handler, PERM, PRIV

// 模型
UserModel, DomainModel, SettingModel, SystemModel, TokenModel

// 装饰器
param, requireSudo

// 类型
Types, Context

// 错误类
BadRequestError, ForbiddenError, PrivilegeError, UserNotFoundError, ValidationError
```

**配置库**:

```typescript
Schema from 'schemastery'
```

## 权限模型

### 权限检查流程

```
1. 系统用户列表 (/manage/users)
   └─ 任何已登录用户可访问
   └─ 但只能看到其有权限的用户

2. 系统用户编辑 (/manage/user/:uid/edit)
   ├─ 系统管理员: 完全权限
   ├─ user-list.admin 中的用户: 有限权限
   └─ 其他用户: 无访问权限

3. 域用户列表 (/d/{domain}/manage/users)
   └─ 需要 PERM_EDIT_DOMAIN 权限

4. 域用户编辑 (/d/{domain}/manage/user/:uid/edit)
   └─ 需要 PERM_EDIT_DOMAIN 权限

5. 批量操作 (/manage/users/batch_operation)
   └─ 需要 PRIV_EDIT_SYSTEM 权限

6. 系统用户导入 (/manage/users/import)
   ├─ 系统管理员: 完全权限
   ├─ user-list.import 中的用户: 受限导入（邮箱域名限制）
   └─ 其他用户: 无权限

7. 域批量导入 (/d/{domain}/domain/bulk_import)
   └─ 需要 PERM_EDIT_DOMAIN 权限
```

### 权限位字段

**User.priv** 是一个位字段，表示用户权限:

- Bit 1 (2): `PRIV_USER_PROFILE` - 允许登录
- Bit 0 (1): `PRIV_EDIT_SYSTEM` - 系统管理员

**查询示例**:

```javascript
// 查询已封禁用户（priv 为 0）
filter.priv = { $bitsAllClear: [2] }

// 查询未封禁用户（priv 包含 PRIV_USER_PROFILE）
filter.priv = { $bitsAnySet: [2] }
```

## 扩展机制

### 状态回调函数 (setBanMode)

```typescript
export function setBanMode(v: 'allPrivilege' | 'noLogin') {
    banMode = v;
}
```

**作用**: 允许主程序在运行时动态改变封禁行为

### 插件依赖注入

**Store 集成**:

```typescript
ctx.inject(['store'], (c) => {
    setHasStore(true);
    // 注册 store 相关的 API
    registerStorePurchaseHandler(c);
});
```

**YSR (课程管理) 集成**:

```typescript
ctx.inject(['ysr'], (c) => {
    setHasYsr(true);
    // 检测到 ysr 时的特殊逻辑
});
```

### 事件处理

**用户导入事件**:

```typescript
// 在用户创建时触发
ctx.serial('user/import/create', uid, userConfig)

// store 购买完成时触发
ctx.on('store/purchase', (buyer, type, args) => {})
```

## 模板设计

### 模板文件

#### users.html - 用户列表页面

**继承关系**: `extends domain_base.html`

**块**:
- `domain_content`: 主要内容区域

**数据变量**:

```typescript
interface UserListTemplateContext {
    // 权限和配置
    hasSystemWidePerm: boolean;
    routerName: string;                   // 当前路由名
    page_name: 'manage_users_list' | 'domain_users_list';

    // 用户数据
    uids: number[];
    udict: Record<number, UserDoc>;
    userDomainMap: Record<number, string[]>;
    ddict: Record<string, string>;

    // 筛选条件回显
    filterUidOrName: string;
    filterSchool: string;
    filterStudentId: string;
    filterPhone: string;
    filterLoginAt: string;
    group: string;

    // 分页
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;

    // 其他
    groups: Array<{name, uids}>;
}
```

**功能**:
- 搜索和筛选表单（支持登录时间相对值、封禁状态、用户组等）
- 用户数据表格
- 列显示开关：使用本地存储记忆（键名 `userlist-visible-columns`），可隐藏/显示“最近登录时间”“最近登录 IP”等列
- 全屏切换：点击按钮切换页面全屏/退出全屏
- 操作列：提供编辑、快速重置密码图标（重置前弹出确认）
- 批量操作按钮：未选择用户时自动禁用，选择后才可提交批量重置/登出/封禁/解封
- 分页控件

#### user_edit.html - 用户编辑页面

**继承关系**:
- 系统级: `extends manage_base.html`
- 域级: `extends domain_base.html`

**包含**:
- `partial_user_edit.html` - 编辑表单

#### domain_bulk_import.html - 域级批量导入

**功能**:
- 导入表单（支持 Tab/逗号分隔）
- 两个操作: 设置角色/组、修改密码

## 国际化 (i18n)

### 翻译文件结构

**locales/zh.yaml**:

```yaml
'User List': '用户列表'
'Import User': '导入用户'
# ... 其他翻译
```

**在代码中使用**:

```typescript
// 在模板中
{{ _('User List') }}  # 输出: 用户列表

// 在 TypeScript 中
this.translate('User List')  # 输出: 用户列表
```

## 性能考虑

1. **分页**: 用户列表采用分页查询（每页 100 条），避免一次性加载大量数据

2. **索引**: 依赖 MongoDB 对以下字段的索引:
   - `_id`, `uname`, `mail` (User)
   - `parentDomain` (User, 用于域过滤)
   - `loginat` (User, 用于时间范围查询)
   - `priv` (User, 用于封禁状态过滤)

3. **缓存**: 用户组通过 `UserModel.listGroup()` 缓存

4. **GeoIP**: 仅在需要时查询 GeoIP 信息

## 错误处理

### 常见错误类型

| 错误 | 场景 | 处理 |
|------|------|------|
| `UserNotFoundError` | 用户不存在 | 返回 404 |
| `ForbiddenError` | 无权限操作 | 返回 403 |
| `PrivilegeError` | 权限不足 | 返回 403 |
| `ValidationError` | 输入验证失败 | 返回 400 并显示错误信息 |
| `BadRequestError` | 业务逻辑错误 | 返回 400 并显示错误信息 |

### 用户导入的错误收集

导入过程中收集所有错误信息，返回给前端进行展示：

```typescript
const errors: string[] = [];
for (const user of users) {
    try {
        // 创建用户
    } catch (e) {
        errors.push(e.message);  // 收集错误
    }
}
// 返回错误列表供用户查看
```

## 维护建议

### 常见修改场景

1. **添加新的筛选条件**:
   - 在 `UserListHandler.get()` 中添加参数
   - 更新 `filter` 查询逻辑
   - 在 `response.body` 中添加回显字段
   - 在模板中添加筛选表单

2. **添加新的用户编辑操作**:
   - 在 `UserEditHandler` 中添加新的 `post*` 方法
   - 确保方法名遵循 `post{操作名}` 的格式
   - 在模板中添加相应的表单或按钮

3. **扩展用户信息字段**:
   - 确保字段在 `User` 模型中已定义
   - 在 `UserListHandler` 和 `UserEditHandler` 中处理新字段
   - 在模板中添加展示或编辑控件

4. **集成新的插件**:
   - 在 `index.ts` 中使用 `ctx.inject()` 检测插件
   - 注册相关的路由或 API
   - 通过状态函数（如 `setHasStore`）传递状态给处理器

## 测试建议

### 单元测试

- 权限检查: 测试不同权限用户的访问
- 筛选逻辑: 测试各种筛选条件的组合
- 数据验证: 测试无效输入的处理

### 集成测试

- 用户导入流程
- 批量操作是否正确更新数据
- 与 store/ysr 插件的集成

### 性能测试

- 大量用户列表查询的响应时间
- 导入大量用户时的内存使用
- 批量操作的执行时间

## 已知限制

1. **搜索范围**: 搜索仅限于 User 和 DomainUser 表，不支持跨越其他数据源
2. **批量大小**: 一次导入最多 100 个用户（可在代码中调整）
3. **同步性**: 所有操作为同步执行，大批量操作可能影响响应时间
4. **模板渲染**: 依赖于 Nunjucks 模板引擎，不支持动态渲染复杂的 JavaScript 交互

## 未来改进方向

1. **异步处理**: 用任务队列处理大批量导入
2. **缓存优化**: 缓存频繁访问的用户数据
3. **前端组件**: 迁移到 React 组件以支持更复杂的 UI
4. **权限细粒度**: 实现更细粒度的权限控制（如字段级权限）
5. **审计日志**: 记录用户操作历史供审计
