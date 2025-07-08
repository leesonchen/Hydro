#!/bin/bash

echo "🚀 Hydro Docker 完整版启动助手"
echo "====================================="

# 进入脚本所在目录
cd "$(dirname "$0")"

# 检查必要文件
if [ ! -f "docker-compose.auto.yml" ] || [ ! -f "prepare-host-dirs.sh" ]; then
    echo "❌ 缺少必要文件，请确保在正确的目录中运行"
    exit 1
fi

# 询问用户选择
echo ""
echo "请选择启动模式："
echo "1. 🆕 全新安装 (清理旧数据并重新安装)"
echo "2. 🔄 重启现有容器"
echo "3. 🧪 运行完整测试"
echo "4. 📊 查看状态信息"
echo "5. 🛑 停止所有容器"
echo ""
read -p "请输入选择 (1-5): " choice

case $choice in
    1)
        echo "🆕 开始全新安装..."
        echo "=== 停止现有容器 ==="
        docker-compose -f docker-compose.auto.yml down 2>/dev/null || true
        
        echo "=== 清理旧数据 ==="
        read -p "⚠️  是否删除本地数据目录? (y/N): " confirm
        if [[ $confirm =~ ^[Yy]$ ]]; then
            rm -rf hydro-data hydro-config hydro-logs hydro-problems hydro-db
            echo "本地数据已清理"
        fi
        
        echo "=== 准备目录 ==="
        ./prepare-host-dirs.sh
        
        echo "=== 构建并启动 ==="
        docker-compose -f docker-compose.auto.yml up -d --build
        
        echo "=== 等待安装完成 ==="
        echo "⏳ 安装过程需要几分钟时间，请耐心等待..."
        sleep 10
        
        echo "=== 查看实时日志 ==="
        echo "按 Ctrl+C 停止查看日志（不会停止容器）"
        docker logs hydro-auto -f
        ;;
    
    2)
        echo "🔄 重启现有容器..."
        docker-compose -f docker-compose.auto.yml restart
        echo "✅ 容器已重启"
        ;;
    
    3)
        echo "🧪 运行完整测试..."
        ./test-fix.sh
        ;;
    
    4)
        echo "📊 查看状态信息..."
        echo ""
        echo "=== 容器状态 ==="
        docker-compose -f docker-compose.auto.yml ps
        
        echo ""
        echo "=== 网络监听状态 ==="
        docker exec hydro-auto netstat -tlnp 2>/dev/null | grep -E ':(80|8888|27017)' || echo "服务尚未启动"
        
        echo ""
        echo "=== 本地目录 ==="
        ls -la hydro-*/ 2>/dev/null || echo "本地目录未创建"
        
        echo ""
        echo "🌐 访问地址："
        echo "   Web界面: http://localhost:80"
        echo "   管理界面: http://localhost:8888"
        echo "   MongoDB: mongodb://localhost:27017"
        ;;
    
    5)
        echo "🛑 停止所有容器..."
        docker-compose -f docker-compose.auto.yml down
        echo "✅ 所有容器已停止"
        ;;
    
    *)
        echo "❌ 无效选择"
        exit 1
        ;;
esac

echo ""
echo "✨ 操作完成！" 