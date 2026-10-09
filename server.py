#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
私人云盘 (cloud-file-manager) - 服务器端
==================================================
运行前：
    1) pip3 install -r requirements.txt
    2) 设置环境变量（或改下面的默认值）：
         CFM_ROOT       要管理/共享的文件夹（必改！指向你云服务器上的目标目录）
         CFM_PASSWORD   登录密码（必改！）
         CFM_HOST       监听地址，默认 0.0.0.0（公网可访问）
         CFM_PORT       监听端口，默认 8000
         CFM_SECRET     Flask 会话密钥（生产环境务必设置，否则重启需重新登录）
         CFM_CHUNK_SIZE 续传分片大小（字节），默认 1MB
         CFM_UPLOAD_TTL 未完成的上传会话保留时长（秒），默认 24 小时
    3) python3 server.py

接口一览：
    - 鉴权：      /api/login, /api/logout, /api/me, /api/password（网页端改密码，无需旧密码）
    - 文件操作：  /api/list, /api/upload, /api/download, /api/mkdir, /api/delete, /api/search
    - 容量配额：  /api/quota（GET 查询；容量在初始化时设定，网页端不可调整）
    - 断点续传：  /api/upload_status, /api/upload_chunk, /api/upload_finalize, /api/upload_abort
    - 文件分享：  /api/share（GET 列表 / POST 生成 / DELETE 取消），公开下载 /s/<token>

安全提示：
    - 推荐用 scripts/install.sh 初始化：密码只保存 PBKDF2 哈希（CFM_PASSWORD_HASH + CFM_PASSWORD_SALT），
      不在配置中保存明文。兼容旧版明文 CFM_PASSWORD。
    - 本程序只暴露 CFM_ROOT 内部的文件，已做路径穿越防护。
==================================================
"""
import os
import re
import json
import time
import shutil
import hashlib
import hmac as hmac_mod
import secrets
import mimetypes
from functools import wraps
from pathlib import Path
from urllib.parse import quote

from flask import (
    Flask, request, session, jsonify, abort, send_file, send_from_directory, Response,
)
from markupsafe import escape

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def _load_env_file():
    """读取项目根目录的 .env（KEY=VALUE 每行一条），不覆盖已存在的环境变量。"""
    env_path = os.path.join(BASE_DIR, ".env")
    if not os.path.isfile(env_path):
        return
    try:
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                k, v = k.strip(), v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
    except Exception as e:
        print(f"[警告] 读取 .env 失败：{e}")


_load_env_file()

# ----------------------------- 配置 -----------------------------
ROOT_DIR = os.environ.get("CFM_ROOT", os.path.join(os.getcwd(), "cloud-files"))
PASSWORD = os.environ.get("CFM_PASSWORD", "123456")                    # 兼容旧版：明文密码
PASSWORD_HASH = os.environ.get("CFM_PASSWORD_HASH", "")                # 推荐：PBKDF2 十六进制哈希
PASSWORD_SALT = os.environ.get("CFM_PASSWORD_SALT", "")                # 哈希盐（十六进制）
PBKDF2_ITERATIONS = int(os.environ.get("CFM_PBKDF2_ITERATIONS", "60000"))
HOST = os.environ.get("CFM_HOST", "0.0.0.0")
PORT = int(os.environ.get("CFM_PORT", "8000"))
SECRET_KEY = os.environ.get("CFM_SECRET", secrets.token_hex(16))
CHUNK_SIZE = int(os.environ.get("CFM_CHUNK_SIZE", 1024 * 1024))    # 续传分片大小，默认 1MB
UPLOAD_TTL = int(os.environ.get("CFM_UPLOAD_TTL", 24 * 3600))      # 上传会话保留时长
SEARCH_LIMIT = int(os.environ.get("CFM_SEARCH_LIMIT", "300"))      # 搜索结果上限
QUOTA = int(os.environ.get("CFM_QUOTA", "0"))                      # 云盘总容量（字节），0=不限
# 初始化时生成的初始密码哈希。登录时拿它和「用户输入的密码」比对：
# 一样 ⇒ 还在用初始密码 ⇒ 强制改密；不一样 ⇒ 用户已改过 ⇒ 不强制。
INITIAL_HASH = os.environ.get("CFM_INITIAL_PASSWORD_HASH", "").lower()
INITIAL_SALT = os.environ.get("CFM_INITIAL_PASSWORD_SALT", "")
ENV_PATH = os.path.join(BASE_DIR, ".env")                          # 配置写回目标

# 标准库 mimetypes 缺失的常见类型，主动补充，保证预览时浏览器能正确渲染
_EXTRA_MIMES = {
    ".apk": "application/vnd.android.package-archive",
    ".ipa": "application/octet-stream",
    ".exe": "application/x-msdownload",
    ".msi": "application/x-msi",
    ".dmg": "application/x-apple-diskimage",
    ".7z": "application/x-7z-compressed",
    ".rar": "application/vnd.rar",
    ".mkv": "video/x-matroska",
    ".flac": "audio/flac",
    ".opus": "audio/opus",
    ".m4a": "audio/mp4",
    ".m4v": "video/x-m4v",
    ".mov": "video/quicktime",
    ".md": "text/markdown",
    ".yml": "text/yaml",
    ".yaml": "text/yaml",
    ".log": "text/plain",
    ".csv": "text/csv",
    ".woff2": "font/woff2",
}
for _ext, _mime in _EXTRA_MIMES.items():
    mimetypes.add_type(_mime, _ext)
# -----------------------------------------------------------------


def verify_password(input_pw):
    """校验密码：优先哈希比对（PBKDF2-SHA256），未配置哈希时回退明文比对（兼容旧部署）。"""
    if PASSWORD_HASH:
        try:
            salt = bytes.fromhex(PASSWORD_SALT) if PASSWORD_SALT else b""
            calc = hashlib.pbkdf2_hmac(
                "sha256", (input_pw or "").encode("utf-8"), salt, PBKDF2_ITERATIONS
            ).hex()
            return hmac_mod.compare_digest(calc, PASSWORD_HASH.lower())
        except Exception:
            return False
    return (input_pw or "") == PASSWORD


def is_initial_password(input_pw):
    """当前登录用的密码是否仍是初始化时的初始密码（哈希比对）。"""
    if INITIAL_HASH:
        try:
            salt = bytes.fromhex(INITIAL_SALT) if INITIAL_SALT else b""
            calc = hashlib.pbkdf2_hmac(
                "sha256", (input_pw or "").encode("utf-8"), salt, PBKDF2_ITERATIONS
            ).hex()
            return hmac_mod.compare_digest(calc, INITIAL_HASH)
        except Exception:
            return False
    # 老版本部署没有初始哈希时，回退到 CFM_PWD_CHANGED 标记
    return os.environ.get("CFM_PWD_CHANGED", "0") != "1"


def update_env_file(updates):
    """把若干 KEY=VALUE 写回 .env（存在则替换，不存在则追加），供网页端改密码/扩容使用。"""
    lines = []
    if os.path.isfile(ENV_PATH):
        try:
            with open(ENV_PATH, "r", encoding="utf-8") as f:
                lines = f.readlines()
        except Exception:
            lines = []
    done = set()
    out = []
    for ln in lines:
        k = ln.split("=", 1)[0].strip() if ("=" in ln and not ln.lstrip().startswith("#")) else None
        if k in updates:
            out.append(f"{k}={updates[k]}\n")
            done.add(k)
        else:
            out.append(ln)
    for k, v in updates.items():
        if k not in done:
            if out and not out[-1].endswith("\n"):
                out[-1] += "\n"
            out.append(f"{k}={v}\n")
    tmp = ENV_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.writelines(out)
    os.replace(tmp, ENV_PATH)
    try:
        os.chmod(ENV_PATH, 0o600)
    except OSError:
        pass

app = Flask(__name__, static_folder="static", static_url_path="")
app.secret_key = SECRET_KEY

ROOT = Path(ROOT_DIR).resolve()
ROOT.mkdir(parents=True, exist_ok=True)

UPLOAD_DIR = ROOT / ".cfmuploads"   # 隐藏目录：存放续传中的分片


# ----------------------------- 工具 -----------------------------
def login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get("auth"):
            return jsonify(ok=False, error="未登录"), 401
        return f(*args, **kwargs)
    return wrapper


def safe_path(rel):
    """把相对路径拼到 ROOT 下，并防止路径穿越。"""
    rel = (rel or "").strip("/").replace("\\", "/")
    target = (ROOT / rel).resolve()
    if target != ROOT and ROOT not in target.parents:
        abort(400, "非法路径")
    # 禁止访问续传分片的隐藏临时目录
    parts = target.relative_to(ROOT).parts if target != ROOT else ()
    if ".cfmuploads" in parts:
        abort(400, "非法路径")
    return target


def clean_name(name):
    """只保留文件名，去掉任何路径成分。"""
    return os.path.basename(str(name).replace("\\", "/"))


def unique_name(base_dir, name):
    """目标位置已存在同名文件时自动改名，避免覆盖已有文件。

    例：a.txt 已存在 → a (1).txt → a (2).txt …
    """
    name = clean_name(name)
    if not (base_dir / name).exists():
        return name
    stem, dot, ext = name.rpartition(".")
    if not dot:            # 没有扩展名的文件（如 README）
        stem, ext = name, ""
    suffix = "." + ext if ext else ""
    for i in range(1, 10000):
        cand = f"{stem} ({i}){suffix}"
        if not (base_dir / cand).exists():
            return cand
    # 极端情况兜底：加时间戳
    return f"{stem} ({int(time.time())}){suffix}"


def session_key(rel, name, size, mtime):
    """由「路径 + 文件名 + 大小 + 修改时间」派生稳定会话 ID，保证同一份文件重复上传能续传。"""
    raw = f"{rel}|{name}|{size}|{mtime}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def valid_uid(uid):
    return bool(re.fullmatch(r"[0-9a-f]{64}", uid or ""))


def cleanup_stale_uploads():
    """清理超过 TTL 仍未完成的上传会话，避免磁盘被残留分片占满。"""
    if not UPLOAD_DIR.is_dir():
        return
    now = time.time()
    removed = 0
    for d in UPLOAD_DIR.iterdir():
        try:
            if d.is_dir() and (now - d.stat().st_mtime) > UPLOAD_TTL:
                shutil.rmtree(str(d), ignore_errors=True)
                removed += 1
        except Exception:
            pass
    if removed:
        print(f"[启动清理] 已清除 {removed} 个过期上传会话")


cleanup_stale_uploads()


# ----------------------------- 文件分享 -----------------------------
# 分享记录存在项目目录的 .shares.json（不放在共享目录里，避免污染文件列表）
SHARE_FILE = os.path.join(BASE_DIR, ".shares.json")
SHARES = {}


def _load_shares():
    global SHARES
    SHARES = {}
    if not os.path.isfile(SHARE_FILE):
        return
    try:
        with open(SHARE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            SHARES = {k: v for k, v in data.items() if isinstance(v, dict)}
    except Exception as e:
        print(f"[警告] 读取分享记录失败：{e}")


def _save_shares():
    try:
        tmp = SHARE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(SHARES, f, ensure_ascii=False)
        os.replace(tmp, SHARE_FILE)
    except Exception as e:
        print(f"[警告] 写入分享记录失败：{e}")


def _share_alive(rec):
    """expires=0 表示永久有效。"""
    exp = rec.get("expires") or 0
    return exp == 0 or exp > time.time()


def _purge_shares():
    """清理已过期的分享链接。"""
    dead = [t for t, r in SHARES.items() if not _share_alive(r)]
    for t in dead:
        SHARES.pop(t, None)
    if dead:
        _save_shares()


def _share_error_page(title, detail, status):
    """分享链接打不开时给一个说明页（比裸 404 友好）。"""
    html = (
        "<!DOCTYPE html><html lang='zh-CN'><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
        f"<title>{escape(title)} · 私人云盘</title><style>"
        "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;"
        "background:#f4f3ef;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;}"
        ".c{background:#fff;border:1px solid #e6e4dc;border-radius:14px;padding:34px 30px;"
        "max-width:380px;text-align:center;box-shadow:0 18px 40px rgba(25,24,34,.16);}"
        ".i{font-size:44px}.t{font-size:18px;font-weight:700;margin:10px 0 6px;color:#191822;}"
        ".d{font-size:13.5px;color:#8f8da0;line-height:1.6;}"
        "</style></head><body><div class='c'><div class='i'>🔗</div>"
        f"<div class='t'>{escape(title)}</div><div class='d'>{escape(detail)}</div></div></body></html>"
    )
    return Response(html, status, mimetype="text/html")


_load_shares()
_purge_shares()


# ----------------------------- 容量配额 -----------------------------
_used_cache = {"ts": 0.0, "bytes": 0}
USED_TTL = 30  # 已用容量缓存秒数，避免每次上传都递归扫盘


def used_bytes():
    """ROOT 下已存文件的总字节数（含续传分片临时目录），带 TTL 缓存。"""
    now = time.time()
    if now - _used_cache["ts"] < USED_TTL:
        return _used_cache["bytes"]
    total = 0
    for dirpath, _dirnames, filenames in os.walk(str(ROOT)):
        for fn in filenames:
            try:
                total += os.path.getsize(os.path.join(dirpath, fn))
            except OSError:
                pass
    _used_cache["ts"] = now
    _used_cache["bytes"] = total
    return total


def invalidate_used():
    """文件落盘/删除后使缓存失效，下次查询重新统计。"""
    _used_cache["ts"] = 0.0


def quota_exceeded(additional):
    """新增 additional 字节是否超过云盘容量。QUOTA<=0 表示不限。"""
    if QUOTA <= 0:
        return False
    return used_bytes() + additional > QUOTA


def quota_error_response():
    return jsonify(
        ok=False,
        error="云盘剩余容量不足，请删除部分文件后重试（云盘容量在初始化时设定）",
        code="quota",
    ), 403


# ----------------------------- 鉴权 -----------------------------
@app.route("/api/login", methods=["POST"])
def login():
    data = request.get_json(silent=True) or {}
    pw = data.get("password", "")
    if verify_password(pw):
        session["auth"] = True
        # 仍在使用初始密码 → 强制弹窗修改；否则不打扰
        session["mustChange"] = is_initial_password(pw)
        return jsonify(ok=True, mustChange=session["mustChange"])
    return jsonify(ok=False, error="密码错误"), 401


@app.route("/api/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify(ok=True)


@app.route("/api/me")
def me():
    return jsonify(
        authenticated=bool(session.get("auth")),
        mustChange=(bool(session.get("auth")) and bool(session.get("mustChange"))),
    )


# ----------------------------- 修改密码（网页端） -----------------------------
# 已登录会话即可修改，无需输入当前密码（用户要求）；仍保留基本防呆校验。
@app.route("/api/password", methods=["POST"])
@login_required
def change_password():
    global PASSWORD_HASH, PASSWORD_SALT
    data = request.get_json(silent=True) or {}
    new = str(data.get("newPassword", ""))
    if len(new) < 6:
        return jsonify(ok=False, error="新密码至少 6 位"), 400
    if verify_password(new):
        # 新密码与当前密码一致：无论当前哈希还是初始哈希，都不能重复沿用
        return jsonify(ok=False, error="新密码不能与当前密码相同"), 400
    if INITIAL_HASH:
        try:
            calc_initial = hashlib.pbkdf2_hmac(
                "sha256", new.encode("utf-8"),
                bytes.fromhex(INITIAL_SALT) if INITIAL_SALT else b"", PBKDF2_ITERATIONS
            ).hex()
            if hmac_mod.compare_digest(calc_initial, INITIAL_HASH):
                return jsonify(ok=False, error="新密码不能与初始密码相同"), 400
        except Exception:
            pass
    salt = secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac(
        "sha256", new.encode("utf-8"), bytes.fromhex(salt), PBKDF2_ITERATIONS
    ).hex()
    PASSWORD_HASH, PASSWORD_SALT = h, salt
    try:
        update_env_file({
            "CFM_PASSWORD_HASH": h,
            "CFM_PASSWORD_SALT": salt,
            "CFM_PWD_CHANGED": "1",
        })
    except Exception as e:
        print(f"[警告] 写回 .env 失败（本次运行内仍生效，重启后回退）：{e}")
    session.clear()  # 修改成功后强制重新登录
    return jsonify(ok=True, relogin=True)


# ----------------------------- 云盘容量 -----------------------------
@app.route("/api/quota", methods=["GET"])
@login_required
def quota_info():
    du = shutil.disk_usage(str(ROOT))
    return jsonify(
        ok=True,
        used=used_bytes(),
        quota=QUOTA if QUOTA > 0 else None,
        diskTotal=du.total,
        diskFree=du.free,
    )


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


# ----------------------------- 文件浏览 -----------------------------
@app.route("/api/list")
@login_required
def list_dir():
    rel = request.args.get("path", "")
    base = safe_path(rel)
    if not base.exists():
        abort(404, "路径不存在")
    entries = []
    for p in sorted(base.iterdir(), key=lambda x: (x.is_file(), x.name.lower())):
        if p.name.startswith("."):  # 隐藏文件/目录（含 .cfmuploads）不展示
            continue
        st = p.stat()
        entries.append({
            "name": p.name,
            "type": "dir" if p.is_dir() else "file",
            "size": st.st_size if p.is_file() else 0,
            "mtime": int(st.st_mtime * 1000),
        })
    try:
        cur = str(base.relative_to(ROOT)).replace("\\", "/")
    except ValueError:
        cur = ""
    if cur == ".":
        cur = ""
    return jsonify(path=cur, root=ROOT.name, entries=entries)


# ----------------------------- 模糊搜索（递归） -----------------------------
@app.route("/api/search")
@login_required
def search():
    q = (request.args.get("q") or "").strip().lower()
    if not q:
        return jsonify(ok=True, results=[], total=0)
    results = []
    root_str = str(ROOT)
    for dirpath, dirnames, filenames in os.walk(root_str):
        # 跳过隐藏目录（含 .cfmuploads 分片目录）
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for name in sorted(dirnames) + sorted(filenames):
            if q in name.lower():
                full = os.path.join(dirpath, name)
                try:
                    st = os.stat(full)
                except OSError:
                    continue
                rel_dir = os.path.relpath(dirpath, root_str).replace("\\", "/")
                if rel_dir == ".":
                    rel_dir = ""
                results.append({
                    "name": name,
                    "dir": rel_dir,
                    "type": "dir" if os.path.isdir(full) else "file",
                    "size": st.st_size if os.path.isfile(full) else 0,
                    "mtime": int(st.st_mtime * 1000),
                })
                if len(results) >= SEARCH_LIMIT:
                    return jsonify(ok=True, results=results, total=len(results),
                                   truncated=True, q=q)
    return jsonify(ok=True, results=results, total=len(results), q=q)


# ----------------------------- 普通上传（小文件） -----------------------------
@app.route("/api/upload", methods=["POST"])
@login_required
def upload():
    rel = request.args.get("path", "")
    base = safe_path(rel)
    base.mkdir(parents=True, exist_ok=True)
    saved = []
    renamed = []
    for f in request.files.getlist("file"):
        if f and f.filename:
            name = clean_name(f.filename)
            if not name:
                continue
            if quota_exceeded(f.content_length or 0):
                return quota_error_response()
            final = unique_name(base, name)     # 重名自动改名，不覆盖已有文件
            f.save(str(base / final))
            saved.append(final)
            if final != name:
                renamed.append({"from": name, "to": final})
    invalidate_used()
    return jsonify(ok=True, saved=saved, renamed=renamed)


# ----------------------------- 断点续传上传 -----------------------------
# 流程：upload_status（拿 uploadId + 已收分片） → 只补传缺失分片 → upload_finalize 合并
@app.route("/api/upload_status", methods=["POST"])
@login_required
def upload_status():
    data = request.get_json(silent=True) or {}
    rel = data.get("path", "")
    name = clean_name(data.get("name", ""))
    if not name:
        abort(400, "非法文件名")
    size = int(data.get("size", 0) or 0)
    mtime = int(data.get("mtime", 0) or 0)
    base = safe_path(rel)

    # 容量校验：文件总大小超过剩余云盘容量时直接拒绝（提示去清理文件）
    if quota_exceeded(size):
        return quota_error_response()

    uid = session_key(rel, name, size, mtime)
    d = UPLOAD_DIR / uid
    d.mkdir(parents=True, exist_ok=True)

    # 云盘里已有同名文件（无论大小是否一致）→ 一律自动改名（a.txt → a (1).txt），绝不覆盖、绝不跳过
    final_name = name
    if (base / name).exists():
        final_name = unique_name(base, name)
    meta_f = d / "meta.json"
    if meta_f.is_file():
        try:
            old = json.loads(meta_f.read_text(encoding="utf-8"))
            if old.get("finalName"):
                final_name = old["finalName"]   # 续传时沿用上次解析出的名字，保持稳定
        except Exception:
            pass
    meta = {
        "path": rel, "name": name, "finalName": final_name, "size": size, "mtime": mtime,
        "chunkSize": CHUNK_SIZE, "updated": time.time(),
    }
    meta_f.write_text(json.dumps(meta), encoding="utf-8")

    received = sorted(
        int(p.name[5:]) for p in d.glob("part_*") if p.name[5:].isdigit()
    )
    return jsonify(ok=True, uploadId=uid, chunkSize=CHUNK_SIZE, received=received,
                   name=name, finalName=final_name)


@app.route("/api/upload_chunk", methods=["POST"])
@login_required
def upload_chunk():
    uid = request.args.get("uploadId", "")
    idx = request.args.get("index", "")
    if not valid_uid(uid) or not idx.isdigit():
        abort(400, "参数错误")
    d = UPLOAD_DIR / uid
    if not (d / "meta.json").is_file():
        abort(404, "上传会话不存在")
    blob = request.get_data()
    if not blob:
        abort(400, "空分片")
    (d / ("part_" + idx)).write_bytes(blob)
    try:
        os.utime(str(d), None)  # 刷新会话活跃时间，避免被 TTL 清理
    except Exception:
        pass
    return jsonify(ok=True, index=int(idx), len=len(blob))


@app.route("/api/upload_finalize", methods=["POST"])
@login_required
def upload_finalize():
    uid = request.args.get("uploadId", "")
    if not valid_uid(uid):
        abort(400, "参数错误")
    d = UPLOAD_DIR / uid
    meta_f = d / "meta.json"
    if not meta_f.is_file():
        abort(404, "上传会话不存在")

    meta = json.loads(meta_f.read_text(encoding="utf-8"))
    size = int(meta["size"])
    chunk = int(meta["chunkSize"])
    total = max(1, (size + chunk - 1) // chunk)

    missing = [i for i in range(total) if not (d / ("part_" + str(i))).is_file()]
    if missing:
        return jsonify(ok=False, error="分片缺失", missing=missing), 400

    base = safe_path(meta["path"])
    base.mkdir(parents=True, exist_ok=True)
    target_name = clean_name(meta.get("finalName") or meta["name"])
    dest = base / target_name
    if dest.exists():
        # 兜底：合并前仍存在同名（并发上传等），再让一次名
        target_name = unique_name(base, target_name)
        dest = base / target_name

    # 按序追加写入，避免一次性把整文件读进内存
    with open(str(dest), "wb") as out:
        for i in range(total):
            out.write((d / ("part_" + str(i))).read_bytes())
    shutil.rmtree(str(d), ignore_errors=True)
    invalidate_used()
    return jsonify(ok=True, name=target_name,
                   renamed=(target_name != clean_name(meta["name"])))


@app.route("/api/upload_abort", methods=["POST"])
@login_required
def upload_abort():
    uid = request.args.get("uploadId", "")
    if valid_uid(uid):
        shutil.rmtree(str(UPLOAD_DIR / uid), ignore_errors=True)
    return jsonify(ok=True)


# ----------------------------- 下载 -----------------------------
# 支持 HTTP Range：让浏览器/下载工具在中断后能从断点继续，不必重头再来。
# 注意：客户端仍是「单连接」下载，不会像并行分片那样在低带宽服务器上反而变慢。
@app.route("/api/download", methods=["GET", "HEAD"])
@login_required
def download():
    rel = request.args.get("path", "")
    inline = request.args.get("inline") == "1"   # inline=1 供浏览器内嵌预览
    f = safe_path(rel)
    if not f.is_file():
        abort(404, "文件不存在")
    size = f.stat().st_size
    disp_type = "inline" if inline else "attachment"
    disp = f"{disp_type}; filename*=UTF-8''" + quote(f.name)

    # 预览时按扩展名推断 MIME，浏览器才能正确渲染（图片/视频/PDF/文本…）
    mime = "application/octet-stream"
    if inline:
        guessed = mimetypes.guess_type(f.name)[0]
        if guessed:
            mime = guessed

    if request.method == "HEAD":
        resp = Response("", 200, headers={
            "Accept-Ranges": "bytes",
            "Content-Type": mime,
            "Content-Disposition": disp,
        })
        resp.headers["Content-Length"] = str(size)
        return resp

    range_header = request.headers.get("Range")
    m = re.match(r"bytes=(\d*)-(\d*)$", (range_header or "").strip())
    if m:
        start_s, end_s = m.group(1), m.group(2)
        start = int(start_s) if start_s else 0
        end = int(end_s) if end_s != "" else size - 1
        if start < 0 or start >= size or end >= size or start > end:
            abort(416, "范围不合法")
        length = end - start + 1
        with open(str(f), "rb") as fh:
            fh.seek(start)
            chunk_data = fh.read(length)
        return Response(chunk_data, 206, mimetype=mime, headers={
            "Content-Range": f"bytes {start}-{end}/{size}",
            "Accept-Ranges": "bytes",
            "Content-Length": str(length),
            "Content-Disposition": disp,
        })

    resp = send_file(
        str(f),
        as_attachment=not inline,
        download_name=f.name,
        mimetype=mime,
    )
    resp.headers["Accept-Ranges"] = "bytes"
    return resp


# ----------------------------- 分享链接 -----------------------------
@app.route("/api/share", methods=["GET"])
@login_required
def share_list():
    _purge_shares()
    items = []
    for t, r in sorted(SHARES.items(), key=lambda kv: kv[1].get("created", 0), reverse=True):
        exp = r.get("expires") or 0
        items.append({
            "token": t,
            "path": r.get("path", ""),
            "name": r.get("name", ""),
            "size": r.get("size", 0),
            "created": int(r.get("created", 0) * 1000),
            "expires": int(exp * 1000) if exp else 0,
            "downloads": int(r.get("downloads", 0)),
        })
    return jsonify(ok=True, items=items)


@app.route("/api/share", methods=["POST"])
@login_required
def share_create():
    """生成一个免登录下载链接。body: {path, expire(小时，0=永久)}"""
    data = request.get_json(silent=True) or {}
    rel = data.get("path", "")
    f = safe_path(rel)
    if not f.is_file():
        return jsonify(ok=False, error="只能分享文件（文件夹暂不支持）"), 400
    try:
        hours = float(data.get("expire", 24 * 7))
    except (TypeError, ValueError):
        hours = 24 * 7
    hours = max(0, min(hours, 24 * 365))   # 最多一年
    _purge_shares()
    token = secrets.token_urlsafe(10)
    exp = (time.time() + hours * 3600) if hours > 0 else 0
    SHARES[token] = {
        "path": rel,
        "name": f.name,
        "size": f.stat().st_size,
        "created": time.time(),
        "expires": exp,
        "downloads": 0,
    }
    _save_shares()
    return jsonify(ok=True, token=token, name=f.name,
                   expires=int(exp * 1000) if exp else 0)


@app.route("/api/share", methods=["DELETE"])
@login_required
def share_remove():
    data = request.get_json(silent=True) or {}
    token = str(data.get("token", ""))
    if token in SHARES:
        SHARES.pop(token, None)
        _save_shares()
    return jsonify(ok=True)


@app.route("/s/<token>")
def share_download(token):
    """公开分享下载：任何拿到链接的人都能直接下载，无需登录。"""
    rec = SHARES.get(token)
    if not rec:
        return _share_error_page("链接无效", "该分享链接不存在或已被取消。", 404)
    if not _share_alive(rec):
        SHARES.pop(token, None)
        _save_shares()
        return _share_error_page("链接已过期", "该分享链接已过期，请联系分享者重新生成。", 410)
    try:
        f = safe_path(rec.get("path", ""))
    except Exception:
        return _share_error_page("链接无效", "分享的文件路径不合法。", 404)
    if not f.is_file():
        return _share_error_page(
            "文件不存在", f"分享的文件「{rec.get('name', '')}」已被移动或删除。", 404)
    rec["downloads"] = int(rec.get("downloads", 0)) + 1
    _save_shares()
    resp = send_file(str(f), as_attachment=True, download_name=f.name)
    # 中文文件名兼容：ASCII 回退名 + RFC5987 编码名
    fallback = "".join(c if ord(c) < 128 else "_" for c in f.name)
    resp.headers["Content-Disposition"] = (
        f'attachment; filename="{fallback}"; filename*=UTF-8\'\'{quote(f.name)}'
    )
    resp.headers["Accept-Ranges"] = "bytes"
    return resp


# ----------------------------- 其它操作 -----------------------------
@app.route("/api/mkdir", methods=["POST"])
@login_required
def mkdir():
    data = request.get_json(silent=True) or {}
    rel = data.get("path", "")
    name = clean_name(data.get("name", ""))
    if not name or "/" in name or "\\" in name:
        abort(400, "非法文件夹名")
    base = safe_path(rel)
    (base / name).mkdir(parents=True, exist_ok=True)
    return jsonify(ok=True)


@app.route("/api/delete", methods=["POST"])
@login_required
def delete():
    data = request.get_json(silent=True) or {}
    for rel in data.get("paths", []):
        p = safe_path(rel)
        if p.exists():
            if p.is_dir():
                shutil.rmtree(p)
            else:
                p.unlink()
    invalidate_used()
    return jsonify(ok=True)


if __name__ == "__main__":
    print(f"私人云盘已启动： http://{HOST}:{PORT}")
    print(f"管理目录： {ROOT}")
    print(f"续传分片： {CHUNK_SIZE // 1024} KB")
    print("请在浏览器打开上面的地址，使用密码登录。")
    app.run(host=HOST, port=PORT, debug=False, threaded=True)
