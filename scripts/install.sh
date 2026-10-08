#!/usr/bin/env bash
# ============================================================
# 私人云盘 (cloud-file-manager) — 一键安装/初始化脚本
#
# 一行部署（任意 Linux 云服务器执行）：
#   curl -fsSL https://raw.githubusercontent.com/lujinzhu/cloud-file-manager/main/scripts/install.sh | bash
#
# 交互输入通过 /dev/tty 读取，因此 curl | bash 也能正常提问。
# 会做以下事情：
#   1. 检测 python3（缺失时询问是否安装，拒绝则退出）
#   2. 检测 pip3 / Flask（安装前询问）
#   3. 下载源码（若当前不在项目目录）
#   4. 生成 .env（密码仅保存 PBKDF2 哈希；未设置的项用默认值）
#   5. 可选安装 systemd 常驻服务（改动系统，先询问）
# ============================================================
set -u

REPO="https://github.com/lujinzhu/cloud-file-manager"
# 源码下载源：直连优先，失败自动切换镜像（大陆服务器直连 GitHub 常不稳定）
TARBALLS=(
  "$REPO/archive/refs/heads/main.tar.gz"
  "https://mirror.ghproxy.com/$REPO/archive/refs/heads/main.tar.gz"
  "https://ghfast.top/$REPO/archive/refs/heads/main.tar.gz"
  "https://gh-proxy.com/$REPO/archive/refs/heads/main.tar.gz"
)
INSTALL_DIR="${CFM_INSTALL_DIR:-$HOME/cloud-file-manager}"
ITER=60000

C_G="\033[32m"; C_Y="\033[33m"; C_R="\033[31m"; C_B="\033[36m"; C_0="\033[0m"
info()  { printf "${C_B}[INFO]${C_0} %s\n" "$*"; }
ok()    { printf "${C_G}[ OK ]${C_0} %s\n" "$*"; }
warn()  { printf "${C_Y}[WARN]${C_0} %s\n" "$*"; }
err()   { printf "${C_R}[FAIL]${C_0} %s\n" "$*"; }

# ---- 交互：优先终端 /dev/tty（兼容 curl|bash），无 tty 时静默用默认值 ----
ask() { # $1=提示语  $2=默认值；结果输出到 stdout
  local prompt="$1" def="${2:-}" ans=""
  {
    if [ -t 0 ]; then
      printf "%s" "$prompt"
      read -r ans || ans=""
    elif [ -c /dev/tty ]; then
      printf "%s" "$prompt" > /dev/tty
      read -r ans < /dev/tty || ans=""
    else
      read -r ans || ans=""
    fi
  } 2>/dev/null
  printf "%s" "${ans:-$def}"
}

confirm() { # $1=提示语  返回 0=同意
  local a
  a=$(ask "$1 [y/N]: " "n")
  case "$a" in y|Y|yes|YES|Yes) return 0 ;; *) return 1 ;; esac
}

pkg_install() { # $@=包名
  if command -v yum >/dev/null 2>&1; then yum install -y "$@" >/dev/null 2>&1
  elif command -v dnf >/dev/null 2>&1; then dnf install -y "$@" >/dev/null 2>&1
  elif command -v apt-get >/dev/null 2>&1; then apt-get update -qq >/dev/null 2>&1; apt-get install -y "$@" >/dev/null 2>&1
  else return 1; fi
}

py_version() { python3 -c 'import sys;print("%d%03d"%sys.version_info[:2])' 2>/dev/null || echo 0; }

hash_password() { # $1=明文密码 → 输出 "SALT HASH"
  python3 - "$1" "$ITER" <<'PYEOF'
import sys, hashlib, secrets
pw, it = sys.argv[1], int(sys.argv[2])
salt = secrets.token_hex(16)
print(salt, hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), bytes.fromhex(salt), it).hex())
PYEOF
}

upsert_env() { # $1=KEY $2=VALUE  （在 $ENV_FILE 中更新或追加）
  local key="$1" val="$2" f="$ENV_FILE"
  if [ -f "$f" ] && grep -q "^${key}=" "$f" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$f"
  else
    printf '%s=%s\n' "$key" "$val" >> "$f"
  fi
}

# ============================================================
printf "\n${C_G}==============================================${C_0}\n"
printf   "${C_G}        私人云盘 一键安装 / 初始化           ${C_0}\n"
printf   "${C_G}==============================================${C_0}\n\n"

# ---------------- 1. python3 ----------------
if command -v python3 >/dev/null 2>&1; then
  ok "python3 已安装：$(python3 --version 2>&1)"
else
  warn "未检测到 python3 环境"
  if confirm "是否现在安装 python3？（将使用系统包管理器，改变系统环境）"; then
    info "正在安装 python3 …"
    if pkg_install python3 python3-pip; then
      command -v python3 >/dev/null 2>&1 && ok "python3 安装成功" || { err "安装后仍找不到 python3，请手动安装后重试"; exit 1; }
    else
      err "python3 安装失败，退出初始化"; exit 1
    fi
  else
    err "你拒绝了安装 python3。私人云盘依赖 Python 环境，退出初始化。"
    exit 1
  fi
fi

# ---------------- 2. pip3 / Flask ----------------
PYVER=$(py_version)
if ! python3 -m pip --version >/dev/null 2>&1 && ! command -v pip3 >/dev/null 2>&1; then
  warn "未检测到 pip"
  if confirm "是否安装 pip？（python3-pip，改变系统环境）"; then
    pkg_install python3-pip || { err "pip 安装失败"; exit 1; }
  else
    warn "跳过 pip 安装（后续若 Flask 已存在也可运行）"
  fi
else
  ok "pip 已就绪"
fi

PIP="pip3"
python3 -m pip --version >/dev/null 2>&1 && PIP="python3 -m pip"

if python3 -c "import flask" >/dev/null 2>&1; then
  ok "Flask 已安装：$(python3 -c 'import flask;print(flask.__version__)')"
else
  warn "未检测到 Flask"
  if confirm "是否安装 Flask 依赖？（pip 安装到系统 Python，改变系统环境）"; then
    if [ "$PYVER" -lt 3007 ] 2>/dev/null; then
      info "Python 版本较旧($PYVER)，安装兼容锁版本 flask==2.0.3 …"
      $PIP install -i https://pypi.tuna.tsinghua.edu.cn/simple \
        "flask==2.0.3" "werkzeug==2.0.3" "jinja2==3.0.3" \
        "markupsafe==2.0.1" "itsdangerous==2.0.1" "click==8.0.4" >/dev/null 2>&1
    else
      $PIP install -q flask >/dev/null 2>&1
    fi
    python3 -c "import flask" >/dev/null 2>&1 && ok "Flask 安装成功" || { err "Flask 安装失败，请手动执行: $PIP install flask"; exit 1; }
  else
    err "你拒绝了安装 Flask（运行必需依赖），退出初始化。"
    exit 1
  fi
fi

# ---------------- 3. 源码 ----------------
if [ -f "./server.py" ] && [ -f "./scripts/manage.sh" ]; then
  PROJECT_DIR="$(pwd)"
  ok "检测到当前目录已是项目目录：$PROJECT_DIR"
else
  info "源码将下载到：$INSTALL_DIR"
  [ -d "$INSTALL_DIR" ] && warn "目录已存在，将覆盖更新"
  mkdir -p "$INSTALL_DIR"
  DL_OK=0
  for src in "${TARBALLS[@]}"; do
    info "尝试下载：$src"
    if curl -fsSL --connect-timeout 10 --max-time 120 "$src" | tar xz -C "$INSTALL_DIR" --strip-components=1 2>/dev/null; then
      DL_OK=1; break
    fi
    warn "该源下载失败，切换下一个…"
  done
  if [ "$DL_OK" != "1" ]; then
    err "所有下载源均失败。请手动克隆项目后再执行：git clone $REPO && cd cloud-file-manager && bash scripts/install.sh"
    exit 1
  fi
  PROJECT_DIR="$INSTALL_DIR"
  ok "源码就绪：$PROJECT_DIR"
fi
cd "$PROJECT_DIR" || exit 1
ENV_FILE="$PROJECT_DIR/.env"

# ---------------- 4. .env 配置 ----------------
printf "\n${C_B}———— 配置 ————${C_0}\n"
if [ -f "$ENV_FILE" ]; then
  if confirm "检测到已有 .env 配置。保留现有配置并跳过本步？"; then
    ok "保留现有配置"
    KEEP_ENV=1
  else
    KEEP_ENV=0
  fi
else
  KEEP_ENV=0
fi

if [ "${KEEP_ENV:-0}" != "1" ]; then
  # 4.1 共享根目录
  CFM_ROOT_INPUT=$(ask "文件根目录（存放你文件的文件夹，回车=默认 \$PROJECT_DIR/cloud-files）: " "")
  CFM_ROOT_VAL="${CFM_ROOT_INPUT:-$PROJECT_DIR/cloud-files}"
  mkdir -p "$CFM_ROOT_VAL"

  # 4.2 端口
  CFM_PORT_INPUT=$(ask "监听端口（回车=默认 8000）: " "8000")
  case "$CFM_PORT_INPUT" in ''|*[!0-9]*) CFM_PORT_INPUT=8000 ;; esac

  # 4.3 密码 → 只存哈希
  printf "登录密码（回车=自动生成随机强密码）："
  CFM_PW_INPUT=$(ask "" "")
  if [ -z "$CFM_PW_INPUT" ]; then
    CFM_PW_INPUT=$(head -c 16 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 12)
    printf "${C_B}[INFO]${C_0} 已生成随机密码\n" > /dev/tty 2>/dev/null || true
  fi
  HASH_OUT=$(hash_password "$CFM_PW_INPUT")
  PW_SALT=$(echo "$HASH_OUT" | awk '{print $1}')
  PW_HASH=$(echo "$HASH_OUT" | awk '{print $2}')

  # 4.4 会话密钥
  CFM_SECRET_VAL=$(python3 -c "import secrets;print(secrets.token_hex(32))")

  # 写 .env
  cat > "$ENV_FILE" <<EOF
# 私人云盘配置（由 install.sh 生成）
# 密码只保存 PBKDF2 哈希，不保存明文；重置密码请用 scripts/manage.sh password
CFM_ROOT=$CFM_ROOT_VAL
CFM_PASSWORD_HASH=$PW_HASH
CFM_PASSWORD_SALT=$PW_SALT
CFM_HOST=0.0.0.0
CFM_PORT=$CFM_PORT_INPUT
CFM_SECRET=$CFM_SECRET_VAL
CFM_CHUNK_SIZE=1048576
CFM_UPLOAD_TTL=86400
EOF
  chmod 600 "$ENV_FILE"

  # 4.5 展示环境变量（密码明文只在本次展示一次）
  printf "\n${C_G}———— 环境变量已写入 $ENV_FILE ————${C_0}\n"
  printf "  ${C_B}CFM_ROOT${C_0}            = %s\n" "$CFM_ROOT_VAL"
  printf "  ${C_B}CFM_PASSWORD${C_0}        = %s   ${C_Y}← 请立即记下，仅展示这一次${C_0}\n" "$CFM_PW_INPUT"
  printf "  ${C_B}CFM_PASSWORD_HASH${C_0}   = %s…（PBKDF2 哈希）\n" "$(echo "$PW_HASH" | head -c 24)"
  printf "  ${C_B}CFM_PASSWORD_SALT${C_0}   = %s…\n" "$(echo "$PW_SALT" | head -c 16)"
  printf "  ${C_B}CFM_HOST${C_0}            = 0.0.0.0\n"
  printf "  ${C_B}CFM_PORT${C_0}            = %s\n" "$CFM_PORT_INPUT"
  printf "  ${C_B}CFM_SECRET${C_0}          = %s…（随机生成）\n" "$(echo "$CFM_SECRET_VAL" | head -c 24)"
  printf "  ${C_B}CFM_CHUNK_SIZE${C_0}      = 1048576 (1MB)\n"
  printf "  ${C_B}CFM_UPLOAD_TTL${C_0}      = 86400 (24小时)\n"
fi

# ---------------- 5. systemd（可选，改系统先询问） ----------------
SYSTEMD_UNIT=/etc/systemd/system/cloudfile.service
if command -v systemctl >/dev/null 2>&1; then
  printf "\n"
  if [ -f "$SYSTEMD_UNIT" ]; then
    ok "检测到已有 systemd 服务 cloudfile"
    if confirm "是否更新其配置指向当前目录并重载？"; then
      cat > "$SYSTEMD_UNIT" <<EOF
[Unit]
Description=Cloud File Manager (私人云盘)
After=network.target

[Service]
WorkingDirectory=$PROJECT_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v python3) $PROJECT_DIR/server.py
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
      systemctl daemon-reload && ok "systemd 配置已更新"
    fi
  elif confirm "是否安装 systemd 常驻服务（开机自启；将写入 $SYSTEMD_UNIT，改变系统）？"; then
    cat > "$SYSTEMD_UNIT" <<EOF
[Unit]
Description=Cloud File Manager (私人云盘)
After=network.target

[Service]
WorkingDirectory=$PROJECT_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v python3) $PROJECT_DIR/server.py
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload && systemctl enable cloudfile >/dev/null 2>&1
    ok "systemd 服务已安装并设置开机自启"
  else
    warn "跳过 systemd，可稍后用 scripts/manage.sh start 直接前台/后台运行"
  fi
fi

# ---------------- 6. 启动 ----------------
printf "\n"
if confirm "是否立即启动服务？"; then
  bash "$PROJECT_DIR/scripts/manage.sh" restart || { err "启动失败，可查看日志 $PROJECT_DIR/logs/"; exit 1; }
  PORT_NOW=$(grep '^CFM_PORT=' "$ENV_FILE" | cut -d= -f2)
  PORT_NOW=${PORT_NOW:-8000}
  printf "\n${C_G}==============================================${C_0}\n"
  printf   "${C_G}  安装完成！${C_0}\n"
  printf   "  访问地址： ${C_B}http://服务器IP:%s${C_0}\n" "$PORT_NOW"
  printf   "  管理脚本： bash %s/scripts/menu.sh\n" "$PROJECT_DIR"
  printf   "  项目目录： %s\n" "$PROJECT_DIR"
  printf "${C_G}==============================================${C_0}\n"
  printf   "  ${C_Y}别忘了在云厂商安全组放行端口 %s${C_0}\n\n" "$PORT_NOW"
else
  info "稍后可用 bash $PROJECT_DIR/scripts/menu.sh 启动"
fi
