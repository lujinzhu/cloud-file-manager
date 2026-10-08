/* 私人云盘 (cloud-file-manager) - 前端逻辑 */
(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 单请求最大重试次数（每个分片独立重试，指数退避）
  const RETRY_MAX = 3;
  const RETRY_BASE_DELAY = 600;

  let state = {
    currentPath: "",   // 当前相对路径，如 "a/b"
    items: [],         // 当前目录条目
    selected: new Set(),
    dlDir: null,       // FileSystemDirectoryHandle（桌面浏览器）
  };

  /* ---------------- 工具 ---------------- */
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove("show"), 2600);
  }

  function fmtSize(n) {
    if (!n) return "—";
    const u = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(1)) + " " + u[i];
  }
  function fmtSpeed(bps) {
    if (!bps || !isFinite(bps)) return "";
    return fmtSize(bps) + "/s";
  }
  function fmtTime(ms) {
    const d = new Date(ms);
    const p = (x) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // 文件类型 → 图标 + 配色分类
  function kindOf(name, type) {
    if (type === "dir") return { icon: "📁", cls: "k-dir" };
    const ext = (String(name).split(".").pop() || "").toLowerCase();
    const map = {
      video: [["mp4", "avi", "mkv", "mov", "webm", "flv"], "🎬", "k-video"],
      audio: [["mp3", "wav", "flac", "m4a", "aac", "ogg"], "🎵", "k-audio"],
      image: [["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic"], "🖼", "k-image"],
      archive: [["zip", "rar", "7z", "gz", "tar", "bz2"], "🗜", "k-archive"],
      doc: [["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "csv", "log"], "📕", "k-doc"],
      app: [["apk", "exe", "msi", "dmg", "deb", "rpm"], "📱", "k-app"],
      code: [["js", "ts", "py", "java", "go", "c", "h", "cpp", "cs", "sh", "json", "html", "css", "xml"], "📜", "k-code"],
    };
    for (const k of Object.keys(map)) {
      const cfg = map[k];
      if (cfg[0].includes(ext)) return { icon: cfg[1], cls: cfg[2] };
    }
    return { icon: "📄", cls: "k-other" };
  }

  /* ---------------- 网络层 ---------------- */
  async function postJSON(url, obj) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(obj || {}),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }

  // 带实时上传进度的 XHR（fetch 拿不到上传进度，必须用 XMLHttpRequest）
  function xhrSend(url, body, opts) {
    opts = opts || {};
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url, true);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && opts.onUp) opts.onUp(e.loaded, e.total);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          let j = {};
          try { j = JSON.parse(xhr.responseText || "{}"); } catch (_) {}
          resolve(j);
        } else {
          reject(new Error("HTTP " + xhr.status));
        }
      };
      xhr.onerror = () => reject(new Error("网络中断"));
      xhr.ontimeout = () => reject(new Error("请求超时"));
      xhr.send(body);
    });
  }

  // 失败自动重试：指数退避
  async function withRetry(fn) {
    let last;
    for (let i = 1; i <= RETRY_MAX; i++) {
      try { return await fn(); }
      catch (e) {
        last = e;
        if (i === RETRY_MAX) break;
        await sleep(RETRY_BASE_DELAY * Math.pow(2, i - 1)); // 600ms → 1.2s
      }
    }
    throw last;
  }

  /* ---------------- 登录 ---------------- */
  async function boot() {
    try {
      const r = await fetch("/api/me");
      const j = await r.json();
      if (j.authenticated) { showApp(); await loadList(""); }
      else showLogin();
    } catch (_) { showLogin(); }

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }

  function showLogin() { $("#login").classList.remove("hidden"); $("#app").classList.add("hidden"); }
  function showApp() { $("#login").classList.add("hidden"); $("#app").classList.remove("hidden"); }

  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = $("#password").value;
    const btn = $("#login-form button");
    btn.disabled = true; btn.textContent = "登录中…";
    try {
      const res = await fetch("/api/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      if (res.ok) { $("#login-error").textContent = ""; await boot(); }
      else { const j = await res.json().catch(() => ({})); $("#login-error").textContent = j.error || "登录失败"; }
    } finally {
      btn.disabled = false; btn.textContent = "登 录";
    }
  });

  $("#btn-logout").addEventListener("click", async () => {
    await fetch("/api/logout", { method: "POST" });
    state.selected.clear(); state.currentPath = "";
    showLogin();
  });

  /* ---------------- 列表 ---------------- */
  async function loadList(rel) {
    state.currentPath = rel || "";
    state.selected.clear();
    updateSelButtons();
    const r = await fetch("/api/list?path=" + encodeURIComponent(state.currentPath));
    if (!r.ok) { toast("加载失败"); return; }
    const j = await r.json();
    state.items = j.entries || [];
    renderBreadcrumb(state.currentPath);
    renderList();
  }

  function renderBreadcrumb(rel) {
    const bc = $("#breadcrumb");
    bc.innerHTML = "";
    const home = document.createElement("span");
    home.className = "crumb home"; home.textContent = "🏠 根目录";
    home.onclick = () => loadList("");
    bc.appendChild(home);

    if (rel) {
      const parts = rel.split("/");
      let acc = "";
      parts.forEach((p, i) => {
        const sep = document.createElement("span");
        sep.className = "crumb sep"; sep.textContent = "›";
        bc.appendChild(sep);
        const c = document.createElement("span");
        acc = acc ? acc + "/" + p : p;
        if (i === parts.length - 1) { c.className = "crumb current"; c.textContent = p; }
        else { c.className = "crumb"; c.textContent = p; c.onclick = () => loadList(acc); }
        bc.appendChild(c);
      });
    }
  }

  function renderList() {
    const box = $("#filelist");
    box.innerHTML = "";
    if (!state.items.length) {
      box.innerHTML = '<div class="empty"><div class="empty-ico">📭</div><div class="empty-t">这个文件夹是空的</div><div class="empty-s">把文件拖进来，或点上方「上传」</div></div>';
      return;
    }
    state.items.forEach((it) => {
      const rel = state.currentPath ? state.currentPath + "/" + it.name : it.name;
      const k = kindOf(it.name, it.type);

      const row = document.createElement("div");
      row.className = "row";

      const chk = document.createElement("input");
      chk.type = "checkbox"; chk.className = "chk";
      chk.checked = state.selected.has(rel);
      chk.onchange = () => { chk.checked ? state.selected.add(rel) : state.selected.delete(rel); updateSelButtons(); };
      row.appendChild(chk);

      const ico = document.createElement("div");
      ico.className = "ico " + k.cls; ico.textContent = k.icon;
      row.appendChild(ico);

      const meta = document.createElement("div");
      meta.className = "meta";
      meta.innerHTML = `<div class="name">${esc(it.name)}</div>
        <div class="sub">${it.type === "dir" ? "文件夹" : fmtSize(it.size) + " · " + fmtTime(it.mtime)}</div>`;
      meta.onclick = () => { if (it.type === "dir") loadList(rel); else downloadFile(rel, it.name); };
      row.appendChild(meta);

      const acts = document.createElement("div");
      acts.className = "acts";
      const dl = document.createElement("button");
      dl.className = "icon-btn"; dl.textContent = "⬇️"; dl.title = "下载";
      dl.onclick = () => downloadFile(rel, it.name);
      acts.appendChild(dl);

      const del = document.createElement("button");
      del.className = "icon-btn danger"; del.textContent = "🗑"; del.title = "删除";
      del.onclick = async () => {
        if (!confirm(`确定删除「${it.name}」？此操作不可恢复。`)) return;
        await fetch("/api/delete", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paths: [rel] }) });
        toast("已删除"); loadList(state.currentPath);
      };
      acts.appendChild(del);
      row.appendChild(acts);

      box.appendChild(row);
    });
  }

  function updateSelButtons() {
    const n = state.selected.size;
    $("#btn-dldown").disabled = n === 0;
    $("#btn-del").disabled = n === 0;
  }

  /* ---------------- 上传队列面板 ---------------- */
  function ensurePanel() { $("#upload-panel").classList.remove("hidden"); }

  function addUpItem(name, size) {
    ensurePanel();
    const el = document.createElement("div");
    el.className = "up-item";
    el.innerHTML = `
      <div class="up-row">
        <span class="up-name">${esc(name)}</span>
        <span class="up-stat">0%</span>
      </div>
      <div class="up-track"><div class="up-bar"></div></div>
      <div class="up-sub"></div>`;
    el.querySelector(".up-name").title = name;
    $("#up-list").appendChild(el);
    const bar = el.querySelector(".up-bar");
    const stat = el.querySelector(".up-stat");
    const sub = el.querySelector(".up-sub");

    let lastT = Date.now(), lastB = 0, speed = 0;
    const api = {
      progress(p, loaded) {
        p = Math.max(0, Math.min(100, p));
        bar.style.width = p + "%";
        stat.textContent = Math.floor(p) + "%";
        if (loaded !== undefined) {
          const now = Date.now();
          const dt = (now - lastT) / 1000;
          if (dt >= 0.6) {
            speed = Math.max(0, (loaded - lastB) / dt);
            lastT = now; lastB = loaded;
            sub.textContent = `${fmtSize(loaded)} / ${fmtSize(size)}${speed ? " · " + fmtSpeed(speed) : ""}`;
          }
        }
        el.classList.add("running");
      },
      status(text, kind) {
        el.classList.remove("running");
        sub.textContent = text;
        if (kind === "resume") el.classList.add("resumed");
      },
      done(text) {
        bar.style.width = "100%";
        stat.textContent = "✓";
        el.classList.remove("running");
        el.classList.add("done");
        sub.textContent = text;
      },
      fail(text) {
        el.classList.remove("running");
        el.classList.add("fail");
        sub.textContent = text;
      },
    };
    return api;
  }

  /* ---------------- 上传：实时进度 + 断点续传 + 失败重试 ---------------- */
  async function uploadOne(file) {
    const item = addUpItem(file.name, file.size);

    // 空文件：走普通上传接口
    if (file.size === 0) {
      try {
        const fd = new FormData(); fd.append("file", file, file.name);
        await withRetry(() => xhrSend("/api/upload?path=" + encodeURIComponent(state.currentPath), fd));
        item.done("完成");
        return { ok: true };
      } catch (e) { item.fail("失败：" + e.message); return { ok: false }; }
    }

    try {
      const payload = {
        path: state.currentPath,
        name: file.name,
        size: file.size,
        mtime: file.lastModified || 0,
      };

      // 1) 询问服务端：能否秒传 / 已收到哪些分片
      const st = await withRetry(() => postJSON("/api/upload_status", payload));
      if (st.done) { item.done("文件已存在，已跳过"); return { skipped: true }; }

      const uploadId = st.uploadId;
      const chunkSize = st.chunkSize;
      const total = Math.max(1, Math.ceil(file.size / chunkSize));
      const have = new Set(st.received || []);

      // 已收到的字节数 = 续传起点
      let baseBytes = 0;
      have.forEach((i) => { baseBytes += Math.min(chunkSize, file.size - i * chunkSize); });

      if (have.size > 0) {
        item.progress((baseBytes / file.size) * 100, baseBytes);
        item.status(`断点续传：已有 ${have.size}/${total} 片，继续上传…`, "resume");
      } else {
        item.progress(0, 0);
      }

      // 2) 只补传缺失分片，每片失败独立重试
      for (let i = 0; i < total; i++) {
        if (have.has(i)) continue;
        const start = i * chunkSize;
        const end = Math.min(file.size, start + chunkSize);
        const blob = file.slice(start, end);
        await withRetry(() =>
          xhrSend(`/api/upload_chunk?uploadId=${uploadId}&index=${i}`, blob, {
            onUp: (loaded) => {
              const doneBytes = baseBytes + loaded;
              item.progress((doneBytes / file.size) * 100, doneBytes);
            },
          })
        );
        baseBytes += (end - start);
        item.progress((baseBytes / file.size) * 100, baseBytes);
      }

      // 3) 通知服务端合并
      await withRetry(() => xhrSend("/api/upload_finalize?uploadId=" + uploadId, null));
      item.done("完成");
      return { ok: true };
    } catch (e) {
      // 失败不清理服务端已收分片，下次重选同一文件自动从断点继续
      item.fail(`失败（${e.message}）。已保留进度，重新选择同一文件将自动续传`);
      return { ok: false, err: e };
    }
  }

  async function uploadFiles(files) {
    if (!files || !files.length) return;
    ensurePanel();
    let ok = 0, skip = 0, fail = 0;
    for (const f of files) {
      const r = await uploadOne(f);
      if (r.skipped) skip++; else if (r.ok) ok++; else fail++;
    }
    loadList(state.currentPath);
    let msg = `上传完成：成功 ${ok}`;
    if (skip) msg += `，跳过 ${skip}`;
    if (fail) msg += `，失败 ${fail}`;
    toast(msg);
  }

  $("#btn-upload").addEventListener("click", () => $("#file-input").click());
  $("#file-input").addEventListener("change", (e) => { uploadFiles(e.target.files); e.target.value = ""; });
  $("#up-close").addEventListener("click", () => $("#upload-panel").classList.add("hidden"));

  // 拖拽上传（桌面）
  const overlay = $("#drop-overlay");
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => { if (e.dataTransfer && e.dataTransfer.types.includes("Files")) { dragDepth++; overlay.classList.add("active"); } });
  window.addEventListener("dragover", (e) => { if (e.dataTransfer && e.dataTransfer.types.includes("Files")) e.preventDefault(); });
  window.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) overlay.classList.remove("active"); });
  window.addEventListener("drop", (e) => {
    if (e.dataTransfer && e.dataTransfer.files.length) {
      e.preventDefault(); dragDepth = 0; overlay.classList.remove("active");
      uploadFiles(e.dataTransfer.files);
    }
  });

  /* ---------------- 下载（保持单连接，稳定性优先） ---------------- */
  async function saveToDir(rel, name) {
    if (!state.dlDir || !state.dlDir.getFileHandle) return false;
    try {
      const fh = await state.dlDir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      const resp = await fetch("/api/download?path=" + encodeURIComponent(rel));
      if (!resp.ok) throw new Error("download failed");
      await resp.body.pipeTo(w);
      return true;
    } catch (err) {
      console.warn("FS Access 写入失败，回退普通下载", err);
      return false;
    }
  }

  function triggerDownload(rel, name) {
    const a = document.createElement("a");
    a.href = "/api/download?path=" + encodeURIComponent(rel);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  }

  async function downloadFile(rel, name) {
    if (await saveToDir(rel, name)) {
      toast(`已保存到：${state.dlDir.name} / ${name}`);
      return;
    }
    triggerDownload(rel, name);
  }

  async function downloadSelected() {
    const list = [...state.selected].filter((p) => {
      const it = state.items.find((x) => (state.currentPath ? state.currentPath + "/" + x.name : x.name) === p);
      return it && it.type === "file";
    });
    if (!list.length) { toast("选中的没有可下载的文件"); return; }
    if (state.dlDir) {
      toast(`开始下载 ${list.length} 个文件到 ${state.dlDir.name}…`);
      let ok = 0;
      for (const rel of list) {
        const name = rel.split("/").pop();
        if (await saveToDir(rel, name)) ok++; else triggerDownload(rel, name);
      }
      toast(`已保存 ${ok}/${list.length} 个文件到 ${state.dlDir.name}`);
    } else {
      toast(`开始下载 ${list.length} 个文件…`);
      for (const rel of list) {
        const name = rel.split("/").pop();
        triggerDownload(rel, name);
        await sleep(300); // 拉开间隔，避免浏览器拦截连续下载
      }
    }
  }

  $("#btn-dldown").addEventListener("click", downloadSelected);

  $("#btn-pickdir").addEventListener("click", async () => {
    if (!window.showDirectoryPicker) {
      toast("当前浏览器不支持选择文件夹，将使用默认下载位置");
      return;
    }
    try {
      const dir = await window.showDirectoryPicker();
      state.dlDir = dir;
      toast(`下载目录已设为：${dir.name}`);
    } catch (_) { /* 用户取消 */ }
  });

  /* ---------------- 新建文件夹 ---------------- */
  $("#btn-mkdir").addEventListener("click", async () => {
    const name = prompt("新建文件夹名称：");
    if (!name) return;
    const r = await fetch("/api/mkdir", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: state.currentPath, name }) });
    if (r.ok) { toast("已创建"); loadList(state.currentPath); }
    else { const j = await r.json().catch(() => ({})); toast(j.error || "创建失败"); }
  });

  /* ---------------- 删除选中 ---------------- */
  $("#btn-del").addEventListener("click", async () => {
    const list = [...state.selected];
    if (!list.length) return;
    if (!confirm(`确定删除选中的 ${list.length} 项？不可恢复。`)) return;
    const r = await fetch("/api/delete", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: list }) });
    if (r.ok) { toast("已删除"); loadList(state.currentPath); }
    else toast("删除失败");
  });

  boot();
})();
