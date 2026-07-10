# Build Spec — From Catalog to Store

Goal: take the current catalog + CMS to a real, direct-sale ecommerce store
at a premium (Blue Bottle) level of polish. Scope decisions locked in with the
client:

- **Sell directly** (not showcase-only). Real checkout is in scope now.
- **Subscriptions** are Phase 2, after one-time checkout is solid.
- **One-time purchases** are the Phase 1 priority.

This doc is the plan of record. It fits the existing constraints from
`ARCHITECTURE.md`: Cloudflare-only free tier, vanilla JS, no build step,
Worker + static assets + D1 + R2. It does not assume a framework or a bundler.
Read `AGENT_HANDOFF.md` for what is already real vs. stubbed before starting
any phase.

Copy rule for this project: no em dashes anywhere (copy, comments, commits).

---

## Guiding principles (do not violate)

1. **Price is server truth, always.** The client cart may hold product ids and
   quantities, never prices. The Worker recomputes every line total and the
   order total from D1 at checkout time. A tampered client payload must never
   change what is charged.
2. **Stripe holds the card, we never do.** Use Stripe Checkout (hosted) or
   Payment Intents with Stripe.js. No raw card data touches the Worker. This
   keeps us out of PCI scope.
3. **Stock is decremented on payment confirmation, not on add-to-cart.** The
   Stripe webhook is the single writer of "this order is paid, reduce stock."
4. **Every new public form gets Turnstile.** `verifyTurnstile()` already exists
   in `worker/index.js` and is currently unused. Checkout contact, reviews, and
   account signup all call it.
5. **Idempotency.** The Stripe webhook can fire more than once for the same
   event. Writes keyed off `stripe_session_id` must be safe to replay.

---

## Phase 1 — Make it transact (the unlock)

Nothing else in this spec matters until money can move. This is the gate.

### 1.1 Schema additions (`db/schema.sql`)

New tables. Money stays integer cents, matching the existing `products`
convention.

```sql
-- Product variants: size, grind, whole-bean vs ground. A product with no
-- variants sells as a single default line. Coffee typically has grind +
-- size; tea typically has size only.
CREATE TABLE IF NOT EXISTS product_variants (
  id             TEXT PRIMARY KEY,
  product_id     TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  label          TEXT NOT NULL,             -- e.g. "250g / Whole bean"
  grind          TEXT,                      -- whole/espresso/filter/french-press, null for tea
  size_grams     INTEGER,                   -- overrides products.weight_grams for shipping
  price_cents    INTEGER NOT NULL,          -- variant price, not a delta
  stock_count    INTEGER NOT NULL DEFAULT 0,
  sku            TEXT,
  active         INTEGER NOT NULL DEFAULT 1,
  sort_order     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_variants_product ON product_variants(product_id);

-- Orders. One row per completed checkout.
CREATE TABLE IF NOT EXISTS orders (
  id                 TEXT PRIMARY KEY,       -- our order number, human-shareable
  stripe_session_id  TEXT UNIQUE,            -- idempotency key for the webhook
  status             TEXT NOT NULL DEFAULT 'pending',
                                            -- pending/paid/fulfilled/shipped/cancelled/refunded
  email              TEXT NOT NULL,
  customer_name      TEXT,
  phone              TEXT,
  ship_address_json  TEXT,                   -- JSON blob: line1, line2, city, region, postal, country
  subtotal_cents     INTEGER NOT NULL,
  shipping_cents     INTEGER NOT NULL DEFAULT 0,
  tax_cents          INTEGER NOT NULL DEFAULT 0,
  discount_cents     INTEGER NOT NULL DEFAULT 0,
  total_cents        INTEGER NOT NULL,
  currency           TEXT NOT NULL DEFAULT 'PHP',
  discount_code      TEXT,
  notes              TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_email ON orders(email);

-- Line items. Snapshot name/price so later product edits do not rewrite
-- historical orders.
CREATE TABLE IF NOT EXISTS order_items (
  id            TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id    TEXT,                        -- nullable: product may be deleted later
  variant_id    TEXT,
  name_snapshot TEXT NOT NULL,               -- "Yirgacheffe / 250g / Whole bean"
  unit_cents    INTEGER NOT NULL,
  quantity      INTEGER NOT NULL,
  line_cents    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

-- Discount codes.
CREATE TABLE IF NOT EXISTS discount_codes (
  code           TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,              -- 'percent' | 'fixed'
  value          INTEGER NOT NULL,           -- percent (0-100) or fixed cents
  min_subtotal_cents INTEGER DEFAULT 0,
  active         INTEGER NOT NULL DEFAULT 1,
  expires_at     TEXT,
  max_uses       INTEGER,
  used_count     INTEGER NOT NULL DEFAULT 0
);
```

Migration note: write these as a separate `db/migrations/002_orders.sql` rather
than editing the seed-bearing `schema.sql`, so applying it to the live D1 does
not re-run the sample-product inserts. Apply with the same
`wrangler d1 execute` pattern already in `package.json`.

### 1.2 Worker routes (`worker/index.js`)

The router is a flat `if` chain in `routeApi()` (see lines 95-170). Add, in the
same style:

Public:
- `POST /api/cart/validate` — body is `[{product_id, variant_id, quantity}]`;
  returns each line re-priced from D1, per-line stock check, and a computed
  subtotal. The client cart calls this on open and before checkout so the UI
  never shows a stale price.
- `POST /api/checkout/session` — validates the cart server-side, applies a
  discount code if present, computes shipping + tax, creates a Stripe Checkout
  Session, returns its URL. Turnstile-gated.
- `POST /api/webhooks/stripe` — verifies the Stripe signature, and on
  `checkout.session.completed`: writes the `orders` + `order_items` rows,
  decrements variant/product stock, marks status `paid`, fires the confirmation
  email. Idempotent on `stripe_session_id`.
- `GET /api/orders/:id?token=...` — order status lookup for the thank-you page
  and email link (opaque per-order token, not the raw id alone).

Admin (all already behind the `requireAuth` gate at line 115):
- `GET /api/admin/orders` — list with status filter + pagination.
- `GET /api/admin/orders/:id` — full order with items.
- `PATCH /api/admin/orders/:id` — status transitions, tracking number, notes.
- `GET/POST/PATCH/DELETE /api/admin/variants` — variant CRUD under a product.
- `GET/POST/PATCH/DELETE /api/admin/discounts` — discount code CRUD.

Secrets to add (via `wrangler secret put`, never in code): `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY` (or Mailchannels), plus the existing
`TURNSTILE_SECRET_KEY` finally wired up.

### 1.3 Shipping + tax (PH launch)

Keep it simple and correct for a Philippine launch:
- Flat or weight-tiered shipping using `size_grams` / `weight_grams` already in
  the schema. A small `shipping_rates` config (metro vs provincial vs
  international) is enough. Do not integrate a live carrier API in Phase 1.
- Tax: if the client is VAT-registered, apply 12% VAT; otherwise zero. Store
  the resolved `tax_cents` on the order regardless, so the number is auditable.
- Both are computed server-side inside `/api/checkout/session`, never trusted
  from the client.

### 1.4 Storefront (`site/index.html`)

The cart is currently a `sessionStorage` UI stub (see the handoff). Upgrade it:
- Cart drawer calls `/api/cart/validate` on open and reflects any price/stock
  drift before the user reaches checkout.
- Variant selectors on the product detail view (grind, size) that change the
  active `variant_id` and price.
- "Proceed to checkout" posts to `/api/checkout/session` and redirects to the
  Stripe-hosted page.
- A `#/order/{id}` thank-you route reading `/api/orders/:id`.
- Turnstile widget on the checkout step.

### 1.5 Admin (`site/admin.html`)

- Wire the existing **Orders** tab (currently a layout-only skeleton per the
  handoff) to `/api/admin/orders`: list, filter by status, open detail, change
  status, add tracking, print/pack view.
- Add a **Variants** section inside the product edit form.
- Add a **Discounts** tab.

### 1.6 Transactional email

One provider (Resend recommended: single secret, single POST route, reuses the
newsletter plumbing shape). Phase 1 needs exactly one template: order
confirmation. Shipping-notification and abandoned-cart come in Phase 3.

### Phase 1 done when

A stranger can land on the site, pick a coffee + grind + size, pay with a real
card via Stripe, receive a confirmation email, and the admin sees the order with
stock decremented. That is the whole gate.

---

## Phase 2 — Trust + discovery + subscriptions groundwork

Turns a working checkout into a store people actually buy from.

- **Product detail upgrade:** variant UI polished, tasting-note chips (you
  already store `flavor_notes`), brew guide block, origin + altitude + roast /
  leaf metadata surfaced (all already in the `products` schema, currently
  under-used).
- **Search + collections:** text search over name/origin/notes, tag/collection
  grouping, sort (price, freshness), clear in/out-of-stock states.
- **Reviews:** `reviews` table, public submit (Turnstile-gated), admin
  moderation queue, average rating on cards and PDP.
- **Discount codes** exposed at checkout (schema already built in Phase 1).
- **SEO, the real one:** this is where the single-file hash-routed SPA starts to
  cost you. Add server-rendered product routes from the Worker (it already has
  the data and serves HTML), real `<title>`/meta/OG per product, JSON-LD
  `Product` structured data, and a generated `sitemap.xml`. This is the one
  place worth deviating from "everything in one static file."
- **Subscriptions groundwork:** design the recurring model now (cadence, grind,
  pause/skip/cancel) so Phase 3 is a build, not a redesign. No billing yet.

---

## Phase 3 — The Blue Bottle signature

- **Subscriptions:** Stripe recurring (Billing/Subscriptions), cadence + grind +
  quantity, customer self-serve pause / skip / cancel. This is Blue Bottle's
  actual core business, deferred to here on purpose so checkout ships first.
- **Customer accounts:** order history, saved addresses, manage subscription.
  Keep auth lightweight (magic-link email over passwords fits the no-SaaS
  constraint and reuses the email provider).
- **Lifecycle email:** abandoned cart, shipping notification, subscription
  renewal reminders.
- **Gift cards + gifting flow.**

---

## Phase 4 — Premium polish

- Content: brewing guides, journal, origin stories, "Find Us" (the placeholder
  nav item already exists).
- Analytics, full accessibility pass, performance budget.
- Custom domain (the `routes` array in `wrangler.jsonc` is still empty by
  design, see the handoff).
- Turnstile confirmed on every public form.

---

## Cross-cutting, do not skip

- **Idempotent webhook** with signature verification. Test with the Stripe CLI
  against local `wrangler dev` before going near production.
- **Staging first, always.** Same rule as `ARCHITECTURE.md` §7. Note the
  gotcha: staging and prod currently share one D1 + R2 (see the handoff), so a
  test order on staging is a real row in prod's database. Decide before Phase 1
  whether to split databases or accept shared test data.
- **Money is integer cents end to end.** Never introduce a float. The admin
  margin calculator's dollars-to-cents conversion is the only human-readable
  boundary and it already rounds correctly.
- **Free-tier ceiling still holds** (see `ARCHITECTURE.md` §9). Orders and
  webhooks are low-volume writes; nothing here threatens the D1/Workers limits.

---

## Suggested execution order

1. Split staging/prod data OR accept shared (decide first, it is a one-line
   `wrangler.jsonc` change either way but changes how you test).
2. Migration `002_orders.sql`: variants, orders, order_items, discounts.
3. Stripe test-mode keys + webhook secret as Worker secrets.
4. `/api/cart/validate` and the server-truth pricing path.
5. `/api/checkout/session` + Stripe Checkout redirect.
6. `/api/webhooks/stripe` with idempotency + stock decrement.
7. Order confirmation email.
8. Storefront cart + variant UI + thank-you page.
9. Admin Orders tab + Variants + Discounts.
10. End-to-end test with a real card in Stripe test mode on staging.
11. Ship Phase 1 to production (explicit go-ahead required, per §7).
