# 云文件管理器 (cloud-file-manager)

一个轻量、零前端依赖的**自建云盘**：在云服务器上指定一个文件夹，通过网页随时随地查看、上传、下载其中的文件。

- **一套代码两端通用**：Windows / Android / iOS 都用浏览器访问同一个网址，支持"添加到主屏幕/安装到开始菜单"当 App 用（PWA）。
- **Windows 拖拽上传**：把文件直接拖进浏览器窗口即可上传当前目录。
- **下载到指定文件夹**：桌面端可选一个本地文件夹，之后下载直接落盘到该目录。
- **密码保护**：所有接口需登录，含路径穿越防护。

> 当前版本为**稳定简化版**（单连接下载 + 单请求上传）。
> 曾尝试过多线程分片并行下载/上传，实测在低带宽服务器上反而更慢且前端提示异常，故已回退，详见下方「版本说明」。

---

## 目录结构

```
cloud-file-manager/
├── server.py          # Flask 服务端（全部后端逻辑）
├── start.sh           # Linux 启动脚本（自动注入环境变量）
├── requirements.txt   # 依赖：仅 Flask
├── gen_icons.py       # PWA 图标生成脚本（一般不需要再跑）
├── static/
│   ├── index.html     # 页面结构
│   ├── app.js         # 前端逻辑
│   ├── style.css      # 样式
│   ├── manifest.json  # PWA 清单
│   ├── sw.js          # Service Worker
│   ├── icon.svg / icon-192.png / icon-512.png
└── .gitignore
```

## 快速开始

### 1. 安装依赖

```bash
pip3 install -r requirements.txt
```

### 2. 指定共享目录 + 密码后启动

```bash
CFM_ROOT=/你的/共享目录 \
CFM_PASSWORD=你的强密码 \
CFM_HOST=0.0.0.0 \
CFM_PORT=8000 \
python3 server.py
```

或直接：

```bash
CFM_ROOT=/opt/cloud-files CFM_PASSWORD=换成强密码 ./start.sh
```

### 3. 访问

浏览器打开 `http://<服务器公网IP>:8000`，输入密码即可。

> 注意在云厂商**安全组/防火墙放行对应端口**（如 8000）。

## 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `CFM_ROOT` | 要管理的根目录（**必改**） | 当前目录下的 `cloud-files` |
| `CFM_PASSWORD` | 登录密码（**必改**） | `123456` |
| `CFM_HOST` | 监听地址 | `0.0.0.0`（公网可访问） |
| `CFM_PORT` | 监听端口 | `8000` |
| `CFM_SECRET` | Flask 会话密钥，不设则每次启动随机生成（会导致重启后需重新登录） | 随机 |

## 部署为常驻服务（systemd，推荐）

适用于任何 Linux 云服务器：

```ini
# /etc/systemd/system/cloudfile.service
[Unit]
Description=Cloud File Manager
After=network.target

[Service]
WorkingDirectory=/opt/cloud-file-manager
Environment=CFM_ROOT=/opt/cloud-files
Environment=CFM_PASSWORD=换成你的强密码
Environment=CFM_HOST=0.0.0.0
Environment=CFM_PORT=8000
Environment=CFM_SECRET=用 openssl rand -hex 16 生成
ExecStart=/usr/bin/python3 /opt/cloud-file-manager/server.py
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

然后：

```bash
systemctl daemon-reload
systemctl enable --now cloudfile    # 开机自启 + 立即启动
systemctl status cloudfile          # 查看状态
journalctl -u cloudfile -f          # 看日志
```

## 兼容老系统（CentOS 7 / Python 3.6）

Python 3.6 装不了新版 Flask，需锁定版本：

```bash
pip3 install -i https://pypi.tuna.tsinghua.edu.cn/simple \
  "flask==2.0.3" "werkzeug==2.0.3" "jinja2==3.0.3" \
  "markupsafe==2.0.1" "itsdangerous==2.0.1" "click==8.0.4"
```

这类老系统的 pip 版本也较旧，可能没有 `pip` 命令（用 `pip3`），且不完全遵循 `requires-python`，因此建议按上面显式锁版本安装，而不是直接 `pip3 install -r requirements.txt`。

## 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/login` | 登录（`{"password":"..."}`） |
| POST | `/api/logout` | 退出 |
| GET | `/api/me` | 查询登录态 |
| GET | `/api/list?path=` | 列出目录（含隐藏文件过滤） |
| POST | `/api/upload?path=` | 上传（multipart，支持多文件） |
| GET | `/api/download?path=` | 下载 |
| POST | `/api/mkdir` | 新建文件夹 |
| POST | `/api/delete` | 删除（递归支持文件夹） |

全部 `/api/*`（除 `/api/login`、`/api/me`）均需登录态，否则返回 401。已做路径穿越防护，非法路径返回 400。

## 安全建议

1. **务必修改默认密码**（`CFM_PASSWORD`），不要用弱口令。
2. `server.py` 用的是 Flask 内置服务器，适合自用。**生产建议前置 nginx 反向代理 + HTTPS**（Let's Encrypt 免费证书），不要把 8000 端口长期裸奔在公网。
3. 云厂商安全组只放行需要访问的 IP/端口。

## 版本说明

- **当前（稳定版）**：单连接 `send_file` 流式下载；桌面端通过 File System Access API 写入指定目录，移动端走浏览器普通下载。上传为单个 multipart 请求。
- **已废弃的加速版**：曾实现 HTTP Range 并行下载 + 分片并行上传 + gzip。实测在带宽较小的轻量服务器上**下载反而变慢**（瓶颈不在单连接限速，分片带来的多请求与内存拼装开销得不偿失），且移动端进度提示异常，故回退。

若日后要再次尝试加速，建议先用 `curl` 实测单连接基准速度再决定是否启用分片。

## 两端使用差异

| 能力 | Windows (Chrome/Edge) | Android |
|---|---|---|
| 拖拽上传 | ✅ 拖进窗口即传 | ❌ 点「⬆️ 上传」选文件 |
| 下载到指定文件夹 | ✅ 选一次目录后直接落盘 | ⚠️ 受浏览器限制，存到系统「下载」目录 |
| 安装为 App | ✅ 地址栏「安装」 | ✅ 菜单「添加到主屏幕」 |
