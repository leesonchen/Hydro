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

倒计时期间执行 `hydro-maintenance off` 会取消预告，不会停止服务。

`scheduled` 状态下，开发版本安装脚本会拒绝执行，避免升级和倒计时同时发生。`active` 状态下可以执行安装、更新或回退；脚本会切换 release，但跳过 Hydro/评测服务重启及登录页验证，完成后必须执行 `hydro-maintenance off`。

已登录用户会通过 `/maintenance.json` 轮询维护状态。预告期间页面顶部会显示提示和倒计时；进入维护后会跳转到 `/maintain.html`。这不是站内信，用户必须在维护前打开过页面且浏览器仍能访问站点才会收到提示。

维护状态默认保存在 `~/.hydro/maintenance/`。Docker 单容器中如果存在可写的 `/data-host`，命令会把该目录持久化到 `/data-host/maintenance`，因此重建维护进程不会丢失状态。
