#!/bin/bash

# Create data directories
mkdir -p /data/db /data/file /root/.hydro /root/.config/hydro

# 解决跨文件系统移动问题：设置临时目录到数据目录
mkdir -p /data/file/temp
export TMPDIR=/data/file/temp
export TMP=/data/file/temp
export TEMP=/data/file/temp
echo "Set temporary directories to /data/file/temp to avoid cross-filesystem issues"

# Set permissions for MongoDB
chmod -R 755 /data/db

# Start MongoDB
echo "Starting MongoDB..."
mongod --dbpath /data/db --logpath /var/log/mongodb.log --fork --bind_ip_all --noauth

# Wait for MongoDB to start
echo "Waiting for MongoDB to be ready..."
until mongosh --eval "print('MongoDB is ready')" > /dev/null 2>&1; do
    sleep 2
done

# Configure Hydro
ROOT=/root/.hydro

if [ ! -f "$ROOT/addon.json" ]; then
    echo '["@hydrooj/ui-default"]' > "$ROOT/addon.json"
fi

if [ ! -f "$ROOT/config.json" ]; then
    echo '{"host": "localhost", "port": "27017", "name": "hydro", "username": "", "password": ""}' > "$ROOT/config.json"
fi

# Set environment variables
export HYDRO_HOST=0.0.0.0
export HYDRO_PORT=8888

# Initialize Hydro if first run
if [ ! -f "$ROOT/first" ]; then
    echo "Initializing Hydro for first run..."
    echo "for marking use only!" > "$ROOT/first"
    
    # Wait a bit more to ensure MongoDB is fully ready
    sleep 3
    
    hydrooj cli user create systemjudge@systemjudge.local root rootroot
    hydrooj cli user setSuperAdmin 2
fi

# Start services using supervisor
echo "Starting all services..."
exec supervisord -c /etc/supervisor/conf.d/supervisord.conf 