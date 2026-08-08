// crystal-brief Worker: private relay between a laptop and a phone.
// The public Pages app is an empty shell; every byte of content lives here in
// KV, behind a single secret key (BRIEF_KEY, a Worker secret).
//
//   POST /brief          laptop pushes the day's brief JSON  {date, ...}
//   GET  /brief[?date=]  app fetches latest (or a specific date; history)
//   POST /ticks          app pushes one checkbox delta       {date, id, done, ...}
//   GET  /ticks?date=    laptop pulls a day's tick state
//   POST /capture        app pushes a free-text note         {date, text, at}
//   GET  /capture?date=  laptop pulls a day's captures
//
// Auth on every route: x-brief-key header or ?key= query param.
// ponytail: single-user KV read-modify-write on /ticks; last write wins.
// Fine for one phone; add a Durable Object if a second writer ever appears.

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-brief-key",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};
const MAX_BODY = 512 * 1024;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// hash ids (10 hex) or stable slugs (sleep-lights-out), same rule as crystal_serve.py
const ID_RE = /^[a-z0-9][a-z0-9-]{2,40}$/;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS },
  });
}

function authorized(request, url, env) {
  if (!env.BRIEF_KEY) return false;
  const k = request.headers.get("x-brief-key") || url.searchParams.get("key") || "";
  return k.length === env.BRIEF_KEY.length && k === env.BRIEF_KEY;
}

const clip = (v, n) => String(v ?? "").slice(0, n);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (!authorized(request, url, env)) return json(401, { error: "bad key" });

    const qdate = url.searchParams.get("date") || "";
    if (qdate && !DATE_RE.test(qdate)) return json(400, { error: "bad date" });

    if (url.pathname === "/brief" && request.method === "GET") {
      const raw = await env.STORE.get(qdate ? `brief:${qdate}` : "brief:latest");
      if (!raw) return json(404, { error: "no brief yet" });
      return new Response(raw, {
        headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS },
      });
    }

    if (url.pathname === "/brief" && request.method === "POST") {
      const raw = await request.text();
      if (raw.length > MAX_BODY) return json(413, { error: "too large" });
      let brief;
      try {
        brief = JSON.parse(raw);
      } catch {
        return json(400, { error: "invalid JSON" });
      }
      if (!DATE_RE.test(brief?.date || "")) return json(400, { error: "brief.date required" });
      await env.STORE.put(`brief:${brief.date}`, raw);
      // backfilling an older day (history) must not clobber the phone's latest
      let latestDate = "";
      try {
        latestDate = JSON.parse((await env.STORE.get("brief:latest")) || "{}").date || "";
      } catch {}
      if (brief.date >= latestDate) await env.STORE.put("brief:latest", raw);
      return json(200, { ok: true, date: brief.date, bytes: raw.length });
    }

    if (url.pathname === "/ticks" && request.method === "GET") {
      if (!qdate) return json(400, { error: "date required" });
      const raw = await env.STORE.get(`ticks:${qdate}`);
      return new Response(raw || JSON.stringify({ date: qdate, items: {} }), {
        headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS },
      });
    }

    if (url.pathname === "/ticks" && request.method === "POST") {
      const raw = await request.text();
      if (raw.length > MAX_BODY) return json(413, { error: "too large" });
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(400, { error: "invalid JSON" });
      }
      const date = body?.date || "";
      const id = body?.id || "";
      if (!DATE_RE.test(date)) return json(400, { error: "date required" });
      if (!ID_RE.test(id)) return json(400, { error: "bad id" });
      const key = `ticks:${date}`;
      let cur = {};
      try {
        cur = JSON.parse((await env.STORE.get(key)) || "{}");
      } catch {
        cur = {};
      }
      const items = cur.items && typeof cur.items === "object" ? cur.items : {};
      if (body.done) {
        items[id] = {
          done: true,
          kind: clip(body.kind || "task", 32),
          section: clip(body.section, 120),
          label: clip(body.label, 200),
          target: clip(body.target, 120),
          at: clip(body.at, 40) || new Date().toISOString(),
          via: "phone",
        };
      } else {
        delete items[id];
      }
      const out = { date, items, updated: new Date().toISOString() };
      await env.STORE.put(key, JSON.stringify(out));
      return json(200, { ok: true, done: Object.keys(items).length });
    }

    if (url.pathname === "/capture" && request.method === "GET") {
      if (!qdate) return json(400, { error: "date required" });
      const raw = await env.STORE.get(`capture:${qdate}`);
      return new Response(raw || JSON.stringify({ date: qdate, items: [] }), {
        headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS },
      });
    }

    if (url.pathname === "/capture" && request.method === "POST") {
      const raw = await request.text();
      if (raw.length > MAX_BODY) return json(413, { error: "too large" });
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(400, { error: "invalid JSON" });
      }
      const date = body?.date || "";
      const text = String(body?.text ?? "").trim();
      if (!DATE_RE.test(date)) return json(400, { error: "date required" });
      if (!text) return json(400, { error: "text required" });
      const key = `capture:${date}`;
      let cur = {};
      try {
        cur = JSON.parse((await env.STORE.get(key)) || "{}");
      } catch {
        cur = {};
      }
      const items = Array.isArray(cur.items) ? cur.items : [];
      if (items.length >= 200) return json(429, { error: "capture full for the day" });
      items.push({
        text: clip(text, 2000),
        at: clip(body.at, 40) || new Date().toISOString(),
        via: "phone",
      });
      await env.STORE.put(key, JSON.stringify({ date, items, updated: new Date().toISOString() }));
      return json(200, { ok: true, count: items.length });
    }

    return json(404, { error: "not found" });
  },
};
