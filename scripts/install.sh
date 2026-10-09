#!/usr/bin/env bash
# ============================================================
# 私人云盘 (cloud-file-manager) — 一键安装/初始化脚本
#
# 一行部署（先在服务器上创建并进入一个空目录，再执行）：
#   mkdir -p /home/xxx/cloud && chmod 777 /home/xxx/cloud && cd /home/xxx/cloud
#   curl -fsSL https://raw.githubusercontent.com/lujinzhu/cloud-file-manager/main/scripts/install.sh | bash
#
# 交互输入通过 /dev/tty 读取，因此 curl | bash 也能正常提问。
# 会做以下事情：
#   1. 检测 python3（缺失时询问是否安装，拒绝则退出）
#   2. 检测 pip3 / Flask（安装前询问）
#   3. 下载源码到【当前目录】（项目所有文件都放在这里，便于统一管理与一键卸载）
#   4. 生成 .env（密码仅保存 PBKDF2 哈希；可设置云盘容量占本地磁盘的百分比，默认 80%）
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
# 安装目录固定为【当前目录】：保证项目所有文件都在用户创建的这个文件夹下
INSTALL_DIR="$(pwd)"
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

quota_by_pct() { # $1=占磁盘总容量的百分比(1-90)，向下取整（>=1TB 按整 TB，>=1GB 按整 GB，否则按整 100MB）
  python3 - "$PROJECT_DIR" "$1" <<'PYEOF'
import sys, shutil
t = shutil.disk_usage(sys.argv[1]).total
pct = min(90, max(1, int(sys.argv[2] or 80)))
q = int(t * pct / 100)
TB, GB, MB = 1024 ** 4, 1024 ** 3, 1024 ** 2
if q >= TB:   print(int(q // TB) * TB)
elif q >= GB: print(int(q // GB) * GB)
else:         print(int(q // (100 * MB)) * 100 * MB)
PYEOF
}

human_bytes() { # $1=字节数 → 人类可读
  python3 -c "
n = int('$1')
tb, gb = 1024**4, 1024**3
print(f'{n/tb:.1f} TB' if n >= tb else f'{n/gb:.1f} GB' if n >= gb else f'{n} 字节')
" 2>/dev/null || echo "$1 字节"
}

upsert_env() { # $1=KEY $2=VALUE  （在 $ENV_FILE 中更新或追加）
  local key="$1" val="$2" f="$ENV_FILE"
  if [ -f "$f" ] && grep -q "^${key}=" "$f" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$f"
  else
    printf '%s=%s\n' "$key" "$val" >> "$f"
  fi
}

# 自动探测公网 IP（国内源优先，单个超时 3 秒；全部失败退回网卡 IP / 占位符）
PUBLIC_IP=""
detect_public_ip() {
  local raw="" urls="https://myip.ipip.net http://cip.cc https://api.ipify.org https://ifconfig.me" u
  if command -v curl >/dev/null 2>&1; then
    for u in $urls; do
      raw=$(curl -s -4 -m 3 "$u" 2>/dev/null | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -1)
      [ -n "$raw" ] && { PUBLIC_IP="$raw"; return 0; }
    done
  fi
  if command -v wget >/dev/null 2>&1; then
    for u in $urls; do
      raw=$(wget -q -T 3 -O - "$u" 2>/dev/null | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -1)
      [ -n "$raw" ] && { PUBLIC_IP="$raw"; return 0; }
    done
  fi
  raw=$(ip -4 addr show scope global 2>/dev/null | awk '/inet /{print $2; exit}' | cut -d/ -f1)
  [ -z "$raw" ] && raw=$(hostname -I 2>/dev/null | awk '{print $1}')
  if [ -n "$raw" ]; then PUBLIC_IP="$raw"; return 1; fi
  PUBLIC_IP="服务器IP"
  return 1
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
  info "源码将下载到当前目录：$INSTALL_DIR"
  if [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
    warn "当前目录不是空目录，下载的文件会与现有内容混在一起"
  fi
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
  # 4.1 共享根目录：固定放在项目目录下，保证所有相关文件都在用户创建的这个文件夹里
  CFM_ROOT_VAL="$PROJECT_DIR/cloud-files"
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

  # 4.5 云盘总容量：询问占本地磁盘总容量的百分比，回车默认 80%
  DISK_TOTAL=$(python3 -c "import shutil;print(shutil.disk_usage('$PROJECT_DIR').total)" 2>/dev/null || echo 0)
  info "本地磁盘总容量：$(human_bytes "$DISK_TOTAL")"
  QUOTA_PCT=$(ask "云盘容量占本地磁盘的百分比（1-90，回车=默认 80）: " "80")
  case "$QUOTA_PCT" in
    ''|*[!0-9]*) QUOTA_PCT=80 ;;
  esac
  if [ "$QUOTA_PCT" -lt 1 ] || [ "$QUOTA_PCT" -gt 90 ] 2>/dev/null; then
    warn "百分比需在 1-90 之间，已回退为默认 80%"
    QUOTA_PCT=80
  fi
  QUOTA_VAL=$(quota_by_pct "$QUOTA_PCT")
  ok "云盘总容量设为磁盘的 ${QUOTA_PCT}%：$(human_bytes "$QUOTA_VAL")"

  # 写 .env
  cat > "$ENV_FILE" <<EOF
# 私人云盘配置（由 install.sh 生成）
# 密码只保存 PBKDF2 哈希，不保存明文；重置密码请用 scripts/manage.sh password
CFM_ROOT=$CFM_ROOT_VAL
CFM_PASSWORD_HASH=$PW_HASH
CFM_PASSWORD_SALT=$PW_SALT
# 初始密码哈希：登录时用它判断「是否还在用初始密码」，相同才强制修改
CFM_INITIAL_PASSWORD_HASH=$PW_HASH
CFM_INITIAL_PASSWORD_SALT=$PW_SALT
CFM_HOST=0.0.0.0
CFM_PORT=$CFM_PORT_INPUT
CFM_SECRET=$CFM_SECRET_VAL
CFM_CHUNK_SIZE=1048576
CFM_UPLOAD_TTL=86400
CFM_QUOTA=$QUOTA_VAL
EOF
  chmod 600 "$ENV_FILE"

  # 4.6 展示环境变量（密码明文只在本次展示一次）
  printf "\n${C_G}———— 环境变量已写入 $ENV_FILE ————${C_0}\n"
  printf "  ${C_B}CFM_ROOT${C_0}            = %s\n" "$CFM_ROOT_VAL"
  printf "  ${C_B}CFM_PASSWORD${C_0}        = %s   ${C_Y}← 请立即记下，仅展示这一次${C_0}\n" "$CFM_PW_INPUT"
  printf "  ${C_B}CFM_PASSWORD_HASH${C_0}   = %s…（PBKDF2 哈希）\n" "$(echo "$PW_HASH" | head -c 24)"
  printf "  ${C_B}CFM_PASSWORD_SALT${C_0}   = %s…\n" "$(echo "$PW_SALT" | head -c 16)"
  printf "  ${C_B}CFM_INITIAL_PASSWORD_HASH${C_0} = 与当前初始密码一致（用于判断是否强制修改）\n"
  printf "  ${C_B}CFM_HOST${C_0}            = 0.0.0.0\n"
  printf "  ${C_B}CFM_PORT${C_0}            = %s\n" "$CFM_PORT_INPUT"
  printf "  ${C_B}CFM_SECRET${C_0}          = %s…（随机生成）\n" "$(echo "$CFM_SECRET_VAL" | head -c 24)"
  printf "  ${C_B}CFM_CHUNK_SIZE${C_0}      = 1048576 (1MB)\n"
  printf "  ${C_B}CFM_UPLOAD_TTL${C_0}      = 86400 (24小时)\n"
  printf "  ${C_B}CFM_QUOTA${C_0}           = %s（云盘总容量 = 磁盘的 %s%%，字节）\n" "$QUOTA_VAL" "$QUOTA_PCT"
fi

# 老部署升级：补写 CFM_QUOTA（保留现有配置时）
if [ -f "$ENV_FILE" ] && ! grep -q '^CFM_QUOTA=' "$ENV_FILE" 2>/dev/null; then
  upsert_env "CFM_QUOTA" "$(quota_by_pct 80)"
  info "已为现有配置补充默认云盘容量（CFM_QUOTA，磁盘的 80%）"
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

# ---------------- 5.5 nginx 子路径反代（可选，改变系统先询问） ----------------
# 配置后可用 http://公网IP/yunpan 访问，无需带端口号
NGINX_CONF=/etc/nginx/conf.d/yunpan.conf
NGINX_DONE=0
setup_nginx() {
  # 0) conf.d 目录可能不存在（部分发行版/自编译 nginx），先确保目录在
  local conf_dir
  conf_dir=$(dirname "$NGINX_CONF")
  if [ ! -d "$conf_dir" ]; then
    mkdir -p "$conf_dir" || { err "无法创建 $conf_dir（权限不足？），跳过 nginx 配置"; return 1; }
    info "已创建缺失目录 $conf_dir"
  fi
  # 1) Debian/Ubuntu：移除会抢占 80 端口的默认站点；CentOS：去掉 nginx.conf 内置站点的 default_server
  rm -f /etc/nginx/sites-enabled/default 2>/dev/null
  if grep -rq "default_server" /etc/nginx/nginx.conf 2>/dev/null; then
    cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.bak-cfm 2>/dev/null
    sed -i 's/listen 80 default_server/listen 80/; s/listen \[::\]:80 default_server/listen [::]:80/' /etc/nginx/nginx.conf
  fi
  # 2) 写子路径反代配置（写失败立即报错退出，不再继续自检）
  if ! cat > "$NGINX_CONF" <<'EOF'
# 私人云盘：/yunpan 反代到本机 8000 端口
server {
    listen 80;
    server_name _;

    location = /yunpan { return 301 /yunpan/; }

    location /yunpan/ {
        proxy_pass http://127.0.0.1:8000/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        client_max_body_size 0;
        proxy_request_buffering off;
    }

    # 分享链接：/s/<token> 免登录下载（同样透传给后端）
    location /s/ {
        proxy_pass http://127.0.0.1:8000/s/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_request_buffering off;
    }
}
EOF
  then
    err "写入 $NGINX_CONF 失败（权限不足？请用 root 执行），跳过 nginx 配置"
    return 1
  fi
  # 3) 有些 nginx.conf 默认不加载 conf.d，缺少 include 时自动注入到 http 块
  if ! grep -Eq 'include[[:space:]].*conf\.d/\*\.conf' /etc/nginx/nginx.conf 2>/dev/null; then
    cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.bak-cfm 2>/dev/null
    sed -i 's|^\([[:space:]]*http[[:space:]]*{\)|\1\n    include /etc/nginx/conf.d/*.conf;|' /etc/nginx/nginx.conf
    info "nginx.conf 未加载 conf.d，已自动注入 include（原文件备份为 nginx.conf.bak-cfm）"
  fi
  # 4) 校验并重载
  if nginx -t >/dev/null 2>&1; then
    systemctl enable --now nginx >/dev/null 2>&1 || service nginx start >/dev/null 2>&1
    systemctl reload nginx >/dev/null 2>&1 || nginx -s reload >/dev/null 2>&1
    sleep 1
    NGINX_DONE=1
    if command -v curl >/dev/null 2>&1 && [ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1/yunpan/)" = "200" ]; then
      ok "nginx 子路径配置完成：http://$PUBLIC_IP/yunpan"
    else
      warn "nginx 配置已生效，但本机自检未通过。可能原因："
      warn "  1) 80 端口被其他站点占用（ss -tlnp | grep ':80 ' 查看）"
      warn "  2) nginx.conf 未加载 conf.d（手动在 http 块加: include /etc/nginx/conf.d/*.conf;）"
      warn "  3) 云服务器安全组未放行 80 端口"
    fi
  else
    err "nginx 配置校验失败（nginx -t），已保留原配置；可检查 $NGINX_CONF 后执行: nginx -s reload"
    rm -f "$NGINX_CONF"
  fi
}

printf "\n"
info "正在探测公网 IP…"
if detect_public_ip; then
  ok "公网 IP：$PUBLIC_IP"
else
  warn "公网 IP 探测失败，下面地址中的 IP 请自行替换（可能显示的是内网 IP）"
fi

if [ -f "$NGINX_CONF" ]; then
  ok "检测到已有 nginx 子路径配置 /yunpan"
  if confirm "是否重新生成该配置？"; then
    if command -v nginx >/dev/null 2>&1; then setup_nginx
    else err "nginx 未安装，请先安装 nginx"; fi
  else
    NGINX_DONE=1
  fi
elif command -v nginx >/dev/null 2>&1; then
  if confirm "是否配置 nginx 子路径访问（http://$PUBLIC_IP/yunpan，免端口号）？"; then
    setup_nginx
  fi
else
  if confirm "未检测到 nginx。是否安装 nginx 并配置 http://$PUBLIC_IP/yunpan 访问？（改变系统）"; then
    pkg_install nginx || { err "nginx 安装失败，跳过子路径配置"; }
    command -v nginx >/dev/null 2>&1 && setup_nginx
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
  printf   "  访问地址： ${C_B}http://%s:%s${C_0}\n" "$PUBLIC_IP" "$PORT_NOW"
  if [ "$NGINX_DONE" = "1" ]; then
    printf   "  （免端口） ${C_B}http://%s/yunpan${C_0}\n" "$PUBLIC_IP"
  fi
  if [ -n "${CFM_PW_INPUT:-}" ]; then
    printf   "  初始密码： ${C_Y}%s${C_0}   ${C_Y}← 请立即记下，仅展示这一次；首次登录会强制修改${C_0}\n" "$CFM_PW_INPUT"
  else
    printf   "  登录密码： 沿用已有配置（不展示）。忘记密码可执行：\n"
    printf   "             bash %s/scripts/manage.sh password\n" "$PROJECT_DIR"
  fi
  printf   "  管理脚本： bash %s/scripts/menu.sh\n" "$PROJECT_DIR"
  printf   "  项目目录： %s\n" "$PROJECT_DIR"
  printf "${C_G}==============================================${C_0}\n"
  if [ "$NGINX_DONE" = "1" ]; then
    printf   "  ${C_Y}别忘了在云厂商安全组放行端口 %s 和 80${C_0}\n\n" "$PORT_NOW"
  else
    printf   "  ${C_Y}别忘了在云厂商安全组放行端口 %s${C_0}\n\n" "$PORT_NOW"
  fi
else
  info "稍后可用 bash $PROJECT_DIR/scripts/menu.sh 启动"
  if [ -n "${CFM_PW_INPUT:-}" ]; then
    info "本次生成的初始密码：$CFM_PW_INPUT（仅展示这一次，请记下）"
  fi
fi
