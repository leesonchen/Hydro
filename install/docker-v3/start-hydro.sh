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

# 加载Nix环境 (Nix 已在 Dockerfile 中安装)
[ -f /root/.nix-profile/etc/profile.d/nix.sh ] && source /root/.nix-profile/etc/profile.d/nix.sh
echo "✅ Nix 环境加载尝试完成."

# 恢复PM2进程 (如果pm2可用)
if command -v pm2 >/dev/null 2>&1; then
    echo "✅ PM2 已安装，尝试恢复进程..."
    pm2 resurrect 2>/dev/null || echo "⚠️ 恢复PM2进程失败或无进程可恢复."
else
    echo "❌ PM2 未找到，无法恢复进程。"
fi

echo "================================="
echo "🌐 访问地址:"
echo "  • Web界面: http://localhost:80"
echo "  • 管理界面: http://localhost:8888"
echo "  • MongoDB: mongodb://localhost:27017"
echo ""
echo "📁 本地数据目录 (通过卷挂载，不会包含在镜像中):"
echo "  • ./hydro-data/    - 数据文件"
echo "  • ./hydro-config/  - 配置文件 (通过卷挂载)"
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