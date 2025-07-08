#!/bin/bash
set -e

echo "🚀 Hydro 启动脚本"
echo "================================="

# 设置环境变量
export HOME=/root
export USER=root
export DEBIAN_FRONTEND=noninteractive
export IGNORE_BT=1
export IGNORE_CENTOS=1
export REGION=CN

# 检查是否已经安装过Hydro
INSTALL_FLAG="/root/.hydro/installed"
if [ -f "$INSTALL_FLAG" ]; then
    echo "✅ Hydro 已安装，启动服务..."
    
    # 加载Nix环境
    [ -f /root/.nix-profile/etc/profile.d/nix.sh ] && source /root/.nix-profile/etc/profile.d/nix.sh
    
    # 恢复PM2进程
    if command -v pm2 >/dev/null 2>&1; then
        pm2 list | grep -q 'online' || pm2 resurrect 2>/dev/null || echo "⚠️ 恢复PM2进程失败"
    fi
else
    echo "🆕 首次安装 Hydro..."

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

    echo "🔧 设置 Nix 环境..."
    if [ -f /root/.nix-profile/etc/profile.d/nix.sh ]; then
        source /root/.nix-profile/etc/profile.d/nix.sh
        echo "✅ Nix 环境加载成功"
    else
        echo "⚠️ Nix 环境文件未找到"
    fi

    echo "🔍 检查安装结果..."
    if command -v pm2 >/dev/null 2>&1; then
        echo "🔧 配置 MongoDB 外部访问..."
        pm2 stop mongodb 2>/dev/null || true
        pm2 start /root/.nix-profile/bin/mongod --name mongodb -- \
            --auth \
            --wiredTigerCacheSizeGB=2.59 \
            --bind_ip 0.0.0.0 \
            --port 27017 \
            --dbpath /data/db
        pm2 save
    else
        echo "❌ PM2 未找到"
    fi

    # 标记安装完成
    echo "$(date): Hydro installation completed" > "$INSTALL_FLAG"
    echo "✅ Hydro 安装完成！"
    # 最终网络状态显示
    echo "🌐 当前网络监听状态:"
    netstat -tlnp 2>/dev/null | grep -E ':(80|8888|27017)' || echo "服务可能仍在启动中..."
fi
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
# 保持容器运行
if command -v pm2 >/dev/null 2>&1; then
    echo "🎯 通过 PM2 保持服务运行..."
    exec pm2 logs --lines 50
else
    echo "⚠️ PM2 不可用，使用 sleep 保持容器运行"
    exec sleep infinity
fi 