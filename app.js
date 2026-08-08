// Brief: phone front end for a daily brief served by a private Cloudflare
// Worker. This repo is a shell: no content, no names, no data. Everything
// arrives at runtime from the Worker, gated by a key the user pastes once.
"use strict";

var WORKER = "https://crystal-brief.janniksin.workers.dev";
var root = document.getElementById("root");
var brief = null;       // the brief JSON currently rendered
var viewDate = "";      // "" = latest; else "YYYY-MM-DD" picked in the switcher
var flushing = false;
var HISTORY_DAYS = 8;   // today + 7 back in the switcher

// ---------- tiny storage helpers ----------
function lsGet(k, fallback) {
  try { var v = localStorage.getItem(k); return v === null ? fallback : JSON.parse(v); }
  catch (e) { return fallback; }
}
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
function key() { return localStorage.getItem("brief.key") || ""; }

// ---------- inline markdown (escape first; content is the owner's own) ----------
function md(s) {
  s = String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*(?!\s)(.+?)(?<!\s)\*/g, "<em>$1</em>");
  s = s.replace(/~~(.+?)~~/g, "<del>$1</del>");
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  // URLs may not contain quotes or angle brackets, so a crafted "link" can
  // never escape the href attribute (content is escaped above regardless).
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s"'<>`]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/(^|[^"=>])\b(https?:\/\/[^\s<)\]"'`]+)/g,
    '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  s = s.replace(/«([^»]+)»/g, '<span class="wiki">$1</span>');
  return s;
}

// ---------- dates ----------
function isoOf(d) {
  var p = function (n) { return (n < 10 ? "0" : "") + n; };
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}
function todayIso() { return isoOf(new Date()); }
function nowIso() {
  var d = new Date(), p = function (n) { return (n < 10 ? "0" : "") + n; };
  return isoOf(d) + "T" + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}
function fmtBuilt(iso) {
  var d = new Date(iso);
  if (isNaN(d)) return "";
  var h = d.getHours(), m = d.getMinutes(), ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return "built " + h + ":" + (m < 10 ? "0" : "") + m + " " + ap;
}

// ---------- per-date brief cache (offline history) ----------
function cacheBrief(data) {
  if (!data || !data.date) return;
  lsSet("brief.day." + data.date, data);
  // prune anything older than the switcher window
  var cut = new Date(); cut.setDate(cut.getDate() - (HISTORY_DAYS + 1));
  var cutIso = isoOf(cut);
  for (var i = localStorage.length - 1; i >= 0; i--) {
    var k = localStorage.key(i);
    if (k && k.indexOf("brief.day.") === 0 && k.slice(10) < cutIso) lsDel(k);
  }
}

// ---------- outbound queue: ticks and captures share one pipe ----------
function ticksKey(date) { return "brief.ticks." + date; }
function localTicks(date) { return lsGet(ticksKey(date), {}); }

function setTick(date, id, done, extra) {
  var t = localTicks(date);
  if (done) t[id] = Object.assign({ done: true, at: nowIso() }, extra || {});
  else delete t[id];
  lsSet(ticksKey(date), t);
  var q = lsGet("brief.queue", []);
  // replace any queued delta for the same box; only the last state matters
  q = q.filter(function (d) {
    return d.type === "capture" || !(d.date === date && d.id === id);
  });
  q.push(Object.assign({ type: "tick", date: date, id: id, done: done, at: nowIso() }, extra || {}));
  lsSet("brief.queue", q);
  flush();
}

function queueCapture(text) {
  var date = todayIso();
  var item = { type: "capture", date: date, text: text, at: nowIso() };
  var q = lsGet("brief.queue", []);
  q.push(item);
  lsSet("brief.queue", q);
  var caps = lsGet("brief.caps." + date, []);
  caps.push({ text: text, at: item.at, sent: false });
  lsSet("brief.caps." + date, caps);
  flush();
}

function markCapSent(d) {
  var caps = lsGet("brief.caps." + d.date, []);
  caps.forEach(function (c) { if (c.at === d.at && c.text === d.text) c.sent = true; });
  lsSet("brief.caps." + d.date, caps);
  var list = document.getElementById("caplist");
  if (list) renderCapList(list);
}

function flush() {
  if (flushing) return;
  var q = lsGet("brief.queue", []);
  if (!q.length) { syncStamp("synced"); return; }
  if (!navigator.onLine) { syncStamp(q.length + " waiting for signal"); return; }
  flushing = true;
  var d = q[0];
  var path = d.type === "capture" ? "/capture" : "/ticks";
  var body = d.type === "capture"
    ? { date: d.date, text: d.text, at: d.at }
    : d;
  fetch(WORKER + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-brief-key": key() },
    body: JSON.stringify(body),
  }).then(function (r) {
    flushing = false;
    if (r.ok || r.status === 400) {
      // 400 = the Worker rejected the payload itself; retrying forever would
      // wedge the queue behind it, so drop it and move on
      var q2 = lsGet("brief.queue", []);
      q2.shift();
      lsSet("brief.queue", q2);
      if (r.ok && d.type === "capture") markCapSent(d);
      flush();
    } else {
      syncStamp(q.length + " not synced (" + r.status + ")");
    }
  }).catch(function () {
    flushing = false;
    syncStamp(q.length + " saved on phone, will sync");
  });
}
window.addEventListener("online", flush);

function syncStamp(text) {
  var el = document.getElementById("sync");
  if (el) el.textContent = text;
}

// ---------- rendering ----------
function el(tag, attrs, html) {
  var e = document.createElement(tag);
  for (var k in attrs || {}) e.setAttribute(k, attrs[k]);
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function foldKey(title) {
  // "Aerospace edge (from the 2026-08-02 brief)" folds like "Aerospace edge":
  // the preference should survive the changing parenthetical
  return String(title).replace(/\(.*$/, "").trim();
}

var CHECK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12.5l5 5 10-11"/></svg>';

function tickRow(date, id, textHtml, checked, extra, cls) {
  var lab = el("label", { class: "tick" + (cls ? " " + cls : "") + (checked ? " done" : "") });
  var box = document.createElement("input");
  box.type = "checkbox";
  box.checked = checked;
  box.addEventListener("change", function () {
    setTick(date, id, box.checked, extra);
    lab.classList.toggle("done", box.checked);
    var card = lab.closest("details.card");
    if (card && cls === "cardtick") card.classList.toggle("done", box.checked);
    if (card) cardCount(card);
    tally();
  });
  lab.appendChild(box);
  lab.appendChild(el("span", { class: "box" }, CHECK_SVG));
  lab.appendChild(el("span", { class: "txt" }, textHtml));
  return lab;
}

function cardCount(card) {
  var boxes = card.querySelectorAll("input[type=checkbox]");
  var n = card.querySelector("summary .n");
  if (!boxes.length || !n) { if (n) n.textContent = ""; return; }
  var done = 0;
  boxes.forEach(function (b) { if (b.checked) done++; });
  n.textContent = done + "/" + boxes.length;
  n.classList.toggle("full", done === boxes.length);
}

function tally() {
  var boxes = document.querySelectorAll("#app input[type=checkbox]");
  var done = 0;
  boxes.forEach(function (b) { if (b.checked) done++; });
  var nd = document.getElementById("ndone"), nt = document.getElementById("ntot");
  if (nd) { nd.textContent = done; nt.textContent = boxes.length; }
  var fill = document.getElementById("fill");
  if (fill) fill.style.width = (boxes.length ? Math.round(done / boxes.length * 100) : 0) + "%";
}

function renderDays() {
  var row = el("div", { class: "days", role: "tablist", "aria-label": "Day" });
  var latestDate = (lsGet("brief.last", null) || {}).date || todayIso();
  var current = viewDate || latestDate;
  for (var back = 0; back < HISTORY_DAYS; back++) {
    (function (back) {
      var d = new Date(); d.setDate(d.getDate() - back);
      var iso = isoOf(d);
      var b = el("button", { type: "button", "aria-current": iso === current ? "true" : "false" },
        '<span class="dw">' + (back === 0 ? "today" : d.toLocaleDateString("en-US", { weekday: "short" })) +
        '</span><span class="dn">' + d.getDate() + "</span>");
      b.addEventListener("click", function () { pickDay(back === 0 ? "" : iso); });
      row.appendChild(b);
    })(back);
  }
  return row;
}

function renderScoreboard(rows) {
  var t = el("section", { class: "score" });
  t.appendChild(el("div", { class: "eyebrow" }, "scoreboard · this week"));
  rows.forEach(function (r) {
    var row = el("div", { class: "row" });
    row.appendChild(el("span", { class: "num" }, md(r.week)));
    row.appendChild(el("span", { class: "lbl" }, md(r.label)));
    if (r.goal) row.appendChild(el("span", { class: "goal" }, md(r.goal)));
    t.appendChild(row);
  });
  return t;
}

function renderCapList(list) {
  list.innerHTML = "";
  var caps = lsGet("brief.caps." + todayIso(), []);
  caps.slice(-6).reverse().forEach(function (c) {
    var li = el("li", {});
    li.appendChild(el("span", { class: "at" },
      (c.sent ? "✓" : "…") + " " + (c.at || "").slice(11, 16)));
    li.appendChild(el("span", {}, md(c.text.length > 90 ? c.text.slice(0, 90) + "..." : c.text)));
    list.appendChild(li);
  });
}

function renderCapture() {
  var box = el("section", { class: "capture" });
  box.appendChild(el("h2", {}, "🪞 Tell Crystal"));
  box.appendChild(el("p", { class: "hint" },
    "Type it and let it go. It lands in the vault with the morning pull."));
  var ta = document.createElement("textarea");
  ta.placeholder = "A thought, a task, a thing to file...";
  ta.setAttribute("aria-label", "Tell Crystal");
  box.appendChild(ta);
  var row = el("div", { class: "row" });
  var stat = el("span", { class: "stat" }, "");
  var send = el("button", { type: "button", class: "send" }, "Send");
  send.addEventListener("click", function () {
    var text = ta.value.trim();
    if (!text) return;
    queueCapture(text);
    ta.value = "";
    stat.textContent = "captured";
    setTimeout(function () { stat.textContent = ""; }, 2500);
    renderCapList(list);
  });
  row.appendChild(stat);
  row.appendChild(send);
  box.appendChild(row);
  var list = el("ul", { class: "caplist", id: "caplist" });
  renderCapList(list);
  box.appendChild(list);
  return box;
}

function render(offlineNote, emptyDayNote) {
  root.innerHTML = "";

  var head = el("header", {});
  var stamp = brief ? fmtBuilt(brief.built) : "";
  head.appendChild(el("div", { class: "eyebrow" },
    "🔮 crystal brief" + (stamp ? " · " + stamp : "")));
  if (brief) {
    // "Friday, August 07, 2026" reads better on a phone without the year
    var day = String(brief.day || "").replace(/,\s*\d{4}\s*$/, "").replace(/ 0(\d)/, " $1");
    head.appendChild(el("h1", {}, md(day)));
    if (brief.strap) head.appendChild(el("div", { class: "strap" }, md(brief.strap)));
  } else {
    head.appendChild(el("h1", {}, "Brief"));
  }
  head.appendChild(el("div", { class: "dawn" }, '<i id="fill"></i>'));
  head.appendChild(el("div", { class: "meter" },
    '<span><b id="ndone">0</b> of <b id="ntot">0</b> closed</span><span id="sync"></span>'));
  root.appendChild(head);

  root.appendChild(renderDays());

  if (offlineNote) root.appendChild(el("div", { class: "banner" }, offlineNote));
  if (brief && viewDate && viewDate !== todayIso()) {
    var backBanner = el("div", { class: "banner" },
      "Reading " + md(brief.day) + ". Ticks still count for that day. ");
    var backBtn = el("button", { type: "button" }, "Back to today");
    backBtn.addEventListener("click", function () { pickDay(""); });
    backBanner.appendChild(backBtn);
    root.appendChild(backBanner);
  } else if (brief && !viewDate && brief.date !== todayIso()) {
    root.appendChild(el("div", { class: "banner" },
      "This brief is from " + md(brief.day) + ", not today. Open with signal to refresh."));
  }

  if (brief && brief.scoreboard && brief.scoreboard.length) {
    root.appendChild(renderScoreboard(brief.scoreboard));
  }

  var app = el("div", { id: "app" });
  if (!brief) {
    app.appendChild(el("p", { class: "empty" },
      emptyDayNote || "No brief cached yet. Open with signal once."));
    root.appendChild(app);
    root.appendChild(renderCapture());
    renderFooter();
    return;
  }

  var date = brief.date;
  var local = localTicks(date);
  var folds = lsGet("brief.fold", {});

  (brief.cards || []).forEach(function (card) {
    var fk = foldKey(card.title);
    var d = el("details", { class: "card" });
    if (!folds[fk]) d.setAttribute("open", "");
    d.addEventListener("toggle", function () {
      var f = lsGet("brief.fold", {});
      if (d.open) delete f[fk]; else f[fk] = true;
      lsSet("brief.fold", f);
    });
    var sum = el("summary", {});
    sum.appendChild(el("span", { class: "t" }, md(card.title)));
    sum.appendChild(el("span", { class: "n" }, ""));
    d.appendChild(sum);
    var body = el("div", { class: "cardbody" });

    if (card.tick) {
      var cchecked = card.tick.checked || !!(local[card.tick.id] || {}).done;
      body.appendChild(tickRow(date, card.tick.id, md(card.tick.label), cchecked, {
        kind: card.kind || "action", section: card.title,
        label: card.tick.label, target: card.tick.target || "",
      }, "cardtick"));
      if (cchecked) d.classList.add("done");
    }

    var ul = null;
    (card.blocks || []).forEach(function (b) {
      if (b.t === "li") {
        if (!ul) { ul = el("ul", {}); body.appendChild(ul); }
        ul.appendChild(el("li", {}, md(b.md)));
        return;
      }
      ul = null;
      if (b.t === "tick") {
        var checked = b.checked || !!(local[b.id] || {}).done;
        body.appendChild(tickRow(date, b.id, md(b.md), checked, {
          kind: "task", section: card.title, label: b.md.slice(0, 120),
        }));
      } else {
        body.appendChild(el("p", b.t === "num" ? { class: "num" } : {}, md(b.md)));
      }
    });
    d.appendChild(body);
    app.appendChild(d);
    cardCount(d);
  });
  root.appendChild(app);
  root.appendChild(renderCapture());
  renderFooter();
  tally();
  flush();
}

function renderFooter() {
  var f = el("footer", {});
  f.appendChild(el("div", {}, "Captured. You do not carry it."));
  var btns = el("div", { class: "btns" });
  var re = el("button", { type: "button" }, "Refresh");
  re.addEventListener("click", function () { pickDay(viewDate, true); });
  var ck = el("button", { type: "button" }, "Change key");
  ck.addEventListener("click", function () { keyScreen(""); });
  btns.appendChild(re);
  btns.appendChild(ck);
  f.appendChild(btns);
  root.appendChild(f);
}

// ---------- key screen ----------
function keyScreen(err) {
  root.innerHTML = "";
  var form = el("div", { id: "keyform" });
  form.appendChild(el("h2", {}, "🔮 Brief"));
  form.appendChild(el("p", {}, "Paste the access key once. It stays on this phone."));
  var input = document.createElement("input");
  input.type = "password";
  input.autocomplete = "off";
  input.placeholder = "access key";
  form.appendChild(input);
  var msg = el("div", { class: "err" }, err || "");
  var btn = el("button", { type: "button" }, "Unlock");
  btn.addEventListener("click", function () {
    var k = input.value.trim();
    if (!k) { msg.textContent = "Key is empty."; return; }
    localStorage.setItem("brief.key", k);
    msg.textContent = "Checking...";
    load(true);
  });
  form.appendChild(btn);
  form.appendChild(msg);
  root.appendChild(form);
  input.focus();
}

// ---------- load ----------
function pickDay(date, force) {
  viewDate = date || "";
  if (!viewDate) { load(true); return; }
  var cached = lsGet("brief.day." + viewDate, null);
  if (cached && !force) { brief = cached; render(""); return; }
  fetch(WORKER + "/brief?date=" + viewDate, { headers: { "x-brief-key": key() } })
    .then(function (r) {
      if (r.status === 404) throw "empty";
      if (!r.ok) throw "http " + r.status;
      return r.json();
    })
    .then(function (data) {
      brief = data;
      cacheBrief(data);
      render("");
    })
    .catch(function (e) {
      if (e === "empty") {
        brief = null;
        render("", "No brief was pushed on this day.");
        return;
      }
      if (cached) { brief = cached; render("Offline. Showing the cached copy."); }
      else { brief = null; render("", "Needs signal to fetch this day."); }
    });
}

function load(force) {
  if (!key()) { keyScreen(""); return; }
  viewDate = "";
  brief = lsGet("brief.last", null);
  if (brief && !force) render("");  // fast paint from cache, then refresh below
  fetch(WORKER + "/brief", { headers: { "x-brief-key": key() } })
    .then(function (r) {
      if (r.status === 401) { keyScreen("That key was refused."); throw "auth"; }
      if (r.status === 404) {
        if (!brief) { render("", "No brief has been pushed yet. It lands with the morning build."); }
        throw "empty";
      }
      if (!r.ok) throw "http " + r.status;
      return r.json();
    })
    .then(function (data) {
      brief = data;
      lsSet("brief.last", data);
      cacheBrief(data);
      render("");
    })
    .catch(function (e) {
      if (e === "auth" || e === "empty") return;
      if (brief) render("Offline. Showing the last cached brief.");
      else render("");
    });
}

load(false);
