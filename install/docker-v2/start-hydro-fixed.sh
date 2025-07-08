#!/bin/bash
set -e

echo "=== Starting Hydro Installation (Fixed Version) ==="

# 确保关键环境变量存在
export HOME=/root
export USER=root
export DEBIAN_FRONTEND=noninteractive

# 检查基础环境
echo "=== Checking environment ==="
echo "HOME: $HOME"
echo "USER: $USER"
which curl || (echo "curl not found" && exit 1)
which wget || (echo "wget not found" && exit 1)

# 设置Hydro安装环境变量
echo "=== Setting Hydro installation variables ==="
export IGNORE_BT=1
export IGNORE_CENTOS=1
export REGION=CN

# 创建必要目录
mkdir -p ~/.hydro /data/db /data/file
# 创建主机映射目录并设置权限
mkdir -p /data-host /root/.hydro-host /var/log/hydro /var/lib/mongodb
chmod 755 /data-host /root/.hydro-host /var/log/hydro /var/lib/mongodb

echo "=== Downloading and running Hydro setup script ==="
curl -fsSL https://hydro.ac/setup.sh -o /tmp/hydro-setup.sh
chmod +x /tmp/hydro-setup.sh

# 运行安装脚本
echo "=== Running Hydro installation ==="
LANG=zh bash /tmp/hydro-setup.sh

# 修改MongoDB配置以允许外部访问
echo "=== Configuring MongoDB for external access ==="

# 方法1: 修改标准的mongod.conf配置文件
if [ -f /etc/mongod.conf ]; then
    echo "Found standard MongoDB config at /etc/mongod.conf"
    # 备份原始配置
    cp /etc/mongod.conf /etc/mongod.conf.backup
    # 修改监听地址
    sed -i 's/bindIp: 127\.0\.0\.1/bindIp: 0.0.0.0/' /etc/mongod.conf
    sed -i 's/bind_ip = 127\.0\.0\.1/bind_ip = 0.0.0.0/' /etc/mongod.conf
    echo "MongoDB configuration updated to listen on 0.0.0.0"
    
    # 重启 MongoDB 服务
    if command -v systemctl >/dev/null 2>&1; then
        systemctl restart mongod || echo "systemctl restart failed"
    elif command -v service >/dev/null 2>&1; then
        service mongod restart || echo "service restart failed"
    fi
    
    sleep 5
    echo "MongoDB restart attempted"
fi

# 方法2: 检查和修改 /usr/local/etc/mongod.conf (Homebrew/自定义安装)
if [ -f /usr/local/etc/mongod.conf ]; then
    echo "Found custom MongoDB config at /usr/local/etc/mongod.conf"
    cp /usr/local/etc/mongod.conf /usr/local/etc/mongod.conf.backup
    sed -i 's/bindIp: 127\.0\.0\.1/bindIp: 0.0.0.0/' /usr/local/etc/mongod.conf
    sed -i 's/bind_ip = 127\.0\.0\.1/bind_ip = 0.0.0.0/' /usr/local/etc/mongod.conf
fi

# 方法3: 如果MongoDB通过PM2运行，我们需要在PM2启动后修改
echo "Will also check PM2 MongoDB processes after installation..."

# 创建MongoDB配置检查脚本
cat > /usr/local/bin/fix-mongodb-bind.sh << 'MONGODB_EOF'
#!/bin/bash
echo "=== Checking MongoDB binding after PM2 start ==="

# 等待MongoDB启动
sleep 10

# 检查MongoDB是否在运行以及监听地址
if netstat -tlnp 2>/dev/null | grep :27017 | grep 127.0.0.1; then
    echo "⚠️  MongoDB is listening on 127.0.0.1, attempting to fix..."
    
    # 尝试找到MongoDB进程并重启
    if command -v pm2 >/dev/null 2>&1; then
        # 如果通过PM2运行，尝试重启MongoDB相关进程
        pm2 list | grep -i mongo && {
            echo "Found MongoDB in PM2, restarting..."
            pm2 restart mongodb 2>/dev/null || pm2 restart mongo 2>/dev/null || echo "PM2 MongoDB restart failed"
        }
    fi
    
    # 再次检查
    sleep 5
    if netstat -tlnp 2>/dev/null | grep :27017 | grep 0.0.0.0; then
        echo "✅ MongoDB now listening on 0.0.0.0:27017"
    else
        echo "❌ MongoDB still not accessible externally"
        echo "Current MongoDB listening status:"
        netstat -tlnp 2>/dev/null | grep :27017 || echo "MongoDB not found listening on port 27017"
    fi
else
    echo "✅ MongoDB binding looks correct or not yet started"
fi
MONGODB_EOF

chmod +x /usr/local/bin/fix-mongodb-bind.sh

# 确保环境变量正确设置
echo "=== Setting up Nix environment ==="
if [ -f /root/.nix-profile/etc/profile.d/nix.sh ]; then
    source /root/.nix-profile/etc/profile.d/nix.sh
    echo "Nix environment loaded successfully"
    echo "PATH: $PATH"
else
    echo "Warning: Nix profile not found"
fi

# 检查安装结果
echo "=== Checking installation result ==="
if command -v pm2 >/dev/null 2>&1; then
    echo "✅ PM2 installed successfully"
    pm2 list
else
    echo "❌ PM2 not found"
fi

if command -v nix-channel >/dev/null 2>&1; then
    echo "✅ Nix installed successfully"
    nix-channel --list
else
    echo "❌ Nix not found"
fi

echo "=== Hydro installation completed! ==="
echo "=== Web interface will be available on port 80 ==="
echo "=== Admin interface on port 8888 ==="

# 最后检查和修复MongoDB绑定
echo "=== Final MongoDB binding check ==="
/usr/local/bin/fix-mongodb-bind.sh &  # 在后台运行

# 显示网络监听状态
echo "=== Current network listening status ==="
netstat -tlnp 2>/dev/null | grep -E ':(80|8888|27017)' || echo "No services found on expected ports yet"

echo "=== Hydro installation and configuration completed! ==="
echo "🌐 Web interface: http://localhost:80"
echo "⚙️  Admin interface: http://localhost:8888"  
echo "🗄️  MongoDB: mongodb://localhost:27017"
echo "📁 Local directories:"
echo "   • ./hydro-data/    - 数据文件"
echo "   • ./hydro-config/  - 配置文件" 
echo "   • ./hydro-logs/    - 日志文件"
echo "   • ./hydro-problems/- 题目文件"
echo "   • ./hydro-db/      - 数据库文件"

# 保持容器运行
if command -v pm2 >/dev/null 2>&1; then
    exec pm2 logs --lines 50
else
    echo "PM2 not available, keeping container running with sleep"
    exec sleep infinity
fi 