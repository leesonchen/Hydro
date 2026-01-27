# @hydrooj/userlist - 用户列表管理插件

## 概述

`@hydrooj/userlist` 是 HydroOJ 的用户管理增强插件，提供了系统级和域级的用户列表管理、用户编辑、批量操作和用户导入等功能。

## 功能特性

### 1. 用户列表管理

#### 系统级用户列表 (`/manage/users`)
- 查看系统中所有用户的信息
- 支持多条件搜索和筛选
- 查看用户在各个域中的角色和权限
- 支持自定义列显示（本地存储记忆），默认显示邮箱/学校/学号/手机号/加入的域/封禁状态，可按需显示/隐藏“最近登录时间/IP”
- 支持全屏查看列表


### 2. 用户搜索和筛选

支持以下筛选条件：
- **用户 ID / 用户名 / 邮箱**: 支持正则表达式搜索
- **学校**: 搜索用户所在的学校
- **学号**: 前缀匹配搜索
- **手机号**: 正则表达式搜索
- **登录时间**: 支持相对时间筛选（1天、1周、1月，以及“超过1/7/30天”）
- **封禁状态**: 已封禁 / 未封禁
- **用户组**: 按用户组筛选

### 3. 用户编辑

#### 系统级用户编辑 (`/manage/user/:uid/edit`)
- 编辑用户基本信息（邮箱、手机、真实姓名等）
- 重置用户密码（页面右上角单用户快捷入口也支持直接重置）
- 修改用户名
- 设置显示名（特定域）
- 修改用户在各域的角色
- 封禁/解封用户
- 强制登出用户
- 修改所有 `setting_info` 类型的用户设置

#### 域级用户编辑 (`/d/{domain}/domain/user/:uid/edit`)
- 编辑用户在当前域的信息
- 修改该域内的显示名
- 需要域管理权限

### 4. 批量操作

支持对多个用户的批量操作：
- **批量重置密码**: 一次性设置多个用户的密码
- **批量强制登出**: 清除多个用户的所有登录 Token
- **批量封禁**: 禁止多个用户登录
- **批量解封**: 恢复被封禁用户的访问权限

需要系统管理员权限 (`PRIV_EDIT_SYSTEM`)，且按钮仅在已选中用户时可用

### 5. 用户导入

#### 系统级用户导入 (`/manage/users/import`)
- 批量创建系统用户
- 支持 Tab 或逗号分隔的格式
- 格式: `邮箱, 用户名, 密码, 显示名, 扩展信息(JSON)`
- 扩展信息支持：
  - `group`: 用户组（逗号分隔）
  - `role`: 用户在导入域的角色
  - `school`: 学校名称
  - `studentId`: 学号
  - `contestMode`: 竞赛模式

#### 域级批量导入 (`/d/{domain}/domain/bulk_import`)
- 批量设置用户角色和组
- 批量修改用户密码
- 支持 Tab 或逗号分隔的格式

### 6. 权限管理

#### 权限配置
- **系统管理员**: 拥有所有权限
- **系统用户列表管理员**: 通过 `user-list.admin` 配置项指定
- **用户导入权限**: 通过 `user-list.import` 配置项指定
- **域管理员**: 可管理域内用户（需要 `PERM_EDIT_DOMAIN`）

## 配置

### 插件配置

在 `hydrooj.yaml` 中配置：

```yaml
plugins:
  '@hydrooj/userlist':
    banMode: 'allPrivilege'  # 'allPrivilege' 或 'noLogin'
```

**banMode 说明**：
- `allPrivilege`: 封禁用户意味着移除用户的所有权限（priv=0）
- `noLogin`: 封禁用户只移除登录权限（PRIV_USER_PROFILE）

### 系统设置

在 HydroOJ 控制面板可配置以下设置：

- **user-list.defaultFields**: 用户列表默认显示字段（逗号分隔）
  - 默认：`_id,uname,mail,displayName,school,studentId,phone,domains`

- **user-list.admin**: 用户列表管理员 UID（逗号分隔）
  - 允许非系统管理员管理系统用户列表

- **user-list.import**: 用户导入权限 UID（逗号分隔）
  - 允许指定用户进行系统级用户导入

## 依赖

### 必需
- `hydrooj`: HydroOJ 核心框架
- `schemastery`: 配置方案库（用于类型验证）

### 可选
- `@hydrooj/store`: 电商模块（支持用户导入付费功能）
- `@hydrooj/course-management` (ysr): 课程管理模块（支持课程级用户管理）

## 数据模型

### 关键字段扩展

#### User 文档
- `parentDomain` (hidden): 用户所属的主域（用于 store 集成）
- `school`: 用户的学校
- `studentId`: 用户的学号
- `phone`: 用户的电话号码
- `displayName`: 用户的显示名（可在 domainuser 级别覆盖）

#### DomainUser 文档
- `displayName`: 用户在该域的显示名

## API 端点

### 列表查询

- `GET /manage/users` - 系统用户列表（HTML+JSON）

### 编辑/管理

- `GET /manage/user/:uid/edit` - 用户编辑页面
- `POST /manage/user/:uid/edit` - 修改用户信息
  - 支持的操作: `set_info`, `set_username`, `set_displayname`, `set_password`, `ban`, `logout`

- `GET /d/{domain}/domain/user/:uid/edit` - 域级用户编辑页面
- `POST /d/{domain}/domain/user/:uid/edit` - 修改域级用户信息

### 批量操作

- `POST /manage/users/batch_operation` - 批量操作（系统级）
  - 支持: `reset_password`, `logout`, `ban`, `unban`
- 批量按钮在未选择用户时自动禁用

### 导入

- `GET /manage/users/import` - 用户导入页面
- `POST /manage/users/import` - 提交用户导入

- `GET /d/{domain}/domain/bulk_import` - 域级批量导入页面
- `POST /d/{domain}/domain/bulk_import` - 提交批量导入
  - 支持操作: `postGroup`, `postPassword`

### 其他 API

- `POST /d/{domain}/set_displayname` - 设置用户显示名（需要 store）

## 页面路由

| 路由名 | 路径 | 描述 | 权限要求 |
|-------|------|------|---------|
| `manage_users_list` | `/manage/users` | 系统用户列表 | 无 |
| `manage_users_import` | `/manage/users/import` | 系统用户导入 | 无 |
| `manage_user_edit` | `/manage/user/:uid/edit` | 系统用户编辑 | 无 |
| `manage_user_batch_operation` | `/manage/users/batch_operation` | 批量操作 | `PRIV_EDIT_SYSTEM` |


## 用户界面集成

### 菜单注入点

- **ControlPanel**: 系统管理员控制面板
- **UserDropdown**: 用户下拉菜单
- **DomainManage**: 域管理侧边栏

## 兼容性

- **与 store 插件**: 支持用户导入付费功能（通过购物车集成）
- **与 course-management 插件**: 支持在课程级别管理用户
- **与其他域**: 支持多域隔离的用户管理

## 翻译支持

目前支持中文 (zh) 翻译。所有 UI 文本使用 `_()` 函数进行国际化处理。

## 限制和已知问题

1. **前端依赖**: 用户列表页面使用服务端渲染模板（Nunjucks），不依赖 React 组件
2. **批量操作**: 仅支持 JSON 请求方式
3. **密码导入**: 导入时使用明文密码，建议在导入后要求用户修改密码
4. **搜索性能**: 大型用户库的搜索可能受到 MongoDB 查询性能的影响

## 相关文档

- [DESIGN.md](./DESIGN.md) - 详细的设计文档和架构说明
