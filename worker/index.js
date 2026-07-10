/**
 * Coffee & Tea Site, Worker
 *
 * Single Worker serves the static site (via the ASSETS binding, configured
 * in wrangler.jsonc) and everything under /api/*. No build step, no
 * framework; plain Request/Response handling.
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
 *   GET    /api/admin/site-media                  list of every homepage image slot   [auth]
 *   POST   /api/admin/site-media/:slot/:variant   replace one slot's desktop or
 *                                                  mobile image                        [auth]
 *          (slots: hero-1, hero-2, hero-3, category-coffee, category-tea,
 *          brand-story; variant: desktop|mobile; see SITE_MEDIA_SLOTS below.
 *          Each slot has two independent images, one per variant, so mobile
 *          and desktop visitors can see different crops/photos. Publicly
 *          served at /media/marketing/{slot}-{variant}.webp, same R2 proxy
 *          serveMedia() already uses for product photos.)
 *
 *   -- Checkout (Phase 1, see BUILD_SPEC.md) --
 *   GET    /api/products/:id/variants   active variants for a product        (public)
 *   POST   /api/cart/validate           re-price + stock-check a cart server-side (public)
 *   POST   /api/checkout/session        create a Stripe Checkout Session      (public)
 *   POST   /api/webhooks/stripe         Stripe webhook: marks orders paid, decrements stock
 *   GET    /api/orders/:id?token=...    thank-you page / order lookup         (public, token-gated)
 *   GET    /api/admin/orders            list orders, optional ?status=        [auth]
 *   GET    /api/admin/orders/:id        single order + line items             [auth]
 *   PATCH  /api/admin/orders/:id        update status/tracking_number/notes   [auth]
 *   GET    /api/admin/products/:id/variants   list a product's variants       [auth]
 *   POST   /api/admin/products/:id/variants   create a variant                [auth]
 *   PUT    /api/admin/variants/:id      update a variant                      [auth]
 *   DELETE /api/admin/variants/:id      delete a variant                      [auth]
 *   GET    /api/admin/discounts         list discount codes                   [auth]
 *   POST   /api/admin/discounts         create a discount code                [auth]
 *   PUT    /api/admin/discounts/:code   update a discount code                [auth]
 *   DELETE /api/admin/discounts/:code   delete a discount code                [auth]
 *
 * Required secrets (wrangler secret put <NAME>):
 *   ADMIN_USERNAME        plain username for the single admin account
 *   ADMIN_PASSWORD_HASH   SHA-256 hex digest of the admin password
 *   SHEETS_WEBHOOK_URL    the deployed Google Apps Script Web App URL
 *   TURNSTILE_SECRET_KEY  for verifying Turnstile tokens on public forms
 *                         (checkout calls verifyTurnstile() when both this
 *                         secret and a token are present; not yet required)
 *   STRIPE_SECRET_KEY     Stripe secret key (test or live). Until this is
 *                         set, /api/checkout/session returns a clear
 *                         "not configured" response instead of failing
 *                         silently or faking a charge.
 *   STRIPE_WEBHOOK_SECRET signing secret for the Stripe webhook endpoint
 *   RESEND_API_KEY        optional; order confirmation email is skipped
 *                         (logged, not faked) until this is set, same
 *                         honest-stub pattern as the newsletter Send button
 *   ORDER_EMAIL_FROM      optional "From" address for order confirmation email
 */

const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours

// Fixed set of homepage image slots an admin can customize. Each slot has
// two independent R2 objects, marketing/{slot}-desktop.webp and
// marketing/{slot}-mobile.webp, served publicly via the existing /media/*
// proxy (same mechanism product photos use, just a fixed key instead of one
// keyed by product id). site/index.html picks the right one per breakpoint
// via CSS media queries (or <picture> for the brand-story <img>). No D1
// table needed since the "current" image is just whatever R2 object
// currently lives at that key.
//
// product-placeholder (the no-photo fallback used elsewhere for products
// without their own photo) is intentionally not managed here for now; it
// has no fixed spot on the homepage layout, so it was pulled from this
// admin panel. The underlying /media/marketing/product-placeholder.webp
// file and its use as a fallback elsewhere are untouched.
const SITE_MEDIA_SLOTS = [
  { slot: "hero-1", label: "Hero slide 1 (Coffee)", maxDim: 1600 },
  { slot: "hero-2", label: "Hero slide 2 (Tea)", maxDim: 1600 },
  { slot: "hero-3", label: "Hero slide 3 (Best sellers)", maxDim: 1600 },
  { slot: "category-coffee", label: "Category tile: Coffee", maxDim: 800 },
  { slot: "category-tea", label: "Category tile: Tea", maxDim: 800 },
  { slot: "brand-story", label: "Brand story image", maxDim: 1200 },
];
const SITE_MEDIA_SLOT_KEYS = new Set(SITE_MEDIA_SLOTS.map((s) => s.slot));
const SITE_MEDIA_VARIANTS = new Set(["desktop", "mobile"]);

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
  if (method === "GET" && /^\/api\/products\/[\w-]+\/variants$/.test(pathname)) {
    const productId = pathname.split("/")[3];
    return getVariantsForProductPublic(env, productId);
  }
  if (method === "POST" && pathname === "/api/admin/login") {
    return adminLogin(request, env);
  }
  if (method === "POST" && pathname === "/api/newsletter/subscribe") {
    return newsletterSubscribe(request, env);
  }
  if (method === "POST" && pathname === "/api/cart/validate") {
    return cartValidateRoute(request, env);
  }
  if (method === "POST" && pathname === "/api/checkout/session") {
    return createCheckoutSession(request, env, url);
  }
  if (method === "POST" && pathname === "/api/webhooks/stripe") {
    return stripeWebhook(request, env);
  }
  if (method === "GET" && /^\/api\/orders\/[\w-]+$/.test(pathname)) {
    const id = pathname.split("/").pop();
    return getOrderPublic(env, id, url.searchParams.get("token"));
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
  if (method === "GET" && pathname === "/api/admin/site-media") {
    return listSiteMedia(env);
  }
  if (method === "POST" && /^\/api\/admin\/site-media\/[\w-]+\/(desktop|mobile)$/.test(pathname)) {
    const parts = pathname.split("/");
    const variant = parts.pop();
    const slot = parts.pop();
    return uploadSiteMedia(request, env, slot, variant);
  }
  if (method === "GET" && pathname === "/api/admin/orders") {
    return getOrdersAdmin(env, url);
  }
  if (method === "GET" && /^\/api\/admin\/orders\/[\w-]+$/.test(pathname)) {
    const id = pathname.split("/").pop();
    return getOrderAdmin(env, id);
  }
  if (method === "PATCH" && /^\/api\/admin\/orders\/[\w-]+$/.test(pathname)) {
    const id = pathname.split("/").pop();
    return updateOrderAdmin(request, env, id);
  }
  if (method === "GET" && /^\/api\/admin\/products\/[\w-]+\/variants$/.test(pathname)) {
    const productId = pathname.split("/")[4];
    return getVariantsForProduct(env, productId);
  }
  if (method === "POST" && /^\/api\/admin\/products\/[\w-]+\/variants$/.test(pathname)) {
    const productId = pathname.split("/")[4];
    return createVariant(request, env, productId);
  }
  if (method === "PUT" && /^\/api\/admin\/variants\/[\w-]+$/.test(pathname)) {
    const id = pathname.split("/").pop();
    return updateVariant(request, env, id);
  }
  if (method === "DELETE" && /^\/api\/admin\/variants\/[\w-]+$/.test(pathname)) {
    const id = pathname.split("/").pop();
    return deleteVariant(env, id);
  }
  if (method === "GET" && pathname === "/api/admin/discounts") {
    return getDiscountCodes(env);
  }
  if (method === "POST" && pathname === "/api/admin/discounts") {
    return createDiscountCode(request, env);
  }
  if (method === "PUT" && /^\/api\/admin\/discounts\/[\w-]+$/.test(pathname)) {
    const code = decodeURIComponent(pathname.split("/").pop());
    return updateDiscountCode(request, env, code);
  }
  if (method === "DELETE" && /^\/api\/admin\/discounts\/[\w-]+$/.test(pathname)) {
    const code = decodeURIComponent(pathname.split("/").pop());
    return deleteDiscountCode(env, code);
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

async function getVariantsForProductPublic(env, productId) {
  const { results } = await env.DB.prepare(
    "SELECT id, label, grind, size_grams, price_cents, stock_count FROM product_variants WHERE product_id = ? AND active = 1 ORDER BY sort_order, label"
  ).bind(productId).all();
  return json({ variants: results });
}

function toPublicProduct(row) {
  // Strip internal-only fields (stock_count stays internal-ish but is useful
  // for an "X left" display, keep it; drop nothing sensitive lives here
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
  // Direct admin delete is a manual, confirmed action from the dashboard;
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

  // The R2 put alone doesn't make the image show up anywhere; the public
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
// Media serving: R2 has no public bucket configured here, so the Worker
// proxies it. (An alternative for higher traffic: put a public R2 custom
// domain in front and skip this route entirely; see ARCHITECTURE.md.)
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
// Health check: verifies R2 assets exist and required fields are filled in
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
// Google Sheets sync: push / diff / restore
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

  // Additive/update only; d1_only rows are intentionally never touched here.
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
// Newsletter: capture is real (writes to D1). Sending campaigns is NOT
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
// Site media: admin-customizable homepage images (hero, category tiles,
// brand story), each with independent desktop and mobile variants.
// Fixed R2 keys, no D1 row involved.
// ---------------------------------------------------------------------------

async function listSiteMedia(env) {
  return json({ slots: SITE_MEDIA_SLOTS });
}

async function uploadSiteMedia(request, env, slot, variant) {
  if (!SITE_MEDIA_SLOT_KEYS.has(slot)) {
    return json({ error: "Unknown slot: " + slot }, 400);
  }
  if (!SITE_MEDIA_VARIANTS.has(variant)) {
    return json({ error: "Unknown variant: " + variant }, 400);
  }
  const key = `marketing/${slot}-${variant}.webp`;
  await env.MEDIA.put(key, request.body, {
    httpMetadata: { contentType: "image/webp" },
  });
  return json({ key });
}

// ---------------------------------------------------------------------------
// Turnstile verification: call this from any public form route once one
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
// Cart validation: the server is the only source of truth for price and
// stock. The client cart may only ever send product_id/variant_id/quantity;
// every price and stock check here is re-derived from D1, never trusted from
// the request body. Both /api/cart/validate and /api/checkout/session share
// this function so they can never disagree.
// ---------------------------------------------------------------------------

async function validateCart(env, items) {
  const lines = [];
  const errors = [];

  for (const item of items) {
    const quantity = Math.floor(Number(item?.quantity));
    if (!item?.product_id || !Number.isFinite(quantity) || quantity < 1) {
      errors.push({ product_id: item?.product_id ?? null, error: "Invalid item" });
      continue;
    }

    const product = await env.DB.prepare("SELECT * FROM products WHERE id = ? AND active = 1")
      .bind(item.product_id)
      .first();
    if (!product) {
      errors.push({ product_id: item.product_id, error: "Product not found or unavailable" });
      continue;
    }

    let unitCents, stock, nameSnapshot, weightGrams, variantId = null;

    if (item.variant_id) {
      const variant = await env.DB.prepare(
        "SELECT * FROM product_variants WHERE id = ? AND product_id = ? AND active = 1"
      ).bind(item.variant_id, item.product_id).first();
      if (!variant) {
        errors.push({ product_id: item.product_id, variant_id: item.variant_id, error: "Variant not found or unavailable" });
        continue;
      }
      unitCents = variant.price_cents;
      stock = variant.stock_count;
      nameSnapshot = `${product.name} — ${variant.label}`;
      weightGrams = variant.size_grams ?? product.weight_grams ?? 0;
      variantId = variant.id;
    } else {
      unitCents = product.price_cents;
      stock = product.stock_count;
      nameSnapshot = product.name;
      weightGrams = product.weight_grams ?? 0;
    }

    if (stock < quantity) {
      errors.push({
        product_id: item.product_id,
        variant_id: variantId,
        error: stock > 0 ? `Only ${stock} left in stock` : "Out of stock",
        available: stock,
      });
      continue;
    }

    const lineCents = unitCents * quantity;
    lines.push({
      product_id: item.product_id,
      variant_id: variantId,
      name: nameSnapshot,
      unit_cents: unitCents,
      quantity,
      line_cents: lineCents,
      weight_grams: weightGrams * quantity,
      currency: product.currency,
    });
  }

  const subtotal_cents = lines.reduce((sum, l) => sum + l.line_cents, 0);
  return { lines, subtotal_cents, errors };
}

async function cartValidateRoute(request, env) {
  const body = await safeJson(request);
  const items = Array.isArray(body?.items) ? body.items : [];
  if (!items.length) return json({ error: "items array required" }, 400);

  const { lines, subtotal_cents, errors } = await validateCart(env, items);
  return json({ lines, subtotal_cents, errors, ok: errors.length === 0 });
}

// ---------------------------------------------------------------------------
// Discount codes
// ---------------------------------------------------------------------------

async function applyDiscountCode(env, rawCode, subtotalCents) {
  if (!rawCode) return { discount_cents: 0, code: null };
  const code = rawCode.trim().toUpperCase();

  const row = await env.DB.prepare("SELECT * FROM discount_codes WHERE code = ? AND active = 1")
    .bind(code)
    .first();
  if (!row) return { discount_cents: 0, code: null, error: "Invalid or inactive code" };
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    return { discount_cents: 0, code: null, error: "Code expired" };
  }
  if (row.max_uses != null && row.used_count >= row.max_uses) {
    return { discount_cents: 0, code: null, error: "Code has reached its usage limit" };
  }
  if (subtotalCents < row.min_subtotal_cents) {
    return { discount_cents: 0, code: null, error: `This code needs a minimum subtotal to apply` };
  }

  const raw = row.kind === "percent" ? Math.round(subtotalCents * (row.value / 100)) : row.value;
  return { discount_cents: Math.min(raw, subtotalCents), code: row.code };
}

async function getDiscountCodes(env) {
  const { results } = await env.DB.prepare("SELECT * FROM discount_codes ORDER BY created_at DESC").all();
  return json({ discounts: results });
}

async function createDiscountCode(request, env) {
  const d = await safeJson(request);
  if (!d?.code || !d?.kind || d?.value == null) {
    return json({ error: "code, kind, and value are required" }, 400);
  }
  if (!["percent", "fixed"].includes(d.kind)) {
    return json({ error: "kind must be 'percent' or 'fixed'" }, 400);
  }
  const code = d.code.trim().toUpperCase();
  await env.DB.prepare(
    `INSERT INTO discount_codes (code, kind, value, min_subtotal_cents, active, expires_at, max_uses)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(code, d.kind, d.value, d.min_subtotal_cents ?? 0, d.active ?? 1, d.expires_at ?? null, d.max_uses ?? null)
    .run();
  return json({ code }, 201);
}

async function updateDiscountCode(request, env, code) {
  const d = await safeJson(request);
  const existing = await env.DB.prepare("SELECT code FROM discount_codes WHERE code = ?").bind(code).first();
  if (!existing) return json({ error: "Not found" }, 404);

  await env.DB.prepare(
    `UPDATE discount_codes SET kind = ?, value = ?, min_subtotal_cents = ?, active = ?, expires_at = ?, max_uses = ?
     WHERE code = ?`
  )
    .bind(d.kind, d.value, d.min_subtotal_cents ?? 0, d.active ?? 1, d.expires_at ?? null, d.max_uses ?? null, code)
    .run();
  return json({ ok: true });
}

async function deleteDiscountCode(env, code) {
  await env.DB.prepare("DELETE FROM discount_codes WHERE code = ?").bind(code).run();
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Product variants (size/grind). A product with no variant rows sells as a
// single default line at its own price_cents; variants are additive.
// ---------------------------------------------------------------------------

async function getVariantsForProduct(env, productId) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM product_variants WHERE product_id = ? ORDER BY sort_order, label"
  ).bind(productId).all();
  return json({ variants: results });
}

async function createVariant(request, env, productId) {
  const v = await safeJson(request);
  if (!v?.label || v?.price_cents == null) {
    return json({ error: "label and price_cents are required" }, 400);
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO product_variants (id, product_id, label, grind, size_grams, price_cents, stock_count, sku, active, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id, productId, v.label, v.grind ?? null, v.size_grams ?? null, v.price_cents,
      v.stock_count ?? 0, v.sku ?? null, v.active ?? 1, v.sort_order ?? 0
    )
    .run();
  return json({ id }, 201);
}

async function updateVariant(request, env, id) {
  const v = await safeJson(request);
  const existing = await env.DB.prepare("SELECT id FROM product_variants WHERE id = ?").bind(id).first();
  if (!existing) return json({ error: "Not found" }, 404);

  await env.DB.prepare(
    `UPDATE product_variants SET label = ?, grind = ?, size_grams = ?, price_cents = ?,
       stock_count = ?, sku = ?, active = ?, sort_order = ? WHERE id = ?`
  )
    .bind(
      v.label, v.grind ?? null, v.size_grams ?? null, v.price_cents, v.stock_count ?? 0,
      v.sku ?? null, v.active ?? 1, v.sort_order ?? 0, id
    )
    .run();
  return json({ ok: true });
}

async function deleteVariant(env, id) {
  await env.DB.prepare("DELETE FROM product_variants WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Shipping + tax: deliberately simple placeholder numbers for a first PH
// launch, not a live carrier rate quote. Confirm real rates and whether the
// client is VAT-registered before launch; both are one-line changes here.
// ---------------------------------------------------------------------------

const VAT_RATE = 0; // set to 0.12 once the client confirms VAT registration

function calculateShipping(country, totalWeightGrams) {
  const isPH = (country || "PH").toUpperCase() === "PH";
  if (!isPH) return 120000; // flat placeholder for international, ₱1,200
  if (totalWeightGrams <= 500) return 15000;   // ₱150, one bag
  if (totalWeightGrams <= 2000) return 20000;  // ₱200, a few bags
  return 30000;                                // ₱300, bulk/multi-bag orders
}

function calculateTax(taxableCents) {
  return Math.round(taxableCents * VAT_RATE);
}

// ---------------------------------------------------------------------------
// Checkout: Stripe Checkout Session (hosted page, no card data touches this
// Worker). Cart lines are re-priced from D1 via validateCart() regardless of
// what the client sent. Stock is NOT decremented here; that only happens in
// the webhook once Stripe confirms payment, so an abandoned checkout never
// reserves inventory.
// ---------------------------------------------------------------------------

async function createCheckoutSession(request, env, url) {
  const body = await safeJson(request);
  const items = Array.isArray(body?.items) ? body.items : [];
  const email = (body?.email || "").trim().toLowerCase();

  if (!items.length) return json({ error: "Cart is empty" }, 400);
  if (!EMAIL_RE.test(email)) return json({ error: "A valid email is required" }, 400);

  if (env.TURNSTILE_SECRET_KEY && body?.turnstile_token) {
    const human = await verifyTurnstile(body.turnstile_token, env, request.headers.get("CF-Connecting-IP"));
    if (!human) return json({ error: "Bot verification failed, please retry" }, 400);
  }

  const { lines, subtotal_cents, errors } = await validateCart(env, items);
  if (errors.length) return json({ error: "Some items changed since you added them", details: errors }, 409);
  if (!lines.length) return json({ error: "Cart is empty" }, 400);

  const discount = await applyDiscountCode(env, body?.discount_code, subtotal_cents);
  if (body?.discount_code && discount.error) return json({ error: discount.error }, 400);

  const country = (body?.country || "PH").toUpperCase();
  const totalWeightGrams = lines.reduce((sum, l) => sum + l.weight_grams, 0);
  const shipping_cents = calculateShipping(country, totalWeightGrams);
  const taxable_cents = subtotal_cents - discount.discount_cents;
  const tax_cents = calculateTax(taxable_cents);
  const total_cents = taxable_cents + shipping_cents + tax_cents;
  const currency = (lines[0]?.currency || "PHP").toLowerCase();

  if (!env.STRIPE_SECRET_KEY) {
    // Honest stub, same pattern as the disabled newsletter Send button: real
    // math, no fake success. Lets the front end show a real total while
    // Stripe keys are still pending.
    return json({
      error: "Checkout is not enabled yet. Add the STRIPE_SECRET_KEY secret to accept payments.",
      would_charge: { subtotal_cents, discount_cents: discount.discount_cents, shipping_cents, tax_cents, total_cents, currency },
    }, 503);
  }

  const orderId = crypto.randomUUID();
  const orderToken = crypto.randomUUID();
  const origin = request.headers.get("Origin") || url.origin;

  let couponId = null;
  if (discount.discount_cents > 0) {
    try {
      const couponParams = new URLSearchParams();
      couponParams.set("amount_off", String(discount.discount_cents));
      couponParams.set("currency", currency);
      couponParams.set("duration", "once");
      couponParams.set("name", `Code: ${discount.code}`);
      const coupon = await stripeRequest(env, "coupons", couponParams);
      couponId = coupon.id;
    } catch (err) {
      return json({ error: "Could not apply discount code", detail: err.message }, 502);
    }
  }

  const sessionParams = new URLSearchParams();
  sessionParams.set("mode", "payment");
  sessionParams.set("customer_email", email);
  sessionParams.set("success_url", `${origin}/#/order/${orderId}?token=${orderToken}`);
  sessionParams.set("cancel_url", `${origin}/#/cart`);
  sessionParams.set("client_reference_id", orderId);
  sessionParams.set("metadata[order_id]", orderId);
  sessionParams.set("shipping_address_collection[allowed_countries][0]", "PH");

  let idx = 0;
  for (const line of lines) {
    sessionParams.set(`line_items[${idx}][quantity]`, String(line.quantity));
    sessionParams.set(`line_items[${idx}][price_data][currency]`, currency);
    sessionParams.set(`line_items[${idx}][price_data][unit_amount]`, String(line.unit_cents));
    sessionParams.set(`line_items[${idx}][price_data][product_data][name]`, line.name);
    idx++;
  }
  if (shipping_cents > 0) {
    sessionParams.set(`line_items[${idx}][quantity]`, "1");
    sessionParams.set(`line_items[${idx}][price_data][currency]`, currency);
    sessionParams.set(`line_items[${idx}][price_data][unit_amount]`, String(shipping_cents));
    sessionParams.set(`line_items[${idx}][price_data][product_data][name]`, "Shipping");
    idx++;
  }
  if (tax_cents > 0) {
    sessionParams.set(`line_items[${idx}][quantity]`, "1");
    sessionParams.set(`line_items[${idx}][price_data][currency]`, currency);
    sessionParams.set(`line_items[${idx}][price_data][unit_amount]`, String(tax_cents));
    sessionParams.set(`line_items[${idx}][price_data][product_data][name]`, "VAT");
    idx++;
  }
  if (couponId) {
    sessionParams.set("discounts[0][coupon]", couponId);
  }

  let session;
  try {
    session = await stripeRequest(env, "checkout/sessions", sessionParams);
  } catch (err) {
    return json({ error: "Could not create checkout session", detail: err.message }, 502);
  }

  // A pending order row now, so the webhook has something to flip to "paid"
  // and so a bounced-back buyer's thank-you page shows real (pending) state
  // instead of a 404.
  await env.DB.prepare(
    `INSERT INTO orders
      (id, order_token, stripe_session_id, status, email, subtotal_cents, shipping_cents,
       tax_cents, discount_cents, total_cents, currency, discount_code)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      orderId, orderToken, session.id, email, subtotal_cents, shipping_cents,
      tax_cents, discount.discount_cents, total_cents, lines[0]?.currency || "PHP", discount.code
    )
    .run();

  for (const line of lines) {
    await env.DB.prepare(
      `INSERT INTO order_items (id, order_id, product_id, variant_id, name_snapshot, unit_cents, quantity, line_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(crypto.randomUUID(), orderId, line.product_id, line.variant_id, line.name, line.unit_cents, line.quantity, line.line_cents)
      .run();
  }

  return json({ checkout_url: session.url, order_id: orderId });
}

async function stripeRequest(env, path, params) {
  const resp = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error?.message || `Stripe request to ${path} failed`);
  return data;
}

async function stripeWebhook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) return json({ error: "Webhook not configured" }, 503);

  const signature = request.headers.get("Stripe-Signature");
  const rawBody = await request.text();
  const valid = await verifyStripeSignature(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return json({ error: "Invalid signature" }, 400);

  const event = JSON.parse(rawBody);
  if (event.type === "checkout.session.completed") {
    await handleCheckoutCompleted(env, event.data.object);
  }
  return json({ received: true });
}

async function verifyStripeSignature(payload, signatureHeader, secret) {
  if (!signatureHeader) return false;
  const parts = Object.fromEntries(signatureHeader.split(",").map((p) => p.split("=")));
  const timestamp = parts.t;
  const expectedSig = parts.v1;
  if (!timestamp || !expectedSig) return false;

  // Reject events older than 5 minutes to limit the replay window.
  const ageSeconds = Date.now() / 1000 - Number(timestamp);
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) return false;

  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payload}`));
  const computedHex = [...new Uint8Array(sigBuffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

  return timingSafeEqual(computedHex, expectedSig);
}

async function handleCheckoutCompleted(env, session) {
  const order = await env.DB.prepare("SELECT * FROM orders WHERE stripe_session_id = ?").bind(session.id).first();
  if (!order) return;          // unknown session id, nothing to reconcile
  if (order.status !== "pending") return; // idempotent: webhook may replay

  const address = session.shipping_details?.address || session.customer_details?.address || null;
  const name = session.shipping_details?.name || session.customer_details?.name || null;

  await env.DB.prepare(
    `UPDATE orders SET status = 'paid', customer_name = ?, phone = ?, ship_address_json = ?, updated_at = datetime('now')
     WHERE id = ?`
  )
    .bind(name, session.customer_details?.phone ?? null, address ? JSON.stringify(address) : null, order.id)
    .run();

  const { results: items } = await env.DB.prepare("SELECT * FROM order_items WHERE order_id = ?").bind(order.id).all();
  for (const item of items) {
    if (item.variant_id) {
      await env.DB.prepare("UPDATE product_variants SET stock_count = MAX(0, stock_count - ?) WHERE id = ?")
        .bind(item.quantity, item.variant_id).run();
    } else if (item.product_id) {
      await env.DB.prepare("UPDATE products SET stock_count = MAX(0, stock_count - ?) WHERE id = ?")
        .bind(item.quantity, item.product_id).run();
    }
  }

  if (order.discount_code) {
    await env.DB.prepare("UPDATE discount_codes SET used_count = used_count + 1 WHERE code = ?")
      .bind(order.discount_code).run();
  }

  await sendOrderConfirmationEmail(env, order.id);
}

// ---------------------------------------------------------------------------
// Order confirmation email: real code path, same honest-stub pattern as the
// newsletter Send button. Without RESEND_API_KEY this logs and returns
// instead of pretending to send.
// ---------------------------------------------------------------------------

async function sendOrderConfirmationEmail(env, orderId) {
  if (!env.RESEND_API_KEY) {
    console.log(`Order confirmation email skipped for ${orderId}: RESEND_API_KEY not set`);
    return;
  }

  const order = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first();
  if (!order) return;
  const { results: items } = await env.DB.prepare("SELECT * FROM order_items WHERE order_id = ?").bind(orderId).all();

  const lines = items
    .map((i) => `${i.quantity} x ${i.name_snapshot} - ${formatMoney(i.line_cents, order.currency)}`)
    .join("\n");
  const text = `Thanks for your order${order.customer_name ? ", " + order.customer_name : ""}!

Order ${order.id}

${lines}

Subtotal: ${formatMoney(order.subtotal_cents, order.currency)}
Shipping: ${formatMoney(order.shipping_cents, order.currency)}
Tax: ${formatMoney(order.tax_cents, order.currency)}
Total: ${formatMoney(order.total_cents, order.currency)}`;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.ORDER_EMAIL_FROM || "orders@example.com",
      to: order.email,
      subject: `Order confirmation - ${order.id}`,
      text,
    }),
  });
}

function formatMoney(cents, currency) {
  return new Intl.NumberFormat("en-PH", { style: "currency", currency: currency || "PHP" }).format(cents / 100);
}

// ---------------------------------------------------------------------------
// Order lookup (public, token-gated): thank-you page + email link.
// ---------------------------------------------------------------------------

async function getOrderPublic(env, id, token) {
  if (!token) return json({ error: "Missing token" }, 400);
  const order = await env.DB.prepare("SELECT * FROM orders WHERE id = ? AND order_token = ?").bind(id, token).first();
  if (!order) return json({ error: "Not found" }, 404);
  const { results: items } = await env.DB.prepare("SELECT * FROM order_items WHERE order_id = ?").bind(id).all();
  const { order_token, stripe_session_id, ...safeOrder } = order; // never echo the token/session id back out
  return json({ order: safeOrder, items });
}

// ---------------------------------------------------------------------------
// Admin orders
// ---------------------------------------------------------------------------

const ORDER_STATUSES = new Set(["pending", "paid", "fulfilled", "shipped", "cancelled", "refunded"]);

async function getOrdersAdmin(env, url) {
  const status = url.searchParams.get("status");
  let query = "SELECT * FROM orders";
  const params = [];
  if (status) {
    query += " WHERE status = ?";
    params.push(status);
  }
  query += " ORDER BY created_at DESC LIMIT 200";
  const { results } = await env.DB.prepare(query).bind(...params).all();
  return json({ orders: results });
}

async function getOrderAdmin(env, id) {
  const order = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first();
  if (!order) return json({ error: "Not found" }, 404);
  const { results: items } = await env.DB.prepare("SELECT * FROM order_items WHERE order_id = ?").bind(id).all();
  return json({ order, items });
}

async function updateOrderAdmin(request, env, id) {
  const body = await safeJson(request);
  const existing = await env.DB.prepare("SELECT id FROM orders WHERE id = ?").bind(id).first();
  if (!existing) return json({ error: "Not found" }, 404);

  const fields = [];
  const values = [];
  if (body?.status !== undefined) {
    if (!ORDER_STATUSES.has(body.status)) return json({ error: "Invalid status" }, 400);
    fields.push("status = ?");
    values.push(body.status);
  }
  if (body?.tracking_number !== undefined) {
    fields.push("tracking_number = ?");
    values.push(body.tracking_number);
  }
  if (body?.notes !== undefined) {
    fields.push("notes = ?");
    values.push(body.notes);
  }
  if (!fields.length) return json({ error: "Nothing to update" }, 400);

  fields.push("updated_at = datetime('now')");
  values.push(id);
  await env.DB.prepare(`UPDATE orders SET ${fields.join(", ")} WHERE id = ?`).bind(...values).run();
  return json({ ok: true });
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
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
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
