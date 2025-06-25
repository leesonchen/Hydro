#!/bin/bash
set -e

echo "🚀 Hydro 自动部署启动脚本"
echo "================================="

# 确保关键环境变量存在
export HOME=/root
export USER=root
export DEBIAN_FRONTEND=noninteractive

# 设置Hydro安装环境变量
export IGNORE_BT=1
export IGNORE_CENTOS=1
export REGION=CN

echo "📋 环境信息:"
echo "  HOME: $HOME"
echo "  USER: $USER"
echo "  REGION: $REGION"

# 创建必要目录
echo "📁 创建必要目录..."
mkdir -p ~/.hydro /data/db /data/file
mkdir -p /data-host /root/.hydro-host /var/log/hydro /var/lib/mongodb
chmod 755 /data-host /root/.hydro-host /var/log/hydro /var/lib/mongodb

echo "⬇️ 下载并运行 Hydro 安装脚本..."
curl -fsSL https://hydro.ac/setup.sh -o /tmp/hydro-setup.sh
chmod +x /tmp/hydro-setup.sh

echo "🔧 开始安装 Hydro..."
LANG=zh bash /tmp/hydro-setup.sh

echo "🔧 配置 MongoDB 外部访问..."

# 创建MongoDB外部访问修复脚本
cat > /usr/local/bin/fix-mongodb-external.sh << 'EOF'
#!/bin/bash
echo "🔧 修复 MongoDB 外部访问..."

# 等待MongoDB启动
sleep 15

# 检查当前MongoDB监听状态
current_bind=$(netstat -tlnp 2>/dev/null | grep :27017 | head -1)
if [[ -n "$current_bind" ]]; then
    echo "当前MongoDB状态: $current_bind"
    if echo "$current_bind" | grep -q "127.0.0.1:27017"; then
        echo "⚠️ MongoDB 仅监听 127.0.0.1，需要修复..."
        
        # 通过PM2修复MongoDB绑定
        if command -v pm2 >/dev/null 2>&1; then
            echo "🔄 重新配置 MongoDB 绑定地址..."
            pm2 stop mongodb 2>/dev/null || true
            pm2 delete mongodb 2>/dev/null || true
            
            sleep 3
            
            # 重新启动MongoDB，指定绑定到0.0.0.0
            if [ -f /root/.nix-profile/bin/mongod ]; then
                mongod_bin="/root/.nix-profile/bin/mongod"
            else
                mongod_bin=$(which mongod)
            fi
            
            pm2 start "$mongod_bin" --name mongodb -- \
                --auth \
                --wiredTigerCacheSizeGB=2.59 \
                --bind_ip 0.0.0.0 \
                --dbpath /data/db
                
            pm2 save
            
            sleep 5
            
            # 验证修复结果
            new_bind=$(netstat -tlnp 2>/dev/null | grep :27017 | head -1)
            if echo "$new_bind" | grep -q "0.0.0.0:27017"; then
                echo "✅ MongoDB 现在监听 0.0.0.0:27017"
            else
                echo "❌ MongoDB 修复失败: $new_bind"
            fi
        fi
    elif echo "$current_bind" | grep -q "0.0.0.0:27017"; then
        echo "✅ MongoDB 已经正确监听 0.0.0.0:27017"
    fi
else
    echo "⚠️ MongoDB 未在 27017 端口监听"
fi
EOF

chmod +x /usr/local/bin/fix-mongodb-external.sh

# 后台运行MongoDB修复脚本
/usr/local/bin/fix-mongodb-external.sh &

echo "🔧 设置 Nix 环境..."
if [ -f /root/.nix-profile/etc/profile.d/nix.sh ]; then
    source /root/.nix-profile/etc/profile.d/nix.sh
    echo "✅ Nix 环境加载成功"
else
    echo "⚠️ Nix 环境文件未找到"
fi

echo "🔍 检查安装结果..."
if command -v pm2 >/dev/null 2>&1; then
    echo "✅ PM2 安装成功"
    pm2 list
else
    echo "❌ PM2 未找到"
fi

echo "✅ Hydro 安装完成！"
echo "================================="
echo "🌐 访问地址:"
echo "  • Web界面: http://localhost:80"
echo "  • 管理界面: http://localhost:8888"
echo "  • MongoDB: mongodb://localhost:27017"
echo ""
echo "📁 本地数据目录:"
echo "  • ./hydro-data/    - 数据文件"
echo "  • ./hydro-config/  - 配置文件"
echo "  • ./hydro-logs/    - 日志文件"
echo "  • ./hydro-problems/- 题目文件"
echo "  • ./hydro-db/      - 数据库文件"
echo "================================="

# 最终网络状态显示
echo "🌐 当前网络监听状态:"
netstat -tlnp 2>/dev/null | grep -E ':(80|8888|27017)' || echo "服务可能仍在启动中..."

# 保持容器运行
if command -v pm2 >/dev/null 2>&1; then
    echo "🎯 通过 PM2 保持服务运行..."
    exec pm2 logs --lines 50
else
    echo "⚠️ PM2 不可用，使用 sleep 保持容器运行"
    exec sleep infinity
fi 