# 私人云盘 (cloud-file-manager)

一个轻量、零前端依赖的**自建云盘**：在云服务器上指定一个文件夹，通过网页随时随地查看、搜索、预览、上传、下载其中的文件。

## 特性

- **一套代码两端通用**：Windows / Android / iOS 浏览器访问同一网址，支持 PWA「安装」当 App 用。
- **一键部署**：一行命令在任意 Linux 云服务器完成安装（见下方快速开始）。
- **上传实时进度**：每个文件独立进度条，实时速度、剩余时间；上传完成后面板自动收起。
- **断点续传**：上传按 1MB 分片，中断后自动跳过已收分片续传；同名同大小文件秒传。
- **失败自动重试**：分片级自动重试 3 次（指数退避）。
- **文件排序**：按文件名 / 上传时间 / 文件类型排序，支持升降序（记忆偏好）。
- **模糊搜索**：递归搜索全部子目录，大小写不敏感。
- **文件预览**：图片、视频、音频、PDF 浏览器原生渲染；文本 / 代码高亮（highlight.js）、Markdown 渲染（marked）。
- **下载到指定文件夹**：桌面端选一次目录后直接落盘；服务端支持 Range(206) 供下载工具续传。
- **密码哈希存储**：配置中只保存 PBKDF2-SHA256 哈希与随机盐，不保存明文。
- **密码保护**：所有接口需登录，含路径穿越防护。

---

## 快速开始（一行部署）

在任意 Linux 云服务器上执行（需 root 或 sudo 权限安装依赖时）：

```bash
curl -fsSL https://raw.githubusercontent.com/lujinzhu/cloud-file-manager/main/scripts/install.sh | bash
```

> 大陆服务器若访问 GitHub 不畅，用镜像加速：
>
> ```bash
> curl -fsSL https://ghfast.top/https://raw.githubusercontent.com/lujinzhu/cloud-file-manager/main/scripts/install.sh | bash
> ```

安装脚本会依次：

1. 检测 **python3**，缺失时**询问是否安装**（拒绝则退出初始化）
2. 检测 **pip / Flask**，安装前**逐一询问**（任何改动系统环境的操作都会先征求同意）
3. 下载源码（直连 GitHub，失败自动切换镜像源）
4. 生成 `.env` 配置：**密码只保存 PBKDF2 哈希**，其余未设置的项使用默认值，并把所有环境变量的值**展示给你**（随机密码仅显示这一次）
5. 可选安装 systemd 常驻服务（会先询问）

已有项目目录时也可以直接运行向导：`bash scripts/install.sh`

## 日常管理（菜单入口）

```bash
bash scripts/menu.sh
```

显示功能菜单，按选项执行对应操作：

```
1) 启动服务        5) 重置登录密码
2) 停止服务        6) 更改文件根目录
3) 重启服务        7) 重新运行初始化向导
4) 查看运行状态    0) 退出
```

也可以直接用子命令：

```bash
bash scripts/manage.sh start | stop | restart | status
bash scripts/manage.sh password            # 交互式重置密码（或 -p 新密码）
bash scripts/manage.sh root /new/path      # 更改文件根目录
```

服务管理会自动适配环境：有 systemd 且 unit 指向本项目时走 `systemctl`，否则用 PID 文件后台运行（`logs/cfm.log` 记日志），同机多实例互不干扰。

## 环境变量

配置统一存放在项目根目录的 `.env`（权限 600），由 install.sh 生成，manage.sh 维护：

| 变量 | 说明 | 默认值 |
|---|---|---|
| `CFM_ROOT` | 要管理的根目录（**必改**） | 项目目录下 `cloud-files` |
| `CFM_PASSWORD_HASH` | 登录密码的 PBKDF2-SHA256 哈希（**推荐，install.sh 自动生成**） | 无 |
| `CFM_PASSWORD_SALT` | 哈希盐（随机 hex，与 HASH 配套） | 无 |
| `CFM_PASSWORD` | 明文密码（仅兼容旧部署；设置了 HASH 即忽略） | `123456` |
| `CFM_HOST` | 监听地址 | `0.0.0.0` |
| `CFM_PORT` | 监听端口 | `8000` |
| `CFM_SECRET` | Flask 会话密钥（不设则重启后需重新登录） | 随机 |
| `CFM_CHUNK_SIZE` | 上传分片大小（字节） | `1048576`（1MB） |
| `CFM_UPLOAD_TTL` | 未完成上传会话保留时长（秒） | `86400`（24 小时） |
| `CFM_PBKDF2_ITERATIONS` | PBKDF2 迭代次数 | `60000` |
| `CFM_SEARCH_LIMIT` | 搜索结果上限 | `300` |

> `.env` 含会话密钥与哈希，已被 `.gitignore` 排除，**不要提交到仓库**。

## 手动部署（不用脚本）

```bash
git clone https://github.com/lujinzhu/cloud-file-manager.git
cd cloud-file-manager
pip3 install -r requirements.txt
CFM_ROOT=/你的目录 CFM_PASSWORD=你的密码 python3 server.py
```

## systemd 常驻

install.sh 可自动安装（会先询问）；手动示例：

```ini
# /etc/systemd/system/cloudfile.service
[Unit]
Description=Cloud File Manager (私人云盘)
After=network.target

[Service]
WorkingDirectory=/opt/cloud-file-manager
EnvironmentFile=/opt/cloud-file-manager/.env
ExecStart=/usr/bin/python3 /opt/cloud-file-manager/server.py
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

## 兼容老系统（CentOS 7 / Python 3.6）

Python 3.6 需锁版本安装依赖（install.sh 会自动识别并使用锁版本）：

```bash
pip3 install -i https://pypi.tuna.tsinghua.edu.cn/simple \
  "flask==2.0.3" "werkzeug==2.0.3" "jinja2==3.0.3" \
  "markupsafe==2.0.1" "itsdangerous==2.0.1" "click==8.0.4"
```

## 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/login` | 登录（服务端校验 PBKDF2 哈希） |
| POST | `/api/logout` | 退出 |
| GET | `/api/me` | 查询登录态 |
| GET | `/api/list?path=` | 列出目录 |
| GET | `/api/search?q=` | 递归模糊搜索（大小写不敏感） |
| POST | `/api/upload?path=` | 上传（multipart，支持多文件） |
| GET / HEAD | `/api/download?path=` | 下载；`&inline=1` 内嵌预览（自动 MIME） |
| POST | `/api/mkdir` | 新建文件夹 |
| POST | `/api/delete` | 删除（递归） |
| POST | `/api/upload_status` | 续传状态（uploadId / received[] / 秒传判定） |
| POST | `/api/upload_chunk?uploadId=&index=` | 上传单个分片 |
| POST | `/api/upload_finalize?uploadId=` | 合并分片 |
| POST | `/api/upload_abort?uploadId=` | 放弃并清理 |

除 `/api/login`、`/api/me` 外均需登录（401）；非法路径返回 400。

## 安全说明

1. **密码只保存哈希**：`.env` 中是 `CFM_PASSWORD_HASH` + `CFM_PASSWORD_SALT`（PBKDF2-SHA256，60000 次迭代），服务端用恒定时间比较校验。仓库与配置中均无明文密码。重置密码用 `manage.sh password`。
2. 登录请求本身走 HTTP 明文传输（个人自用可接受）；暴露公网建议前置 nginx + HTTPS。
3. 云厂商安全组只放行需要的端口。

## 版本说明

### v1.2.0（当前）

- 新增**文件排序**（文件名 / 时间 / 类型，升降序，记忆偏好）
- 新增**递归模糊搜索**（服务端 /api/search + 前端防抖搜索框）
- 新增**文件预览**：图片 / 视频 / 音频 / PDF 原生渲染，文本与代码 highlight.js 高亮，Markdown 用 marked 渲染；预览态用 inline MIME
- 新增**一键部署脚本** `scripts/install.sh`（curl | bash 可用；交互走 /dev/tty；无 tty 自动用默认值；GitHub 多镜像下载 fallback；安装 python/flask/systemd 前逐一询问）
- 新增**管理脚本** `scripts/manage.sh`（start/stop/restart/status/password/root）与**菜单入口** `scripts/menu.sh`
- 新增 **.env 配置文件**统一管理环境变量（systemd 用 EnvironmentFile 加载）
- **密码安全性增强**：支持并推荐 PBKDF2 哈希存储，兼容旧明文配置
- 上传队列全部完成后**自动收起**（有失败时保留供查看）
- 移除旧 `start.sh`（由 manage.sh 取代）

### v1.1.0

- 上传实时进度 / 断点续传（指纹会话 + 秒传）/ 分片级失败自动重试
- 服务端 Range(206) 下载支持
- 界面改版为「私人云盘」，底部版权

### v1.0.0

- 基础版本：登录鉴权、目录浏览、上传/下载、新建/删除、路径穿越防护、PWA

### 已废弃的加速版

曾实现并行分片下载/上传，实测低带宽服务器上反而更慢，已回退。**当前及之后的版本下载保持单连接，上传分片仅用于续传。**

## 两端使用差异

| 能力 | Windows (Chrome/Edge) | Android |
|---|---|---|
| 拖拽上传 | ✅ | ❌ 点「⬆️ 上传」 |
| 上传进度/续传 | ✅ | ✅ |
| 文件预览 | ✅ | ✅ |
| 搜索/排序 | ✅ | ✅ |
| 下载到指定文件夹 | ✅ | ⚠️ 存到系统「下载」目录 |
| 安装为 App | ✅ | ✅ |
