# Architecture — Coffee & Tea Site

Status: pre-build scaffold. Client discovery is in progress (Google Form sent);
placeholders below get replaced once answers are in. See `AGENT_HANDOFF.md` for
what's actually done vs. still a stub.

## 1. Stack (all free tier — see cost table at the bottom)

```
Browser (vanilla JS SPA, no build step)
   │
   ├── Cloudflare Worker + Static Assets ── hosting + API in one project
   │        │                               (see note on Pages vs Workers below)
   │        ├── Cloudflare D1 ────────────  primary database (SQLite)
   │        ├── Cloudflare R2 ────────────  product images (webp, client-optimized)
   │        └── Cloudflare Turnstile ─────  bot protection on public forms
   │
   └── Google Sheets + Apps Script ──────  human-editable backup / bulk-edit layer
```

**Why Workers-with-static-assets instead of Pages:** Cloudflare is folding
Pages into Workers — Pages still works and isn't being killed, but new
platform features (Secrets Store, Workflows, Containers, etc.) are landing on
Workers only going forward. Starting fresh in mid/late-2026, a Worker project
with a static assets binding is the straighter path and avoids a migration
later. One project (`coffee-tea-site`) serves both the SPA and the `/api/*`
routes — no separate Pages project needed.

## 2. Entities

Based on the discovery call, the site sells two product families that share
most fields but differ on a couple of tasting attributes:

- **`products`** — one table, a `category` column (`coffee` | `tea`)
  distinguishes them. Coffee-specific fields (roast level, process) and
  tea-specific fields (leaf type, caffeine level) both live on the same row
  and are simply left null for the other category. Simpler than two tables
  for a single-admin, low-thousands-of-rows catalog.
- **`sessions`** — opaque admin auth tokens, backed by D1 (no KV needed at
  this scale).
- Media lives in R2, not the database — `products` stores only the R2 keys.

Exact fields are in `db/schema.sql`. Adjust once the client's discovery form
answers are in (e.g. if they want subscriptions or equipment, those are
separate concerns layered on later, not a reason to redesign this table).

## 3. Data pattern: D1 is truth, Sheets is the safety net

- All public reads and all admin writes go through the Worker to **D1**.
- Every create/update fires a background push to a **Google Sheet** via an
  Apps Script Web App URL (stored as a Worker secret, not in code).
- `/api/admin/sheets/diff` compares D1 vs. the Sheet and buckets every row as
  `added` / `updated` / `unchanged` / `d1-only`.
- `/api/admin/sheets/restore` applies a diff **additively** — it can insert
  rows that exist only in the Sheet and update rows that differ, but it never
  deletes a D1 row that's merely missing from the Sheet. Deletions stay a
  manual, confirmed action in the admin UI.

## 4. Media handling

Resize, convert to WebP, strip EXIF, and generate a thumbnail — all in the
**browser** (Canvas API) before upload, so the Worker only ever receives
already-optimized files and R2/Worker usage stays trivially inside the free
tier. Key scheme:

```
images/{product_id}.webp
images/{product_id}-thumb.webp
```

If the client wants tasting/brewing video clips later, the same principle
applies: trim/transcode client-side before upload.

## 5. Auth

Single admin account. Username lives in a Worker secret
(`ADMIN_USERNAME`), password is checked against a hashed secret
(`ADMIN_PASSWORD_HASH`, SHA-256 — see `worker/index.js`). A successful login
issues an opaque token stored in the `sessions` table with an expiry; the
token goes in `sessionStorage` client-side and is sent as
`Authorization: Bearer <token>` on every admin call. No third-party auth SaaS.

## 6. Admin dashboard (`admin.html`)

One self-contained file: auth gate → dashboard shell → list view → detail/edit
form, all as show/hide panels (no router library). Includes:

- **Health-check panel** — for each product, the Worker does a HEAD request
  against R2 (server-side, so it doesn't hit CORS) and flags missing images
  or empty required fields with a status dot in the list view.
- **Sheets sync toolbar** — push-to-Sheets, and restore-from-Sheets with a
  diff preview shown before anything is applied.
- **Margin calculator** — inline widget in the product form: enter cost per
  unit + target margin, or price + cost, and it computes the other. Coffee
  nerds care about this per-bag; keeping it inline avoids a separate tool.

## 7. Deployment workflow

```
wrangler deploy --env staging          # staging first, always
wrangler deploy                        # production — only after explicit go-ahead
```

- Never push to `main` / deploy to production without explicit confirmation.
- No `git push --force` on `main`.
- After every production deploy, update `AGENT_HANDOFF.md` so the next
  session (human or AI) can pick this up from that file alone.

## 8. Account ownership plan (freelancer → client handoff)

Cloudflare doesn't support transferring Pages/Workers/D1/R2 between accounts
directly — only a DNS zone can move, and even that needs a manual
export/reimport. The workaround that's actually clean:

1. Build everything in a **dedicated Cloudflare account** created just for
   this project — not the freelancer's personal/main account.
2. At handoff: invite the client's email as **Super Administrator** under
   **Members**, wait for them to accept, confirm they can see everything,
   then remove your own membership. Nothing gets migrated — the same
   resources just change hands.
3. GitHub: transfer repo ownership natively (Settings → Transfer ownership)
   whenever the client is ready. No workaround needed there.
4. Domain: DNS provider and registrar are independent. The domain can stay
   registered at Namecheap indefinitely while DNS is fully handled by
   Cloudflare (point Namecheap's nameservers at the ones Cloudflare gives
   you) — this alone is enough for the "zero recurring cost beyond the
   domain" goal. Moving registration to Cloudflare Registrar later is a
   convenience, not a requirement, and needs the domain to be >60 days past
   registration/last transfer (standard ICANN lock) plus an unlock + auth
   code from Namecheap.

## 9. Free tier ceiling (for reference)

| Layer | Service | Rough free ceiling |
|---|---|---|
| Hosting + compute | Cloudflare Workers (+ static assets) | 100,000 requests/day |
| Database | Cloudflare D1 | 5GB storage, 5M row reads/day |
| Object storage | Cloudflare R2 | 10GB storage, no egress cost |
| Bot protection | Cloudflare Turnstile | Unlimited |
| Backup/admin data | Google Sheets + Apps Script | Unlimited (Google account) |
| Domain | Registrar of choice | **Only paid line item** |

## 10. Open items pending client discovery answers

- Final brand name, palette, and copy voice (site currently uses a
  placeholder identity — see `site/index.html` header comment).
- Whether "other products" (equipment, subscriptions, merch) are in scope
  for launch or phase 2 — schema has room for it (`category` is not an enum
  constraint in D1, just an application-level check) but UI only builds
  coffee/tea filters until confirmed.
- Shipping/payment: brief says no payment processor unless the project
  needs one, and Stripe (pay-per-transaction) over any subscription
  platform if it does. Not yet wired up — confirm with client whether
  launch is "showcase only" or "sell directly" before building checkout.
