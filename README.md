# Brief

A small installable web app (PWA) that shows a personal daily brief on a phone.

This repo is only the app shell: HTML, CSS, JS, icons. It contains no content
and no personal data. At runtime the app fetches its content as JSON from a
private Cloudflare Worker, authenticated with a key the user pastes once
(stored in localStorage on the device). Checkbox state is posted back to the
same Worker.

- `index.html` + `app.js`: the whole app, no frameworks, no build step.
- `sw.js`: offline shell cache (the last fetched brief is kept in localStorage).
- `worker/`: the Cloudflare Worker (KV-backed, key-gated). Deploy with wrangler;
  the key lives only as a Worker secret.
- `tools/make-icons.mjs`: zero-dependency icon generator (`node tools/make-icons.mjs`).

## Hard rule

No personal data in this repo, ever: no names, no schedules, no vault paths,
no keys. Content exists only in the Worker's KV at runtime.
