#!/usr/bin/env bash
# ============================================================
# 私人云盘 — 服务管理脚本
#
# 用法：
#   bash manage.sh start          启动服务
#   bash manage.sh stop           停止服务
#   bash manage.sh restart        重启服务
#   bash manage.sh status         查看状态
#   bash manage.sh password       重置登录密码（只更新哈希）
#   bash manage.sh password -p 新密码
# ============================================================
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_DIR/.env"
PID_FILE="$PROJECT_DIR/run/cfm.pid"
LOG_DIR="$PROJECT_DIR/logs"

C_G="\033[32m"; C_Y="\033[33m"; C_R="\033[31m"; C_B="\033[36m"; C_0="\033[0m"
info() { printf "${C_B}[INFO]${C_0} %s\n" "$*"; }
ok()   { printf "${C_G}[ OK ]${C_0} %s\n" "$*"; }
warn() { printf "${C_Y}[WARN]${C_0} %s\n" "$*"; }
err()  { printf "${C_R}[FAIL]${C_0} %s\n" "$*"; }

# ---------------- .env ----------------
load_env() {
  if [ ! -f "$ENV_FILE" ]; then
    err "未找到 $ENV_FILE，请先运行 scripts/install.sh 初始化"
    exit 1
  fi
  # 仅取 KEY=VALUE 行做 source，安全起见过滤
  eval "$(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$ENV_FILE" | sed 's/^/export /')"
}

env_port() { grep '^CFM_PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 | tr -d '"' || echo 8000; }

upsert_env() { # $1=KEY $2=VALUE
  local key="$1" val="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}

hash_password() { # $1=明文 → "SALT HASH"
  python3 - "$1" <<'PYEOF'
import sys, hashlib, secrets
pw = sys.argv[1]
salt = secrets.token_hex(16)
print(salt, hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), bytes.fromhex(salt), 60000).hex())
PYEOF
}

use_systemd() {
  # 仅当 systemd unit 的 WorkingDirectory 指向【本项目目录】时才用 systemd 管理，
  # 避免同机多实例（如测试目录）误操作正式服务；不匹配则回退 PID 模式。
  command -v systemctl >/dev/null 2>&1 \
    && [ -f /etc/systemd/system/cloudfile.service ] \
    && grep -Eq "^WorkingDirectory=/?$PROJECT_DIR/?$" /etc/systemd/system/cloudfile.service
}

# ---------------- 启停 ----------------
svc_start() {
  if use_systemd; then
    systemctl start cloudfile && ok "服务已启动（systemd）" && return 0
    err "systemd 启动失败：journalctl -u cloudfile -n 20"; return 1
  fi
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    warn "服务已在运行（PID $(cat "$PID_FILE")）"; return 0
  fi
  mkdir -p "$LOG_DIR" "$PROJECT_DIR/run"
  cd "$PROJECT_DIR" || return 1
  load_env
  nohup python3 "$PROJECT_DIR/server.py" >> "$LOG_DIR/cfm.log" 2>&1 &
  echo $! > "$PID_FILE"
  sleep 1
  if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    ok "服务已启动（PID $(cat "$PID_FILE")，日志 $LOG_DIR/cfm.log）"
  else
    err "启动失败，请查看 $LOG_DIR/cfm.log"; return 1
  fi
}

svc_stop() {
  if use_systemd; then
    systemctl stop cloudfile && ok "服务已停止（systemd）" && return 0
  fi
  if [ -f "$PID_FILE" ]; then
    local pid; pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" && ok "服务已停止（PID $pid）"
    else
      warn "进程不存在，清理残留 PID 文件"
    fi
    rm -f "$PID_FILE"; return 0
  fi
  warn "服务未在运行"
}

svc_restart() { svc_stop; sleep 1; svc_start; }

svc_status() {
  if use_systemd; then
    systemctl status cloudfile --no-pager -l | head -15
    return 0
  fi
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    ok "运行中（PID $(cat "$PID_FILE")）"
  else
    warn "未在运行"
  fi
  local port; port=$(env_port)
  if command -v curl >/dev/null 2>&1; then
    local code; code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:${port}/" || echo 000)
    if [ "$code" = "200" ]; then ok "HTTP 检测正常：http://127.0.0.1:${port}/ → $code"
    else warn "HTTP 检测异常：$code"; fi
  fi
}

# ---------------- 重置密码 ----------------
svc_password() {
  load_env
  shift  # 去掉子命令名 "password"
  local pw=""
  while [ $# -gt 0 ]; do
    case "$1" in
      -p|--password) [ $# -ge 2 ] && { pw="$2"; shift 2; } || { err "-p 缺少参数"; return 1; } ;;
      *) pw="$1"; shift ;;
    esac
  done
  if [ -z "$pw" ]; then
    printf "输入新密码（回车=生成 12 位随机密码）: "
    if [ -e /dev/tty ]; then read -r pw < /dev/tty || pw=""; else read -r pw || pw=""; fi
    if [ -z "$pw" ]; then
      pw=$(head -c 16 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 12)
      info "已生成随机密码"
    fi
  fi
  [ -z "$pw" ] && { err "密码不能为空"; return 1; }
  local out salt hash
  out=$(hash_password "$pw") || { err "哈希计算失败（需要 python3）"; return 1; }
  salt=$(echo "$out" | awk '{print $1}')
  hash=$(echo "$out" | awk '{print $2}')
  upsert_env "CFM_PASSWORD_HASH" "$hash"
  upsert_env "CFM_PASSWORD_SALT" "$salt"
  # 删除可能的旧明文密码配置
  sed -i '/^CFM_PASSWORD=/d' "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  printf "\n${C_G}新密码：%s${C_0}   ${C_Y}← 仅展示这一次，请记牢${C_0}\n" "$pw"
  printf "已更新 $ENV_FILE（CFM_PASSWORD_HASH / CFM_PASSWORD_SALT）\n"
  svc_restart
  ok "密码已重置并重启服务"
}

# ---------------- 入口 ----------------
case "${1:-}" in
  start)    svc_start ;;
  stop)     svc_stop ;;
  restart)  svc_restart ;;
  status)   svc_status ;;
  password) svc_password "$@" ;;
  *)
    printf "私人云盘服务管理\n\n"
    printf "用法: bash manage.sh <命令>\n\n"
    printf "  start                 启动服务\n"
    printf "  stop                  停止服务\n"
    printf "  restart               重启服务\n"
    printf "  status                查看状态\n"
    printf "  password [-p 新密码]  重置登录密码（只保存哈希）\n"
    [ "${1:-}" != "" ] && { err "未知命令: $1"; exit 1; }
    ;;
esac
