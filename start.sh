#!/usr/bin/env bash
# 云文件管理器 启动脚本（Linux / 腾讯云服务器）
# 用法：
#   CFM_ROOT=/path/to/your/folder CFM_PASSWORD=你的密码 ./start.sh
set -e

export CFM_ROOT="${CFM_ROOT:-/home/$(whoami)/cloud-files}"
export CFM_PASSWORD="${CFM_PASSWORD:-123456}"
export CFM_HOST="${CFM_HOST:-0.0.0.0}"
export CFM_PORT="${CFM_PORT:-8000}"
export CFM_SECRET="${CFM_SECRET:-$(python3 -c 'import secrets;print(secrets.token_hex(16))')}"

echo "管理目录: $CFM_ROOT"
echo "监听:     $CFM_HOST:$CFM_PORT"

# 若使用虚拟环境，请先激活；此处直接用系统 python3
exec python3 "$(dirname "$0")/server.py"
