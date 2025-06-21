# Hydro Docker 部署修复方案

## 问题分析

在使用 `hydrooj restore` 命令时出现 `spawnSync mongorestore ENOENT` 错误，原因是：

1. **MongoDB 客户端工具缺失**：Hydro 后端容器中没有安装 MongoDB 客户端工具（如 `mongorestore`）
2. **容器分离架构**：MongoDB 服务在独立容器中，无法直接访问 MongoDB 工具

## 解决方案

### 方案1：修复现有分离架构（推荐）

修改 `backend/Dockerfile`，添加 MongoDB 客户端工具：

```dockerfile
FROM node:20

# Install MongoDB client tools
RUN apt-get update && \
    apt-get install -y gnupg wget && \
    wget -qO - https://www.mongodb.org/static/pgp/server-6.0.asc | apt-key add - && \
    echo "deb [ arch=amd64,arm64 ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/6.0 multiverse" | tee /etc/apt/sources.list.d/mongodb-org-6.0.list && \
    apt-get update && \
    apt-get install -y mongodb-database-tools && \
    rm -rf /var/lib/apt/lists/*

ADD ./entrypoint.sh /root/entrypoint.sh
RUN yarn global add pm2 hydrooj @hydrooj/ui-default
RUN chmod +x /root/entrypoint.sh && \
    mkdir -p /root/.hydro
ENTRYPOINT /root/entrypoint.sh
```

**使用方法：**
```bash
# 重新构建后端容器
docker-compose build oj-backend

# 启动服务
docker-compose up -d

# 现在可以正常使用 restore 功能
docker-compose exec oj-backend hydrooj restore /path/to/backup.zip
```

### 方案2：All-in-One 单容器架构

使用 `Dockerfile.all-in-one` 和 `docker-compose-all-in-one.yml`：

**特点：**
- 单个容器包含所有服务（MongoDB + Hydro + Judge）
- 解决服务间通信问题
- 简化部署和维护

**使用方法：**
```bash
# 使用 All-in-One 配置启动
docker-compose -f docker-compose-all-in-one.yml up -d

# 进入容器执行命令
docker exec -it hydro-all-in-one bash

# 直接使用 restore 功能
hydrooj restore /path/to/backup.zip
```

## 性能和架构对比

| 特性 | 分离架构 | All-in-One |
|------|----------|-------------|
| 资源隔离 | ✅ 好 | ❌ 差 |
| 扩展性 | ✅ 好 | ❌ 差 |
| 部署复杂度 | ❌ 高 | ✅ 低 |
| 故障隔离 | ✅ 好 | ❌ 差 |
| 维护便利性 | ❌ 差 | ✅ 好 |
| 适用场景 | 生产环境 | 开发/测试 |

## 建议

1. **生产环境**：使用方案1（分离架构 + MongoDB 客户端工具）
2. **开发/测试环境**：可以使用方案2（All-in-One）
3. **现有环境升级**：推荐方案1，只需重新构建后端容器

## 注意事项

1. 重新构建容器后需要重新启动服务
2. 确保数据目录正确挂载，避免数据丢失
3. All-in-One 方案适合单机部署，不适合集群环境 