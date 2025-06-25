#!/bin/bash

echo "=== 准备 Hydro 容器的本地目录映射 ==="

# 进入脚本所在目录
cd "$(dirname "$0")"

# 创建本地目录
echo "=== 创建本地目录 ==="
mkdir -p hydro-data
mkdir -p hydro-config  
mkdir -p hydro-logs
mkdir -p hydro-problems
mkdir -p hydro-db

# 设置目录权限
echo "=== 设置目录权限 ==="
chmod 755 hydro-data hydro-config hydro-logs hydro-problems hydro-db

# 创建说明文件
cat > hydro-data/README.txt << 'EOF'
这个目录映射到容器内的 /data-host
用于存储 Hydro 的数据文件
EOF

cat > hydro-config/README.txt << 'EOF'
这个目录映射到容器内的 /root/.hydro-host
用于存储 Hydro 的配置文件副本
EOF

cat > hydro-logs/README.txt << 'EOF'
这个目录映射到容器内的 /var/log/hydro
用于存储 Hydro 的日志文件
EOF

cat > hydro-problems/README.txt << 'EOF'
这个目录映射到容器内的 /data/file
用于存储题目文件和测试数据
EOF

cat > hydro-db/README.txt << 'EOF'
这个目录映射到容器内的 /var/lib/mongodb
用于存储 MongoDB 数据库文件
注意：需要确保 MongoDB 有写入权限
EOF

echo "=== 目录准备完成 ==="
echo ""
echo "📁 创建的本地目录："
echo "  • hydro-data/    -> /data-host (数据文件)"
echo "  • hydro-config/  -> /root/.hydro-host (配置文件)"
echo "  • hydro-logs/    -> /var/log/hydro (日志文件)"
echo "  • hydro-problems/-> /data/file (题目文件)"
echo "  • hydro-db/      -> /var/lib/mongodb (数据库文件)"
echo ""
echo "🚀 现在可以启动容器："
echo "   docker-compose -f docker-compose.auto.yml up -d" 