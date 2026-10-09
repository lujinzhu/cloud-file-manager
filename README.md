# 私人云盘 (cloud-file-manager)

一个轻量、零前端依赖的**自建云盘**：在云服务器上指定一个文件夹，通过网页随时随地查看、搜索、预览、上传、下载其中的文件。

> ## 📌 部署前必读
>
> 请先在服务器的**任意位置创建一个空目录**，并赋予该目录权限（下面以 777 为例；如果你的目录属主就是执行部署的用户，可以省略授权这一步）：
>
> ```bash
> mkdir -p /home/yourname/cloud
> chmod 777 /home/yourname/cloud
> cd /home/yourname/cloud
> ```
>
> **然后在这个目录里面执行一键部署命令**（见下方快速开始）。本项目的所有相关文件（源码、配置、日志、以及你上传的文件）都会放在这个目录下，方便统一管理与一键卸载。

## 特性

- **一套代码两端通用**：Windows / Android / iOS 浏览器访问同一网址，支持 PWA「安装」当 App 用。
- **免端口访问**：初始化可选配置 nginx 子路径，用 `http://服务器IP/yunpan` 直接访问（前端全相对路径，任意子路径可用）。
- **一键部署**：一行命令在任意 Linux 云服务器完成安装（见下方快速开始）。
- **云盘容量管理**：初始化自动设云盘容量为磁盘的 80%（取整），网页顶栏实时显示剩余/总容量，设置菜单**滑动条增量扩容**（上限磁盘 90%，扩不动时按钮自动置灰），容量不足上传时会提示扩容。
- **上传实时进度**：每个文件独立进度条，实时速度、剩余时间；上传完成后面板自动收起。
- **重名自动改名**：上传的文件与云盘已有文件同名时**自动改名**（`a.txt` → `a (1).txt`），绝不覆盖原文件；同名且大小完全一致则视为同一份文件直接秒传。
- **一键分享链接**：文件上点 🔗 即生成**免登录下载链接**（可设 1 天 / 7 天 / 30 天 / 永久），对方打开链接直接下载；设置菜单可统一管理或随时作废。
- **断点续传**：上传按 1MB 分片，中断后自动跳过已收分片续传；同名同大小文件秒传。
- **失败自动重试**：分片级自动重试 3 次（指数退避）。
- **文件排序**：按文件名 / 上传时间 / 文件类型排序，支持升降序（记忆偏好）。
- **模糊搜索**：递归搜索全部子目录，大小写不敏感。
- **文件预览**：图片、视频、音频、PDF 浏览器原生渲染；**代码查看器**——highlight.js 本地高亮 + JetBrains Mono 等宽字体 + 行号栏（横向滚动时行号保持可见）+ 常驻横向滚动条（内容过宽无需滚到底）；Markdown 渲染（marked）；Esc / 点遮罩 / ✕ 均可关闭。
- **首次登录强制改密**：登录时把「你输入的密码」与**初始密码哈希**比对——一样就强制弹窗修改（新密码不能与旧密码/初始密码相同），改完自动登出重新登录；一旦改成不一样的新密码，之后登录不再弹窗。
- **一键卸载**：`scripts/uninstall.sh` 列出所有项目文件，确认后清理（数据目录默认保留）。
- **下载到指定文件夹**：桌面端选一次目录后直接落盘；服务端支持 Range(206) 供下载工具续传。
- **密码哈希存储**：配置中只保存 PBKDF2-SHA256 哈希与随机盐，不保存明文。
- **密码保护**：所有接口需登录，含路径穿越防护。

---

## 快速开始（一行部署）

**先按「部署前必读」创建并进入一个空目录**，在该目录里执行（需 root 或 sudo 权限安装依赖时）：

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
3. 下载源码到**当前目录**（直连 GitHub，失败自动切换镜像源）
4. 生成 `.env` 配置：**密码只保存 PBKDF2 哈希**；**云盘容量自动设为磁盘总容量的 80%（取整）**，并把所有环境变量的值**展示给你**（随机密码仅显示这一次）
5. 可选安装 systemd 常驻服务（会先询问）
6. 可选安装并配置 **nginx 子路径反代**：用 `http://服务器IP/yunpan` 免端口访问（会先询问；80 端口需在云厂商安全组放行）
7. 安装完成自动**探测公网 IP**，横幅直接给出**可点开的访问地址**和**初始密码**（仅展示这一次，首次登录会强制修改）

> nginx 配置兼容性：脚本会自动创建缺失的 `/etc/nginx/conf.d/` 目录，并在 `nginx.conf` 缺少 `include conf.d/*.conf` 时自动注入（原文件备份为 `nginx.conf.bak-cfm`）。

已有项目目录时也可以直接运行向导：`bash scripts/install.sh`

## 日常管理（菜单入口）

```bash
bash scripts/menu.sh
```

显示功能菜单，按选项执行对应操作：

```
1) 启动服务        5) 重置登录密码
2) 停止服务        6) 重新运行初始化向导
3) 重启服务        7) 卸载私人云盘（清理项目文件）
4) 查看运行状态    0) 退出
```

也可以直接用子命令：

```bash
bash scripts/manage.sh start | stop | restart | status
bash scripts/manage.sh password            # 交互式重置密码（或 -p 新密码）
```

## 一键卸载

```bash
bash scripts/uninstall.sh
```

卸载脚本会：

1. 停止并移除 systemd 服务 / 后台进程
2. **列出所有将要删除的项目文件**（源码、配置、日志、systemd 配置等）
3. 询问**文件数据目录**（cloud-files，你上传的文件）是否一并删除——**默认保留**
4. 输入 `yes` 确认后才会真正删除；只删本项目相关文件，不碰目录里的其他内容

服务管理会自动适配环境：有 systemd 且 unit 指向本项目时走 `systemctl`，否则用 PID 文件后台运行（`logs/cfm.log` 记日志），同机多实例互不干扰。

## 环境变量

配置统一存放在项目根目录的 `.env`（权限 600），由 install.sh 生成，manage.sh 维护：

| 变量                          | 说明                                                        | 默认值                                       |
| --------------------------- | --------------------------------------------------------- | ----------------------------------------- |
| `CFM_ROOT`                  | 要管理的根目录                                                   | 项目目录下 `cloud-files`（初始化时固定，保证所有文件都在部署目录内） |
| `CFM_PASSWORD_HASH`         | 登录密码的 PBKDF2-SHA256 哈希（**推荐，install.sh 自动生成**）            | 无                                         |
| `CFM_PASSWORD_SALT`         | 哈希盐（随机 hex，与 HASH 配套）                                     | 无                                         |
| `CFM_INITIAL_PASSWORD_HASH` | **初始密码**的哈希（install.sh 自动生成，与初始时的 `CFM_PASSWORD_HASH` 一致） | 无                                         |
| `CFM_INITIAL_PASSWORD_SALT` | 初始密码哈希的盐                                                  | 无                                         |
| `CFM_QUOTA`                 | 云盘总容量（字节）；初始化默认磁盘 80% 取整，网页设置里可调（上限磁盘 90%）                | 磁盘 80%                                    |
| `CFM_PASSWORD`              | 明文密码（仅兼容旧部署；设置了 HASH 即忽略）                                 | `123456`                                  |
| `CFM_HOST`                  | 监听地址                                                      | `0.0.0.0`                                 |
| `CFM_PORT`                  | 监听端口                                                      | `8000`                                    |
| `CFM_SECRET`                | Flask 会话密钥（不设则重启后需重新登录）                                   | 随机                                        |
| `CFM_CHUNK_SIZE`            | 上传分片大小（字节）                                                | `1048576`（1MB）                            |
| `CFM_UPLOAD_TTL`            | 未完成上传会话保留时长（秒）                                            | `86400`（24 小时）                            |
| `CFM_PBKDF2_ITERATIONS`     | PBKDF2 迭代次数                                               | `60000`                                   |
| `CFM_SEARCH_LIMIT`          | 搜索结果上限                                                    | `300`                                     |

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

| 方法         | 路径                                   | 说明                                         |
| ---------- | ------------------------------------ | ------------------------------------------ |
| POST       | `/api/login`                         | 登录（服务端校验 PBKDF2 哈希；返回 mustChange 标记强制改密）   |
| POST       | `/api/logout`                        | 退出                                         |
| GET        | `/api/me`                            | 查询登录态                                      |
| POST       | `/api/password`                      | 修改密码（旧密码 + 新密码 ≥6 位；成功后强制重新登录）             |
| GET        | `/api/quota`                         | 云盘容量：已用 / 总容量 / 磁盘总量                       |
| POST       | `/api/quota`                         | 设置云盘容量（上限磁盘总容量的 90%，下限已用容量）                |
| GET        | `/api/list?path=`                    | 列出目录                                       |
| GET        | `/api/search?q=`                     | 递归模糊搜索（大小写不敏感）                             |
| POST       | `/api/upload?path=`                  | 上传（multipart，支持多文件）                        |
| GET / HEAD | `/api/download?path=`                | 下载；`&inline=1` 内嵌预览（自动 MIME）               |
| POST       | `/api/mkdir`                         | 新建文件夹                                      |
| POST       | `/api/delete`                        | 删除（递归）                                     |
| POST       | `/api/upload_status`                 | 续传状态（uploadId / received[] / 秒传判定）         |
| POST       | `/api/upload_chunk?uploadId=&index=` | 上传单个分片                                     |
| POST       | `/api/upload_finalize?uploadId=`     | 合并分片                                       |
| POST       | `/api/upload_abort?uploadId=`        | 放弃并清理                                      |
| GET        | `/api/share`                         | 分享链接列表（含下载次数、到期时间）                         |
| POST       | `/api/share`                         | 生成分享链接（`{path, expire}`；expire 单位为小时，0=永久） |
| DELETE     | `/api/share`                         | 取消分享（`{token}`），链接立即失效                     |
| GET        | `/s/<token>`                         | **公开下载**：免登录，任何人打开即下载（过期/失效返回中文说明页）        |

除 `/api/login`、`/api/me`、`/s/<token>` 外均需登录（401）；非法路径返回 400。  
分享记录保存在项目目录的 `.shares.json`（不写入共享文件夹，不会污染文件列表）。

## 安全说明

1. **密码只保存哈希**：`.env` 中是 `CFM_PASSWORD_HASH` + `CFM_PASSWORD_SALT`（PBKDF2-SHA256，60000 次迭代），服务端用恒定时间比较校验。仓库与配置中均无明文密码。重置密码用 `manage.sh password`。
2. 登录请求本身走 HTTP 明文传输（个人自用可接受）；暴露公网建议前置 nginx + HTTPS。
3. 云厂商安全组只放行需要的端口。

## 版本说明

### v1.5.0（当前）

- **上传重名自动改名**：上传的文件与目标目录已有文件同名时，服务端自动改名为 `a (1).txt` / `a (2).txt`… **不再覆盖原文件**；上传面板会提示"已存在同名文件，将保存为「xxx」"。同名且大小完全一致仍视为同一份文件直接跳过（保留秒传）
- **文件分享链接**：文件行与预览界面新增 🔗 按钮，点击即生成**免登录下载链接**，可选 1 天 / 7 天 / 30 天 / 永久有效；改有效期自动重新生成，点"停止分享"立即作废
- **分享管理**：设置菜单新增「🔗 分享链接管理」，可查看全部链接（文件名 / 大小 / 到期时间 / 已被下载次数）、一键复制链接或取消分享
- **公开下载路由**：`/s/<token>` 免鉴权直连下载，支持中文文件名（ASCII 回退 + RFC5987）；过期返回 410、失效返回 404，均为中文说明页
- nginx 模板新增 `/s/` 反代，分享链接在 `:8000` 与 `/yunpan` 两种访问方式下都可用

### v1.4.0

- **免端口访问**：新增 nginx 子路径反代配置（install.sh 可选安装），`http://服务器IP/yunpan` 直接访问；前端全部改为相对路径，任意子路径均可部署
- **扩容交互重做**：滑动条选择 + 增量输入框双向联动——输入值是**要增加的容量**，增量 + 当前容量超过磁盘 90% 上限时无效；已无可扩容空间时滑条与按钮自动置灰
- **代码查看器升级**：代码不再硬换行（保持真实行结构）、新增行号栏（sticky 左侧，横向滚动时行号始终可见）、**常驻横向滚动条**（内容过宽时固定显示在预览底部，无需滚到最底部才能拖动）
- **视觉体系升级**（工业实用方向）：去白底紫渐变 → 深靛墨主色 + 暖纸白工作区 + 琥珀唯一强调色；JetBrains Mono 本地化（代码与数字等宽）；阴影三级体系与焦点环（可访问性）；`prefers-reduced-motion` 降级
- Service Worker 缓存版本升级（cfm-v2），修复子路径部署下的缓存作用域

### v1.3.1

- **强制改密判定修正**：不再依赖标记位，改为登录时把「你输入的密码」与**初始密码哈希**比对——**相同才强制修改，不同就不弹窗**（老部署无初始哈希时回退到 CFM_PWD_CHANGED）
- 修改密码时校验：**新密码不能与旧密码相同**，也不能改回初始密码
- `.env` 新增 `CFM_INITIAL_PASSWORD_HASH` / `CFM_INITIAL_PASSWORD_SALT`（install.sh 自动生成，与初始密码哈希一致）

### v1.3.0

- **预览界面改版**：由全屏改为居中卡片式，头部显示文件图标、文件名、大小，带下载与关闭按钮；Esc / 点遮罩 / ✕ 均可关闭，移动端自动全屏化
- **代码高亮本地化**：highlight.js / marked 内置到 `static/vendor/`，不再依赖 jsdelivr CDN（解决大陆网络下代码不着色的问题）
- **设置菜单**：主界面新增「⚙️ 设置」二级菜单，支持网页端修改登录密码、调整云盘容量（上限磁盘 90%）
- **云盘容量**：顶栏实时显示剩余/总容量；初始化自动设为磁盘总容量的 80%（取整）；上传超容时提示扩容并弹出设置
- **首次登录强制改密**：登录时比对「输入密码」与**初始密码哈希**，相同才强制改密（不再依赖单独的标记位）；新密码不得与旧密码 / 初始密码相同，修改后需重新登录
- **一键卸载**：新增 `scripts/uninstall.sh`，先展示将删除的文件清单，确认后清理（数据目录默认保留）
- **安装目录约定**：install.sh 固定安装到当前目录，项目所有相关文件都在用户创建的文件夹下；README 顶部增加部署前提说明
- 移除 `manage.sh root` 更改根目录功能（根目录固定为部署目录下的 `cloud-files`）

### v1.2.0

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

| 能力       | Windows (Chrome/Edge) | Android       |
| -------- | --------------------- | ------------- |
| 拖拽上传     | ✅                     | ❌ 点「⬆️ 上传」    |
| 上传进度/续传  | ✅                     | ✅             |
| 文件预览     | ✅                     | ✅             |
| 搜索/排序    | ✅                     | ✅             |
| 下载到指定文件夹 | ✅                     | ⚠️ 存到系统「下载」目录 |
| 安装为 App  | ✅                     | ✅             |
