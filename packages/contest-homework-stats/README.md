# HydroOJ 比赛 / 作业统计插件

## 功能概览

1. **比赛 / 作业统计页**
   - 在 `/contest/main` 与 `/homework/main` 右上角注入“统计”入口。
   - 针对同一用户组内所有成员汇总进度：
     - **ACM 赛制**：展示 `AC / 未AC / 未提交`。
     - **非 ACM / 作业**：展示 `总分 (AC / 未AC / 未提交)`，并将 CE/FE 计入“未AC”。
   - 支持模糊搜索（按用户昵称）、行列切换（题目在行或用户在行）与 CSV 导出。

2. **用户详情页“最近活动”增强（可选）**
   - 仅对拥有 `PERM_CREATE_HOMEWORK`（教师）权限的用户展示最近参与的比赛 / 作业统计：
     - 非 ACM：总分 + AC/未AC/未提交。
     - ACM：AC/未AC/未提交。
     - 最后提交时间（`YYYY-MM-DD HH:mm`）。
   - 该特性完全在插件内部实现，不再修改 core 代码，便于升级维护。

3. **模板覆盖 / Hook 支持**
   - 自动覆盖 `templates/contest_main.html`、`homework_main.html`、`partials/user_detail/activity.html` 等片段。
   - 若站点有自定义主题，可基于本插件模板进一步扩展。

## 安装方式（路径型插件）

1. 将插件目录拷贝至服务器，例如：
   ```bash
   cp -r packages/contest-homework-stats /opt/hydro/addons/contest-homework-stats
   ```
2. 安装依赖：
   ```bash
   cd /opt/hydro/addons/contest-homework-stats
   yarn install  # 或 npm install
   ```
3. 注册插件：
   ```bash
   hydrooj addon add /opt/hydro/addons/contest-homework-stats
   ```
4. 根据部署方式重启 HydroOJ（如 `pm2 restart hydrooj` 或 `docker restart <container>`）。

> **Docker 部署提示**：将目录挂载至容器 `/root/.hydro/addons/contest-homework-stats`，然后在容器内执行 `hydrooj addon add` 即可。

## 配置与使用

### 页面入口与路由

- 比赛列表右上角的 “Contest Statistics” 按钮 → `/contest-statistics`
- 作业列表右上角的 “Homework Statistics” 按钮 → `/homework-statistics`

### 查询参数

| 参数         | 说明                                                                 |
| ------------ | -------------------------------------------------------------------- |
| `group`      | 指定用户组，留空则默认取第一个可见分组。                            |
| `rule`       | 仅比赛统计可用，限定赛制（如 `acm`、`oi`）。                         |
| `q`          | 按用户昵称进行模糊搜索，自动切换成“用户在列”布局。                  |
| `layout`     | 强制布局 `item` / `user`。                                           |
| `download`   | `true` 时返回 CSV 文件。                                             |

### 权限模型

- `PERM_VIEW_CONTEST`：访问比赛统计页。
- `PERM_VIEW_HOMEWORK`：访问作业统计页。
- `PERM_CREATE_HOMEWORK`：在用户详情页查看“最近活动”增强信息。
- 是否可见隐藏比赛 / 作业、是否可访问某个用户组等逻辑，均沿用 HydroOJ 原有权限体系。

### 模板覆盖 & Hook

- 模板位于 `templates/` 目录，启动时由 TemplateService 自动注册。
- `partials/user_detail/activity.html` 会被插件模板替换，仅当访问者具备教师权限时展示额外统计信息。
- 插件通过 `ctx.on('handler/after/UserDetail#get', ...)` 对 handler 输出做二次加工，如需禁用可在自定义插件中覆盖同名 hook。

### 更新 / 回滚建议

- 建议与主站同版本 Node.js (>=22)。
- 使用 `hydrooj addon upgrade <path>` 可直接覆盖旧版本；如需回滚，可重新安装旧版本或移除插件后再添加。

## 运维建议

- 与主站保持一致的 Node.js 版本（>=22），避免运行时差异。
- 通过 `hydrooj addon add|remove|upgrade` 统一管理插件，记录操作历史。
- 若站点启用了自定义主题或 CDN，需要确保模板 registry 顺序正确；本插件模板在启动时自动导入，可依据 `templates/` 内容做差异化维护。
- 针对用户详情页 Hook，如果其他插件也修改了 `tdocs` 数据，可以在自定义插件中监听同一事件并在 order 上调整优先级。
