// Cloudflare Pages Function: GET /icantplay3mod/api/count returns the number of converted skins,
// POST adds one. Needs a D1 database bound to the project as `DB`.

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

export async function onRequestGet({ env }) {
  await ensureTable(env.DB);
  const row = await env.DB.prepare("SELECT value FROM counters WHERE name = 'converted'").first();
  return json({ count: row ? row.value : 0 });
}

export async function onRequestPost({ request, env }) {
  // Only count conversions made from this site, not requests from other pages.
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) {
    return json({ error: "forbidden" }, 403);
  }
  await ensureTable(env.DB);
  const row = await env.DB.prepare(
    "INSERT INTO counters (name, value) VALUES ('converted', 1) " +
    "ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value"
  ).first();
  return json({ count: row.value });
}
