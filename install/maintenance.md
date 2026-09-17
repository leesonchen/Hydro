# Hydro 维护模式

安装或升级完成后，使用 `hydro-maintenance` 控制维护状态。Caddy 会继续运行并提供维护页，Hydro、MongoDB、sandbox 和 judge 会按进入维护前的在线状态停止。

```bash
# 首次安装/更新 Caddy 维护路由
hydro-maintenance setup

# 发布预告，10 分钟后自动进入维护
hydro-maintenance on --in 10m

# 立即进入维护
hydro-maintenance on

# 查看维护状态和 PM2 状态
hydro-maintenance status

# 升级或维护完成后恢复进入维护前在线的服务
hydro-maintenance off
```

倒计时期间执行 `hydro-maintenance off` 会取消预告，不会停止服务。预告由 PM2 管理的持久化调度进程执行，原始终端退出或机器重启后仍会在到点时进入维护；如调度进程被删除，重新执行 `hydro-maintenance setup` 或启动 Hydro 服务会恢复它。服务启动时只在有预告的情况下执行一次有时限的调度器修复，不会为每次 CLI 调用创建后台轮询进程。

`scheduled` 状态下，开发版本安装脚本会拒绝执行，避免升级和倒计时同时发生。`active` 状态下可以执行安装、更新或回退；脚本会切换 release，但跳过 Hydro/评测服务重启及登录页验证，完成后必须执行 `hydro-maintenance off`。

已登录用户会通过 `/maintenance.json` 轮询维护状态。该轮询受系统设置 `server.maintenance_poll` 控制（默认关闭，避免日常无意义轮询与日志刷屏）。管理员可在控制面板（`/manage/setting` -> 服务器设置）中开启；开启后已登录用户刷新页面即可开始感知维护状态；关闭后用户刷新页面即停止轮询。预告期间页面顶部会显示提示和倒计时；进入维护后会跳转到 `/maintain.html`。这不是站内信，用户必须在维护前打开过页面且浏览器仍能访问站点才会收到提示。

维护状态默认保存在 `~/.hydro/maintenance/`。Docker 单容器中如果存在可写的 `/data-host`，命令会把该目录持久化到 `/data-host/maintenance`，因此重建维护进程不会丢失状态。`--in` 支持 `s/m/h/d`，延迟不能超过 Node.js 定时器的最大值（约 24 天 20 小时）。

进入维护时按 Hydro → judge → sandbox → MongoDB 的顺序停止服务，恢复时按相反顺序启动。取消预告或恢复成功后会删除 PM2 维护调度器并保存进程列表。

维护命令与开发版本安装脚本共用操作锁。为了避免并发操作误删正在初始化的锁，两者均不会自动回收已有锁目录。若操作异常退出留下锁，请先确认没有维护或升级操作运行，核对锁目录中的 `owner` PID 后，再手工删除 `owner` 文件及空锁目录；不要在操作仍运行时清理。锁目录默认是 `~/.hydro/maintenance.lock`，可由 `HYDRO_OPERATION_LOCK_DIR` 或 `HYDRO_MAINTENANCE_LOCK` 指定。
