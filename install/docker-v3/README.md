# Hydro Docker 部署指南 (v3)

这是一个干净、简化的 Hydro Docker 部署方案，包含了所有必要的修复和优化。

## 🚀 快速开始

### 一键启动（推荐）
```bash
chmod +x *.sh
./quick-start.sh
```

### 手动步骤
```bash
# 1. 准备本地目录
./prepare-dirs.sh

# 2. 启动服务
docker-compose up -d

# 3. 验证部署
./verify.sh
```

## 📁 文件说明

| 文件 | 说明 |
|------|------|
| `Dockerfile` | 修复版 Hydro 镜像定义 |
| `docker-compose.yml` | 服务编排配置 |
| `start-hydro.sh` | 容器内启动脚本 |
| `quick-start.sh` | 一键启动脚本 |
| `prepare-dirs.sh` | 本地目录准备 |
| `verify.sh` | 部署状态验证 |

## 🔧 已修复的问题

- ✅ **Nix 环境变量问题**: 设置 `HOME=/root` 和 `USER=root`
- ✅ **MongoDB 外部访问**: 自动配置 `0.0.0.0:27017` 监听
- ✅ **本地目录映射**: 数据持久化和容器外访问
- ✅ **国内镜像源**: 使用阿里云镜像加速构建
- ✅ **资源优化**: 合理的内存和CPU限制

## 🌐 访问地址

- **Web界面**: http://localhost:80
- **管理界面**: http://localhost:8888  
- **MongoDB**: mongodb://localhost:27017

## 📁 数据目录

本地目录会自动映射到容器内，数据持久化：

```
./hydro-data/     -> /data-host          (数据文件)
./hydro-config/   -> /root/.hydro-host   (配置文件)
./hydro-logs/     -> /var/log/hydro      (日志文件)
./hydro-problems/ -> /data/file          (题目文件)
./hydro-db/       -> /var/lib/mongodb    (数据库文件)
```

## 📋 常用命令

```bash
# 查看容器状态
docker ps

# 查看日志
docker logs hydro -f

# 进入容器
docker exec -it hydro bash

# 停止服务
docker-compose down

# 重启服务
docker-compose restart

# 重新构建
docker-compose up -d --build

# 验证状态
./verify.sh
```

## 🔍 故障排除

### 1. 服务启动失败
```bash
# 查看详细日志
docker logs hydro

# 检查端口占用
netstat -tlnp | grep -E ':(80|8888|27017)'
```

### 2. MongoDB 连接问题
```bash
# 检查 MongoDB 状态
docker exec hydro netstat -tlnp | grep 27017

# 手动修复 MongoDB 绑定
docker exec hydro /usr/local/bin/fix-mongodb-external.sh
```

### 3. 权限问题
```bash
# 修复目录权限
sudo chown -R $USER:$USER ./hydro-*
chmod -R 755 ./hydro-*
```

## 🚨 系统要求

- **Docker**: 20.10+
- **Docker Compose**: 2.0+
- **内存**: 建议 4GB+
- **磁盘**: 建议 10GB+ 可用空间
- **操作系统**: Ubuntu 20.04+, CentOS 7+, 或其他支持 Docker 的 Linux 发行版

## 🔄 更新升级

```bash
# 停止服务
docker-compose down

# 拉取最新代码
git pull

# 重新构建并启动
docker-compose up -d --build
```

## 📞 技术支持

如遇问题，可以：
1. 查看 `docker logs hydro` 获取详细日志
2. 运行 `./verify.sh` 检查服务状态
3. 检查 GitHub Issues 或提交新的 Issue

---

**注意**: 首次启动可能需要 10-15 分钟，请耐心等待安装完成。 