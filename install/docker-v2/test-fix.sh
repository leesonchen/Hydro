#!/bin/bash

echo "=== 测试 Hydro 完整功能（环境变量修复 + MongoDB外部访问 + 目录映射）==="

# 进入脚本所在目录
cd "$(dirname "$0")"

# 准备本地目录
echo "=== 准备本地目录 ==="
./prepare-host-dirs.sh

# 停止旧容器
echo "=== 清理旧容器 ==="
docker-compose down 2>/dev/null || true
docker-compose -f docker-compose.auto.yml down 2>/dev/null || true

# 构建并启动修复版本
echo "=== 构建修复版本 ==="
docker-compose -f docker-compose.auto.yml build --no-cache

echo "=== 启动修复版本 ==="
docker-compose -f docker-compose.auto.yml up -d

echo "=== 等待安装完成 (90秒) ==="
sleep 90

echo "=== 检查容器状态 ==="
docker-compose -f docker-compose.auto.yml ps

echo "=== 查看安装日志 ==="
docker logs hydro-auto --tail 50

echo "=== 测试环境变量 ==="
docker exec hydro-auto bash -c "echo 'HOME=' && echo \$HOME && echo 'USER=' && echo \$USER"

echo "=== 测试 Nix 安装 ==="
docker exec hydro-auto bash -c "which nix-channel && nix-channel --list"

echo "=== 测试 PM2 ==="
docker exec hydro-auto bash -c "which pm2 && pm2 list"

echo "=== 测试网络监听状态 ==="
docker exec hydro-auto bash -c "netstat -tlnp | grep -E ':(80|8888|27017)'"

echo "=== 测试MongoDB外部访问 ==="
echo "检查MongoDB是否监听0.0.0.0..."
docker exec hydro-auto bash -c "netstat -tlnp | grep :27017"

echo "=== 检查本地目录映射 ==="
echo "检查本地目录内容..."
ls -la hydro-*/

echo "=== 测试完成 ==="
echo ""
echo "🎉 如果看到以下信息说明成功："
echo "✅ MongoDB监听 0.0.0.0:27017"
echo "✅ Web服务监听 0.0.0.0:80"
echo "✅ 管理界面监听 0.0.0.0:8888"
echo "✅ 本地目录已创建并映射"
echo ""
echo "🌐 访问地址："
echo "   Web界面: http://localhost:80"
echo "   管理界面: http://localhost:8888"
echo "   MongoDB: mongodb://localhost:27017" 