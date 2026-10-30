// hyoseong.dev Worker: static files are served from the repo root as assets; only the
// icantplay3mod conversion counter runs code. GET returns the count, POST adds one.

let tableReady = false;

async function ensureTable(db) {
  if (tableReady) return;
  await db.prepare("CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL)").run();
  tableReady = true;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function handleCount(request, env) {
  await ensureTable(env.DB);
  if (request.method === "GET") {
    const row = await env.DB.prepare("SELECT value FROM counters WHERE name = 'converted'").first();
    return json({ count: row ? row.value : 0 });
  }
  if (request.method === "POST") {
    // Only count conversions made from this site, not requests from other pages.
    const origin = request.headers.get("origin");
    if (origin && new URL(origin).host !== new URL(request.url).host) {
      return json({ error: "forbidden" }, 403);
    }
    const row = await env.DB.prepare(
      "INSERT INTO counters (name, value) VALUES ('converted', 1) " +
      "ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value"
    ).first();
    return json({ count: row.value });
  }
  return json({ error: "method not allowed" }, 405);
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/icantplay3mod/api/count") return handleCount(request, env);
    return env.ASSETS.fetch(request);
  },
};
