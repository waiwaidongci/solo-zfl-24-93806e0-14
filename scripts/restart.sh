#!/usr/bin/env bash
# 重启应用服务（先停旧进程，可选 --fresh 清空数据库）
set -u
cd "$(dirname "$0")/.."
if [ -f /tmp/app.pid ]; then kill "$(cat /tmp/app.pid)" 2>/dev/null; sleep 0.5; fi
if [ "${1:-}" = "--fresh" ]; then rm -f data/app.db data/app.db-wal data/app.db-shm; fi
nohup node server.js > /tmp/server.log 2>&1 &
echo $! > /tmp/app.pid
sleep 1.2
cat /tmp/server.log
