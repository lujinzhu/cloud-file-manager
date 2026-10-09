#!/usr/bin/env bash
# ============================================================
# 私人云盘 — 更新脚本
#   bash scripts/update.sh           交互式：检查版本并询问是否更新
#   bash scripts/update.sh --yes     非交互：有新版本直接更新（网页端「一键更新」调用）
#   bash scripts/update.sh --check   只检查版本，不更新
#
# 更新时保留 .env（密码/配置）、.shares.json（分享记录）、logs/ 与云盘数据目录，
# 更新完成后自动重启服务。
# ============================================================
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO="lujinzhu/cloud-file-manager"
BRANCH="main"

YES=0
CHECK=0
for a in "$@"; do
  case "$a" in
    --yes|-y)   YES=1 ;;
    --check|-c) CHECK=1 ;;
    -h|--help)
      printf "用法: bash scripts/update.sh [--yes|--check]\n"; exit 0 ;;
  esac
done

C_G="\033[32m"; C_Y="\033[33m"; C_B="\033[36m"; C_R="\033[31m"; C_0="\033[0m"
ok()   { printf "${C_G}✔${C_0} %s\n" "$1"; }
info() { printf "${C_B}ℹ${C_0} %s\n" "$1"; }
warn() { printf "${C_Y}!${C_0} %s\n" "$1"; }
err()  { printf "${C_R}✘${C_0} %s\n" "$1"; }

# 更新源：主站不通时自动换镜像（国内服务器常拉不到 raw.githubusercontent.com）
RAW_SOURCES=(
  "https://raw.githubusercontent.com/$REPO/$BRANCH/"
  "https://ghfast.top/https://raw.githubusercontent.com/$REPO/$BRANCH/"
  "https://raw.fastgit.org/$REPO/$BRANCH/"
)
PKG_SOURCES=(
  "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH"
  "https://ghfast.top/https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH"
)

confirm() { # $1=提示语；--yes 或无终端时默认同意
  local a
  [ "$YES" = "1" ] && return 0
  if [ ! -e /dev/tty ]; then return 0; fi
  printf "%s [y/N]: " "$1" > /dev/tty
  read -r a < /dev/tty 2>/dev/null || a="n"
  case "$a" in y|Y|yes|YES|Yes) return 0 ;; *) return 1 ;; esac
}

# 取远端文本文件（VERSION / CHANGELOG.md）
fetch_text() {
  local f="$1" s out
  for s in "${RAW_SOURCES[@]}"; do
    if command -v curl >/dev/null 2>&1; then
      out=$(curl -fsSL -m 15 "$s$f" 2>/dev/null)
      if [ -n "$out" ]; then printf '%s' "$out"; return 0; fi
    elif command -v wget >/dev/null 2>&1; then
      out=$(wget -qO- -T 15 "$s$f" 2>/dev/null)
      if [ -n "$out" ]; then printf '%s' "$out"; return 0; fi
    fi
  done
  return 1
}

# 下载整包
download_pkg() {
  local dest="$1" s
  for s in "${PKG_SOURCES[@]}"; do
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL -m 180 -o "$dest" "$s" 2>/dev/null && [ -s "$dest" ] && return 0
    elif command -v wget >/dev/null 2>&1; then
      wget -q -T 180 -O "$dest" "$s" 2>/dev/null && [ -s "$dest" ] && return 0
    fi
  done
  return 1
}

# 版本比较：ver_gt A B → A > B
ver_gt() {
  local IFS=.
  local i x y
  # shellcheck disable=SC2206
  local a=($1) b=($2)
  for i in 0 1 2 3; do
    x=${a[$i]:-0}; y=${b[$i]:-0}
    case "$x" in ''|*[!0-9]*) x=0 ;; esac
    case "$y" in ''|*[!0-9]*) y=0 ;; esac
    if [ "$x" -gt "$y" ]; then return 0; fi
    if [ "$x" -lt "$y" ]; then return 1; fi
  done
  return 1
}

read_local_version() {
  if [ -f "$PROJECT_DIR/VERSION" ]; then
    head -n 1 "$PROJECT_DIR/VERSION" | tr -d '\r' | tr -d ' '
  else
    echo "0.0.0"
  fi
}

printf "\n${C_B}==============================================${C_0}\n"
printf   "${C_B}            私人云盘 更新检查${C_0}\n"
printf   "${C_B}==============================================${C_0}\n"

LOCAL_VER=$(read_local_version)
info "当前版本：$LOCAL_VER"
info "正在查询最新版本…"

REMOTE_VER=$(fetch_text VERSION 2>/dev/null | head -n 1 | tr -d '\r' | tr -d ' ')
if [ -z "$REMOTE_VER" ]; then
  err "获取最新版本失败：所有更新源都连不上（服务器需要能访问 GitHub 或镜像站）"
  exit 1
fi
info "最新版本：$REMOTE_VER"

if ! ver_gt "$REMOTE_VER" "$LOCAL_VER"; then
  ok "已是最新版本（$LOCAL_VER），无需更新"
  exit 0
fi

printf "\n${C_Y}发现新版本：%s → %s${C_0}\n" "$LOCAL_VER" "$REMOTE_VER"
CHANGE_TXT=$(fetch_text CHANGELOG.md 2>/dev/null)
if [ -n "$CHANGE_TXT" ]; then
  # 只打印新版本那一段（## vX.Y.Z 到下一个 ## 之间）
  printf "%s\n" "$CHANGE_TXT" | awk -v v="$REMOTE_VER" '
    /^## / {
      t=$0; sub(/^##[ \t]*/, "", t); sub(/^v/, "", t);
      want=v; sub(/^v/, "", want);
      if (inblk) exit;
      if (t == want || index(t, want) == 1) { inblk=1; print; }
      next
    }
    inblk { print }
  '
fi
printf "\n"

if [ "$CHECK" = "1" ]; then
  info "（--check 模式，不执行更新）"
  exit 0
fi

if ! confirm "是否更新到 $REMOTE_VER？（会保留 .env / 分享记录 / 云盘数据，更新后自动重启服务）"; then
  info "已取消更新"
  exit 2
fi

# ---------- 备份（用于失败回滚） ----------
BAK=$(mktemp -d /tmp/cfm-backup.XXXXXX 2>/dev/null) || BAK=""
if [ -n "$BAK" ]; then
  cp -a "$PROJECT_DIR/server.py" "$BAK/" 2>/dev/null
  cp -a "$PROJECT_DIR/static" "$BAK/" 2>/dev/null
  cp -a "$PROJECT_DIR/scripts" "$BAK/" 2>/dev/null
  cp -a "$PROJECT_DIR/VERSION" "$BAK/" 2>/dev/null
fi

rollback() {
  err "$1"
  if [ -n "$BAK" ] && [ -f "$BAK/server.py" ]; then
    cp -a "$BAK/server.py" "$PROJECT_DIR/" 2>/dev/null
    cp -a "$BAK/static" "$PROJECT_DIR/" 2>/dev/null
    cp -a "$BAK/scripts" "$PROJECT_DIR/" 2>/dev/null
    cp -a "$BAK/VERSION" "$PROJECT_DIR/" 2>/dev/null
    warn "已回滚到更新前的版本 $LOCAL_VER"
  fi
  exit 1
}

# ---------- 下载 ----------
TMP=$(mktemp -d /tmp/cfm-update.XXXXXX) || { err "创建临时目录失败"; exit 1; }
PKG="$TMP/pkg.tar.gz"
info "正在下载 $REMOTE_VER 的安装包…"
if ! download_pkg "$PKG"; then
  rm -rf "$TMP"
  err "下载失败：所有更新源都不可用"
  exit 1
fi
ok "下载完成（$(du -h "$PKG" 2>/dev/null | cut -f1)）"

if ! tar -xzf "$PKG" -C "$TMP" 2>/dev/null; then
  rm -rf "$TMP"; rollback "解压失败，安装包可能已损坏"
fi

SRC="$TMP/cloud-file-manager-$BRANCH"
if [ ! -d "$SRC" ]; then
  SRC=$(find "$TMP" -maxdepth 1 -mindepth 1 -type d ! -name ".*" | head -n 1)
fi
if [ ! -d "$SRC" ] || [ ! -f "$SRC/server.py" ]; then
  rm -rf "$TMP"; rollback "安装包结构异常（未找到 server.py）"
fi

# ---------- 覆盖（排除运行时数据与配置） ----------
EXCLUDE=".env .shares.json logs __pycache__ .git cloud-files run"
info "正在覆盖项目文件…"
for f in $(cd "$SRC" && ls -A 2>/dev/null); do
  skip=0
  for e in $EXCLUDE; do
    [ "$f" = "$e" ] && skip=1
  done
  [ "$skip" = "1" ] && continue
  rm -rf "$PROJECT_DIR/$f" 2>/dev/null
  cp -a "$SRC/$f" "$PROJECT_DIR/" 2>/dev/null || rollback "复制 $f 失败（磁盘空间不足？权限不足？）"
done
ok "文件已更新"

# ---------- 换行符清洗 + 权限 + 语法检查 ----------
for f in "$PROJECT_DIR"/scripts/*.sh; do
  [ -f "$f" ] || continue
  tr -d '\r' < "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  chmod +x "$f"
done
[ -f "$PROJECT_DIR/server.py" ] && chmod +x "$PROJECT_DIR/server.py"
for f in "$PROJECT_DIR"/scripts/*.sh; do
  [ -f "$f" ] || continue
  bash -n "$f" || rollback "脚本语法检查失败：$f"
done
rm -rf "$TMP"

NEW_VER=$(read_local_version)
if [ "$NEW_VER" != "$REMOTE_VER" ]; then
  warn "版本文件显示 $NEW_VER，与目标 $REMOTE_VER 不一致（不影响使用）"
fi

# ---------- 重启服务 ----------
info "正在重启服务…"
if systemctl list-unit-files 2>/dev/null | grep -q '^cloudfile\.service'; then
  systemctl restart cloudfile >/dev/null 2>&1 && ok "服务已重启（systemd: cloudfile）" || warn "systemctl restart 失败，请手动执行：systemctl restart cloudfile"
elif [ -f "$PROJECT_DIR/scripts/manage.sh" ]; then
  bash "$PROJECT_DIR/scripts/manage.sh" restart >/dev/null 2>&1 && ok "服务已重启" || warn "重启失败，请手动执行：bash $PROJECT_DIR/scripts/manage.sh restart"
else
  warn "未找到服务管理方式，请手动重启云盘服务"
fi

printf "\n${C_G}==============================================${C_0}\n"
printf   "${C_G}  更新完成：%s → %s${C_0}\n" "$LOCAL_VER" "$NEW_VER"
printf   "  项目目录： %s\n" "$PROJECT_DIR"
printf   "${C_G}==============================================${C_0}\n\n"
exit 0
