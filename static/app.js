/* 云文件管理器 - 前端逻辑 */
(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const api = (path, opts) => fetch(path, opts);

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
  function fmtTime(ms) {
    const d = new Date(ms);
    const p = (x) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* ---------------- 登录 ---------------- */
  async function boot() {
    try {
      const r = await api("/api/me");
      const j = await r.json();
      if (j.authenticated) { showApp(); await loadList(""); }
      else showLogin();
    } catch { showLogin(); }

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }

  function showLogin() { $("#login").classList.remove("hidden"); $("#app").classList.add("hidden"); }
  function showApp() { $("#login").classList.add("hidden"); $("#app").classList.remove("hidden"); }

  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = $("#password").value;
    const res = await api("/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw }),
    });
    if (res.ok) { $("#login-error").textContent = ""; await boot(); }
    else { const j = await res.json().catch(() => ({})); $("#login-error").textContent = j.error || "登录失败"; }
  });

  $("#btn-logout").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" });
    state.selected.clear(); state.currentPath = "";
    showLogin();
  });

  /* ---------------- 列表 ---------------- */
  async function loadList(rel) {
    state.currentPath = rel || "";
    state.selected.clear();
    updateSelButtons();
    const r = await api("/api/list?path=" + encodeURIComponent(state.currentPath));
    if (!r.ok) { toast("加载失败"); return; }
    const j = await r.json();
    state.items = j.entries || [];
    renderBreadcrumb(state.currentPath);
    renderList();
  }

  function renderBreadcrumb(rel) {
    const bc = $("#breadcrumb");
    bc.innerHTML = "";
    const root = document.createElement("span");
    root.className = "crumb"; root.textContent = "根目录";
    root.onclick = () => loadList("");
    bc.appendChild(root);

    if (rel) {
      const parts = rel.split("/");
      let acc = "";
      parts.forEach((p, i) => {
        const sep = document.createElement("span");
        sep.className = "crumb sep"; sep.textContent = " / ";
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
      box.innerHTML = '<div class="empty-hint">这个文件夹是空的</div>';
      return;
    }
    state.items.forEach((it) => {
      const rel = state.currentPath ? state.currentPath + "/" + it.name : it.name;
      const row = document.createElement("div");
      row.className = "row";

      const chk = document.createElement("input");
      chk.type = "checkbox"; chk.className = "chk";
      chk.checked = state.selected.has(rel);
      chk.onchange = () => { chk.checked ? state.selected.add(rel) : state.selected.delete(rel); updateSelButtons(); };
      row.appendChild(chk);

      const ico = document.createElement("div");
      ico.className = "ico"; ico.textContent = it.type === "dir" ? "📁" : "📄";
      row.appendChild(ico);

      const meta = document.createElement("div");
      meta.className = "meta";
      meta.innerHTML = `<div class="name">${esc(it.name)}</div>
        <div class="sub">${it.type === "dir" ? "文件夹" : fmtSize(it.size)} · ${fmtTime(it.mtime)}</div>`;
      meta.onclick = () => { if (it.type === "dir") loadList(rel); else downloadFile(rel, it.name); };
      row.appendChild(meta);

      const acts = document.createElement("div");
      acts.className = "acts";
      const dl = document.createElement("button");
      dl.className = "btn"; dl.textContent = "⬇️"; dl.title = "下载";
      dl.onclick = () => downloadFile(rel, it.name);
      acts.appendChild(dl);

      const del = document.createElement("button");
      del.className = "btn danger"; del.textContent = "🗑"; del.title = "删除";
      del.onclick = async () => {
        if (!confirm(`确定删除「${it.name}」？此操作不可恢复。`)) return;
        await api("/api/delete", { method: "POST", headers: { "Content-Type": "application/json" },
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

  /* ---------------- 上传 ---------------- */
  async function uploadFiles(files) {
    if (!files || !files.length) return;
    const fd = new FormData();
    for (const f of files) fd.append("file", f, f.name);
    toast(`上传中：${files.length} 个文件…`);
    const r = await api("/api/upload?path=" + encodeURIComponent(state.currentPath), { method: "POST", body: fd });
    if (r.ok) { const j = await r.json(); toast(`已上传 ${j.saved.length} 个文件`); loadList(state.currentPath); }
    else toast("上传失败");
  }

  $("#btn-upload").addEventListener("click", () => $("#file-input").click());
  $("#file-input").addEventListener("change", (e) => { uploadFiles(e.target.files); e.target.value = ""; });

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

  /* ---------------- 下载 ---------------- */
  // 桌面浏览器：直接写入已选目录，成功返回 true
  async function saveToDir(rel, name) {
    if (!state.dlDir || !state.dlDir.getFileHandle) return false;
    try {
      const fh = await state.dlDir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      const resp = await api("/api/download?path=" + encodeURIComponent(rel));
      if (!resp.ok) throw new Error("download failed");
      await resp.body.pipeTo(w);
      return true;
    } catch (err) {
      console.warn("FS Access 写入失败，回退普通下载", err);
      return false;
    }
  }

  // 回退：浏览器默认下载位置
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
        await new Promise((r) => setTimeout(r, 300)); // 间隔，避免浏览器拦截
      }
    }
  }

  $("#btn-dldown").addEventListener("click", downloadSelected);

  // 选择下载目录（桌面 Chrome/Edge）
  $("#btn-pickdir").addEventListener("click", async () => {
    if (!window.showDirectoryPicker) {
      toast("当前浏览器不支持选择文件夹，将使用默认下载位置");
      return;
    }
    try {
      const dir = await window.showDirectoryPicker();
      state.dlDir = dir;
      toast(`下载目录已设为：${dir.name}`);
    } catch (e) { /* 用户取消 */ }
  });

  /* ---------------- 新建文件夹 ---------------- */
  $("#btn-mkdir").addEventListener("click", async () => {
    const name = prompt("新建文件夹名称：");
    if (!name) return;
    const r = await api("/api/mkdir", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: state.currentPath, name }) });
    if (r.ok) { toast("已创建"); loadList(state.currentPath); }
    else { const j = await r.json().catch(() => ({})); toast(j.error || "创建失败"); }
  });

  /* ---------------- 删除选中 ---------------- */
  $("#btn-del").addEventListener("click", async () => {
    const list = [...state.selected];
    if (!list.length) return;
    if (!confirm(`确定删除选中的 ${list.length} 项？不可恢复。`)) return;
    const r = await api("/api/delete", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: list }) });
    if (r.ok) { toast("已删除"); loadList(state.currentPath); }
    else toast("删除失败");
  });

  boot();
})();
