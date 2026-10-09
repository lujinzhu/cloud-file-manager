#!/usr/bin/env bash
# ============================================================
# 私人云盘 — 一键卸载脚本
#
# 功能：
#   1. 停止并移除 systemd 服务 / 后台进程
#   2. 列出所有与本项目的相关文件，经用户确认后删除
#      （只删本项目相关内容，绝不碰目录里的其他文件）
#   3. 文件数据目录（cloud-files，里面是你的文件）默认保留，
#      询问后可选择一并删除
#
# 用法：
#   bash scripts/uninstall.sh
#
# 退出码（供 menu.sh 判断）：
#   0 = 卸载成功（脚本文件已被删除，菜单必须一并退出）
#   2 = 用户取消，未删任何文件（可返回菜单）
#   3 = 卸载完成但有条目删除失败（菜单同样退出）
# ============================================================
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_DIR/.env"
PID_FILE="$PROJECT_DIR/run/cfm.pid"
SYSTEMD_UNIT=/etc/systemd/system/cloudfile.service

C_G="\033[32m"; C_Y="\033[33m"; C_R="\033[31m"; C_B="\033[36m"; C_0="\033[0m"
info() { printf "${C_B}[INFO]${C_0} %s\n" "$*"; }
ok()   { printf "${C_G}[ OK ]${C_0} %s\n" "$*"; }
warn() { printf "${C_Y}[WARN]${C_0} %s\n" "$*"; }
err()  { printf "${C_R}[FAIL]${C_0} %s\n" "$*"; }

# 从 .env 读某个 KEY 的值
env_val() { grep "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- ; }

DATA_ROOT="$(env_val CFM_ROOT)"
[ -z "$DATA_ROOT" ] && DATA_ROOT="$PROJECT_DIR/cloud-files"
# 转成绝对路径再做比较
DATA_ROOT="$(cd "$(dirname "$DATA_ROOT")" 2>/dev/null && pwd)/$(basename "$DATA_ROOT")"

# ---------------- 1. 停服务 ----------------
info "正在停止服务…"
if [ -f "$SYSTEMD_UNIT" ] && grep -q "WorkingDirectory=$PROJECT_DIR" "$SYSTEMD_UNIT" 2>/dev/null; then
  systemctl stop cloudfile 2>/dev/null
  systemctl disable cloudfile 2>/dev/null
  ok "已停止并禁用 systemd 服务 cloudfile"
elif [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  kill "$(cat "$PID_FILE")" 2>/dev/null && ok "已停止后台进程（PID $(cat "$PID_FILE")）"
else
  info "服务未在运行"
fi

# ---------------- 2. 收集将删除的文件 ----------------
declare -a DELETE_LIST=()   # 项目目录内的待删条目（排除数据目录本身）

printf "\n${C_B}———— 将删除的文件 / 目录（完整路径） ————${C_0}\n"
# 统一打印：第 1 列完整路径（超长自动截断），第 2 列大小/说明
line() {
  local p="$1" note="$2"
  if [ "${#p}" -gt 62 ]; then
    printf "  %s…  %s\n" "${p:0:61}" "$note"
  else
    printf "  %-62s %s\n" "$p" "$note"
  fi
}

# 2.1 systemd unit（仅当指向本项目时才删）
if [ -f "$SYSTEMD_UNIT" ]; then
  if grep -q "WorkingDirectory=$PROJECT_DIR" "$SYSTEMD_UNIT" 2>/dev/null; then
    line "/etc/systemd/system/cloudfile.service" "(systemd 服务配置)"
    DELETE_UNIT=1
  else
    warn "systemd 服务存在但指向别的目录，不会动它"
    DELETE_UNIT=0
  fi
else
  DELETE_UNIT=0
fi

# 2.2 项目目录内的条目（排除数据目录、排除与本任务无关内容）
if [ -d "$PROJECT_DIR" ]; then
  for p in "$PROJECT_DIR"/* "$PROJECT_DIR"/.[!.]* "$PROJECT_DIR"/..?*; do
    [ -e "$p" ] || continue
    real="$(cd "$(dirname "$p")" 2>/dev/null && pwd)/$(basename "$p")"
    [ "$real" = "$DATA_ROOT" ] && continue    # 数据目录单独处理
    size=$(du -sh "$p" 2>/dev/null | cut -f1)
    [ -z "$size" ] && size="?"
    line "$p" "(${size})"
    DELETE_LIST+=("$p")
  done
fi

# 汇总计数（避免 printf 收到空参数报错“无效数字”）
EXTRA_NOTE=""
[ "$DELETE_UNIT" = "1" ] && EXTRA_NOTE=" + systemd 服务配置"
printf "\n共 %d 个项目相关条目%s\n" "${#DELETE_LIST[@]}" "$EXTRA_NOTE"

# ---------------- 3. 数据目录去留 ----------------
printf "\n"
if [ -d "$DATA_ROOT" ]; then
  dsize=$(du -sh "$DATA_ROOT" 2>/dev/null | cut -f1)
  warn "文件数据目录：$DATA_ROOT（$dsize）"
  warn "里面是你上传的所有文件，默认【保留】，不会被删除。"
  printf "是否连数据一起删除？输入 %bdelete%b 删除，直接回车=保留: " "${C_R}" "${C_0}"
  ans=""
  if [ -e /dev/tty ]; then read -r ans < /dev/tty 2>/dev/null || ans=""; else read -r ans 2>/dev/null || ans=""; fi
  if [ "$ans" = "delete" ]; then
    DELETE_DATA=1
    err "数据目录已列入删除清单：$DATA_ROOT"
  else
    DELETE_DATA=0
    ok "数据目录将保留：$DATA_ROOT"
  fi
else
  DELETE_DATA=0
  info "未找到数据目录 $DATA_ROOT（可能已删除）"
fi

# ---------------- 4. 最终确认 ----------------
printf "\n${C_R}⚠️  以上清单中的文件将被永久删除（不进回收站），此操作不可恢复！${C_0}\n"
printf "确认卸载？输入 %byes%b 执行，其他任意内容取消: " "${C_R}" "${C_0}"
ans=""
if [ -e /dev/tty ]; then read -r ans < /dev/tty 2>/dev/null || ans=""; else read -r ans 2>/dev/null || ans=""; fi
if [ "$ans" != "yes" ]; then
  info "已取消，未删除任何文件。"
  exit 2
fi

# ---------------- 5. 执行删除 ----------------
printf "\n"
if [ "$DELETE_UNIT" = "1" ]; then
  rm -f "$SYSTEMD_UNIT" && systemctl daemon-reload 2>/dev/null
  ok "已删除 systemd 服务配置"
fi

FAIL=0
for p in "${DELETE_LIST[@]}"; do
  if rm -rf -- "$p" 2>/dev/null; then
    ok "已删除 $p"
  else
    err "删除失败：$p"; FAIL=1
  fi
done

if [ "$DELETE_DATA" = "1" ]; then
  rm -rf -- "$DATA_ROOT" 2>/dev/null && ok "已删除数据目录 $DATA_ROOT" || { err "数据目录删除失败"; FAIL=1; }
fi

# 项目目录若已空则一并移除（非空则保留剩余文件）
if [ -d "$PROJECT_DIR" ] && [ -z "$(ls -A "$PROJECT_DIR" 2>/dev/null)" ]; then
  rmdir "$PROJECT_DIR" 2>/dev/null && ok "已移除空的项目目录 $PROJECT_DIR"
fi

if [ "$FAIL" = "0" ]; then
  printf "\n${C_G}卸载完成，私人云盘已从本机清理干净。${C_0}\n"
  printf "${C_Y}管理脚本已随项目一并删除，若当前正从菜单运行，请直接退出，不要再选择其他菜单项。${C_0}\n"
  exit 0
else
  printf "\n${C_Y}卸载完成，但部分条目删除失败（多为权限不足），请用 sudo 重试。${C_0}\n"
  printf "${C_Y}管理脚本已随项目一并删除，若当前正从菜单运行，请直接退出，不要再选择其他菜单项。${C_0}\n"
  exit 3
fi
