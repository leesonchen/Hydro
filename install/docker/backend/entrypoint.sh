#!/bin/sh

ROOT=/root/.hydro

if [ ! -f "$ROOT/addon.json" ]; then
    echo '["@hydrooj/ui-default"]' > "$ROOT/addon.json"
fi

if [ ! -f "$ROOT/config.json" ]; then
    echo '{"host": "oj-mongo", "port": "27017", "name": "hydro", "username": "", "password": ""}' > "$ROOT/config.json"
fi

# 设置环境变量让Hydro监听所有网络接口
export HYDRO_HOST=0.0.0.0
export HYDRO_PORT=8888

# 设置临时目录到数据目录，避免跨文件系统移动问题
mkdir -p /data/file/temp
export TMPDIR=/data/file/temp
export TMP=/data/file/temp
export TEMP=/data/file/temp

if [ ! -f "$ROOT/first" ]; then
    echo "for marking use only!" > "$ROOT/first"

    hydrooj cli user create systemjudge@systemjudge.local root rootroot
    hydrooj cli user setSuperAdmin 2
fi

pm2-runtime start hydrooj -- --host=0.0.0.0 --port=8888
