// Agoryx web UI — a thin view over the local daemon. The daemon owns the room
// (event log, projection, agents); this page renders snapshots + SSE patches.

const root = document.getElementById("root");

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const clock = (iso) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const fullDate = (iso) => new Date(iso).toLocaleString("uk-UA", { dateStyle: "medium", timeStyle: "short" });

const secs = (ms) => {
  if (ms == null) return "";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} с` : `${Math.floor(s / 60)} хв ${String(s % 60).padStart(2, "0")} с`;
};

const plural = (n, one, few, many) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} ${one}`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
};

const ago = (iso) => {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "щойно";
  if (diff < 3600) return `${Math.floor(diff / 60)} хв`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} год`;
  return new Date(iso).toLocaleDateString("uk-UA", { day: "numeric", month: "short" });
};

const shortPath = (path) => {
  const parts = String(path).split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
};

const ext = (path) => {
  const m = /\.([a-z0-9]+)$/i.exec(path ?? "");
  return m ? m[1].toLowerCase() : "";
};
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "ico"]);
const FRAME_EXT = new Set(["html", "htm", "pdf"]);

const ICON = {
  brand:
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5.5" r="3.2"/><circle cx="5.5" cy="17" r="3.2"/><circle cx="18.5" cy="17" r="3.2"/><path d="M12 11.5 8 16h8z" opacity=".35"/></svg>',
  claude:
    '<svg viewBox="0 0 20 20" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M10 3v14M3.9 6.5l12.2 7M3.9 13.5l12.2-7"/></svg>',
  codex:
    '<svg viewBox="0 0 20 20" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 5 3 10l4 5M13 5l4 5-4 5"/></svg>',
  menu: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M3 6h14M3 10h14M3 14h14"/></svg>',
  terminal:
    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="3.5" width="15" height="13" rx="2.5"/><path d="m6 8 2.5 2L6 12M10.5 12.5H14"/></svg>',
  gear: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="2.6"/><path d="M10 2.5v2M10 15.5v2M17.5 10h-2M4.5 10h-2M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4M15.3 15.3l-1.4-1.4M6.1 6.1 4.7 4.7"/></svg>',
  folder:
    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6a1.5 1.5 0 0 1 1.5-1.5h3.5l2 2H16A1.5 1.5 0 0 1 17.5 8v6.5A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5z"/></svg>',
  q: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="10" cy="10" r="7.5"/><path d="M7.8 7.8a2.3 2.3 0 1 1 3.2 2.1c-.6.3-1 .8-1 1.4v.4M10 14.2v.1"/></svg>',
  plus: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M10 4v12M4 10h12"/></svg>',
  pin: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 10.5 4 4 8-9"/></svg>',
  step: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10h11M11 6l4 4-4 4"/></svg>',
  file: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true" width="14" height="14"><path d="M5 2.5h6l4 4v11H5z"/><path d="M11 2.5v4h4"/></svg>',
};

// ---------------------------------------------------------------------------
// Markdown (escape first, then a small safe subset)
// ---------------------------------------------------------------------------

const inline = (raw, ctx) => {
  const slots = [];
  const keep = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = String(raw).replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${esc(code)}</code>`));
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, text, url) =>
    keep(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`),
  );
  s = s.replace(/\bhttps?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?]/g, (url) =>
    keep(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`),
  );
  s = esc(s);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^\w@])@([a-z][\w-]*)/gi, (m, pre, name) => {
    const who = ctx?.participant?.(name.toLowerCase());
    if (!who) return m;
    return `${pre}<span class="at ${who.cls}">@${esc(name)}</span>`;
  });
  s = s.replace(/\b([QPDNXSF]\d{1,3})\b/g, (m) => (ctx?.refs?.has(m) ? `<span class="at ref" role="link" tabindex="0" data-act="ref" data-ref="${m}">${m}</span>` : m));
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)]);
};

const markdown = (raw, ctx) => {
  const text = String(raw ?? "").replace(/\r\n?/g, "\n");
  const out = [];
  const lines = text.split("\n");
  let i = 0;
  const isList = (line) => /^\s*([-*+]|\d+[.)])\s+/.test(line);
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const body = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i += 1;
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(4, heading[1].length + 1);
      out.push(`<h${level}>${inline(heading[2], ctx)}</h${level}>`);
      i += 1;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${markdown(body.join("\n"), ctx)}</blockquote>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const row = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
      const head = row(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(row(lines[i++]));
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c, ctx)}</th>`).join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c, ctx)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`,
      );
      continue;
    }
    if (isList(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items = [];
      while (i < lines.length && (isList(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (isList(lines[i])) items.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ""));
        else items[items.length - 1] += `\n${lines[i].trim()}`;
        i += 1;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((item) => `<li>${inline(item, ctx).replace(/\n/g, "<br>")}</li>`).join("")}</${tag}>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^#{1,4}\s/.test(lines[i]) && !isList(lines[i]) && !/^\s*>/.test(lines[i])) {
      para.push(lines[i++]);
    }
    out.push(`<p>${para.map((l) => inline(l, ctx)).join("<br>")}</p>`);
  }
  return out.join("");
};

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

class Unauthorized extends Error {}

const api = async (method, path, body) => {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (response.status === 401) {
    showGate();
    throw new Unauthorized(data.error ?? "unauthorized");
  }
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
};

const roomPath = (suffix = "") => `/api/rooms/${encodeURIComponent(S.roomId)}${suffix}`;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const S = {
  rooms: [],
  roomId: null,
  snap: null, // { state, presence, streams, resume, driven, lockedBy, ops, rawBase }
  tab: "conv",
  openTraces: new Set(),
  seenMessages: new Set(),
  firstPaint: true,
  es: null,
  reconnectTimer: null,
  dirty: new Set(),
  frame: 0,
  sheet: null,
};

const state = () => S.snap?.state;

const participant = (handle) => {
  const st = state();
  if (!st) return null;
  const agent = st.agents.find((a) => a.id === handle);
  if (agent) return { id: agent.id, label: agent.label, kind: agent.kind, cls: agent.kind === "codex" ? "cx" : "cl", agent: true };
  if (handle === st.human || handle === st.human.toLowerCase()) return { id: st.human, label: st.human, cls: "hu", agent: false };
  if (handle === "agoryx") return { id: "agoryx", label: "Agoryx", cls: "sys", agent: false };
  return null;
};

const mdCtx = () => {
  const st = state();
  const refs = new Set();
  if (st) {
    for (const q of st.table.questions) refs.add(q.id);
    for (const o of st.table.options) refs.add(o.id);
    for (const list of [st.table.notes, st.table.facts, st.table.settled, st.table.next]) for (const item of list) refs.add(item.id);
  }
  return { participant, refs };
};

const avatar = (handle, size = 30) => {
  const who = participant(handle) ?? { label: handle || "?", cls: "hu", agent: false };
  const working = who.agent && S.snap?.presence?.[who.id] === "working" ? " working" : "";
  const s = `s${size}`;
  if (who.agent) {
    return `<span class="av ag ${who.cls} ${s}${working}" style="--s:${size}px" title="${esc(who.label)}" aria-hidden="true">${who.kind === "codex" ? ICON.codex : ICON.claude}</span>`;
  }
  if (who.cls === "sys") return `<span class="av sys ${s}" style="--s:${size}px" aria-hidden="true">${ICON.brand}</span>`;
  return `<span class="av ${s}" style="--s:${size}px" title="${esc(who.label)}" aria-hidden="true">${esc(who.label.slice(0, 1).toUpperCase())}</span>`;
};

const nameOf = (handle) => participant(handle)?.label ?? handle;

// ---------------------------------------------------------------------------
// Render scheduling
// ---------------------------------------------------------------------------

const invalidate = (...parts) => {
  for (const part of parts) S.dirty.add(part);
  if (!S.frame) S.frame = requestAnimationFrame(flush);
};

const flush = () => {
  S.frame = 0;
  const parts = new Set(S.dirty);
  S.dirty.clear();
  if (parts.has("side")) renderSide();
  if (!S.snap) return;
  if (parts.has("header")) renderHeader();
  if (parts.has("feed")) renderFeed();
  if (parts.has("runbar")) renderRunbar();
  if (parts.has("table")) renderTable();
};

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

let els = {};

const buildShell = () => {
  root.innerHTML = `
  <div class="app" id="app">
    <aside class="side" id="side" aria-label="Кімнати">
      <div class="brand">${ICON.brand}<span>Agoryx</span></div>
      <nav class="grp" id="roomList"></nav>
      <div class="foot" id="sideFoot">Кожен агент працює у своїй рідній сесії. Ця сторінка — лише вікно в кімнату; <code>agoryx tail -f</code> показує те саме в терміналі.</div>
    </aside>
    <div class="scrimnav" data-act="nav"></div>
    <main class="main">
      <header class="mh" id="mh"></header>
      <div class="view">
        <section class="conv" id="conv">
          <div class="feed" id="feed"><div class="feed-in" id="feedIn"></div></div>
          <div class="composer">
            <div class="cwrap">
              <div class="runbar" id="runbar"></div>
              <form class="cbox" id="cform" autocomplete="off">
                <textarea id="ctext" rows="1" placeholder="Напишіть у кімнату — агенти прочитають і відповідять" aria-label="Повідомлення"></textarea>
                <button class="primary" id="csend" type="submit">Надіслати</button>
                <div class="ctools" id="ctools"></div>
              </form>
            </div>
          </div>
        </section>
        <section class="tview" id="tview" hidden></section>
        <section class="nowroom" id="noroom" hidden></section>
      </div>
    </main>
  </div>
  <div class="scrim" id="scrim" data-act="close-sheet"></div>
  <aside class="sheet" id="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle">
    <div class="sh-h"><div style="min-width:0"><b id="sheetTitle"></b><div class="sub" id="sheetSub"></div></div><button class="close" data-act="close-sheet">Закрити</button></div>
    <div class="sh-b" id="sheetBody"></div>
  </aside>`;
  els = {
    app: document.getElementById("app"),
    roomList: document.getElementById("roomList"),
    mh: document.getElementById("mh"),
    conv: document.getElementById("conv"),
    feed: document.getElementById("feed"),
    feedIn: document.getElementById("feedIn"),
    runbar: document.getElementById("runbar"),
    cform: document.getElementById("cform"),
    ctext: document.getElementById("ctext"),
    csend: document.getElementById("csend"),
    ctools: document.getElementById("ctools"),
    tview: document.getElementById("tview"),
    noroom: document.getElementById("noroom"),
    scrim: document.getElementById("scrim"),
    sheet: document.getElementById("sheet"),
    sheetTitle: document.getElementById("sheetTitle"),
    sheetSub: document.getElementById("sheetSub"),
    sheetBody: document.getElementById("sheetBody"),
  };

  document.addEventListener("click", onClick);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && S.sheet) closeSheet();
  });
  els.cform.addEventListener("submit", (event) => {
    event.preventDefault();
    sendMessage();
  });
  els.ctext.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendMessage();
    }
  });
  els.ctext.addEventListener("input", () => {
    autosize();
    try {
      if (S.roomId) localStorage.setItem(`agoryx.draft.${S.roomId}`, els.ctext.value);
    } catch {}
  });
  window.addEventListener("hashchange", () => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (id && id !== S.roomId) openRoom(id);
  });
  setInterval(tickElapsed, 1000);
  setInterval(() => loadRooms().catch(() => {}), 5000);
};

const autosize = () => {
  const ta = els.ctext;
  const max = window.innerHeight * 0.4;
  ta.style.height = "auto";
  ta.style.height = `${Math.min(ta.scrollHeight, max)}px`;
  ta.style.overflowY = ta.scrollHeight > max ? "auto" : "hidden";
};

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

const renderSide = () => {
  const list = S.rooms
    .map((room) => {
      const on = room.id === S.roomId ? " on" : "";
      const tail = room.running ? '<span class="live" title="Агенти працюють"></span>' : `<span class="st">${esc(ago(room.updatedAt))}</span>`;
      return `<button class="item${on}" data-act="room" data-id="${esc(room.id)}" title="${esc(room.workspace)}"><span class="hash">#</span><span class="nm">${esc(room.name)}</span>${tail}</button>`;
    })
    .join("");
  els.roomList.innerHTML = `<h3>Кімнати <button data-act="new-room" title="Нова кімната" aria-label="Нова кімната">+</button></h3>${
    list || '<div class="empty-side">Ще немає кімнат.</div>'
  }`;
};

const loadRooms = async () => {
  const { rooms } = await api("GET", "/api/rooms");
  const changed = JSON.stringify(rooms) !== JSON.stringify(S.rooms);
  S.rooms = rooms;
  if (changed) invalidate("side");
  return rooms;
};

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

const tableCount = (table) =>
  table.questions.filter((q) => q.status === "open").length + table.options.filter((o) => o.status === "open" && !o.q).length;

const renderHeader = () => {
  const st = state();
  const count = tableCount(st.table);
  const people = [...st.agents.map((a) => a.id), st.human]
    .map((handle) => {
      const working = S.snap.presence?.[handle] === "working";
      return `<span title="${esc(nameOf(handle))}${working ? " — працює" : ""}">${avatar(handle, 26)}</span>`;
    })
    .join("");
  els.mh.innerHTML = `
    <button class="iconbtn menu" data-act="nav" aria-label="Кімнати">${ICON.menu}</button>
    <div class="title"><b>${esc(st.name)}</b><button data-act="files" title="${esc(st.workspace)} — файли робочої теки">${esc(shortPath(st.workspace))}</button></div>
    <div class="tabs" role="tablist">
      <button role="tab" aria-selected="${S.tab === "conv"}" class="${S.tab === "conv" ? "on" : ""}" data-act="tab" data-tab="conv">Розмова</button>
      <button role="tab" aria-selected="${S.tab === "table"}" class="${S.tab === "table" ? "on" : ""}" data-act="tab" data-tab="table">Стіл${count ? ` <span class="n">${count}</span>` : ""}</button>
    </div>
    <div class="right">
      <div class="stack">${people}</div>
      <button class="iconbtn" data-act="sessions" title="Рідні сесії агентів" aria-label="Сесії агентів">${ICON.terminal}</button>
      <button class="iconbtn" data-act="settings" title="Налаштування кімнати" aria-label="Налаштування">${ICON.gear}</button>
    </div>`;
  document.title = `${st.name} · Agoryx`;
};

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

const ACT_ICON = { command: "$", edit: "✎", read: "◇", search: "⌕", web: "↗", tool: "⚙", thinking: "…", note: "•", denied: "⊘", error: "!" };

const activityHtml = (a) => {
  const cls = [a.status === "fail" || a.kind === "error" ? "fail" : "", a.kind === "denied" ? "denied" : "", a.status === "running" ? "running" : ""].join(" ");
  const wrap = a.kind === "thinking" || a.kind === "note" || a.kind === "error" || a.kind === "denied";
  const label = wrap && a.label.length > 600 ? `${a.label.slice(0, 600)}…` : a.label;
  const detail = a.detail && (a.status === "fail" || a.kind === "error") ? `<span class="dt">${esc(a.detail.slice(0, 500))}</span>` : "";
  return `<div class="act ${cls}"><span class="ic">${ACT_ICON[a.kind] ?? "·"}</span><span class="lb${wrap ? " wrap" : ""}" title="${esc(a.label)}">${esc(label)}${detail}</span></div>`;
};

const OP_WORD = {
  ask: (o) => `${o.id ?? ""} питання`,
  propose: (o) => `${o.id ?? ""} · ${o.title}`,
  object: (o) => `заперечення до ${o.target}`,
  support: (o) => `підтримка ${o.target}`,
  evidence: (o) => `доказ до ${o.target}`,
  fact: () => "факт",
  settle: () => "узгоджено",
  next: () => "наступний крок",
  done: (o) => `${o.target} виконано`,
  withdraw: (o) => `${o.target} відкликано`,
  decide: (o) => `рішення: ${o.target}`,
  reopen: (o) => `${o.target} відкрито знову`,
};

const opRef = (o) => (o.op === "ask" || o.op === "propose" ? o.id : o.target);

const opChip = (o) => {
  const word = (OP_WORD[o.op] ?? (() => o.op))(o);
  const ref = opRef(o);
  return `<button class="pill op${o.op === "object" ? " obj" : ""}" data-act="ref" data-ref="${esc(ref ?? "")}" title="${esc(o.text ?? o.body ?? o.title ?? "")}"><span class="ell">▸ ${esc(word)}</span></button>`;
};

const opSentence = (o) => {
  const who = nameOf(o.by);
  switch (o.op) {
    case "ask":
      return `${who} ставить питання ${o.id}: «${o.text}»`;
    case "propose":
      return `${who} пропонує ${o.id}: «${o.title}»`;
    case "object":
      return `${who} заперечує ${o.target}: «${o.text}»`;
    case "support":
      return `${who} підтримує ${o.target}: «${o.text}»`;
    case "evidence":
      return `${who} додає доказ до ${o.target}: «${o.text}»`;
    case "fact":
      return `${who} фіксує факт: «${o.text}»`;
    case "settle":
      return `${who} позначає узгодженим: «${o.text}»`;
    case "next":
      return `${who} додає наступний крок: «${o.text}»`;
    case "done":
      return `${who} позначає ${o.target} виконаним`;
    case "withdraw":
      return `${who} відкликає ${o.target}`;
    case "reopen":
      return `${who} знову відкриває ${o.target}`;
    default:
      return `${who}: ${o.op} ${o.target ?? ""}`;
  }
};

const turnSummary = (turn) => {
  const n = turn.activity.length;
  const files = turn.files?.length ?? 0;
  const parts = [];
  if (n) parts.push(plural(n, "дія", "дії", "дій"));
  if (files) parts.push(plural(files, "файл", "файли", "файлів"));
  return parts.join(" · ");
};

const turnBar = (turn, ops) => {
  if (!turn) return ops?.length ? `<div class="turnbar">${ops.map(opChip).join("")}</div>` : "";
  const open = S.openTraces.has(turn.id);
  const summary = turnSummary(turn);
  const bits = [];
  if (summary) bits.push(`<button class="pill" data-act="trace" data-turn="${esc(turn.id)}" aria-expanded="${open}">${open ? "▾" : "▸"} ${esc(summary)}</button>`);
  for (const file of turn.files ?? []) bits.push(`<button class="pill file" data-act="file" data-path="${esc(file)}" title="${esc(file)}"><span class="ell">${esc(file)}</span></button>`);
  for (const o of ops ?? []) bits.push(opChip(o));
  if (!bits.length) return "";
  const trace = open && turn.activity.length ? `<div class="trace">${turn.activity.map(activityHtml).join("")}</div>` : "";
  return `<div class="turnbar">${bits.join("")}</div>${trace}`;
};

const turnMeta = (turn) => {
  if (!turn) return "";
  const bits = [];
  if (turn.durationMs != null) bits.push(secs(turn.durationMs));
  if (turn.usage?.costUsd) bits.push(`$${turn.usage.costUsd.toFixed(turn.usage.costUsd < 0.1 ? 3 : 2)}`);
  if (turn.status === "error" || turn.status === "interrupted") bits.push(turn.status === "error" ? "помилка" : "перервано");
  return bits.length ? `<span class="kind">${esc(bits.join(" · "))}</span>` : "";
};

const messageHtml = (m, ctx, { round = false } = {}) => {
  const fresh = !S.firstPaint && !S.seenMessages.has(m.id) ? " fresh" : "";
  S.seenMessages.add(m.id);
  const turn = m.turnId ? ctx.turns.get(m.turnId) : undefined;
  const ops = m.turnId ? ctx.opsByTurn.get(m.turnId) : undefined;
  if (m.kind === "pass") {
    const note = m.text && m.text.trim() && !/^::pass::$/i.test(m.text.trim()) ? ` — ${esc(m.text.replace(/^[`"'*_\s]*::pass::[`"'*_\s.:—–-]*/i, ""))}` : "";
    const chips = ops?.length || turn?.files?.length ? turnBar(turn, ops) : "";
    return `<div class="passl${fresh}" id="m-${esc(m.id)}">${avatar(m.author, 18)}<span><b>${esc(nameOf(m.author))}</b> мовчить${note}</span>${chips}</div>`;
  }
  if (m.kind === "system") {
    const err = /error|failed|помилк|не вдалося|timed out|rate limit/i.test(m.text) ? " err" : "";
    return `<div class="sysl${err}${fresh}" id="m-${esc(m.id)}"><span>${inline(m.text, mdCtx())}</span></div>`;
  }
  if (m.kind === "decision") {
    return `<div class="decision${fresh}" id="m-${esc(m.id)}"><span class="dn">◆</span><div>${inline(m.text, mdCtx())}</div></div>`;
  }
  const size = round ? 26 : 30;
  return `<article class="msg${fresh}" id="m-${esc(m.id)}">
    ${avatar(m.author, size)}
    <div style="min-width:0">
      <div class="meta"><b>${esc(nameOf(m.author))}</b><time datetime="${esc(m.ts)}" title="${esc(fullDate(m.ts))}">${clock(m.ts)}</time>${turnMeta(turn)}</div>
      <div class="txt">${markdown(m.text, mdCtx())}</div>
      ${turnBar(turn, ops)}
    </div>
  </article>`;
};

const liveHtml = (turn, ops) => {
  const stream = S.snap.streams?.[turn.id]?.text ?? "";
  const last = turn.activity.slice(-4);
  const elapsed = Date.now() - new Date(turn.startedAt).getTime();
  return `<article class="msg live" data-live="${esc(turn.id)}">
    ${avatar(turn.agent, 30)}
    <div style="min-width:0">
      <div class="meta"><b>${esc(nameOf(turn.agent))}</b><span class="kind"><span class="dots" style="--c:var(--${participant(turn.agent)?.cls === "cx" ? "cx" : "cl"})"><i></i><i></i><i></i></span> працює · <span data-elapsed="${esc(turn.startedAt)}">${secs(elapsed)}</span>${turn.resume ? " · продовжує свою сесію" : " · нова сесія"}</span></div>
      <div class="stream" data-stream="${esc(turn.id)}">${esc(stream.slice(-2000))}</div>
      ${last.length ? `<div class="trace" data-trace="${esc(turn.id)}">${last.map(activityHtml).join("")}</div>` : ""}
      ${ops?.length ? `<div class="turnbar">${ops.map(opChip).join("")}</div>` : ""}
    </div>
  </article>`;
};

const helloHtml = (st) => `
  <div class="hello">
    <h2>Кімната «${esc(st.name)}» готова</h2>
    <p>Напишіть, що треба зробити або обговорити. ${st.agents.map((a) => esc(a.label)).join(" і ")} відповідять паралельно, не бачачи відповідей одне одного, а потім продовжать самі: кожен отримує лише нове, мовчить, коли нема чого додати, і працює у власній сесії з усіма своїми інструментами.</p>
    <ul>
      <li>Розмова зупиняється, коли всі змовкли або вичерпано бюджет — ${plural(st.settings.budget, "хід", "ходи", "ходів")} на раунд.</li>
      <li>Звертайтеся напряму: <span class="at cl">@${esc(st.agents[0]?.id ?? "claude")}</span>${st.agents[1] ? `, <span class="at cx">@${esc(st.agents[1].id)}</span>` : ""}.</li>
      <li>Коли є реальні варіанти — вони з'являються на <b>Столі</b>: питання, пропозиції, заперечення, рішення.</li>
      <li>Робоча тека: <code>${esc(st.workspace)}</code></li>
    </ul>
  </div>`;

const buildFeedModel = () => {
  const st = state();
  const turns = new Map(st.turns.map((t) => [t.id, t]));
  const withMessage = new Set(st.messages.filter((m) => m.turnId).map((m) => m.turnId));
  const opsByTurn = new Map();
  const items = [];
  for (const entry of S.snap.ops ?? []) {
    const o = entry.op;
    const turn = o.turnId ? turns.get(o.turnId) : undefined;
    if (o.turnId && (withMessage.has(o.turnId) || turn?.status === "running")) {
      const list = opsByTurn.get(o.turnId) ?? [];
      list.push(o);
      opsByTurn.set(o.turnId, list);
    } else if (o.op !== "decide") {
      items.push({ seq: entry.seq, type: "op", op: o });
    }
  }
  for (const m of st.messages) items.push({ seq: m.seq, type: "msg", m });
  for (const c of st.commits) items.push({ seq: c.seq, type: "commit", c });
  items.sort((a, b) => a.seq - b.seq);
  return { turns, opsByTurn, items };
};

/** Turn behind an agent reply or pass, or null for anything else. */
const replyTurn = (item, ctx) => {
  if (item?.type !== "msg" || (item.m.kind !== "agent" && item.m.kind !== "pass") || !item.m.turnId) return null;
  return ctx.turns.get(item.m.turnId) ?? null;
};

const renderFeed = () => {
  const st = state();
  const feed = els.feed;
  const pinned = S.firstPaint || feed.scrollHeight - feed.scrollTop - feed.clientHeight < 90;
  const before = feed.scrollTop;
  const ctx = buildFeedModel();
  const html = [];
  if (!st.messages.length) html.push(helloHtml(st));
  const { items } = ctx;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (replyTurn(item, ctx)) {
      // Replies whose turns never saw the first one's message ran blind, in parallel.
      const group = [item];
      const agents = new Set([item.m.author]);
      let j = i + 1;
      while (j < items.length && replyTurn(items[j], ctx) && replyTurn(items[j], ctx).cursor < item.m.seq && !agents.has(items[j].m.author)) {
        agents.add(items[j].m.author);
        group.push(items[j]);
        j += 1;
      }
      if (group.length > 1 && group.some((g) => g.m.kind === "agent")) {
        html.push(`<section class="round"><div class="round-h">одночасно · наосліп</div><div class="round-b">${group
          .map((g) => messageHtml(g.m, ctx, { round: true }))
          .join("")}</div></section>`);
        i = j - 1;
        continue;
      }
    }
    if (item.type === "msg") html.push(messageHtml(item.m, ctx));
    else if (item.type === "commit")
      html.push(`<div class="commit">✓ контрольна точка <button data-act="commit" data-sha="${esc(item.c.sha)}">${esc(item.c.sha.slice(0, 7))}</button> · ${esc(plural(item.c.files, "файл", "файли", "файлів"))}</div>`);
    else if (item.type === "op") html.push(`<div class="opline"><span class="tag">Стіл</span><span>${inline(opSentence(item.op), mdCtx())}</span></div>`);
  }
  for (const turn of st.turns) if (turn.status === "running") html.push(liveHtml(turn, ctx.opsByTurn.get(turn.id)));
  els.feedIn.innerHTML = html.join("");
  if (pinned) feed.scrollTop = feed.scrollHeight;
  else feed.scrollTop = before;
  S.firstPaint = false;
};

const tickElapsed = () => {
  for (const node of document.querySelectorAll("[data-elapsed]")) {
    node.textContent = secs(Date.now() - new Date(node.dataset.elapsed).getTime());
  }
};

// ---------------------------------------------------------------------------
// Run bar + composer tools
// ---------------------------------------------------------------------------

const renderRunbar = () => {
  const st = state();
  const run = st.runs[st.runs.length - 1];
  const working = st.agents.filter((a) => S.snap.presence?.[a.id] === "working").map((a) => a.label);
  let left = "";
  let action = "";
  if (!S.snap.driven) {
    left = `<span class="st">Кімнату веде інший процес agoryx — тут лише перегляд${S.snap.lockedBy ? ` (${esc(S.snap.lockedBy)})` : ""}</span>`;
  } else if (run?.status === "active") {
    left = `<span class="st on">Раунд: хід ${run.used} з ${run.budget}${working.length ? ` · працюють: ${esc(working.join(", "))}` : ""}</span>`;
    action = '<button class="linkbtn warn" data-act="stop">Зупинити</button>';
  } else if (run?.endReason === "budget") {
    left = '<span class="st budget">Бюджет ходів вичерпано — розмова на паузі</span>';
    action = '<button class="linkbtn" data-act="more">Ще раунд</button>';
  } else if (run?.endReason === "stopped") {
    left = '<span class="st budget">Зупинено</span>';
    action = '<button class="linkbtn" data-act="more">Продовжити</button>';
  } else if (run?.endReason === "quiet") {
    left = '<span class="st">Усі змовкли — черга за вами</span>';
  } else {
    left = '<span class="st">Тиша</span>';
  }
  els.runbar.innerHTML = `${left}<span class="grow"></span>${action}<button class="linkbtn" data-act="settings" title="Налаштування">${esc(plural(st.settings.budget, "хід", "ходи", "ходів"))} на раунд</button>`;
  els.ctools.innerHTML = `${st.agents
    .map((a) => `<button type="button" class="mention ${a.kind === "codex" ? "cx" : "cl"}" data-act="mention" data-who="${esc(a.id)}">@${esc(a.id)}</button>`)
    .join("")}<span class="hint">Enter — надіслати · Shift+Enter — новий рядок</span>`;
  const disabled = !S.snap.driven;
  els.ctext.disabled = disabled;
  els.csend.disabled = disabled;
};

const sendMessage = async () => {
  const text = els.ctext.value.trim();
  if (!text || !S.roomId || !S.snap?.driven) return;
  els.csend.disabled = true;
  try {
    await api("POST", roomPath("/messages"), { text });
    els.ctext.value = "";
    autosize();
    try {
      localStorage.removeItem(`agoryx.draft.${S.roomId}`);
    } catch {}
    els.feed.scrollTop = els.feed.scrollHeight;
  } catch (error) {
    toast(error.message, true);
  } finally {
    els.csend.disabled = !S.snap?.driven;
  }
};

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

const agentCls = (handle) => participant(handle)?.cls ?? "hu";

const noteHtml = (n) => {
  const title = { object: "Заперечення", support: "Підтримка", evidence: "Доказ" }[n.kind];
  let source = "";
  if (n.source) {
    source = /^https?:\/\//.test(n.source)
      ? `<a class="src" href="${esc(n.source)}" target="_blank" rel="noopener noreferrer" title="${esc(n.source)}">${esc(n.source.replace(/^https?:\/\//, ""))}</a>`
      : `<button class="src" data-act="file" data-path="${esc(n.source)}" title="${esc(n.source)}">${esc(n.source)}</button>`;
  }
  return `<div class="note ${n.kind}" id="ti-${esc(n.id)}"><div class="t">${avatar(n.by, 16)} ${title} · ${esc(nameOf(n.by))}${source}</div>${inline(n.text, mdCtx())}</div>`;
};

const previewHtml = (file) => {
  const kind = ext(file);
  const url = `${S.snap.rawBase}${file.split("/").map(encodeURIComponent).join("/")}`;
  if (IMAGE_EXT.has(kind)) {
    return `<button class="thumb" data-act="file" data-path="${esc(file)}" title="${esc(file)}"><img src="${esc(url)}" alt="${esc(file)}" loading="lazy"></button>`;
  }
  if (FRAME_EXT.has(kind)) {
    return `<div class="frame-wrap"><iframe class="frame" src="${esc(url)}" sandbox="allow-scripts" loading="lazy" title="${esc(file)}"></iframe><button class="preview" data-act="file" data-path="${esc(file)}">${ICON.file}<span class="mono">${esc(file)}</span><span style="margin-left:auto">відкрити</span></button></div>`;
  }
  return `<button class="preview" data-act="file" data-path="${esc(file)}">${ICON.file}<span class="mono">${esc(file)}</span><span style="margin-left:auto">переглянути</span></button>`;
};

const optionHtml = (o, table, decidedQ) => {
  const notes = table.notes.filter((n) => n.target === o.id);
  const order = { object: 0, evidence: 1, support: 2 };
  notes.sort((a, b) => order[a.kind] - order[b.kind] || a.seq - b.seq);
  const lost = decidedQ && o.status === "open" ? " lost" : "";
  const counts = [];
  const obj = notes.filter((n) => n.kind === "object").length;
  const sup = notes.filter((n) => n.kind === "support").length;
  if (obj) counts.push(plural(obj, "заперечення", "заперечення", "заперечень"));
  if (sup) counts.push(plural(sup, "підтримка", "підтримки", "підтримок"));
  let pick = "";
  if (o.status === "chosen") pick = '<button class="pick" disabled>Обрано ✓</button>';
  else if (o.status === "open" && !decidedQ) pick = `<button class="pick" data-act="table-form" data-kind="decide" data-id="${esc(o.id)}">Обрати</button>`;
  else if (o.status === "withdrawn") pick = '<div class="minor"><span class="faint" style="font-size:12px">відкликано автором</span></div>';
  const minor =
    o.status === "open" && !decidedQ
      ? `<div class="minor"><button data-act="table-form" data-kind="object" data-id="${esc(o.id)}">Заперечити</button><button data-act="table-form" data-kind="support" data-id="${esc(o.id)}">Підтримати</button><button data-act="table-form" data-kind="evidence" data-id="${esc(o.id)}">Доказ</button></div>`
      : "";
  return `<article class="col ${agentCls(o.by)} ${o.status}${lost}" id="opt-${esc(o.id)}">
    <div class="col-h"><span class="vl">${esc(o.id)}</span><div style="min-width:0"><b>${inline(o.title, mdCtx())}</b><span class="who">${avatar(o.by, 16)} ${esc(nameOf(o.by))}${counts.length ? ` · ${esc(counts.join(", "))}` : ""}</span></div></div>
    ${o.body ? `<div class="body txt">${markdown(o.body, mdCtx())}</div>` : ""}
    ${o.file ? previewHtml(o.file) : ""}
    ${notes.length ? `<div class="notes">${notes.map(noteHtml).join("")}</div>` : ""}
    <div class="foot">${pick}${minor}</div>
  </article>`;
};

const questionHtml = (q, table) => {
  const options = table.options.filter((o) => o.q === q.id);
  const decided = q.status === "decided";
  const decision = table.decisions.filter((d) => d.q === q.id).pop();
  const chosen = decision ? table.options.find((o) => o.id === decision.option) : undefined;
  const status = decided
    ? `<span class="status done">Вирішено${chosen ? ` — ${esc(chosen.id)} «${esc(chosen.title)}»` : ""}</span>`
    : `<span class="status">${options.length ? `${esc(plural(options.filter((o) => o.status === "open").length, "варіант", "варіанти", "варіантів"))} · відкрите` : "Відкрите — варіантів ще немає"}</span>`;
  return `<section class="qblock" id="q-${esc(q.id)}">
    <div class="q">
      <div class="kick">${avatar(q.by, 18)} Питання ${esc(q.id)} · ${esc(nameOf(q.by))}</div>
      <h1>${inline(q.text, mdCtx())}</h1>
      ${status}
      ${decided ? "" : `<div class="qacts"><button class="ghost" data-act="table-form" data-kind="propose" data-q="${esc(q.id)}">Запропонувати варіант</button></div>`}
    </div>
    ${options.length ? `<div class="cols">${options.map((o) => optionHtml(o, table, decided)).join("")}</div>` : ""}
  </section>`;
};

const railHtml = (table) => {
  const decisions = [...table.decisions].reverse().map((d) => {
    const o = table.options.find((x) => x.id === d.option);
    return `<div class="dec"><span class="faint" style="font-size:12px">Рішення №${d.n} · ${esc(nameOf(d.by))}</span><b>${esc(o ? `${o.id} «${o.title}»` : d.option)}</b>${d.note ? `<span class="faint">${inline(d.note, mdCtx())}</span>` : ""}</div>`;
  });
  const settled = [
    ...table.settled.map((s) => `<li id="ti-${esc(s.id)}"><span class="ok"></span><span>${inline(s.text, mdCtx())}<small>${esc(nameOf(s.by))}</small></span></li>`),
    ...table.facts.map((f) => `<li id="ti-${esc(f.id)}"><span class="fx" title="Факт">F</span><span>${inline(f.text, mdCtx())}<small>факт · ${esc(nameOf(f.by))}</small></span></li>`),
  ];
  const next = table.next.map(
    (n) =>
      `<li id="ti-${esc(n.id)}" class="${n.done ? "done" : ""}">${n.done ? '<span class="nx"></span>' : `<button class="nx" data-act="done" data-id="${esc(n.id)}" title="Позначити виконаним" aria-label="Позначити виконаним"></button>`}<span>${inline(n.text, mdCtx())}<small>${esc(n.id)} · ${esc(nameOf(n.by))}</small></span></li>`,
  );
  const open = table.questions
    .filter((q) => q.status === "open")
    .map((q) => `<li><span class="qm">?</span><span><button class="link" data-act="ref" data-ref="${esc(q.id)}">${inline(q.text, mdCtx())}</button><small>${esc(q.id)}</small></span></li>`);
  const none = (text) => `<div class="none">${text}</div>`;
  return `<aside class="rail">
    <h2>Де ми зараз</h2>
    <section><h3>Рішення</h3>${decisions.length ? `<div style="display:flex;flex-direction:column;gap:8px">${decisions.join("")}</div>` : none("Ще нічого не вирішено.")}</section>
    <section><h3>Узгоджено</h3>${settled.length ? `<ul>${settled.join("")}</ul>` : none("Поки немає спільних висновків.")}</section>
    <section><h3>Наступні кроки</h3>${next.length ? `<ul>${next.join("")}</ul>` : none("Кроків ще не записано.")}</section>
    <section><h3>Відкриті питання</h3>${open.length ? `<ul>${open.join("")}</ul>` : none("Відкритих питань немає.")}</section>
  </aside>`;
};

const dockHtml = () => `<div class="dock"><div class="dock-in">
  <button class="tool" data-act="table-form" data-kind="ask">${ICON.q}<span class="tl">Питання</span></button>
  <button class="tool" data-act="table-form" data-kind="propose">${ICON.plus}<span class="tl">Пропозиція</span></button>
  <span class="sep"></span>
  <button class="tool" data-act="table-form" data-kind="settle">${ICON.pin}<span class="tl">Узгоджено</span></button>
  <button class="tool" data-act="table-form" data-kind="next">${ICON.step}<span class="tl">Наступний крок</span></button>
</div></div>`;

const renderTable = () => {
  const st = state();
  const table = st.table;
  const empty = !table.questions.length && !table.options.length && !table.settled.length && !table.facts.length && !table.next.length;
  const blocks = [];
  const questions = [...table.questions].sort((a, b) => (a.status === b.status ? a.seq - b.seq : a.status === "open" ? -1 : 1));
  for (const q of questions) blocks.push(questionHtml(q, table));
  const loose = table.options.filter((o) => !o.q);
  if (loose.length) {
    blocks.push(`<section class="qblock loose"><h3>Пропозиції без окремого питання</h3><div class="cols">${loose
      .map((o) => optionHtml(o, table, false))
      .join("")}</div></section>`);
  }
  const emptyHtml = `<div class="table-empty">
    <h2>Стіл порожній</h2>
    <p>Стіл — спільна структура для рішень, де є справжні альтернативи. Агенти кладуть сюди питання й пропозиції, заперечують і підтримують одне одного, додають докази. Ви бачите, де згода, а де суперечка, і обираєте.</p>
    <p>Агенти роблять це самі командами <code>agoryx table propose …</code>, <code>object</code>, <code>support</code>. Або почніть ви:</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px"><button class="primary" data-act="table-form" data-kind="ask">Поставити питання</button><button class="ghost" data-act="table-form" data-kind="propose">Запропонувати варіант</button></div>
  </div>`;
  const scroll = els.tview.scrollTop;
  els.tview.innerHTML = `<div class="tbl"><div class="canvas">${empty ? emptyHtml : blocks.join("")}${empty ? "" : dockHtml()}</div>${railHtml(table)}</div>`;
  els.tview.scrollTop = scroll;
};

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

const openSheet = (title, sub, body) => {
  S.sheet = { title };
  els.sheetTitle.textContent = title;
  els.sheetSub.textContent = sub ?? "";
  els.sheetBody.innerHTML = body;
  els.sheet.classList.add("on");
  els.scrim.classList.add("on");
  const focus = els.sheetBody.querySelector("[autofocus], textarea, input, select") ?? els.sheet.querySelector(".close");
  setTimeout(() => focus?.focus(), 60);
};

const closeSheet = () => {
  S.sheet = null;
  els.sheet.classList.remove("on");
  els.scrim.classList.remove("on");
  setTimeout(() => {
    if (!S.sheet) els.sheetBody.innerHTML = "";
  }, 320);
};

const codeTable = (text, classify) => {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return `<div class="code"><table>${lines
    .map((line, index) => `<tr class="${classify ? classify(line) : ""}"><td class="ln">${index + 1}</td><td>${esc(line) || " "}</td></tr>`)
    .join("")}</table></div>`;
};

const showFile = async (path) => {
  const kind = ext(path);
  const url = `${S.snap.rawBase}${path.split("/").map(encodeURIComponent).join("/")}`;
  openSheet(path.split("/").pop(), path, '<div class="faint">Завантажую…</div>');
  try {
    if (IMAGE_EXT.has(kind) && kind !== "svg") {
      els.sheetBody.innerHTML = `<img src="${esc(url)}" alt="${esc(path)}" style="max-width:100%;border-radius:10px;border:1px solid var(--rule)"><a class="ghost" href="${esc(url)}" target="_blank" rel="noopener">Відкрити окремо</a>`;
      return;
    }
    const file = await api("GET", `${roomPath("/file")}?path=${encodeURIComponent(path)}`);
    const meta = `<div class="faint" style="font-size:12.5px">${esc((file.size / 1024).toFixed(1))} КБ · змінено ${esc(fullDate(file.mtime))}${file.truncated ? " · показано початок" : ""}</div>`;
    let body = "";
    if (FRAME_EXT.has(kind) || kind === "svg") {
      body = `<iframe class="frame big" src="${esc(url)}" sandbox="allow-scripts allow-forms allow-modals" title="${esc(path)}"></iframe>
        <div style="display:flex;gap:8px"><a class="ghost" href="${esc(url)}" target="_blank" rel="noopener">Відкрити в новій вкладці</a></div>
        ${file.binary ? "" : `<details><summary class="faint" style="cursor:pointer">Код</summary>${codeTable(file.text)}</details>`}`;
    } else if (file.binary) {
      body = `<p class="faint">Двійковий файл — попередній перегляд недоступний.</p><a class="ghost" href="${esc(url)}" target="_blank" rel="noopener">Відкрити</a>`;
    } else if (kind === "md" || kind === "markdown") {
      body = `<div class="txt">${markdown(file.text, mdCtx())}</div><details><summary class="faint" style="cursor:pointer">Сирий текст</summary>${codeTable(file.text)}</details>`;
    } else {
      body = codeTable(file.text);
    }
    if (S.sheet) els.sheetBody.innerHTML = meta + body;
  } catch (error) {
    if (S.sheet) els.sheetBody.innerHTML = `<div class="err-box">${esc(error.message)}</div>`;
  }
};

const showCommit = async (sha) => {
  openSheet(`Контрольна точка ${sha.slice(0, 7)}`, "git show", '<div class="faint">Завантажую…</div>');
  try {
    const { text } = await api("GET", `${roomPath("/commit")}?sha=${encodeURIComponent(sha)}`);
    const classify = (line) =>
      line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git")
        ? "fileh"
        : line.startsWith("@@")
          ? "hunk"
          : line.startsWith("+")
            ? "add"
            : line.startsWith("-")
              ? "del"
              : "";
    if (S.sheet) els.sheetBody.innerHTML = codeTable(text, classify);
  } catch (error) {
    if (S.sheet) els.sheetBody.innerHTML = `<div class="err-box">${esc(error.message)}</div>`;
  }
};

const showFiles = async () => {
  const st = state();
  openSheet("Робоча тека", st.workspace, '<div class="faint">Завантажую…</div>');
  try {
    const { files } = await api("GET", roomPath("/tree"));
    const list = files.length
      ? `<div class="files">${files.map((f) => `<button data-act="file" data-path="${esc(f)}">${esc(f)}</button>`).join("")}</div>`
      : '<p class="faint">Поки що порожньо — агенти ще нічого не створили.</p>';
    if (S.sheet) {
      els.sheetBody.innerHTML = `<p class="faint" style="margin:0">Спільна git-тека кімнати. Агенти читають і пишуть тут (у пісочниці), а наприкінці кожного раунду Agoryx робить контрольну точку.</p>${list}`;
    }
  } catch (error) {
    if (S.sheet) els.sheetBody.innerHTML = `<div class="err-box">${esc(error.message)}</div>`;
  }
};

const copyButton = (text) => `<button class="ghost" data-act="copy" data-text="${esc(text)}">Копіювати</button>`;

const showSessions = () => {
  const st = state();
  const rows = st.agents
    .map((a) => {
      const session = st.sessions[a.id];
      const command = S.snap.resume?.[a.id];
      return `<div class="cmd">
        ${avatar(a.id, 30)}
        <div class="who" style="min-width:0"><b>${esc(a.label)}</b><small>${session ? `сесія ${esc(session.sessionId)}` : "ще не говорив — сесія з'явиться після першого ходу"}</small>${command ? `<code style="margin-top:6px">${esc(command)}</code>` : ""}</div>
        ${command ? copyButton(command) : ""}
      </div>`;
    })
    .join("");
  openSheet(
    "Сесії агентів",
    "рідні сесії Claude Code і Codex",
    `<p style="margin:0;color:var(--soft)">Agoryx не перепаковує агентів: кожен працює у своїй справжній сесії, і розмова в кімнаті — це їхні ходи в цих сесіях. Відкрийте сесію в терміналі, щоб побачити все, що агент робив, або продовжити з ним сам-на-сам.</p>
     ${rows}
     <p class="faint" style="margin:0;font-size:12.5px">Для всієї кімнати в терміналі: <code>agoryx tail -f</code>, <code>agoryx say "…"</code>, <code>agoryx table</code>.</p>`,
  );
};

const showSettings = () => {
  const s = state().settings;
  openSheet(
    "Налаштування кімнати",
    state().name,
    `<form class="form" data-form="settings">
      <label>Бюджет ходів на раунд<input type="number" name="budget" min="1" max="100" value="${s.budget}"><small>Скільки ходів агенти можуть зробити після вашого повідомлення, перш ніж розмова стане на паузу.</small></label>
      <label>Доступ агентів<select name="access"><option value="workspace"${s.access === "workspace" ? " selected" : ""}>Читання і запис у робочій теці</option><option value="readonly"${s.access === "readonly" ? " selected" : ""}>Лише читання</option></select><small>Агенти завжди працюють у пісочниці; поза робочою текою писати не можуть.</small></label>
      <label class="check"><input type="checkbox" name="network"${s.network ? " checked" : ""}> Мережа для команд агентів</label>
      <label class="check"><input type="checkbox" name="autoCommit"${s.autoCommit ? " checked" : ""}> Контрольна точка (git commit) після кожного раунду</label>
      <div class="row"><button type="button" class="ghost" data-act="close-sheet">Скасувати</button><button class="primary" type="submit">Зберегти</button></div>
    </form>`,
  );
};

const showNewRoom = () => {
  openSheet(
    "Нова кімната",
    "Claude + Codex + ви",
    `<form class="form" data-form="new-room">
      <label>Назва<input type="text" name="name" required placeholder="напр. Редизайн онбордингу" autofocus></label>
      <label>Робоча тека <small>Необов'язково. Порожньо — Agoryx створить нову git-теку для кімнати. Можна вказати наявний проєкт.</small><input type="text" name="dir" placeholder="~/projects/my-app"></label>
      <label>Бюджет ходів на раунд<input type="number" name="budget" min="1" max="100" value="8"></label>
      <label>Перше повідомлення <small>Необов'язково — агенти почнуть одразу.</small><textarea name="text" placeholder="Що треба зробити чи обговорити?"></textarea></label>
      <div class="row"><button type="button" class="ghost" data-act="close-sheet">Скасувати</button><button class="primary" type="submit">Створити</button></div>
    </form>`,
  );
};

const TABLE_FORMS = {
  ask: { title: "Нове питання", fields: [["text", "Питання", "textarea", "Що треба вирішити?"]] },
  propose: { title: "Нова пропозиція", fields: [["title", "Коротка назва", "text", "напр. SQLite замість JSON"], ["body", "Що і чому", "textarea", ""], ["file", "Файл у робочій теці (необов'язково)", "text", "mockup.html"]] },
  object: { title: "Заперечення", fields: [["text", "Чому ні", "textarea", "Що саме не так і що змінило б вашу думку?"]] },
  support: { title: "Підтримка", fields: [["text", "Чому так", "textarea", ""]] },
  evidence: { title: "Доказ", fields: [["text", "Що встановлено", "textarea", ""], ["source", "Джерело (URL або файл)", "text", ""]] },
  decide: { title: "Обрати", fields: [["note", "Чому саме цей варіант (необов'язково)", "textarea", ""]] },
  settle: { title: "Узгоджено", fields: [["text", "Що тепер вважаємо встановленим", "textarea", ""]] },
  next: { title: "Наступний крок", fields: [["text", "Конкретна дія", "textarea", ""]] },
};

const showTableForm = (kind, id, q) => {
  const form = TABLE_FORMS[kind];
  if (!form) return;
  const table = state().table;
  const option = id ? table.options.find((o) => o.id === id) : undefined;
  let questionPicker = "";
  if (kind === "propose") {
    const open = table.questions.filter((x) => x.status === "open");
    questionPicker = open.length
      ? `<label>До питання<select name="q"><option value="">— без питання —</option>${open
          .map((x) => `<option value="${esc(x.id)}"${x.id === q ? " selected" : ""}>${esc(x.id)} · ${esc(x.text.slice(0, 80))}</option>`)
          .join("")}</select></label>`
      : "";
  }
  const fields = form.fields
    .map(([name, label, type, placeholder], index) =>
      type === "textarea"
        ? `<label>${esc(label)}<textarea name="${name}" placeholder="${esc(placeholder)}"${index === 0 ? " autofocus" : ""}${name === "text" && kind !== "decide" ? " required" : ""}></textarea></label>`
        : `<label>${esc(label)}<input type="text" name="${name}" placeholder="${esc(placeholder)}"${index === 0 ? " autofocus" : ""}${name === "title" ? " required" : ""}></label>`,
    )
    .join("");
  const context = option
    ? `<div class="col ${agentCls(option.by)}" style="box-shadow:none"><div class="col-h"><span class="vl">${esc(option.id)}</span><div><b>${esc(option.title)}</b><span class="who">${avatar(option.by, 16)} ${esc(nameOf(option.by))}</span></div></div></div>`
    : "";
  const verb = kind === "decide" ? `Обрати ${esc(id)}` : "Покласти на стіл";
  const hint =
    kind === "decide"
      ? '<p class="faint" style="margin:0;font-size:13px">Рішення з\'явиться в розмові, і агенти продовжать із нього.</p>'
      : '<p class="faint" style="margin:0;font-size:13px">Агенти побачать це у своєму наступному ході.</p>';
  openSheet(
    kind === "decide" ? `Обрати ${id}` : form.title,
    option ? option.title : "Стіл",
    `<form class="form" data-form="table" data-kind="${kind}" data-id="${esc(id ?? "")}">${context}${fields}${questionPicker}${hint}
      <div class="row"><button type="button" class="ghost" data-act="close-sheet">Скасувати</button><button class="primary" type="submit">${verb}</button></div></form>`,
  );
};

document.addEventListener("submit", async (event) => {
  const form = event.target.closest("form[data-form]");
  if (!form) return;
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form).entries());
  const submit = form.querySelector('button[type="submit"]');
  if (submit) submit.disabled = true;
  try {
    if (form.dataset.form === "settings") {
      await api("POST", roomPath("/settings"), {
        budget: Math.max(1, Number.parseInt(data.budget, 10) || state().settings.budget),
        access: data.access,
        network: form.elements.network.checked,
        autoCommit: form.elements.autoCommit.checked,
      });
      closeSheet();
      toast("Збережено");
    } else if (form.dataset.form === "new-room") {
      const budget = Number.parseInt(data.budget, 10);
      const { room } = await api("POST", "/api/rooms", {
        name: data.name,
        ...(data.dir?.trim() ? { dir: data.dir.trim() } : {}),
        ...(Number.isFinite(budget) ? { budget } : {}),
        ...(data.text?.trim() ? { text: data.text.trim() } : {}),
      });
      closeSheet();
      await loadRooms();
      location.hash = encodeURIComponent(room.id);
    } else if (form.dataset.form === "table") {
      const kind = form.dataset.kind;
      const id = form.dataset.id;
      const body = { op: kind };
      if (kind === "propose") {
        Object.assign(body, { title: data.title, ...(data.body ? { body: data.body } : {}), ...(data.file ? { file: data.file } : {}), ...(data.q ? { q: data.q } : {}) });
      } else if (kind === "decide") {
        Object.assign(body, { target: id, ...(data.note ? { note: data.note } : {}) });
      } else if (kind === "object" || kind === "support" || kind === "evidence") {
        Object.assign(body, { target: id, text: data.text, ...(data.source ? { source: data.source } : {}) });
      } else {
        body.text = data.text;
      }
      await api("POST", roomPath("/table"), body);
      closeSheet();
    }
  } catch (error) {
    if (!(error instanceof Unauthorized)) toast(error.message, true);
    if (submit) submit.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Click delegation
// ---------------------------------------------------------------------------

const goToRef = (ref) => {
  if (!ref) return;
  const st = state();
  const t = st.table;
  const isTable = [t.questions, t.options, t.notes, t.facts, t.settled, t.next].some((list) => list.some((item) => item.id === ref));
  if (!isTable) return;
  setTab("table");
  requestAnimationFrame(() => {
    const node = document.getElementById(ref.startsWith("Q") ? `q-${ref}` : ref.startsWith("P") ? `opt-${ref}` : `ti-${ref}`);
    if (!node) return;
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    node.animate?.([{ boxShadow: "0 0 0 3px var(--sage)" }, { boxShadow: "0 0 0 0 transparent" }], { duration: 1400 });
  });
};

const setTab = (tab) => {
  S.tab = tab;
  els.conv.hidden = tab !== "conv";
  els.tview.hidden = tab !== "table";
  try {
    localStorage.setItem("agoryx.tab", tab);
  } catch {}
  invalidate("header", tab === "table" ? "table" : "feed");
};

const onClick = async (event) => {
  const target = event.target.closest("[data-act]");
  if (!target) return;
  const act = target.dataset.act;
  switch (act) {
    case "nav":
      els.app.classList.toggle("nav");
      break;
    case "room":
      els.app.classList.remove("nav");
      location.hash = encodeURIComponent(target.dataset.id);
      break;
    case "new-room":
      els.app.classList.remove("nav");
      showNewRoom();
      break;
    case "tab":
      setTab(target.dataset.tab);
      break;
    case "trace": {
      const id = target.dataset.turn;
      if (S.openTraces.has(id)) S.openTraces.delete(id);
      else S.openTraces.add(id);
      invalidate("feed");
      break;
    }
    case "file":
      event.preventDefault();
      showFile(target.dataset.path);
      break;
    case "commit":
      showCommit(target.dataset.sha);
      break;
    case "files":
      showFiles();
      break;
    case "sessions":
      showSessions();
      break;
    case "settings":
      showSettings();
      break;
    case "close-sheet":
      closeSheet();
      break;
    case "ref":
      if (S.sheet) closeSheet();
      goToRef(target.dataset.ref);
      break;
    case "mention": {
      const who = `@${target.dataset.who} `;
      const ta = els.ctext;
      const start = ta.selectionStart ?? ta.value.length;
      const before = ta.value.slice(0, start);
      const pad = before && !/\s$/.test(before) ? " " : "";
      ta.value = `${before}${pad}${who}${ta.value.slice(ta.selectionEnd ?? start)}`;
      ta.focus();
      const pos = before.length + pad.length + who.length;
      ta.setSelectionRange(pos, pos);
      autosize();
      break;
    }
    case "stop":
      target.disabled = true;
      api("POST", roomPath("/stop"), {}).catch((error) => toast(error.message, true));
      break;
    case "more":
      target.disabled = true;
      api("POST", roomPath("/continue"), {}).catch((error) => {
        toast(error.message, true);
        target.disabled = false;
      });
      break;
    case "table-form":
      showTableForm(target.dataset.kind, target.dataset.id || undefined, target.dataset.q || undefined);
      break;
    case "done":
      target.disabled = true;
      api("POST", roomPath("/table"), { op: "done", target: target.dataset.id }).catch((error) => toast(error.message, true));
      break;
    case "copy": {
      const text = target.dataset.text;
      try {
        await navigator.clipboard.writeText(text);
        toast("Скопійовано");
      } catch {
        const code = target.parentElement.querySelector("code");
        if (code) getSelection().selectAllChildren(code);
        toast("Виділено — натисніть ⌘C");
      }
      break;
    }
    default:
      break;
  }
};

// ---------------------------------------------------------------------------
// Live data
// ---------------------------------------------------------------------------

const upsert = (list, item) => {
  const index = list.findIndex((entry) => entry.id === item.id);
  if (index === -1) list.push(item);
  else list[index] = item;
};

const applyPatch = (event, patch) => {
  const st = state();
  if (!st || event.seq <= st.seq) return;
  st.seq = patch.seq ?? event.seq;
  if (patch.runs) st.runs = patch.runs;
  if (patch.presence) S.snap.presence = patch.presence;
  if (patch.message) upsert(st.messages, patch.message);
  if (patch.turn) upsert(st.turns, patch.turn);
  if (patch.cursors) st.cursors = patch.cursors;
  if (patch.sessions) st.sessions = patch.sessions;
  if (patch.table) st.table = patch.table;
  if (patch.settings) st.settings = patch.settings;
  if (patch.commits) st.commits = patch.commits;
  if (patch.activity) {
    const turn = st.turns.find((t) => t.id === patch.activity.turnId);
    if (turn) upsert(turn.activity, patch.activity.activity);
  }
  if (event.type === "table.op") S.snap.ops.push({ seq: event.seq, ts: event.ts, op: event.op });
  if (event.type === "turn.ended") delete S.snap.streams[event.turnId];
  if (event.type === "turn.started") S.snap.streams[event.turnId] = { agent: event.agent, text: "" };

  if (event.type === "turn.activity") {
    // cheap path: refresh the live card's trace only
    const trace = document.querySelector(`[data-trace="${CSS.escape(event.turnId)}"]`);
    const turn = st.turns.find((t) => t.id === event.turnId);
    if (trace && turn?.status === "running") {
      trace.innerHTML = turn.activity.slice(-4).map(activityHtml).join("");
      keepPinned();
      return;
    }
  }
  const parts = ["feed", "runbar", "header"];
  if (event.type === "table.op" || event.type === "message.posted") parts.push("table");
  invalidate(...parts);
  if (event.type === "run.started" || event.type === "run.ended" || event.type === "message.posted") {
    const room = S.rooms.find((r) => r.id === S.roomId);
    if (room) {
      room.running = st.runs.some((r) => r.status === "active");
      invalidate("side");
    }
  }
};

const keepPinned = () => {
  const feed = els.feed;
  if (feed.scrollHeight - feed.scrollTop - feed.clientHeight < 160) feed.scrollTop = feed.scrollHeight;
};

const applyStream = (event) => {
  if (!S.snap) return;
  const buffer = S.snap.streams[event.turnId] ?? { agent: event.agent, text: "" };
  buffer.text = event.reset ? event.text : buffer.text + event.text;
  S.snap.streams[event.turnId] = buffer;
  const node = document.querySelector(`[data-stream="${CSS.escape(event.turnId)}"]`);
  if (node) {
    node.textContent = buffer.text.slice(-2000);
    node.scrollTop = node.scrollHeight;
    keepPinned();
  } else {
    invalidate("feed");
  }
};

const connect = () => {
  if (S.es) S.es.close();
  clearTimeout(S.reconnectTimer);
  const id = S.roomId;
  const es = new EventSource(`${roomPath("/events")}?after=${state().seq}`);
  S.es = es;
  es.addEventListener("room", (message) => {
    if (S.roomId !== id) return;
    const { event, patch } = JSON.parse(message.data);
    applyPatch(event, patch);
  });
  es.addEventListener("stream", (message) => {
    if (S.roomId !== id) return;
    applyStream(JSON.parse(message.data));
  });
  es.onerror = () => {
    es.close();
    if (S.es !== es) return;
    S.es = null;
    S.reconnectTimer = setTimeout(() => {
      if (S.roomId === id) openRoom(id, { quiet: true });
    }, 1500);
  };
};

const openRoom = async (id, { quiet = false } = {}) => {
  S.roomId = id;
  if (!quiet) {
    S.firstPaint = true;
    S.seenMessages.clear();
    S.openTraces.clear();
  }
  try {
    const snap = await api("GET", `/api/rooms/${encodeURIComponent(id)}`);
    if (S.roomId !== id) return;
    snap.ops ??= [];
    snap.streams ??= {};
    S.snap = snap;
    S.roomId = snap.state.id;
    els.noroom.hidden = true;
    els.conv.hidden = S.tab !== "conv";
    els.tview.hidden = S.tab !== "table";
    if (!quiet) {
      let draft = "";
      try {
        draft = localStorage.getItem(`agoryx.draft.${S.roomId}`) ?? "";
      } catch {}
      els.ctext.value = draft;
      autosize();
    }
    invalidate("side", "header", "feed", "runbar", "table");
    connect();
    if (!quiet && S.snap.driven && matchMedia("(min-width: 761px)").matches) setTimeout(() => els.ctext.focus(), 50);
  } catch (error) {
    if (error instanceof Unauthorized) return;
    if (!quiet) toast(error.message, true);
    else S.reconnectTimer = setTimeout(() => S.roomId === id && openRoom(id, { quiet: true }), 3000);
  }
};

const showNoRoom = () => {
  els.conv.hidden = true;
  els.tview.hidden = true;
  els.noroom.hidden = false;
  els.mh.innerHTML = `<button class="iconbtn menu" data-act="nav" aria-label="Кімнати">${ICON.menu}</button><div class="title"><b>Agoryx</b></div>`;
  els.noroom.innerHTML = `<div class="gate"><div class="box">
    <h1>Спільна кімната для вас, Claude і Codex</h1>
    <p>Агенти працюють у своїх рідних сесіях, бачать одне одного й сперечаються по суті. Agoryx дає їм контекст, а не ролі.</p>
    <p><button class="primary" data-act="new-room">Створити першу кімнату</button></p>
    <p class="faint" style="font-size:13px">Або з терміналу: <code>agoryx new "Назва" -m "завдання"</code></p>
  </div></div>`;
};

// ---------------------------------------------------------------------------
// Gate + toast
// ---------------------------------------------------------------------------

function showGate() {
  if (S.es) S.es.close();
  root.innerHTML = `<div class="gate"><div class="box">
    <h1>Потрібен вхід</h1>
    <p>Ця сторінка — локальне вікно в демон Agoryx. Щоб відкрити її з доступом, запустіть у терміналі:</p>
    <p><code>agoryx open</code></p>
    <p class="faint" style="font-size:13px">Команда відкриє браузер із одноразовим посиланням, і сторінка запам'ятає доступ на 30 днів.</p>
  </div></div>`;
}

let toastTimer = 0;
const toast = (text, error = false) => {
  let node = document.querySelector(".toast");
  if (!node) {
    node = document.createElement("div");
    node.className = "toast";
    node.setAttribute("role", "status");
    document.body.append(node);
  }
  node.textContent = text;
  node.classList.toggle("err", error);
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, error ? 6000 : 2200);
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const boot = async () => {
  try {
    const saved = localStorage.getItem("agoryx.tab");
    if (saved === "table" || saved === "conv") S.tab = saved;
  } catch {}
  buildShell();
  let rooms;
  try {
    rooms = await loadRooms();
  } catch (error) {
    if (!(error instanceof Unauthorized)) {
      root.innerHTML = `<div class="gate"><div class="box"><h1>Демон не відповідає</h1><p>${esc(error.message)}</p><p><code>agoryx up -d</code></p></div></div>`;
    }
    return;
  }
  renderSide();
  const wanted = decodeURIComponent(location.hash.slice(1));
  const id = (wanted && rooms.find((r) => r.id === wanted)?.id) || wanted || rooms[0]?.id;
  if (id) {
    if (!wanted) history.replaceState(null, "", `#${encodeURIComponent(id)}`);
    openRoom(id);
  } else {
    showNoRoom();
  }
};

boot();
