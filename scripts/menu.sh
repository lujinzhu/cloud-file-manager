#!/usr/bin/env bash
# ============================================================
# 私人云盘 — 功能菜单入口
#   bash menu.sh
# ============================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANAGE="$SCRIPT_DIR/manage.sh"
INSTALL="$SCRIPT_DIR/install.sh"

C_G="\033[32m"; C_Y="\033[33m"; C_B="\033[36m"; C_R="\033[31m"; C_0="\033[0m"

show_menu() {
  printf "\n${C_G}==============================================${C_0}\n"
  printf   "${C_G}              私人云盘 管理菜单               ${C_0}\n"
  printf   "${C_G}==============================================${C_0}\n"
  printf   "  ${C_B}1${C_0}) 启动服务\n"
  printf   "  ${C_B}2${C_0}) 停止服务\n"
  printf   "  ${C_B}3${C_0}) 重启服务\n"
  printf   "  ${C_B}4${C_0}) 查看运行状态\n"
  printf   "  ${C_B}5${C_0}) 重置登录密码\n"
  printf   "  ${C_B}6${C_0}) 更改文件根目录\n"
  printf   "  ${C_B}7${C_0}) 重新运行初始化向导\n"
  printf   "  ${C_B}0${C_0}) 退出\n"
  printf   "${C_G}----------------------------------------------${C_0}\n"
}

pause() {
  printf "\n按回车键返回菜单…"
  if [ -e /dev/tty ]; then read -r _ < /dev/tty || true; else read -r _ || true; fi
}

while true; do
  show_menu
  choice=""
  if [ -e /dev/tty ]; then read -r choice < /dev/tty || exit 0; else read -r choice || exit 0; fi
  case "$choice" in
    1) bash "$MANAGE" start; pause ;;
    2) bash "$MANAGE" stop;  pause ;;
    3) bash "$MANAGE" restart; pause ;;
    4) bash "$MANAGE" status; pause ;;
    5) bash "$MANAGE" password; pause ;;
    6) bash "$MANAGE" root; pause ;;
    7) bash "$INSTALL"; pause ;;
    0|q|Q) printf "再见！\n"; exit 0 ;;
    *) printf "${C_R}无效选项，请输入 0-7${C_0}\n" ;;
  esac
done
