/* 私人云盘 (cloud-file-manager) - 前端逻辑 */
(function () {
  "use strict";

  window.__cfmBooted = true;   // 供 index.html 的兜底脚本判断脚本是否已加载
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
    sortBy: localStorage.getItem("cfm_sortBy") || "name",   // name | time | type
    sortAsc: (localStorage.getItem("cfm_sortAsc") || "1") === "1",
    mode: "browse",    // browse | search（搜索结果模式）
    searchTimer: null,
    quota: null,       // /api/quota 结果（used/quota/diskTotal/diskFree）
    ver: {},           // /api/version 结果（current/latest/hasUpdate/changelog）
    dragRels: [],      // 正在拖动的文件相对路径（多选时整批移动）
  };

  /* ---------------- 排序 ---------------- */
  function typeRank(it) {
    const k = kindOf(it.name, it.type).cls;
    const order = ["k-dir", "k-image", "k-video", "k-audio", "k-doc", "k-code", "k-archive", "k-app", "k-other"];
    return order.indexOf(k);
  }
  function sortedItems(items) {
    const arr = items.slice();
    const dir = state.sortAsc ? 1 : -1;
    arr.sort((a, b) => {
      // 文件夹始终排在最前（升降序都不打散）
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      let r = 0;
      if (state.sortBy === "time") r = (a.mtime || 0) - (b.mtime || 0);
      else if (state.sortBy === "type") r = typeRank(a) - typeRank(b) || a.name.localeCompare(b.name, "zh-CN");
      else r = a.name.localeCompare(b.name, "zh-CN", { numeric: true });
      return r * dir;
    });
    return arr;
  }
  function saveSortPref() {
    localStorage.setItem("cfm_sortBy", state.sortBy);
    localStorage.setItem("cfm_sortAsc", state.sortAsc ? "1" : "0");
  }

  /* ---------------- 工具 ---------------- */
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove("show"), 2600);
  }

  function fmtSize(n) {
    // 云盘为空 / 空文件时，0 要如实显示为 "0 B"；只有真的没值才显示占位符
    if (n === null || n === undefined || n === "") return "—";
    n = Number(n);
    if (!isFinite(n) || n < 0) return "—";
    if (n === 0) return "0 B";
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
    if (!r.ok) throw await httpError(r);
    return r.json();
  }

  // 从错误响应中提取服务端错误信息（如容量不足 code=quota）
  async function httpError(r) {
    let msg = "HTTP " + r.status, code = "";
    try {
      const j = await r.json();
      if (j && j.error) msg = j.error;
      if (j && j.code) code = j.code;
    } catch (_) {}
    const e = new Error(msg);
    e.status = r.status;
    e.code = code;
    return e;
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
          let msg = "HTTP " + xhr.status, code = "";
          try {
            const j = JSON.parse(xhr.responseText || "{}");
            if (j.error) msg = j.error;
            if (j.code) code = j.code;
          } catch (_) {}
          const e = new Error(msg); e.code = code;
          reject(e);
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
      const r = await fetch("api/me");
      const j = await r.json();
      if (j.authenticated) {
        showApp();
        loadQuota();
        loadVersion();
        await loadList("");
        if (j.mustChange) openForceModal();   // 首次登录强制改密
      } else showLogin();
    } catch (_) { showLogin(); }

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  }

  function hideBoot() { const b = $("#boot"); if (b) b.classList.add("hidden"); }
  function showLogin() {
    hideBoot();
    $("#login").classList.remove("hidden");
    $("#app").classList.add("hidden");
    closeForceModal();
    closeSettings();
    closeSharesModal();
  }
  function showApp() {
    hideBoot();
    $("#login").classList.add("hidden");
    $("#app").classList.remove("hidden");
    layoutVerFloat();   // 登录前 #app 隐藏、页脚高度为 0，显示后需重算更新按钮位置
  }

  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = $("#password").value;
    const btn = $("#login-form button");
    btn.disabled = true; btn.textContent = "登录中…";
    try {
      const res = await fetch("api/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      if (res.ok) {
        $("#login-error").textContent = "";
        $("#password").value = "";
        const j = await res.json();
        showApp();
        loadQuota();
        loadVersion();
        await loadList("");
        if (j.mustChange) openForceModal();   // 初始密码未修改 → 强制弹窗
      } else {
        const j = await res.json().catch(() => ({}));
        $("#login-error").textContent = j.error || "登录失败";
      }
    } finally {
      btn.disabled = false; btn.textContent = "登 录";
    }
  });

  $("#btn-logout").addEventListener("click", async () => {
    await fetch("api/logout", { method: "POST" });
    state.selected.clear(); state.currentPath = "";
    showLogin();
  });

  /* ---------------- 云盘容量（顶栏徽章） ---------------- */
  async function loadQuota() {
    try {
      const r = await fetch("api/quota");
      if (!r.ok) return;
      const j = await r.json();
      state.quota = j;
      renderQuotaBadge(j);
    } catch (_) {}
  }

  function renderQuotaBadge(q) {
    const el = $("#quota-badge");
    if (!q.quota) { el.textContent = `💾 已用 ${fmtSize(q.used)}`; el.classList.remove("warn"); return; }
    const pct = Math.min(100, Math.round((q.used / q.quota) * 1000) / 10);
    const free = Math.max(0, q.quota - q.used);
    el.textContent = `💾 已用 ${fmtSize(q.used)} / ${fmtSize(q.quota)}  (${pct}%)`;
    el.classList.toggle("warn", q.used / q.quota >= 0.9);
    el.title = `已用 ${fmtSize(q.used)}，总容量 ${fmtSize(q.quota)}，剩余 ${fmtSize(free)}`;
  }

  /* ---------------- 文件分享（免登录下载链接） ---------------- */
  // 部署在子路径（如 /yunpan/）时，分享链接也要带同样的前缀
  function appBase() {
    return location.pathname.replace(/[^/]*$/, "");
  }
  function shareUrl(token) {
    return location.origin + appBase() + "s/" + token;
  }
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) {}
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (_) { return false; }
  }

  let shareState = { rel: "", name: "", token: "" };

  function openShareModal(rel, name) {
    shareState = { rel, name, token: "" };
    $("#sh-name").textContent = "🔗 " + name;
    $("#sh-url").value = "";
    $("#sh-msg").textContent = ""; $("#sh-msg").className = "st-msg";
    $("#share-modal").classList.remove("hidden");
    createShare();
  }
  function closeShareModal() { $("#share-modal").classList.add("hidden"); }

  async function createShare() {
    const hours = parseFloat($("#sh-expire").value);
    const msg = $("#sh-msg");
    msg.textContent = "生成中…"; msg.className = "st-msg";
    // 同一文件重复分享时先作废旧链接，避免堆积
    if (shareState.token) {
      await fetch("api/share", { method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: shareState.token }) }).catch(() => {});
      shareState.token = "";
    }
    try {
      const r = await fetch("api/share", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: shareState.rel, expire: hours }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { msg.textContent = j.error || "生成失败"; msg.className = "st-msg err"; return; }
      shareState.token = j.token;
      shareState.name = j.name || shareState.name;
      $("#sh-url").value = shareUrl(j.token);
      msg.textContent = j.expires
        ? `已生成，有效期至 ${fmtTime(j.expires)}`
        : "已生成，永久有效";
      msg.className = "st-msg ok";
    } catch (e) {
      msg.textContent = "网络错误：" + e.message; msg.className = "st-msg err";
    }
  }

  $("#sh-close").addEventListener("click", closeShareModal);
  $("#share-modal").addEventListener("click", (e) => { if (e.target.id === "share-modal") closeShareModal(); });
  $("#sh-expire").addEventListener("change", () => { if (shareState.rel) createShare(); });
  $("#sh-copy").addEventListener("click", async () => {
    const url = $("#sh-url").value;
    if (!url) { toast("链接还没生成好"); return; }
    const ok = await copyText(url);
    toast(ok ? "链接已复制，发给对方即可直接下载" : "复制失败，请手动选中复制");
    if (ok) { const b = $("#sh-copy"); b.textContent = "已复制"; setTimeout(() => (b.textContent = "复制"), 1800); }
  });
  $("#sh-revoke").addEventListener("click", async () => {
    if (!shareState.token) { closeShareModal(); return; }
    await fetch("api/share", { method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: shareState.token }) }).catch(() => {});
    shareState.token = "";
    toast("已停止分享，旧链接立即失效");
    closeShareModal();   // 停止分享后直接关闭弹窗
  });

  /* ---------------- 分享链接管理（独立界面） ---------------- */
  function openSharesModal() {
    renderShareList();
    $("#shares-modal").classList.remove("hidden");
  }
  function closeSharesModal() { $("#shares-modal").classList.add("hidden"); }

  $("#btn-shares").addEventListener("click", openSharesModal);
  $("#sm-close").addEventListener("click", closeSharesModal);
  $("#shares-modal").addEventListener("click", (e) => { if (e.target.id === "shares-modal") closeSharesModal(); });

  // 分享链接管理列表
  async function renderShareList() {
    const box = $("#sh-list");
    let j;
    try {
      const r = await fetch("api/share");
      j = await r.json();
    } catch (_) { box.innerHTML = '<div class="st-hint">加载失败</div>'; return; }
    const items = (j && j.items) || [];
    if (!items.length) { box.innerHTML = '<div class="st-hint">还没有分享链接。在文件上点 🔗 即可生成。</div>'; return; }
    box.innerHTML = "";
    items.forEach((it) => {
      const row = document.createElement("div");
      row.className = "sh-item";
      const exp = it.expires ? fmtTime(it.expires) + " 过期" : "永久有效";
      row.innerHTML = `
        <div class="sh-meta">
          <div class="sh-item-name" title="${esc(it.name)}">🔗 ${esc(it.name)}</div>
          <div class="sh-item-sub">${fmtSize(it.size)} · ${exp} · 已下载 ${it.downloads} 次</div>
        </div>`;
      const acts = document.createElement("div");
      acts.className = "sh-acts";
      const cp = document.createElement("button");
      cp.className = "icon-btn"; cp.textContent = "📋"; cp.title = "复制链接";
      cp.onclick = async () => {
        const ok = await copyText(shareUrl(it.token));
        toast(ok ? "链接已复制" : "复制失败，请手动复制");
      };
      const rm = document.createElement("button");
      rm.className = "icon-btn danger"; rm.textContent = "🗑"; rm.title = "取消分享";
      rm.onclick = async () => {
        await fetch("api/share", { method: "DELETE", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: it.token }) });
        toast("已取消分享"); renderShareList();
      };
      acts.appendChild(cp); acts.appendChild(rm);
      row.appendChild(acts);
      box.appendChild(row);
    });
  }

  /* ---------------- 设置二级菜单 ---------------- */
  function openSettings() {
    $("#st-msg").textContent = ""; $("#st-msg").className = "st-msg";
    $("#st-newpw").value = $("#st-newpw2").value = "";
    renderDlDir();
    $("#settings-modal").classList.remove("hidden");
  }
  function closeSettings() { $("#settings-modal").classList.add("hidden"); }

  $("#btn-settings").addEventListener("click", openSettings);
  $("#st-close").addEventListener("click", closeSettings);
  $("#settings-modal").addEventListener("click", (e) => { if (e.target.id === "settings-modal") closeSettings(); });

  // 修改密码（设置菜单内）：无需当前密码；成功后服务端已登出 → 回登录页重新登录
  $("#st-pw-btn").addEventListener("click", () => doChangePassword({
    nw: $("#st-newpw"), nw2: $("#st-newpw2"), msg: $("#st-msg"),
  }));

  /* ---------------- 首次登录强制修改密码 ---------------- */
  function openForceModal() {
    $("#fc-newpw").value = $("#fc-newpw2").value = "";
    $("#fc-msg").textContent = ""; $("#fc-msg").className = "st-msg";
    $("#force-modal").classList.remove("hidden");
    setTimeout(() => $("#fc-newpw").focus(), 120);
  }
  function closeForceModal() { $("#force-modal").classList.add("hidden"); }

  $("#fc-btn").addEventListener("click", async () => {
    const ok = await doChangePassword({
      nw: $("#fc-newpw"), nw2: $("#fc-newpw2"), msg: $("#fc-msg"),
    });
    if (ok) {
      closeForceModal();
      await fetch("api/logout", { method: "POST" });
      state.selected.clear(); state.currentPath = "";
      showLogin();
      toast("密码修改成功，请用新密码重新登录");
    }
  });

  async function doChangePassword(els) {
    const msg = els.msg;
    const nw = els.nw.value, nw2 = els.nw2.value;
    msg.textContent = ""; msg.className = "st-msg";
    if (nw.length < 6) { msg.textContent = "新密码至少 6 位"; msg.className = "st-msg err"; return false; }
    if (nw !== nw2) { msg.textContent = "两次输入的新密码不一致"; msg.className = "st-msg err"; return false; }
    try {
      const r = await fetch("api/password", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword: nw }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) return true;
      msg.textContent = j.error || "修改失败"; msg.className = "st-msg err";
      return false;
    } catch (e) {
      msg.textContent = "网络错误：" + e.message; msg.className = "st-msg err";
      return false;
    }
  }

  /* ---------------- 列表 ---------------- */
  async function loadList(rel) {
    state.currentPath = rel || "";
    state.selected.clear();
    updateSelButtons();
    const r = await fetch("api/list?path=" + encodeURIComponent(state.currentPath));
    if (!r.ok) { toast("加载失败"); return; }
    const j = await r.json();
    state.items = j.entries || [];
    renderBreadcrumb(state.currentPath);
    renderList();
  }

  /* ---------------- 搜索（递归模糊） ---------------- */
  function exitSearch() {
    if (state.mode !== "search") return;
    state.mode = "browse";
    $("#search-clear").classList.add("hidden");
    $("#search-input").value = "";
  }

  async function runSearch(q) {
    const r = await fetch("api/search?q=" + encodeURIComponent(q));
    if (!r.ok) { toast("搜索失败"); return; }
    const j = await r.json();
    state.mode = "search";
    state.currentPath = "";
    state.selected.clear();
    updateSelButtons();
    state.items = j.results || [];
    $("#search-clear").classList.remove("hidden");

    // 面包屑显示搜索态
    const bc = $("#breadcrumb");
    bc.innerHTML = "";
    const back = document.createElement("span");
    back.className = "crumb home";
    back.textContent = "🏠 返回浏览";
    back.onclick = () => { exitSearch(); loadList(""); };
    bc.appendChild(back);
    const info = document.createElement("span");
    info.className = "crumb current";
    info.textContent = `「${q}」${j.truncated ? " 的搜索结果（仅前 " + j.total + " 条）" : " 的搜索结果 " + j.total + " 项"}`;
    bc.appendChild(info);

    renderList();
  }

  $("#search-input").addEventListener("input", (e) => {
    const q = e.target.value.trim();
    clearTimeout(state.searchTimer);
    if (!q) { exitSearch(); loadList(state.currentPath || ""); return; }
    state.searchTimer = setTimeout(() => runSearch(q), 350); // 输入防抖
  });
  $("#search-clear").addEventListener("click", () => {
    exitSearch(); loadList(state.currentPath || "");
    $("#search-input").focus();
  });

  /* ---------------- 排序控件 ---------------- */
  $("#sort-select").value = state.sortBy;
  $("#sort-dir").textContent = state.sortAsc ? "↑" : "↓";
  $("#sort-select").addEventListener("change", (e) => {
    state.sortBy = e.target.value; saveSortPref(); renderList();
  });
  $("#sort-dir").addEventListener("click", () => {
    state.sortAsc = !state.sortAsc;
    $("#sort-dir").textContent = state.sortAsc ? "↑" : "↓";
    $("#sort-dir").title = state.sortAsc ? "当前升序，点击切换降序" : "当前降序，点击切换升序";
    saveSortPref(); renderList();
  });

  function renderBreadcrumb(rel) {
    const bc = $("#breadcrumb");
    bc.innerHTML = "";
    const home = document.createElement("span");
    home.className = "crumb home"; home.textContent = "🏠 根目录";
    home.onclick = () => loadList("");
    bindCrumbDrop(home, "");
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
        else {
          c.className = "crumb"; c.textContent = p; c.onclick = () => loadList(acc);
          bindCrumbDrop(c, acc);   // 拖到面包屑上 = 移动到那一层目录
        }
        bc.appendChild(c);
      });
    }
  }

  // 面包屑也可作为拖放目标（拖到哪一层的名字上，就移动到那一层）
  function bindCrumbDrop(el, target) {
    el.addEventListener("dragover", (e) => {
      if (!state.dragRels.length) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      el.classList.add("crumb-drop");
    });
    el.addEventListener("dragleave", () => el.classList.remove("crumb-drop"));
    el.addEventListener("drop", async (e) => {
      e.preventDefault();
      el.classList.remove("crumb-drop");
      const rels = state.dragRels.slice();
      state.dragRels = [];
      if (!rels.length) return;
      await moveTo(target, rels);
    });
  }

  function renderList() {
    const box = $("#filelist");
    box.innerHTML = "";
    const items = sortedItems(state.items);
    $("#tb-count").textContent = items.length
      ? `共 ${items.length} 项` : "";
    if (!items.length) {
      box.innerHTML = state.mode === "search"
        ? '<div class="empty"><div class="empty-ico">🔍</div><div class="empty-t">没有匹配的文件</div><div class="empty-s">换个关键词试试</div></div>'
        : '<div class="empty"><div class="empty-ico">📭</div><div class="empty-t">这个文件夹是空的</div><div class="empty-s">把文件拖进来，或点上方「上传」</div></div>';
      return;
    }
    items.forEach((it) => {
      const rel = state.mode === "search"
        ? (it.dir ? it.dir + "/" + it.name : it.name)
        : (state.currentPath ? state.currentPath + "/" + it.name : it.name);
      const k = kindOf(it.name, it.type);
      const locTag = state.mode === "search"
        ? `<span class="loc">📂 /${esc(it.dir || "根目录")}</span>` : "";

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
        <div class="sub">${locTag}${it.type === "dir"
          ? "文件夹"
          : `${fmtSize(it.size)} · <span title="上传时间">上传于 ${fmtTime(it.mtime)}</span>`}</div>`;
      meta.onclick = () => {
        if (it.type === "dir") {
          const target = state.mode === "search" ? rel : rel; // 搜索结果同样进入其真实目录
          exitSearch();
          loadList(target);
        } else {
          previewFile(rel, it.name, it.size);
        }
      };
      row.appendChild(meta);

      // 拖动：把文件/文件夹拖到文件夹行上松手即可移动（多选时整批移动）
      row.draggable = true;
      row.addEventListener("dragstart", (e) => {
        const rels = (state.selected.has(rel) && state.selected.size > 1) ? [...state.selected] : [rel];
        state.dragRels = rels;
        e.dataTransfer.effectAllowed = "move";
        try { e.dataTransfer.setData("text/plain", rels.join("\n")); } catch (_) {}
        row.classList.add("dragging");
      });
      row.addEventListener("dragend", () => {
        row.classList.remove("dragging");
        state.dragRels = [];
        clearDropHover();
      });
      if (it.type === "dir") {
        row.addEventListener("dragover", (e) => {
          if (!state.dragRels.length || state.dragRels.includes(rel)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          row.classList.add("drop-hover");
        });
        row.addEventListener("dragleave", () => row.classList.remove("drop-hover"));
        row.addEventListener("drop", async (e) => {
          e.preventDefault();
          row.classList.remove("drop-hover");
          let rels = state.dragRels.slice();
          if (!rels.length) {
            rels = (e.dataTransfer.getData("text/plain") || "").split("\n").filter(Boolean);
          }
          state.dragRels = [];
          if (!rels.length || rels.includes(rel)) return;
          await moveTo(rel, rels);
        });
      }

      const acts = document.createElement("div");
      acts.className = "acts";

      const rn = document.createElement("button");
      rn.className = "icon-btn"; rn.textContent = "✏️"; rn.title = "重命名";
      rn.onclick = () => openRenameModal(rel, it.name, it.type);
      acts.appendChild(rn);

      if (it.type === "file") {
        const sh = document.createElement("button");
        sh.className = "icon-btn"; sh.textContent = "🔗"; sh.title = "生成分享链接（免登录下载）";
        sh.onclick = () => openShareModal(rel, it.name);
        acts.appendChild(sh);
      }

      const dl = document.createElement("button");
      dl.className = "icon-btn"; dl.textContent = "⬇️"; dl.title = "下载";
      dl.onclick = () => downloadFile(rel, it.name);
      acts.appendChild(dl);

      const del = document.createElement("button");
      del.className = "icon-btn danger"; del.textContent = "🗑"; del.title = "删除";
      del.onclick = async () => {
        if (!confirm(`确定删除「${it.name}」？此操作不可恢复。`)) return;
        await fetch("api/delete", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paths: [rel] }) });
        toast("已删除"); loadList(state.currentPath); loadQuota();
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

  // 右下角的更新按钮：默认悬在页脚栏上方（版本徽标在页脚内居中），
  // 上传面板弹出时自动上移，避免被挡住
  function layoutVerFloat() {
    const f = $("#ver-float"), p = $("#upload-panel");
    if (!f) return;
    const ft = document.querySelector(".footer");
    const base = (ft ? ft.offsetHeight : 40) + 12;
    f.style.bottom = (p && !p.classList.contains("hidden")) ? (p.offsetHeight + 28) + "px" : base + "px";
  }
  if ($("#upload-panel") && window.MutationObserver) {
    new MutationObserver(layoutVerFloat).observe($("#upload-panel"), { attributes: true, attributeFilter: ["class"] });
  }
  layoutVerFloat();
  window.addEventListener("resize", layoutVerFloat);

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
        const r = await withRetry(() => xhrSend("api/upload?path=" + encodeURIComponent(state.currentPath), fd));
        const rn = (r && r.renamed && r.renamed[0]) || null;
        item.done(rn ? `完成 · 已重命名为「${rn.to}」` : "完成");
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

      // 1) 询问服务端：续传会话 / 已收到哪些分片（同名文件由服务端自动改名，绝不跳过）
      const st = await withRetry(() => postJSON("api/upload_status", payload));

      // 云盘里已有同名文件 → 服务端会自动改名保存，这里提前告知最终文件名
      const finalName = st.finalName || file.name;
      if (finalName !== file.name) {
        item.status(`已存在同名文件，将保存为「${finalName}」`, "resume");
      }

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
          xhrSend(`api/upload_chunk?uploadId=${uploadId}&index=${i}`, blob, {
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
      const fin = await withRetry(() => xhrSend("api/upload_finalize?uploadId=" + uploadId, null));
      const savedName = (fin && fin.name) || finalName;
      item.done(savedName !== file.name ? `完成 · 已重命名为「${savedName}」` : "完成");
      return { ok: true, savedName };
    } catch (e) {
      // 失败不清理服务端已收分片，下次重选同一文件自动从断点继续
      if (e.code === "quota") {
        item.fail("云盘容量不足，上传已停止");
        uploadFiles.quotaHit = true;
        return { ok: false, quota: true };
      }
      item.fail(`失败（${e.message}）。已保留进度，重新选择同一文件将自动续传`);
      return { ok: false, err: e };
    }
  }

  async function uploadFiles(files) {
    if (!files || !files.length) return;
    ensurePanel();
    let ok = 0, fail = 0, renamed = 0;
    for (const f of files) {
      const r = await uploadOne(f);
      if (r.quota) break;               // 容量不足：停止后续上传
      if (r.ok) { ok++; if (r.savedName && r.savedName !== f.name) renamed++; }
      else fail++;
    }
    loadList(state.currentPath);
    loadQuota();   // 上传后刷新容量显示
    if (uploadFiles.quotaHit) {
      uploadFiles.quotaHit = false;
      toast("云盘剩余容量不足，上传已停止；可删除部分文件后重试");
      const p = $("#upload-panel"); p.classList.add("hidden"); $("#up-list").innerHTML = "";
      return;
    }
    let msg = `上传完成：成功 ${ok}`;
    if (renamed) msg += `，${renamed} 个重名已自动改名`;
    if (fail) msg += `，失败 ${fail}`;
    toast(msg);

    // 全部成功后稍等片刻自动收起面板；有失败则保留，方便查看错误
    if (fail === 0) {
      clearTimeout(uploadFiles._t);
      uploadFiles._t = setTimeout(() => {
        const p = $("#upload-panel");
        p.classList.add("hidden");
        $("#up-list").innerHTML = "";
      }, 2500);
    }
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

  /* ---------------- 文件预览 ---------------- */
  // 高亮 / Markdown 库已本地化到 static/vendor/，不再依赖 CDN（大陆网络下 jsdelivr 经常加载失败导致代码不着色）
  const PV_LIB = {
    marked: "vendor/marked.min.js",
    hljs: "vendor/highlight.min.js",
    hljsCss: "vendor/github-dark.min.css",
  };
  function loadScript(src) {
    return new Promise((res, rej) => {
      if (document.querySelector(`script[data-src="${src}"]`)) return res();
      const s = document.createElement("script");
      s.src = src; s.dataset.src = src;
      s.onload = res; s.onerror = () => rej(new Error("脚本加载失败"));
      document.head.appendChild(s);
    });
  }
  function loadCss(href) {
    if (document.querySelector(`link[data-href="${href}"]`)) return;
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = href; l.dataset.href = href;
    document.head.appendChild(l);
  }

  const PV_IMG = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico"];
  const PV_VIDEO = ["mp4", "webm", "mov", "m4v"];
  const PV_AUDIO = ["mp3", "wav", "flac", "m4a", "aac", "ogg", "opus"];
  const PV_TEXT = ["txt", "md", "log", "csv", "json", "js", "ts", "jsx", "tsx", "py", "java", "go", "c", "h", "cpp", "cs", "sh", "bat", "html", "htm", "css", "xml", "yml", "yaml", "ini", "conf", "sql", "lua"];
  // 代码类：不换行、带行号、横向滚动（保持代码结构不被硬折断）
  const PV_CODE = ["json", "js", "ts", "jsx", "tsx", "py", "java", "go", "c", "h", "cpp", "cs", "sh", "bat", "html", "htm", "css", "xml", "yml", "yaml", "ini", "conf", "sql", "lua"];

  function closePreview() {
    $("#preview-modal").classList.add("hidden");
    $("#pv-body").innerHTML = ""; // 停止视频/音频播放
    $("#pv-hbar").classList.add("hidden");
  }
  $("#pv-close").addEventListener("click", closePreview);
  $("#preview-modal").addEventListener("click", (e) => { if (e.target.id === "preview-modal") closePreview(); });

  /* 常驻横向滚动条：内容过宽时固定显示在预览卡片底部（无需滚到最底部才能拖动） */
  function setupPvHbar() {
    const body = $("#pv-body"), bar = $("#pv-hbar"), space = $("#pv-hbar-space");
    const wide = body.scrollWidth > body.clientWidth + 1;
    bar.classList.toggle("hidden", !wide);
    if (!wide) return;
    space.style.width = body.scrollWidth + "px";
    bar.scrollLeft = body.scrollLeft;
  }
  $("#pv-body").addEventListener("scroll", () => { $("#pv-hbar").scrollLeft = $("#pv-body").scrollLeft; });
  $("#pv-hbar").addEventListener("scroll", () => { $("#pv-body").scrollLeft = $("#pv-hbar").scrollLeft; });
  window.addEventListener("resize", () => {
    if (!$("#preview-modal").classList.contains("hidden")) setupPvHbar();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("#force-modal").classList.contains("hidden")) return;   // 强制改密弹窗不可 Esc 关闭
    if (!$("#preview-modal").classList.contains("hidden")) closePreview();
    if (!$("#share-modal").classList.contains("hidden")) closeShareModal();
    if (!$("#shares-modal").classList.contains("hidden")) closeSharesModal();
    if (!$("#settings-modal").classList.contains("hidden")) closeSettings();
    if (!$("#rename-modal").classList.contains("hidden")) closeRenameModal();
    // 更新进行中不允许 Esc 关闭（避免用户以为失败而重复触发）
    if (!$("#update-modal").classList.contains("hidden") && !$("#up-go").disabled) closeUpdateModal();
  });

  function previewFile(rel, name, size) {
    const ext = (String(name).split(".").pop() || "").toLowerCase();
    const src = "api/download?inline=1&path=" + encodeURIComponent(rel);
    const body = $("#pv-body");
    $("#pv-title").textContent = name;
    $("#pv-title").title = name;
    $("#pv-ico").textContent = kindOf(name, "file").icon;
    $("#pv-size").textContent = size !== undefined ? fmtSize(size) : "";
    $("#pv-download").onclick = () => downloadFile(rel, name);
    $("#pv-share").onclick = () => openShareModal(rel, name);
    body.innerHTML = "";
    $("#preview-modal").classList.remove("hidden");

    if (PV_IMG.includes(ext)) {
      body.innerHTML = `<div class="pv-center"><img class="pv-img" src="${src}" alt=""></div>`;
    } else if (PV_VIDEO.includes(ext)) {
      body.innerHTML = `<div class="pv-center"><video class="pv-media" src="${src}" controls autoplay></video></div>`;
    } else if (PV_AUDIO.includes(ext)) {
      body.innerHTML = `<div class="pv-center"><div class="pv-audio-wrap"><div class="pv-audio-ico">🎵</div><audio class="pv-media" src="${src}" controls autoplay></audio></div></div>`;
    } else if (ext === "pdf") {
      body.innerHTML = `<iframe class="pv-frame" src="${src}"></iframe>`;
    } else if (PV_TEXT.includes(ext)) {
      renderTextPreview(src, ext);
    } else {
      body.innerHTML = `<div class="pv-center pv-unsupported">
        <div class="pv-uns-ico">📦</div>
        <div class="pv-uns-t">该类型暂不支持在线预览</div>
        <button class="btn primary" id="pv-dl2">⬇️ 下载该文件</button></div>`;
      body.querySelector("#pv-dl2").onclick = () => downloadFile(rel, name);
    }
  }

  async function renderTextPreview(src, ext) {
    const body = $("#pv-body");
    body.innerHTML = `<div class="pv-center pv-loading">加载中…</div>`;
    try {
      const r = await fetch(src);
      if (!r.ok) throw new Error("HTTP " + r.status);
      let text = await r.text();
      const LIMIT = 2 * 1024 * 1024;
      if (text.length > LIMIT) text = text.slice(0, LIMIT) + "\n\n…（内容过大，仅显示前 2MB）";
      loadCss(PV_LIB.hljsCss);
      if (ext === "md") {
        await loadScript(PV_LIB.marked);
        await loadScript(PV_LIB.hljs);
        body.innerHTML = `<div class="pv-doc md-body"></div>`;
        const div = body.querySelector(".md-body");
        div.innerHTML = marked.parse(text);
        div.querySelectorAll("pre code").forEach((el) => { try { hljs.highlightElement(el); } catch (_) {} });
      } else if (PV_CODE.includes(ext)) {
        // 代码：等宽字体 + 行号栏（sticky 左侧，横向滚动时行号保持可见）+ 不换行
        await loadScript(PV_LIB.hljs);
        const lines = text.split("\n").length;
        body.innerHTML =
          `<div class="pv-code">` +
          `<div class="pv-gutter" aria-hidden="true">${Array.from({ length: lines }, (_, i) => i + 1).join("\n")}</div>` +
          `<pre class="pv-doc code-body"><code class="hljs"></code></pre>` +
          `</div>`;
        const code = body.querySelector("code");
        code.textContent = text;
        try { hljs.highlightElement(code); } catch (_) {}
      } else {
        await loadScript(PV_LIB.hljs);
        body.innerHTML = `<pre class="pv-doc code-body"><code class="hljs"></code></pre>`;
        const code = body.querySelector("code");
        code.textContent = text;
        try { hljs.highlightElement(code); } catch (_) {}
      }
      setupPvHbar();   // 内容过宽时显示常驻横向滚动条
    } catch (e) {
      body.innerHTML = `<div class="pv-center pv-unsupported">预览加载失败：${esc(e.message)}</div>`;
      $("#pv-hbar").classList.add("hidden");
    }
  }

  /* ---------------- 下载（保持单连接，稳定性优先） ---------------- */
  async function saveToDir(rel, name) {
    if (!state.dlDir || !state.dlDir.getFileHandle) return false;
    try {
      const fh = await state.dlDir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      const resp = await fetch("api/download?path=" + encodeURIComponent(rel));
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
    a.href = "api/download?path=" + encodeURIComponent(rel);
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
      renderDlDir();
      toast(`下载目录已设为：${dir.name}`);
    } catch (_) { /* 用户取消 */ }
  });

  // 设置 → 下载保存目录：显示当前所选目录
  function renderDlDir() {
    const el = $("#dl-dir-name");
    if (el) el.textContent = state.dlDir ? state.dlDir.name : "默认下载位置";
  }

  /* ---------------- 新建文件夹 ---------------- */
  $("#btn-mkdir").addEventListener("click", async () => {
    const name = prompt("新建文件夹名称：");
    if (!name) return;
    const r = await fetch("api/mkdir", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: state.currentPath, name }) });
    if (r.ok) { toast("已创建"); loadList(state.currentPath); }
    else { const j = await r.json().catch(() => ({})); toast(j.error || "创建失败"); }
  });

  /* ---------------- 移动（拖动到文件夹 / 面包屑） ---------------- */
  function clearDropHover() {
    document.querySelectorAll(".row.drop-hover").forEach((el) => el.classList.remove("drop-hover"));
    document.querySelectorAll(".crumb-drop").forEach((el) => el.classList.remove("crumb-drop"));
  }
  function targetName(t) { return t ? String(t).split("/").pop() : "根目录"; }

  async function moveTo(target, rels) {
    const r = await fetch("api/move", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: rels, target }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { toast(j.error || "移动失败"); return; }
    const n = (j.moved || []).length;
    const errs = j.errors || [];
    if (errs.length) toast(`已移动 ${n} 项，${errs.length} 项失败：${errs[0]}`);
    else if (n) toast(`已移动 ${n} 项到「${targetName(target)}」`);
    else toast("已经在目标位置了");
    state.selected.clear(); updateSelButtons();
    loadList(state.currentPath);
    loadQuota();
  }

  /* ---------------- 重命名 ---------------- */
  let renameState = { rel: "", name: "", type: "file" };

  function openRenameModal(rel, name, type) {
    renameState = { rel, name, type: type || "file" };
    $("#rn-kind").textContent = (type === "dir" ? "📁 " : "📄 ") + name;
    $("#rn-name").value = name;
    $("#rn-msg").textContent = ""; $("#rn-msg").className = "st-msg";
    $("#rename-modal").classList.remove("hidden");
    setTimeout(() => { const i = $("#rn-name"); i.focus(); i.select(); }, 120);
  }
  function closeRenameModal() { $("#rename-modal").classList.add("hidden"); }

  $("#rn-close").addEventListener("click", closeRenameModal);
  $("#rn-cancel").addEventListener("click", closeRenameModal);
  $("#rename-modal").addEventListener("click", (e) => { if (e.target.id === "rename-modal") closeRenameModal(); });
  $("#rn-ok").addEventListener("click", submitRename);
  $("#rn-name").addEventListener("keydown", (e) => { if (e.key === "Enter") submitRename(); });

  async function submitRename() {
    const name = $("#rn-name").value.trim();
    const msg = $("#rn-msg");
    if (!name) { msg.textContent = "名称不能为空"; msg.className = "st-msg err"; return; }
    if (name === renameState.name) { closeRenameModal(); return; }
    const r = await fetch("api/rename", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: renameState.rel, name }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { msg.textContent = j.error || "重命名失败"; msg.className = "st-msg err"; return; }
    closeRenameModal();
    toast("已重命名");
    loadList(state.currentPath);
  }

  /* ---------------- 版本显示 & 一键更新 ---------------- */
  async function loadVersion(force, retry) {
    // 1) 先取本地版本（/api/ping 不访问外网，版本号秒出）
    try {
      const p = await fetch("api/ping?" + Date.now());
      if (p.ok) {
        const pj = await p.json();
        if (pj.version) { state.ver = Object.assign({}, state.ver, { current: pj.version }); renderVersion(); }
      }
    } catch (_) {}
    // 2) 再查远端最新版本（服务端后台检测，可能要等一会儿）
    try {
      const r = await fetch("api/version" + (force ? "?force=1" : ""));
      if (!r.ok) return;
      const j = await r.json();
      state.ver = Object.assign({}, state.ver, j);
      renderVersion();
      // 服务端还在检测中：过几秒再取一次结果（最多 6 次）
      if (j.checking && !j.latest && !j.error && (retry || 0) < 6) {
        setTimeout(() => loadVersion(false, (retry || 0) + 1), 5000);
      }
    } catch (_) {}
  }

  function renderVersion() {
    const v = state.ver || {};
    const badge = $("#ver-badge");
    if (badge) {
      badge.textContent = "v" + (v.current || "—");
      badge.title = v.hasUpdate ? `当前 v${v.current}，最新 v${v.latest}` : `当前项目版本 v${v.current}`;
    }
    const btn = $("#btn-update");
    if (btn) {
      if (v.hasUpdate) { btn.classList.remove("hidden"); btn.textContent = `🆕 更新到 v${v.latest}`; }
      else btn.classList.add("hidden");
    }
  }

  function openUpdateModal() {
    const v = state.ver || {};
    $("#up-cur").textContent = "v" + (v.current || "—");
    $("#up-new").textContent = "v" + (v.latest || "—");
    const box = $("#up-changes");
    const txt = (v.changelog || "").trim();
    box.innerHTML = "";
    if (!txt) {
      box.innerHTML = '<div class="st-hint">暂未获取到该版本的详细变更说明，可直接更新。</div>';
    } else {
      txt.split("\n").forEach((ln) => {
        const s = ln.trim();
        if (!s) return;
        const div = document.createElement("div");
        const isItem = /^[-*•]\s?/.test(s);
        div.className = "up-line " + (isItem ? "up-item" : "up-head");
        div.textContent = s.replace(/^[-*•]\s?/, "");
        box.appendChild(div);
      });
    }
    $("#up-msg").textContent = ""; $("#up-msg").className = "st-msg";
    $("#up-go").disabled = false; $("#up-go").textContent = "立即更新";
    $("#up-cancel").textContent = "以后再说";
    $("#update-modal").classList.remove("hidden");
  }
  function closeUpdateModal() { $("#update-modal").classList.add("hidden"); }

  $("#btn-update").addEventListener("click", openUpdateModal);
  $("#up-close").addEventListener("click", closeUpdateModal);
  $("#up-cancel").addEventListener("click", closeUpdateModal);
  $("#update-modal").addEventListener("click", (e) => {
    if (e.target.id === "update-modal" && !$("#up-go").disabled) closeUpdateModal();
  });

  $("#up-go").addEventListener("click", async () => {
    const go = $("#up-go"), msg = $("#up-msg");
    const from = (state.ver || {}).current;
    go.disabled = true; go.textContent = "正在更新…";
    $("#up-cancel").textContent = "后台进行中";
    msg.textContent = "正在下载并更新，完成后服务会自动重启，请稍候…";
    msg.className = "st-msg";
    try {
      const r = await fetch("api/update", { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        go.disabled = false; go.textContent = "重试更新";
        $("#up-cancel").textContent = "以后再说";
        msg.textContent = j.error || "更新启动失败"; msg.className = "st-msg err";
        return;
      }
    } catch (e) {
      go.disabled = false; go.textContent = "重试更新";
      msg.textContent = "网络错误：" + e.message; msg.className = "st-msg err";
      return;
    }
    // 轮询等待服务重启（/api/ping 无需登录，重启后也能拿到版本号）
    let done = false;
    for (let i = 0; i < 40; i++) {
      await sleep(3000);
      try {
        const r = await fetch("api/ping?" + Date.now());
        if (!r.ok) continue;
        const j = await r.json();
        if (j.version && j.version !== from) { done = true; break; }
      } catch (_) { /* 服务重启中，继续等 */ }
    }
    if (done) {
      msg.textContent = "更新完成！正在刷新页面（需重新登录一次）…";
      msg.className = "st-msg ok";
      setTimeout(() => location.reload(), 1500);
    } else {
      go.disabled = false; go.textContent = "重试更新";
      $("#up-cancel").textContent = "以后再说";
      msg.textContent = "未能确认更新结果，请稍后刷新页面看版本号，或在服务器执行：bash scripts/update.sh";
      msg.className = "st-msg err";
    }
  });

  /* ---------------- 删除选中 ---------------- */
  $("#btn-del").addEventListener("click", async () => {
    const list = [...state.selected];
    if (!list.length) return;
    if (!confirm(`确定删除选中的 ${list.length} 项？不可恢复。`)) return;
    const r = await fetch("api/delete", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: list }) });
    if (r.ok) { toast("已删除"); loadList(state.currentPath); loadQuota(); }
    else toast("删除失败");
  });

  boot();
})();
