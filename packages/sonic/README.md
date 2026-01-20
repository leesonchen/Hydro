# HydroOJ Sonic 搜索插件

该插件将 [Sonic](https://github.com/valeriansaliou/sonic) 集成为 HydroOJ 的题目搜索后端，替换原有的 MongoDB 正则搜索，提供真正的全文索引，并可按需开启跨域搜索。

## 功能亮点

- **全文检索**：对题目标题、标签及题面内容（`title` + `content`）建立倒排索引。
- **增量同步**：监听题目新增 / 编辑 / 删除事件，实时更新 Sonic。
- **全局桶**：自动维护 `global@title`、`global@content`，支持一次查询全域题目。
- **可调查询上限**：`maxQueryLimit` 可与 Sonic 的 `query_limit_maximum` 对齐，避免报错。
- **重建脚本**：提供 `ensureSonicSearch`，一键重建索引。

## 前置条件

1. 已部署 Sonic 服务（建议 v1.4+）。
   - **Ubuntu 22 本地安装**：
   ```bash
   # 安装依赖并下载 Sonic 二进制
   sudo apt update && sudo apt install -y curl unzip
   curl -L https://github.com/valeriansaliou/sonic/releases/download/v1.4.0/sonic-v1.4.0-x86_64-unknown-linux-gnu.zip -o sonic.zip
   sudo mkdir -p /usr/local/sonic && sudo unzip sonic.zip -d /usr/local/sonic

   # 创建数据目录与配置
   sudo mkdir -p /var/lib/sonic/store/{kv,fst}
   sudo tee /etc/sonic.cfg >/dev/null <<'EOF'
   [server]
   log_level = "info"

   [channel]
   inet = "0.0.0.0:1491"
   tcp_timeout = 300

   [channel.search]
   query_limit_maximum = 500

   [store.kv]
   path = "/var/lib/sonic/store/kv/"

   [store.fst]
   path = "/var/lib/sonic/store/fst/"
   EOF

   # 创建 systemd 服务
   sudo tee /etc/systemd/system/sonic.service >/dev/null <<'EOF'
   [Unit]
   Description=Sonic Search Backend
   After=network.target

   [Service]
   ExecStart=/usr/local/sonic/sonic -c /etc/sonic.cfg
   Restart=on-failure
   User=root

   [Install]
   WantedBy=multi-user.target
   EOF

   sudo systemctl daemon-reload
   sudo systemctl enable --now sonic
   ```
   - **Docker 部署**：
   ```bash
   mkdir -p /opt/sonic && cat >/opt/sonic/config.cfg <<'EOF'
   [server]
   log_level = "info"

   [channel]
   inet = "0.0.0.0:1491"
   tcp_timeout = 300

   [channel.search]
   query_limit_maximum = 500

   [store.kv]
   path = "/var/lib/sonic/store/kv/"

   [store.fst]
   path = "/var/lib/sonic/store/fst/"
   EOF

   docker run -d --name sonic \
     -p 1491:1491 \
     -v /opt/sonic/config.cfg:/etc/sonic.cfg \
     -v /opt/sonic/store:/var/lib/sonic/store \
     valeriansaliou/sonic:latest
   ```
   `config.cfg` 示例片段：
   ```toml
   [channel]
   inet = "0.0.0.0:1491"
   tcp_timeout = 300
   auth_password = "SecretPassword"  # 可选

   [channel.search]
   query_limit_maximum = 500

   [store.kv]
   path = "/var/lib/sonic/store/kv/"

   [store.fst]
   path = "/var/lib/sonic/store/fst/"
   ```
2. HydroOJ 4.x，并允许加载自定义 addon。

## 安装（路径 addon）

1. 将此目录（`packages/sonic`）复制到服务器，例如：
   ```bash
   cp -r packages/sonic /opt/hydro/addons/sonic
   ```
2. 若 HydroOJ 运行在 Docker 中，将其挂载/复制进容器：
   ```bash
   docker run ... -v /opt/hydro/addons/sonic:/root/.hydro/addons/sonic:ro ...
   ```
3. 在 HydroOJ 内注册该 addon：
   ```bash
   hydrooj addon add /root/.hydro/addons/sonic
   # 如之前安装过 npm 版本，建议卸载
   hydrooj addon remove @hydrooj/sonic
   ```
4. 重启 HydroOJ（`pm2 restart hydrooj`）。

## 配置项

重启后进入 **系统设置 → sonic**，填写以下字段：

| 键名           | 说明                                                                                  |
|----------------|---------------------------------------------------------------------------------------|
| `host`         | Sonic 主机地址，例如 `host.docker.internal`、`127.0.0.1`。                             |
| `port`         | Sonic 端口，默认 `1491`。                                                              |
| `auth`         | 若 Sonic `auth_password` 不为空，此处填写同样的密码，否则留空。                        |
| `maxQueryLimit`| 单次查询返回的最大条数，应 **≤** Sonic `query_limit_maximum`（例如 `500`）。           |

### 跨域搜索（可选）
- 插件已将所有题目写入 `global@title` / `global@content`。
- 若需要全域搜索，请在题库列表请求中添加 `global=1`，例如：
  `https://your-oj/d/system/p?q=keyword&global=1`
- 当 `domainId !== 'system'` 或未传 `global` 时，仍只搜索当前域。

## 重建索引

首次安装或怀疑 Sonic 数据不同步时，运行重建脚本：

```bash
hydrooj script ensureSonicSearch
# 或在后台→脚本→“ensureSonicSearch”
```
- `domainId` 为空：重建所有域。
- 指定 `domainId`：仅重建该域。

## 常见问题

| 现象                                                       | 处理办法                                                                                          |
|------------------------------------------------------------|---------------------------------------------------------------------------------------------------|
| `Cannot set properties of undefined (problemSearch)`       | 确认已加载本插件（路径 addon），并卸载旧的 `@hydrooj/sonic` npm 版本。                            |
| 搜索时报 `LIMIT out of minimum/maximum bounds`             | 降低 HydroOJ `pagination.problem`，或同时提高 Sonic `query_limit_maximum` 与 `maxQueryLimit`。    |
| Sonic 日志提示配置解析报错                                | 检查 `config.cfg` 是否包含 `[channel.search]`、`[store.kv.pool]` 等必要段落。                      |
| 找不到旧题目                                               | 执行 `ensureSonicSearch` 重建索引（尤其是在启用全局桶之后）。                                    |

## 许可证

与 HydroOJ 主项目保持一致，详情见 HydroOJ 仓库。
