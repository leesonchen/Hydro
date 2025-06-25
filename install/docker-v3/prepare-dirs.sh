#!/bin/bash

# Hydro 本地目录准备脚本
# 创建并设置本地映射目录的权限

set -e

echo "📁 准备 Hydro 本地目录..."
echo "=========================="

# 创建本地映射目录
directories=(
    "hydro-data"
    "hydro-config"
    "hydro-logs"
    "hydro-problems"
    "hydro-db"
)

for dir in "${directories[@]}"; do
    if [ ! -d "$dir" ]; then
        mkdir -p "$dir"
        echo "✅ 创建目录: ./$dir/"
    else
        echo "📁 目录已存在: ./$dir/"
    fi
    
    # 设置权限
    chmod 755 "$dir"
done

echo ""
echo "📋 目录说明:"
echo "  • ./hydro-data/    - Hydro 数据文件"
echo "  • ./hydro-config/  - Hydro 配置文件"
echo "  • ./hydro-logs/    - 服务日志文件"
echo "  • ./hydro-problems/- 题目和测试数据"
echo "  • ./hydro-db/      - MongoDB 数据库文件"
echo ""
echo "✅ 本地目录准备完成！"
echo "现在可以运行: docker-compose up -d" 