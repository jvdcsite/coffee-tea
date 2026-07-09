/**
 * Coffee & Tea Site — Worker
 *
 * Single Worker serves the static site (via the ASSETS binding, configured
 * in wrangler.jsonc) and everything under /api/*. No build step, no
 * framework — plain Request/Response handling.
 *
 * Routes:
 *   GET    /api/products              public catalog (optional ?category=coffee|tea)
 *   GET    /api/products/:id          public single product
 *   POST   /api/admin/login           { username, password } -> { token }
 *   GET    /api/admin/products        all products, incl. inactive  [auth]
 *   POST   /api/admin/products        create product               [auth]
 *   PUT    /api/admin/products/:id    update product                [auth]
 *   DELETE /api/admin/products/:id    delete product                [auth]
 *   POST   /api/admin/upload          upload an already-optimized file to R2 [auth]
 *   POST   /api/admin/health-check    verify R2 assets + required fields    [auth]
 *   POST   /api/admin/sheets/push     push all products to the Sheet       [auth]
 *   GET    /api/admin/sheets/diff     compare D1 vs Sheet                  [auth]
 *   POST   /api/admin/sheets/restore  apply a diff additively/updates only [auth]
 *   POST   /api/newsletter/subscribe        add an email to the list           (public)
 *   GET    /api/admin/newsletter/subscribers list subscribers                  [auth]
 *   DELETE /api/admin/newsletter/subscribers/:email  remove a subscriber       [auth]
 *
 * Required secrets (wrangler secret put <NAME>):
 *   ADMIN_USERNAME        plain username for the single admin account
 *   ADMIN_PASSWORD_HASH   SHA-256 hex digest of the admin password
 *   SHEETS_WEBHOOK_URL    the deployed Google Apps Script Web App URL
 *   TURNSTILE_SECRET_KEY  for verifying Turnstile tokens on public forms
 *                         (not yet wired to a route — see apps-script notes;
 *                         call verifyTurnstile() once a public form exists)
 */

const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
      if (url.pathname.startsWith("/api/")) {
        const response = await routeApi(request, env, url);
        return withCors(response);
      }
      if (url.pathname.startsWith("/media/")) {
        return serveMedia(env, url.pathname.slice("/media/".length));
      }
      // Anything not under /api/* or /media/* falls through to static assets.
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error("Unhandled error:", err);
      return withCors(json({ error: "Internal error" }, 500));
    }
  },
};

async function routeApi(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  // ---- Public routes ----
  if (method === "GET" && pathname === "/api/products") {
    return getProducts(request, env, url);
  }
  if (method === "GET" && /^\/api\/products\/[\w-]+$/.test(pathname)) {
    const id = pathname.split("/").pop();
    return getProduct(env, id);
  }
  if (method === "POST" && pathname === "/api/admin/login") {
    return adminLogin(request, env);
  }
  if (method === "POST" && pathname === "/api/newsletter/subscribe") {
    return newsletterSubscribe(request, env);
  }

  // ---- Admin routes (all require a valid session token) ----
  if (pathname.startsWith("/api/admin/")) {
    const authError = await requireAuth(request, env);
    if (authError) return authError;
  }

  if (method === "GET" && pathname === "/api/admin/products") {
    return getAllProductsAdmin(env);
  }
  if (method === "POST" && pathname === "/api/admin/products") {
    return createProduct(request, env);
  }
  if (method === "PUT" && /^\/api\/admin\/products\/[\w-]+$/.test(pathname)) {
    const id = pathname.split("/").pop();
    return updateProduct(request, env, id);
  }
  if (method === "DELETE" && /^\/api\/admin\/products\/[\w-]+$/.test(pathname)) {
    const id = pathname.split("/").pop();
    return deleteProduct(env, id);
  }
  if (method === "POST" && pathname === "/api/admin/upload") {
    return uploadMedia(request, env);
  }
  if (method === "POST" && pathname === "/api/admin/health-check") {
    return healthCheck(env);
  }
  if (method === "POST" && pathname === "/api/admin/sheets/push") {
    return sheetsPush(env);
  }
  if (method === "GET" && pathname === "/api/admin/sheets/diff") {
    return sheetsDiff(env);
  }
  if (method === "POST" && pathname === "/api/admin/sheets/restore") {
    return sheetsRestore(request, env);
  }
  if (method === "GET" && pathname === "/api/admin/newsletter/subscribers") {
    return getNewsletterSubscribers(env);
  }
  if (method === "DELETE" && pathname.startsWith("/api/admin/newsletter/subscribers/")) {
    const email = decodeURIComponent(pathname.slice("/api/admin/newsletter/subscribers/".length));
    return deleteNewsletterSubscriber(env, email);
  }

  return json({ error: "Not found" }, 404);
}

// ---------------------------------------------------------------------------
// Public catalog
// ---------------------------------------------------------------------------

async function getProducts(request, env, url) {
  const category = url.searchParams.get("category"); // "coffee" | "tea" | null
  let query = "SELECT * FROM products WHERE active = 1";
  const params = [];
  if (category === "coffee" || category === "tea") {
    query += " AND category = ?";
    params.push(category);
  }
  query += " ORDER BY created_at DESC";

  const { results } = await env.DB.prepare(query).bind(...params).all();
  return json({ products: results.map(toPublicProduct) });
}

async function getProduct(env, id) {
  const row = await env.DB.prepare("SELECT * FROM products WHERE id = ? AND active = 1")
    .bind(id)
    .first();
  if (!row) return json({ error: "Not found" }, 404);
  return json({ product: toPublicProduct(row) });
}

function toPublicProduct(row) {
  // Strip internal-only fields (stock_count stays internal-ish but is useful
  // for an "X left" display — keep it; drop nothing sensitive lives here
  // today, but this is the seam to redact fields later if needed).
  return row;
}

// ---------------------------------------------------------------------------
// Admin auth
// ---------------------------------------------------------------------------

async function adminLogin(request, env) {
  const body = await safeJson(request);
  if (!body?.username || !body?.password) {
    return json({ error: "Username and password required" }, 400);
  }

  const passwordHash = await sha256Hex(body.password);
  const validUsername = timingSafeEqual(body.username, env.ADMIN_USERNAME || "");
  const validPassword = timingSafeEqual(passwordHash, env.ADMIN_PASSWORD_HASH || "");

  if (!validUsername || !validPassword) {
    return json({ error: "Invalid credentials" }, 401);
  }

  const token = crypto.randomUUID() + crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await env.DB.prepare("INSERT INTO sessions (token, expires_at) VALUES (?, ?)")
    .bind(token, expiresAt)
    .run();

  return json({ token, expires_at: expiresAt });
}

async function requireAuth(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return json({ error: "Missing token" }, 401);

  const session = await env.DB.prepare(
    "SELECT token FROM sessions WHERE token = ? AND expires_at > datetime('now')"
  )
    .bind(token)
    .first();

  if (!session) return json({ error: "Invalid or expired session" }, 401);
  return null; // null = authorized, no error response
}

// ---------------------------------------------------------------------------
// Admin product CRUD
// ---------------------------------------------------------------------------

async function getAllProductsAdmin(env) {
  const { results } = await env.DB.prepare("SELECT * FROM products ORDER BY updated_at DESC").all();
  return json({ products: results });
}

async function createProduct(request, env) {
  const p = await safeJson(request);
  if (!p?.category || !p?.name || p?.price_cents == null) {
    return json({ error: "category, name, and price_cents are required" }, 400);
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO products
      (id, category, name, origin, process, roast_level, leaf_type, caffeine_level,
       altitude_m, flavor_notes, description, price_cents, currency, stock_count,
       weight_grams, image_key, thumb_key, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id, p.category, p.name, p.origin ?? null, p.process ?? null,
      p.roast_level ?? null, p.leaf_type ?? null, p.caffeine_level ?? null,
      p.altitude_m ?? null, p.flavor_notes ?? null, p.description ?? null,
      p.price_cents, p.currency ?? "PHP", p.stock_count ?? 0,
      p.weight_grams ?? null, p.image_key ?? null, p.thumb_key ?? null,
      p.active ?? 1
    )
    .run();
  return json({ id }, 201);
}

async function updateProduct(request, env, id) {
  const p = await safeJson(request);
  const existing = await env.DB.prepare("SELECT id FROM products WHERE id = ?").bind(id).first();
  if (!existing) return json({ error: "Not found" }, 404);

  await env.DB.prepare(
    `UPDATE products SET
       category = ?, name = ?, origin = ?, process = ?, roast_level = ?,
       leaf_type = ?, caffeine_level = ?, altitude_m = ?, flavor_notes = ?,
       description = ?, price_cents = ?, currency = ?, stock_count = ?,
       weight_grams = ?, image_key = ?, thumb_key = ?, active = ?,
       updated_at = datetime('now')
     WHERE id = ?`
  )
    .bind(
      p.category, p.name, p.origin ?? null, p.process ?? null,
      p.roast_level ?? null, p.leaf_type ?? null, p.caffeine_level ?? null,
      p.altitude_m ?? null, p.flavor_notes ?? null, p.description ?? null,
      p.price_cents, p.currency ?? "PHP", p.stock_count ?? 0,
      p.weight_grams ?? null, p.image_key ?? null, p.thumb_key ?? null,
      p.active ?? 1, id
    )
    .run();
  return json({ ok: true });
}

async function deleteProduct(env, id) {
  // Direct admin delete is a manual, confirmed action from the dashboard —
  // this is NOT the Sheets restore path, which must never auto-delete.
  await env.DB.prepare("DELETE FROM products WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Media upload (browser already resized/converted to WebP before this call)
// ---------------------------------------------------------------------------

async function uploadMedia(request, env) {
  const productId = request.headers.get("X-Product-Id");
  const variant = request.headers.get("X-Variant"); // "full" | "thumb"
  if (!productId || !["full", "thumb"].includes(variant)) {
    return json({ error: "X-Product-Id and X-Variant (full|thumb) headers required" }, 400);
  }

  const key = variant === "thumb"
    ? `images/${productId}-thumb.webp`
    : `images/${productId}.webp`;

  await env.MEDIA.put(key, request.body, {
    httpMetadata: { contentType: "image/webp" },
  });

  // The R2 put alone doesn't make the image show up anywhere — the public
  // site and admin health-check both read image_key/thumb_key off the D1
  // row, not off R2 directly. Persist it here so callers don't have to
  // remember to issue a separate PUT /admin/products/:id afterward.
  const column = variant === "thumb" ? "thumb_key" : "image_key";
  await env.DB.prepare(`UPDATE products SET ${column} = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(key, productId)
    .run();

  return json({ key });
}

// ---------------------------------------------------------------------------
// Media serving — R2 has no public bucket configured here, so the Worker
// proxies it. (An alternative for higher traffic: put a public R2 custom
// domain in front and skip this route entirely — see ARCHITECTURE.md.)
// ---------------------------------------------------------------------------

async function serveMedia(env, key) {
  const object = await env.MEDIA.get(key);
  if (!object) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return new Response(object.body, { headers });
}

// ---------------------------------------------------------------------------
// Health check — verifies R2 assets exist and required fields are filled in
// ---------------------------------------------------------------------------

async function healthCheck(env) {
  const { results } = await env.DB.prepare("SELECT * FROM products").all();
  const report = [];

  for (const p of results) {
    const issues = [];
    if (!p.name) issues.push("missing name");
    if (p.price_cents == null) issues.push("missing price");
    if (!p.image_key) {
      issues.push("no image set");
    } else {
      const head = await env.MEDIA.head(p.image_key);
      if (!head) issues.push(`image missing in R2: ${p.image_key}`);
    }
    if (p.thumb_key) {
      const head = await env.MEDIA.head(p.thumb_key);
      if (!head) issues.push(`thumbnail missing in R2: ${p.thumb_key}`);
    }
    report.push({ id: p.id, name: p.name, ok: issues.length === 0, issues });
  }

  return json({ report });
}

// ---------------------------------------------------------------------------
// Google Sheets sync — push / diff / restore
// ---------------------------------------------------------------------------

async function sheetsPush(env) {
  const { results } = await env.DB.prepare("SELECT * FROM products").all();
  const resp = await fetch(env.SHEETS_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "push", products: results }),
  });
  if (!resp.ok) {
    return json({ error: "Sheets push failed", detail: await resp.text() }, 502);
  }
  return json({ ok: true, count: results.length });
}

async function fetchSheetRows(env) {
  const resp = await fetch(`${env.SHEETS_WEBHOOK_URL}?action=list`);
  if (!resp.ok) throw new Error(`Sheets fetch failed: ${await resp.text()}`);
  const data = await resp.json();
  return data.products ?? [];
}

async function sheetsDiff(env) {
  const [{ results: d1Rows }, sheetRows] = await Promise.all([
    env.DB.prepare("SELECT * FROM products").all(),
    fetchSheetRows(env),
  ]);

  const d1ById = new Map(d1Rows.map((r) => [r.id, r]));
  const sheetById = new Map(sheetRows.map((r) => [r.id, r]));

  const added = [];    // in Sheet, not in D1
  const updated = [];  // in both, differs
  const unchanged = []; // in both, identical
  const d1Only = [];   // in D1, not in Sheet (never auto-deleted)

  for (const [id, sheetRow] of sheetById) {
    const d1Row = d1ById.get(id);
    if (!d1Row) {
      added.push(sheetRow);
    } else if (JSON.stringify(sortKeys(d1Row)) !== JSON.stringify(sortKeys(sheetRow))) {
      updated.push({ id, d1: d1Row, sheet: sheetRow });
    } else {
      unchanged.push(sheetRow);
    }
  }
  for (const [id, d1Row] of d1ById) {
    if (!sheetById.has(id)) d1Only.push(d1Row);
  }

  return json({ added, updated, unchanged, d1_only: d1Only });
}

async function sheetsRestore(request, env) {
  const body = await safeJson(request);
  const { added = [], updated = [] } = body ?? {};

  // Additive/update only — d1_only rows are intentionally never touched here.
  for (const row of added) {
    await createProductFromRow(env, row);
  }
  for (const { id, sheet } of updated) {
    await updateProductFromRow(env, id, sheet);
  }

  return json({ ok: true, added: added.length, updated: updated.length });
}

async function createProductFromRow(env, row) {
  await env.DB.prepare(
    `INSERT INTO products
      (id, category, name, origin, process, roast_level, leaf_type, caffeine_level,
       altitude_m, flavor_notes, description, price_cents, currency, stock_count,
       weight_grams, image_key, thumb_key, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      row.id, row.category, row.name, row.origin ?? null, row.process ?? null,
      row.roast_level ?? null, row.leaf_type ?? null, row.caffeine_level ?? null,
      row.altitude_m ?? null, row.flavor_notes ?? null, row.description ?? null,
      row.price_cents, row.currency ?? "PHP", row.stock_count ?? 0,
      row.weight_grams ?? null, row.image_key ?? null, row.thumb_key ?? null,
      row.active ?? 1
    )
    .run();
}

async function updateProductFromRow(env, id, row) {
  await env.DB.prepare(
    `UPDATE products SET
       category = ?, name = ?, origin = ?, process = ?, roast_level = ?,
       leaf_type = ?, caffeine_level = ?, altitude_m = ?, flavor_notes = ?,
       description = ?, price_cents = ?, currency = ?, stock_count = ?,
       weight_grams = ?, image_key = ?, thumb_key = ?, active = ?,
       updated_at = datetime('now')
     WHERE id = ?`
  )
    .bind(
      row.category, row.name, row.origin ?? null, row.process ?? null,
      row.roast_level ?? null, row.leaf_type ?? null, row.caffeine_level ?? null,
      row.altitude_m ?? null, row.flavor_notes ?? null, row.description ?? null,
      row.price_cents, row.currency ?? "PHP", row.stock_count ?? 0,
      row.weight_grams ?? null, row.image_key ?? null, row.thumb_key ?? null,
      row.active ?? 1, id
    )
    .run();
}

function sortKeys(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}

// ---------------------------------------------------------------------------
// Newsletter — capture is real (writes to D1). Sending campaigns is NOT
// wired up here; that needs an email provider (e.g. Resend, Mailchannels)
// added as a secret plus a send route. The admin "Compose" UI reflects that.
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function newsletterSubscribe(request, env) {
  const body = await safeJson(request);
  const email = (body?.email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return json({ error: "A valid email address is required" }, 400);
  }
  await env.DB.prepare("INSERT OR IGNORE INTO newsletter_subscribers (email) VALUES (?)")
    .bind(email)
    .run();
  return json({ ok: true }, 201);
}

async function getNewsletterSubscribers(env) {
  const { results } = await env.DB.prepare(
    "SELECT email, subscribed_at FROM newsletter_subscribers ORDER BY subscribed_at DESC"
  ).all();
  return json({ subscribers: results });
}

async function deleteNewsletterSubscriber(env, email) {
  await env.DB.prepare("DELETE FROM newsletter_subscribers WHERE email = ?").bind(email).run();
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Turnstile verification — call this from any public form route once one
// exists (e.g. a contact/inquiry endpoint). Not yet wired to a route.
// ---------------------------------------------------------------------------

async function verifyTurnstile(token, env, remoteIp) {
  const resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      secret: env.TURNSTILE_SECRET_KEY,
      response: token,
      remoteip: remoteIp,
    }),
  });
  const data = await resp.json();
  return data.success === true;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Product-Id, X-Variant",
  };
}

function withCors(response) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hashBuffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}
