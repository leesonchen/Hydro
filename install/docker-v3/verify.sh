#!/bin/bash

# Hydro 部署验证脚本

set -e

echo "🔍 验证 Hydro 部署状态..."
echo "=========================="

# 检查容器状态
echo "📦 容器状态:"
if docker ps | grep -q hydro; then
    echo "✅ hydro 容器正在运行"
    CONTAINER_ID=$(docker ps --format "table {{.ID}}\t{{.Names}}" | grep hydro | awk '{print $1}')
else
    echo "❌ hydro 容器未运行"
    echo "请先运行: docker-compose up -d"
    exit 1
fi

# 检查端口
echo ""
echo "🌐 端口监听状态:"
check_port() {
    local port=$1
    local service=$2
    
    if docker exec $CONTAINER_ID netstat -tlnp 2>/dev/null | grep ":$port "; then
        bind_info=$(docker exec $CONTAINER_ID netstat -tlnp 2>/dev/null | grep ":$port " | head -1)
        echo "✅ $service ($port): $(echo $bind_info | awk '{print $4}')"
    else
        echo "❌ $service ($port): 未监听"
    fi
}

check_port "27017" "MongoDB"
check_port "80" "Web服务"
check_port "8888" "管理界面"

# 检查PM2服务
echo ""
echo "🔧 PM2 服务状态:"
if docker exec $CONTAINER_ID command -v pm2 >/dev/null 2>&1; then
    docker exec $CONTAINER_ID pm2 list
else
    echo "❌ PM2 未安装"
fi

# 检查本地目录
echo ""
echo "📁 本地目录映射:"
local_dirs=("hydro-data" "hydro-config" "hydro-logs" "hydro-problems" "hydro-db")
for dir in "${local_dirs[@]}"; do
    if [[ -d "$dir" ]]; then
        echo "✅ ./$dir/ 存在"
    else
        echo "❌ ./$dir/ 不存在"
    fi
done

# 检查访问
echo ""
echo "🌐 服务访问测试:"
if curl -s -f -o /dev/null --max-time 10 "http://localhost:80"; then
    echo "✅ Web服务 (80) 可访问"
else
    echo "⚠️ Web服务 (80) 暂不可访问"
fi

if curl -s -f -o /dev/null --max-time 10 "http://localhost:8888"; then
    echo "✅ 管理界面 (8888) 可访问"
else
    echo "⚠️ 管理界面 (8888) 暂不可访问"
fi

echo ""
echo "📊 容器资源使用:"
docker stats $CONTAINER_ID --no-stream --format "table {{.Container}}\t{{.CPUPerc}}\t{{.MemUsage}}"

echo ""
echo "🎯 访问地址:"
echo "  • Web界面: http://localhost:80"
echo "  • 管理界面: http://localhost:8888"
echo "  • MongoDB: mongodb://localhost:27017"
echo ""
echo "✅ 验证完成！" 