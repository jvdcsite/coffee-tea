-- Adds real checkout: variants, orders, order items, discount codes.
-- Apply with: wrangler d1 execute coffee-tea-db --file=./db/migrations/002_orders.sql --remote
-- (drop --remote for local dev). Separate from schema.sql on purpose so this
-- can be applied to the live D1 without re-running the sample-product seeds.

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

CREATE TABLE IF NOT EXISTS orders (
  id                 TEXT PRIMARY KEY,       -- our order number, human-shareable
  order_token        TEXT NOT NULL,          -- opaque token for the thank-you/lookup URL
  stripe_session_id  TEXT UNIQUE,            -- idempotency key for the webhook
  status             TEXT NOT NULL DEFAULT 'pending',
                                            -- pending/paid/fulfilled/shipped/cancelled/refunded
  email              TEXT NOT NULL,
  customer_name      TEXT,
  phone              TEXT,
  ship_address_json  TEXT,                   -- JSON: line1, line2, city, region, postal, country
  subtotal_cents     INTEGER NOT NULL,
  shipping_cents     INTEGER NOT NULL DEFAULT 0,
  tax_cents          INTEGER NOT NULL DEFAULT 0,
  discount_cents     INTEGER NOT NULL DEFAULT 0,
  total_cents        INTEGER NOT NULL,
  currency           TEXT NOT NULL DEFAULT 'PHP',
  discount_code      TEXT,
  tracking_number    TEXT,
  notes              TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_email ON orders(email);

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

CREATE TABLE IF NOT EXISTS discount_codes (
  code                TEXT PRIMARY KEY,
  kind                TEXT NOT NULL,         -- 'percent' | 'fixed'
  value               INTEGER NOT NULL,      -- percent (0-100) or fixed cents
  min_subtotal_cents  INTEGER NOT NULL DEFAULT 0,
  active              INTEGER NOT NULL DEFAULT 1,
  expires_at          TEXT,
  max_uses            INTEGER,
  used_count          INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
