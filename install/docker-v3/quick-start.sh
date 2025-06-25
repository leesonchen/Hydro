#!/bin/bash

# Hydro 一键启动脚本

set -e

echo "🚀 Hydro 一键启动脚本"
echo "======================"

# 检查 Docker 和 Docker Compose
if ! command -v docker >/dev/null 2>&1; then
    echo "❌ Docker 未安装，请先安装 Docker"
    exit 1
fi

if ! command -v docker-compose >/dev/null 2>&1 && ! docker compose version >/dev/null 2>&1; then
    echo "❌ Docker Compose 未安装，请先安装 Docker Compose"
    exit 1
fi

echo "✅ Docker 环境检查通过"

# 准备本地目录
echo ""
echo "📁 准备本地目录..."
./prepare-dirs.sh

# 启动服务
echo ""
echo "🚀 启动 Hydro 服务..."
echo "这可能需要几分钟时间，首次运行需要下载镜像并安装..."

# 使用 docker compose 或 docker-compose
if docker compose version >/dev/null 2>&1; then
    docker compose up -d
else
    docker-compose up -d
fi

echo ""
echo "⏳ 等待服务启动..."
sleep 30

# 显示日志
echo ""
echo "📝 显示启动日志（前50行）:"
docker logs hydro --tail 50

echo ""
echo "🔍 运行验证脚本..."
./verify.sh

echo ""
echo "🎉 Hydro 启动完成！"
echo "==================="
echo "🌐 访问地址:"
echo "  • Web界面: http://localhost:80"
echo "  • 管理界面: http://localhost:8888"
echo "  • MongoDB: mongodb://localhost:27017"
echo ""
echo "📋 常用命令:"
echo "  • 查看日志: docker logs hydro -f"
echo "  • 停止服务: docker-compose down"
echo "  • 重启服务: docker-compose restart"
echo "  • 验证状态: ./verify.sh" 