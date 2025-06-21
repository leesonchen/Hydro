#!/bin/bash

# Create data directories
mkdir -p /data/db /data/file /root/.hydro

# Set MongoDB directory permissions
chmod 755 /data/db

# Start MongoDB in background
echo "Starting MongoDB..."
mongod --dbpath /data/db --logpath /var/log/mongodb.log --fork --bind_ip_all --noauth

# Wait for MongoDB to be ready
echo "Waiting for MongoDB to start..."
until mongosh --eval "print('MongoDB is ready')" > /dev/null 2>&1; do
    sleep 2
done

echo "MongoDB started successfully!"

# Configure Hydro to use local MongoDB
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
    
    sleep 3
    
    hydrooj cli user create systemjudge@systemjudge.local root rootroot
    hydrooj cli user setSuperAdmin 2
fi

# Start Hydro
echo "Starting Hydro..."
exec pm2-runtime start hydrooj -- --host=0.0.0.0 --port=8888 