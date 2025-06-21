# Hydro All-in-One 完整版使用说明

## 🎯 功能特点

### ✅ 已解决的问题
- **跨文件系统移动问题**：通过设置临时目录环境变量解决
- **MongoDB 工具缺失**：包含完整的 MongoDB 工具集（mongorestore、mongodump 等）
- **restore 功能正常**：`hydrooj restore` 命令现在可以正常工作
- **All-in-One 架构**：单容器包含所有必需服务

### 🔧 包含的服务
- **MongoDB 7.0** (PID 12) - 数据库服务
- **Hydro Core** (PID 166) - 主要应用服务
- **PM2 Runtime** (PID 1) - 进程管理
- **Judge 支持** - 评测功能（可扩展）

## 🚀 使用方法

### 1. 启动容器
```powershell
# 使用现有镜像启动（推荐）
docker run -d --name hydro-complete \
  --privileged \
  -p 8080:8888 \
  -v ${PWD}/data/db:/data/db \
  -v ${PWD}/data/file:/data/file \
  -e TMPDIR=/data/file/temp \
  -e TMP=/data/file/temp \
  -e TEMP=/data/file/temp \
  docker-hydro-minimal

# 或者使用 Docker Compose（如果网络允许重新构建）
docker-compose -f docker-compose-minimal.yml up -d
```

### 2. 验证服务状态
```powershell
# 检查容器状态
docker ps

# 检查内部进程
docker exec hydro-complete ps aux

# 检查 MongoDB 连接
docker exec hydro-complete mongosh --eval "db.runCommand({ping: 1})"

# 检查 Web 服务
curl http://localhost:8080
```

### 3. 使用 restore 功能
```bash
# 进入容器
docker exec -it hydro-complete bash

# 使用 restore 命令（现在已修复跨文件系统问题）
hydrooj restore /path/to/backup/file

# 验证 MongoDB 工具
which mongorestore  # 应该返回 /usr/bin/mongorestore
which mongodump     # 应该返回 /usr/bin/mongodump
```

## 🔧 关键修复

### 跨文件系统问题解决方案
通过设置环境变量将临时目录重定向到与目标目录相同的文件系统：
```bash
export TMPDIR=/data/file/temp
export TMP=/data/file/temp
export TEMP=/data/file/temp
```

### 环境变量验证
```bash
# 在容器内检查
env | grep -E 'TMP|TEMP'
# 应该显示：
# TMPDIR=/data/file/temp
# TMP=/data/file/temp
# TEMP=/data/file/temp (在 Windows 环境下)
```

## 📁 目录结构
```
./data/
├── db/          # MongoDB 数据目录
├── file/        # Hydro 文件存储
│   └── temp/    # 临时文件目录（修复跨文件系统问题）
├── hydro/       # Hydro 配置目录
└── judge/       # Judge 配置目录
```

## 🌐 访问方式
- **Web 界面**: http://localhost:8080
- **MongoDB**: localhost:27017 (仅限本地，如需要外部访问请添加端口映射)

## ⚙️ 高级配置

### 添加 Judge 功能
```bash
# 如果网络允许，可以在运行时添加
docker exec hydro-complete yarn global add @hydrooj/hydrojudge
```

### 性能优化
- 使用 SSD 存储数据目录
- 根据负载调整容器资源限制
- 定期清理临时文件

## 🔍 故障排除

### 常见问题
1. **跨文件系统移动失败**
   - 检查环境变量设置
   - 确认临时目录已创建

2. **MongoDB 连接失败**
   - 检查 MongoDB 进程状态
   - 查看日志：`docker logs hydro-complete`

3. **restore 命令失败**
   - 确认 MongoDB 工具已安装
   - 检查备份文件路径和权限

### 日志查看
```bash
# 查看容器日志
docker logs hydro-complete -f

# 查看 MongoDB 日志
docker exec hydro-complete tail -f /var/log/mongodb.log
```

## 🎉 测试验证
完整版本已通过以下测试：
- ✅ MongoDB 服务正常运行
- ✅ Hydro Web 界面可访问 (HTTP 200)
- ✅ MongoDB 工具集完整可用
- ✅ 跨文件系统移动修复生效
- ✅ 环境变量正确设置

## 📞 技术支持
如遇到问题，请提供：
1. 容器日志：`docker logs hydro-complete`
2. 进程状态：`docker exec hydro-complete ps aux`
3. 环境变量：`docker exec hydro-complete env | grep -E 'TMP|TEMP'` 