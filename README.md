# 私人云盘 (cloud-file-manager)

一个轻量、零前端依赖的**自建云盘**：在云服务器上指定一个文件夹，通过网页随时随地查看、上传、下载其中的文件。

## 特性

- **一套代码两端通用**：Windows / Android / iOS 都用浏览器访问同一个网址，支持"添加到主屏幕/安装到开始菜单"当 App 用（PWA）。
- **上传实时进度**：每个文件独立显示进度条、实时速度、已传大小/总大小、剩余时间。
- **断点续传**：上传按 1MB 分片，中断后（关页面、断网、刷新）再次上传同一文件时**自动跳过已接收的分片**，只补传缺失部分；同名同大小文件直接**秒传**。
- **失败自动重试**：每个分片失败自动重试 3 次（指数退避），网络抖动不用手动重来。
- **下载支持 Range**：服务端返回 `Accept-Ranges: bytes` 与 `206 Partial Content`，浏览器/下载工具中断后可从断点继续（客户端仍是单连接，不做并行分片）。
- **Windows 拖拽上传**：把文件直接拖进浏览器窗口即可上传到当前目录。
- **下载到指定文件夹**：桌面端可选一个本地文件夹，之后下载直接落盘到该目录。
- **密码保护**：所有接口需登录，含路径穿越防护。

> **下载为什么不做并行分片**：曾实现过多线程并行下载/上传，实测在低带宽服务器上反而更慢且前端提示异常，因此本版本**只对上传做分片（用于续传），下载保持单连接**。详见下方「版本说明」。

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
│   ├── app.js         # 前端逻辑（XHR 上传、续传、重试、队列面板）
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
| `CFM_CHUNK_SIZE` | 上传分片大小（字节） | `1048576`（1MB） |
| `CFM_UPLOAD_TTL` | 未完成上传会话的保留时长（秒），超时自动清理 | `86400`（24 小时） |

> 上传分片临时存放在共享目录下的隐藏目录 `.cfmuploads/`，不会出现在文件列表中。

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
Environment=CFM_CHUNK_SIZE=1048576
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
| GET | `/api/list?path=` | 列出目录（自动过滤分片目录与隐藏文件） |
| POST | `/api/upload?path=` | 上传（multipart，支持多文件） |
| GET / HEAD | `/api/download?path=` | 下载，支持 `Range` 请求（206） |
| POST | `/api/mkdir` | 新建文件夹 |
| POST | `/api/delete` | 删除（递归支持文件夹） |
| POST | `/api/upload_status` | 查询续传状态，返回 `uploadId`、已接收分片 `received[]`；若文件已存在且大小一致则返回 `done:true`（秒传） |
| POST | `/api/upload_chunk?uploadId=&index=` | 上传单个分片（请求体为原始字节） |
| POST | `/api/upload_finalize?uploadId=` | 合并全部分片为目标文件 |
| POST | `/api/upload_abort?uploadId=` | 放弃上传并清理临时分片 |

全部 `/api/*`（除 `/api/login`、`/api/me`）均需登录态，否则返回 401。已做路径穿越防护，非法路径返回 400。

### 断点续传原理

会话 ID（`uploadId`）由 `目录 + 文件名 + 大小 + 修改时间` 计算指纹得出，因此**同一文件再次上传会命中同一个会话**，无需客户端持久化记录。前端流程：

```
upload_status → 拿到 uploadId 与已收分片列表
  → 跳过 received 中的分片，只上传缺失部分（每片失败重试 3 次）
  → upload_finalize 服务端按序合并
```

## 安全建议

1. **务必修改默认密码**（`CFM_PASSWORD`），不要用弱口令。本仓库不含任何真实密码或密钥，可安全公开。
2. `server.py` 用的是 Flask 内置服务器，适合自用。**生产建议前置 nginx 反向代理 + HTTPS**（Let's Encrypt 免费证书），不要把 8000 端口长期裸奔在公网。
3. 云厂商安全组只放行需要访问的 IP/端口。

## 版本说明

### v1.1.0（当前）

- 新增**上传实时进度**：每个文件的进度条、实时速度、剩余时间
- 新增**断点续传**：上传分片化，中断后跳过已完成分片；同名同大小文件秒传
- 新增**失败自动重试**：分片级自动重试 3 次（指数退避）
- 服务端 `/api/download` 恢复 **Range 支持**（206），便于下载工具续传
- 界面改版：项目更名「私人云盘」，全新视觉（渐变顶栏、文件类型彩色标识、卡片悬浮、重制登录页），底部增加版权信息

### v1.0.0

- 基础版本：登录鉴权、目录浏览、上传/下载、新建/删除、路径穿越防护、PWA

### 已废弃的加速版

曾实现 HTTP Range **并行**下载 + 分片并行上传 + gzip。实测在带宽较小的轻量服务器上**下载反而更慢**（瓶颈不在单连接限速，并行带来的多请求与内存拼装开销得不偿失），且移动端进度条走完仍重复弹下载，故已回退。

> v1.1.0 的上传分片仅用于**续传**，并刻意保持下载为单连接，就是吸取了这次教训。若日后要再次尝试并行加速，建议先用 `curl` 实测单连接基准速度再决定。

## 两端使用差异

| 能力 | Windows (Chrome/Edge) | Android |
|---|---|---|
| 拖拽上传 | ✅ 拖进窗口即传 | ❌ 点「⬆️ 上传」选文件 |
| 上传进度/续传 | ✅ | ✅ |
| 下载到指定文件夹 | ✅ 选一次目录后直接落盘 | ⚠️ 受浏览器限制，存到系统「下载」目录 |
| 安装为 App | ✅ 地址栏「安装」 | ✅ 菜单「添加到主屏幕」 |
