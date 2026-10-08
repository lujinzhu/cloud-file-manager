#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
云文件管理器 - 服务器端
==================================================
运行前：
    1) pip install -r requirements.txt
    2) 设置环境变量（或改下面的默认值）：
         CFM_ROOT     要管理/共享的文件夹（必改！指向你云服务器上的目标目录）
         CFM_PASSWORD 登录密码
         CFM_HOST     监听地址，默认 0.0.0.0（公网可访问）
         CFM_PORT     监听端口，默认 8000
         CFM_SECRET   Flask 会话密钥（生产环境务必设置）
    3) python server.py

安全提示：
    - 请务必修改默认密码，并尽量用防火墙/安全组只放行需要的端口。
    - 本程序只暴露 CFM_ROOT 内部的文件，已做路径穿越防护。
==================================================
"""
import os
import shutil
import secrets
from functools import wraps
from pathlib import Path

from flask import (
    Flask, request, session, jsonify, abort, send_file, send_from_directory,
)

# ----------------------------- 配置 -----------------------------
ROOT_DIR = os.environ.get("CFM_ROOT", os.path.join(os.getcwd(), "cloud-files"))
PASSWORD = os.environ.get("CFM_PASSWORD", "123456")
HOST = os.environ.get("CFM_HOST", "0.0.0.0")
PORT = int(os.environ.get("CFM_PORT", "8000"))
SECRET_KEY = os.environ.get("CFM_SECRET", secrets.token_hex(16))
# -----------------------------------------------------------------

app = Flask(__name__, static_folder="static", static_url_path="")
app.secret_key = SECRET_KEY

ROOT = Path(ROOT_DIR).resolve()
ROOT.mkdir(parents=True, exist_ok=True)


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
    return target


def clean_name(name):
    """只保留文件名，去掉任何路径成分。"""
    return os.path.basename(str(name).replace("\\", "/"))


@app.route("/api/login", methods=["POST"])
def login():
    data = request.get_json(silent=True) or {}
    if data.get("password", "") == PASSWORD:
        session["auth"] = True
        return jsonify(ok=True)
    return jsonify(ok=False, error="密码错误"), 401


@app.route("/api/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify(ok=True)


@app.route("/api/me")
def me():
    return jsonify(authenticated=bool(session.get("auth")))


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/api/list")
@login_required
def list_dir():
    rel = request.args.get("path", "")
    base = safe_path(rel)
    if not base.exists():
        abort(404, "路径不存在")
    entries = []
    for p in sorted(base.iterdir(), key=lambda x: (x.is_file(), x.name.lower())):
        if p.name.startswith("."):  # 隐藏文件/目录不展示
            continue
        st = p.stat()
        entries.append({
            "name": p.name,
            "type": "dir" if p.is_dir() else "file",
            "size": st.st_size if p.is_file() else 0,
            "mtime": int(st.st_mtime * 1000),
        })
    # 计算当前层级的相对路径（用于面包屑）
    try:
        cur = str(base.relative_to(ROOT)).replace("\\", "/")
    except ValueError:
        cur = ""
    if cur == ".":
        cur = ""
    return jsonify(path=cur, root=ROOT.name, entries=entries)


@app.route("/api/upload", methods=["POST"])
@login_required
def upload():
    rel = request.args.get("path", "")
    base = safe_path(rel)
    base.mkdir(parents=True, exist_ok=True)
    saved = []
    for f in request.files.getlist("file"):
        if f and f.filename:
            name = clean_name(f.filename)
            if not name:
                continue
            dest = base / name
            f.save(str(dest))
            saved.append(name)
    return jsonify(ok=True, saved=saved)


@app.route("/api/download")
@login_required
def download():
    rel = request.args.get("path", "")
    f = safe_path(rel)
    if not f.is_file():
        abort(404, "文件不存在")
    return send_file(
        str(f),
        as_attachment=True,
        download_name=f.name,
        mimetype="application/octet-stream",
    )


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
    return jsonify(ok=True)


if __name__ == "__main__":
    print(f"云文件管理器已启动： http://{HOST}:{PORT}")
    print(f"管理目录： {ROOT}")
    print("请在浏览器打开上面的地址，使用密码登录。")
    app.run(host=HOST, port=PORT, debug=False, threaded=True)
