// Brief: phone front end for a daily brief served by a private Cloudflare
// Worker. This repo is a shell: no content, no names, no data. Everything
// arrives at runtime from the Worker, gated by a key the user pastes once.
"use strict";

var WORKER = "https://crystal-brief.janniksin.workers.dev";
var root = document.getElementById("root");
var brief = null;      // the rendered brief JSON
var flushing = false;

// ---------- tiny storage helpers ----------
function lsGet(k, fallback) {
  try { var v = localStorage.getItem(k); return v === null ? fallback : JSON.parse(v); }
  catch (e) { return fallback; }
}
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
function key() { return localStorage.getItem("brief.key") || ""; }

// ---------- inline markdown (escape first; content is the owner's own) ----------
function md(s) {
  s = String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*(?!\s)(.+?)(?<!\s)\*/g, "<em>$1</em>");
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

// ---------- tick state ----------
function ticksKey(date) { return "brief.ticks." + date; }
function localTicks(date) { return lsGet(ticksKey(date), {}); }

function nowIso() {
  var d = new Date(), p = function (n) { return (n < 10 ? "0" : "") + n; };
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
    "T" + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

function setTick(date, id, done, extra) {
  var t = localTicks(date);
  if (done) t[id] = Object.assign({ done: true, at: nowIso() }, extra || {});
  else delete t[id];
  lsSet(ticksKey(date), t);
  var q = lsGet("brief.queue", []);
  // replace any queued delta for the same box; only the last state matters
  q = q.filter(function (d) { return !(d.date === date && d.id === id); });
  q.push(Object.assign({ date: date, id: id, done: done, at: nowIso() }, extra || {}));
  lsSet("brief.queue", q);
  flush();
}

function flush() {
  if (flushing) return;
  var q = lsGet("brief.queue", []);
  if (!q.length) { syncStamp("synced"); return; }
  if (!navigator.onLine) { syncStamp(q.length + " waiting for signal"); return; }
  flushing = true;
  var d = q[0];
  fetch(WORKER + "/ticks", {
    method: "POST",
    headers: { "content-type": "application/json", "x-brief-key": key() },
    body: JSON.stringify(d),
  }).then(function (r) {
    flushing = false;
    if (r.ok) {
      var q2 = lsGet("brief.queue", []);
      q2.shift();
      lsSet("brief.queue", q2);
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

function fmtBuilt(iso) {
  var d = new Date(iso);
  if (isNaN(d)) return "";
  var h = d.getHours(), m = d.getMinutes(), ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return "built " + h + ":" + (m < 10 ? "0" : "") + m + " " + ap;
}

function todayIso() {
  var d = new Date(), p = function (n) { return (n < 10 ? "0" : "") + n; };
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

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
  lab.appendChild(el("span", {}, textHtml));
  return lab;
}

function cardCount(card) {
  var boxes = card.querySelectorAll("input[type=checkbox]");
  var n = card.querySelector("summary .n");
  if (!boxes.length || !n) { if (n) n.textContent = ""; return; }
  var done = 0;
  boxes.forEach(function (b) { if (b.checked) done++; });
  n.textContent = done + "/" + boxes.length;
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

function render(offlineNote) {
  root.innerHTML = "";
  if (!brief) {
    root.appendChild(el("div", { id: "app" },
      '<p class="empty">No brief cached yet. Open with signal once.</p>'));
    renderFooter();
    return;
  }
  var date = brief.date;
  var local = localTicks(date);

  var head = el("header", {});
  head.appendChild(el("h1", {}, "🔮 Crystal Brief"));
  head.appendChild(el("div", { class: "date" }, md(brief.day + ". " + (brief.strap || ""))));
  head.appendChild(el("div", { class: "built" }, fmtBuilt(brief.built)));
  head.appendChild(el("div", { class: "bar" }, '<i id="fill"></i>'));
  head.appendChild(el("div", { class: "count" },
    '<span><b id="ndone">0</b> of <b id="ntot">0</b> done</span><span id="sync"></span>'));
  root.appendChild(head);

  if (offlineNote) root.appendChild(el("div", { class: "banner" }, offlineNote));
  if (date !== todayIso()) {
    root.appendChild(el("div", { class: "banner" },
      "This brief is from " + md(brief.day) + ", not today. Open with signal to refresh."));
  }

  var app = el("div", { id: "app" });
  (brief.cards || []).forEach(function (card) {
    var d = el("details", { class: "card", open: "" });
    var sum = el("summary", {});
    sum.appendChild(el("span", {}, md(card.title)));
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
  renderFooter();
  tally();
  flush();
}

function renderFooter() {
  var f = el("footer", {});
  f.appendChild(el("div", {}, "Captured. You do not carry it."));
  var re = el("button", { type: "button" }, "Refresh");
  re.addEventListener("click", function () { load(true); });
  var ck = el("button", { type: "button" }, "Change key");
  ck.addEventListener("click", function () { keyScreen(""); });
  f.appendChild(re);
  f.appendChild(ck);
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
function load(force) {
  if (!key()) { keyScreen(""); return; }
  brief = lsGet("brief.last", null);
  if (brief && !force) render("");  // fast paint from cache, then refresh below
  fetch(WORKER + "/brief", { headers: { "x-brief-key": key() } })
    .then(function (r) {
      if (r.status === 401) { keyScreen("That key was refused."); throw "auth"; }
      if (r.status === 404) {
        if (!brief) root.innerHTML =
          '<p class="empty" style="color:var(--dim);text-align:center;margin-top:30vh">' +
          "No brief has been pushed yet. It lands with the morning build.</p>";
        throw "empty";
      }
      if (!r.ok) throw "http " + r.status;
      return r.json();
    })
    .then(function (data) {
      brief = data;
      lsSet("brief.last", data);
      render("");
    })
    .catch(function (e) {
      if (e === "auth" || e === "empty") return;
      if (brief) render("Offline. Showing the last cached brief.");
      else render("");
    });
}

load(false);
