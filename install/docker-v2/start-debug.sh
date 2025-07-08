#!/bin/bash

echo "=== 启动 Hydro 调试容器 ==="

# 进入脚本所在目录
cd "$(dirname "$0")"

# 停止可能存在的旧容器
echo "=== 清理旧容器 ==="
docker-compose down 2>/dev/null || true

# 构建并启动新容器
echo "=== 构建镜像 ==="
docker-compose build --no-cache

echo "=== 启动容器 ==="
docker-compose up -d

# 等待容器启动
echo "=== 等待容器启动 ==="
sleep 5

# 显示容器状态
echo "=== 容器状态 ==="
docker-compose ps

# 显示容器日志
echo "=== 容器日志 ==="
docker logs hydro-debug --tail 10

echo ""
echo "=== 调试容器已启动！==="
echo ""
echo "🔧 进入容器进行手动调试："
echo "   docker exec -it hydro-debug bash"
echo ""
echo "💡 手动安装 Hydro："
echo "   curl -fsSL https://hydro.ac/setup.sh | bash"
echo ""
echo "📊 查看容器日志："
echo "   docker logs hydro-debug --follow"
echo ""
echo "🛑 停止容器："
echo "   docker-compose down"
echo "" 