# HydroOJ 比赛/作业统计插件

## 功能概览

- 在比赛列表 `/contest/main` 与作业列表 `/homework/main` 右上角新增“统计”入口。
- 针对同一用户组内的每位成员统计完成情况：
  - **ACM 赛制**：显示 `AC/未AC/未提交`。
  - **其他赛制及作业**：显示 `总分 (AC/未AC/未提交)`，且 CE/FE 判题结果统一视为“未AC”。
- 支持一键导出 CSV 文件，方便线下归档或二次分析。

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

- 插件无需额外配置页面，会自动读取现有的用户组及比赛/作业权限。
- 页面入口：
  - 比赛列表右上角的 “Contest Statistics” 按钮。
  - 作业列表右上角的 “Homework Statistics” 按钮。
- 支持的查询参数：
  - `group`：指定用户组，留空时默认使用可选列表中的第一个组。
  - `rule`：仅在比赛统计页面可用，用于限定具体赛制。
  - `q`：标题模糊搜索关键字。
  - `download=true`：追加到查询字符串即可导出 CSV。
- 权限要求：访问比赛统计需 `PERM_VIEW_CONTEST`，访问作业统计需 `PERM_VIEW_HOMEWORK`，隐藏比赛/作业的可见性沿用 HydroOJ 原有逻辑。

## 运维建议

- 建议与主站保持相同的 Node.js 版本（>=22）。
- 使用 `hydrooj addon add` 统一管理插件，便于启停及升级。
- 如站点自定义了 UI 主题，请确认模板覆盖顺序正确；TemplateService 会自动注册此插件自带模板。
