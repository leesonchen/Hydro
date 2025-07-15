# Hydro 域复制功能部署指南

## 概述
本指南帮助您将 Hydro 域复制功能部署到 Docker 容器中。域复制功能允许管理员将一个域的完整内容复制到新域。

## 功能特性
- ✅ 域基本信息复制
- ✅ 题库和测试数据复制
- ✅ 比赛和作业复制
- ✅ 训练计划复制
- ✅ 用户权限和角色复制
- ✅ 用户分组复制
- ✅ 讨论内容复制
- ✅ 题目题解复制
- ✅ 题目 ID 映射
- ✅ 实时进度显示
- ✅ 错误处理和恢复

## 部署脚本说明

### 1. 一键部署脚本 (推荐)
```bash
./deploy-domain-copy.sh
```
自动完成构建、更新、验证的完整流程。

### 2. 分步部署脚本

#### 构建脚本
```bash
./build-hydro.sh
```
- 检查域复制功能文件
- 构建项目（可选）
- 准备部署文件
- 生成文件清单

#### 更新脚本
```bash
./update-hydro.sh
```
- 创建备份
- 更新容器中的文件
- 重启服务
- 验证更新

#### 验证脚本
```bash
./verify-domain-copy.sh
```
- 检查容器状态
- 验证文件完整性
- 测试 HTTP 访问
- 生成测试报告

## 使用前准备

### 1. 确保环境就绪
- Docker 和 Docker Compose 已安装
- Hydro 容器正在运行
- Node.js 和 npm 已安装（用于构建）

### 2. 检查容器状态
```bash
docker ps | grep hydro
```

### 3. 检查端口访问
```bash
curl -I http://localhost:8082/
```

## 部署步骤

### 方法一：一键部署（推荐）
```bash
# 进入脚本目录
cd /mnt/d/work/Hydro/install/docker-v3

# 运行一键部署脚本
./deploy-domain-copy.sh
```

### 方法二：分步部署
```bash
# 进入脚本目录
cd /mnt/d/work/Hydro/install/docker-v3

# 1. 构建项目
./build-hydro.sh

# 2. 更新容器
./update-hydro.sh

# 3. 验证功能
./verify-domain-copy.sh
```

## 部署后使用

### 1. 访问系统
- 系统主页: http://localhost:8082/
- 管理面板: http://localhost:8082/manage
- 域复制页面: http://localhost:8082/domain/copy

### 2. 使用域复制功能
1. 使用管理员账号登录
2. 进入管理面板
3. 找到 "Domain" 分类
4. 点击 "Copy Domain" 选项
5. 选择源域和目标域
6. 配置复制选项
7. 开始复制过程

### 3. 权限要求
- 需要系统管理员权限 (PRIV_EDIT_SYSTEM)
- 普通用户无法访问此功能

## 复制选项说明

### 内容复制选项
- **题库和测试数据**: 复制所有题目及其测试数据文件
- **比赛和作业**: 复制所有比赛和作业配置
- **训练计划**: 复制所有训练计划和 DAG 结构
- **讨论内容**: 复制所有讨论帖子和回复
- **题目题解**: 复制所有题目的官方题解

### 用户数据选项
- **用户权限和角色**: 复制用户在域内的权限设置
- **用户分组**: 复制用户组配置和成员关系

### 高级选项
- **保留题目ID**: 保持原有题目 ID 不变
- **题目ID映射**: 自定义题目 ID 映射关系

## 故障排除

### 常见问题

#### 1. 容器未运行
```bash
# 检查容器状态
docker ps | grep hydro

# 启动容器
docker-compose up -d
```

#### 2. 服务未启动
```bash
# 检查服务状态
docker exec hydro pm2 list

# 重启服务
docker exec hydro pm2 restart all
```

#### 3. 端口无法访问
```bash
# 检查端口映射
docker port hydro

# 检查防火墙设置
sudo ufw status
```

#### 4. 文件权限问题
```bash
# 检查文件权限
ls -la /mnt/d/work/Hydro/install/docker-v3/

# 设置执行权限
chmod +x *.sh
```

### 日志查看
```bash
# 查看容器日志
docker logs hydro

# 查看 PM2 日志
docker exec hydro pm2 logs

# 查看系统日志
docker exec hydro tail -f /var/log/hydro/error.log
```

## 备份和恢复

### 自动备份
部署脚本会自动创建备份：
- 位置: `./backup/YYYYMMDD_HHMMSS/`
- 包含容器配置和数据文件

### 手动备份
```bash
# 备份容器数据
docker exec hydro tar -czf /tmp/backup.tar.gz -C /root/.hydro .
docker cp hydro:/tmp/backup.tar.gz ./manual-backup.tar.gz

# 备份本地数据
cp -r ./hydro-config ./backup-config
```

### 恢复备份
```bash
# 恢复容器数据
docker cp ./backup.tar.gz hydro:/tmp/
docker exec hydro tar -xzf /tmp/backup.tar.gz -C /root/.hydro
```

## 性能优化

### 1. 大数据量复制
- 建议分批复制大量题目
- 监控内存和磁盘使用情况
- 考虑在低峰时段进行复制

### 2. 网络优化
- 确保容器网络配置正确
- 检查防火墙设置
- 优化数据库连接参数

### 3. 资源配置
- 根据需要调整容器资源限制
- 监控 CPU 和内存使用率
- 优化 MongoDB 配置

## 安全考虑

### 1. 访问控制
- 确保只有授权管理员可以访问
- 定期检查用户权限
- 启用审计日志

### 2. 数据保护
- 定期备份重要数据
- 加密敏感配置文件
- 监控异常访问活动

### 3. 网络安全
- 使用 HTTPS 连接
- 配置适当的防火墙规则
- 定期更新系统补丁

## 技术支持

### 联系方式
- 项目文档: https://hydro.js.org/
- 问题反馈: https://github.com/hydro-dev/Hydro/issues
- 社区讨论: https://hydro.js.org/discuss

### 调试信息
如需技术支持，请提供：
- 系统版本信息
- 错误日志内容
- 操作步骤描述
- 环境配置信息

---

**版本信息**
- 创建日期: 2025-07-10
- 脚本版本: 1.0.0
- 适用系统: Docker 容器中的 Hydro
- 维护者: Claude Code