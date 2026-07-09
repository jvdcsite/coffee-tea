# Agent Handoff — Coffee & Tea Site

Read this first. It's the single source of truth for "what actually exists
vs. what's a stub." If this doc and the code disagree, trust the code and
fix this doc.

## Where this stands right now

**Deployed to production and staging, on the workers.dev subdomain (no
custom domain yet).** Cloudflare account: `johncolastre@gmail.com`
(dedicated account — see §8 of `ARCHITECTURE.md` for the handoff plan).
Resources created and wired into `wrangler.jsonc`:

- D1 database `coffee-tea-db` (id `6df5e015-d18b-4bf5-a8c8-2747c7309fe0`),
  schema applied, 2 sample products loaded (`npm run db:init:remote`).
- R2 bucket `coffee-tea-media` created and bound.
- `ADMIN_USERNAME` / `ADMIN_PASSWORD_HASH` secrets set on both the
  production and `staging` Worker environments (username `admin`; password
  was chosen directly by the client — not recorded here).
- **Production:** https://coffee-tea-site.johncolastre.workers.dev
- **Staging:** https://coffee-tea-site-staging.johncolastre.workers.dev
- Both are in sync as of this writing (redesign + currency/font/photo pass
  + admin restructure below, all deployed to both). Production and staging
  share the *same* D1 database and R2 bucket (see `wrangler.jsonc` — same
  `database_id` and `bucket_name` under both the top-level config and
  `env.staging`), so any data change (product edits, image uploads,
  newsletter signups, site media) is instantly visible on both regardless
  of which URL you're looking at. Only the *code* (Worker + static assets)
  can drift between them — that's the only thing `deploy:staging` vs
  `deploy:prod` actually controls.

## Admin restructure: Site Media, Orders, and the removal of Health Check / Sheets sync

- **Removed from the admin nav (UI only):** Health Check and Sheets sync
  tabs. The *backend* routes (`/api/admin/health-check`,
  `/api/admin/sheets/*`) are still in `worker/index.js`, just unreferenced
  by any UI — re-add nav buttons + panel sections if this project ever
  wants them back (the JS logic wasn't deleted from git history, just from
  the live file — check the commit before this one).
- **Added "Orders" tab:** layout-only placeholder (a table skeleton with an
  empty state), no backend. Needs: an `orders` table (line items, customer,
  shipping, payment status) and a real checkout integration (Stripe, per
  the payment brief in `ARCHITECTURE.md` §10) before this can show
  anything real.
- **Added "Site Media" tab:** lets the admin replace every homepage image
  (3 hero slides, 2 category tiles, brand-story, and the product
  placeholder) without a redeploy. Two-part UI: live `<iframe>` previews of
  the actual homepage at desktop (1280px, scaled to fit) and mobile
  (390px, scaled to fit) widths with a Refresh button, plus a card grid —
  one per slot — showing the current image, a "max Npx" hint, last-updated
  date, and a file input that uploads immediately on selection (no
  separate save step).

### How Site Media actually works (read this before touching it)

This did **not** get a new D1 table. Each image "slot" (`hero-1`, `hero-2`,
`hero-3`, `category-coffee`, `category-tea`, `brand-story`,
`product-placeholder` — the fixed list is `SITE_MEDIA_SLOTS` in
`worker/index.js`) is just an R2 object at a **fixed key**:
`marketing/{slot}.webp`. Uploading through the admin tab
(`POST /api/admin/site-media/:slot`) overwrites that R2 object directly;
there's no "current value" stored anywhere except R2 itself, which is also
why `GET /api/admin/site-media` HEAD-checks each key instead of reading a
table. The public site's CSS/HTML references `/media/marketing/{slot}.webp`
directly (that's the existing `serveMedia()` R2 proxy, same one product
photos already used at `/media/images/...`).

**This is a real behavior change from before:** `site/index.html` used to
reference `/assets/marketing/*.webp` as static files bundled with the
deploy. It now reads everything from R2 instead. `site/assets/marketing/`
still exists in the repo but is now just the *original source* the site
was seeded from (via `scripts/resize-marketing.js` + a one-time
`wrangler r2 object put ... --remote` per file) — **editing those files
and redeploying does nothing** to the live site anymore. If R2 is ever
wiped or a fresh environment is stood up, reseed it with:

```
for slot in hero-1 hero-2 hero-3 category-coffee category-tea brand-story product-placeholder; do
  wrangler r2 object put "coffee-tea-media/marketing/${slot}.webp" \
    --file="site/assets/marketing/${slot}.webp" --content-type=image/webp --remote
done
```

(drop `--remote` to seed the local dev bucket instead.)

**Not yet done:** `SHEETS_WEBHOOK_URL` / `TURNSTILE_SECRET_KEY` secrets
(Sheets sync and Turnstile untested), real branding (name/copy), custom
domain. See "Suggested next steps" below.

## Currency: PHP (Philippine pesos)

Switched from USD. `products.currency` defaults to `'PHP'` in
`db/schema.sql`, the Worker's create/update fallback is `"PHP"`
(`worker/index.js`), and the sample rows were re-priced to plausible PHP
amounts (₱650 / ₱550) rather than just relabeling the old USD cents value —
run the `UPDATE products SET currency = ..., price_cents = ...` pattern
from this session's history if more legacy USD rows ever need migrating.
The public site's price formatting (`Intl.NumberFormat` keyed off each
product's own `currency` field) needed no change — it already displays
whatever currency is stored per-row. `admin.html` had a few hardcoded `$`
symbols (product table, margin calculator) that were swapped to `₱`.

## Fonts: "Geometric Warm" pairing

`--font-display: 'Space Grotesk'`, `--font-body: 'DM Sans'`,
`--font-mono` unchanged (`'IBM Plex Mono'`). Replaced the old
Fraunces/Inter pairing in both `site/index.html` and `site/admin.html`.

Client feedback: Space Grotesk read as too clunky/blocky at headline size.
Fix was weight, not family — the Google Fonts import now only loads 400/500
(dropped 600), and every heading using `var(--font-display)` was turned
down a notch (former 600 → 500, former 500 → 400). If another "still too
heavy" round comes in, the next lever is swapping the family entirely
(Sora/Manrope were the alternatives on the table), not weight.

## Product photo placeholder (front-end only)

`site/assets/marketing/product-placeholder.webp` — a blank/unbranded
packaging mockup, shown wherever a product has no `image_key`/`thumb_key`:
public catalog cards, the featured band, the product detail view, and in
`admin.html`'s product list thumbnails + edit-form preview. This is a
**display-only fallback** — it is never written to a product's
`image_key`/`thumb_key` in D1, and never goes through the R2 admin upload
endpoint. Real product photos still go through the existing
`resizeToWebp()` → `POST /api/admin/upload` flow exactly as before; this
just means an unphotographed product looks intentional instead of showing
a blank swatch.

## Marketing photography pipeline

`site/assets/marketing/` now holds only the **processed** deliverables —
`hero-1/2/3.webp`, `category-coffee.webp`, `category-tea.webp`,
`brand-story.webp` — wired into the hero carousel, category tiles, and a
newly two-column brand-story band (it used to be text-only). The **raw**
source photos (2MB+ PNGs, UUID-named) were deleted after processing; they
shouldn't be re-added to `site/` since everything in there gets deployed as
a static asset. `scripts/resize-marketing.js` is the one-off tool that did
the crop/compress (`sharp`, added as a devDependency — not part of the
Worker bundle or a build step, just asset prep). Re-run it if new source
photography needs the same treatment; it expects the same UUID-named PNGs
in `site/assets/marketing/` and is *not* idempotent-safe against renamed
inputs, so check the `jobs` array before rerunning.

Two more images showed up in that folder later — blank/unbranded packaging
mockups (a stand-up pouch and a box). Left untouched, not wired into
anything: they're not lifestyle photography and have no label, so they
don't fit the hero/category/story slots or work as product photos. Likely
useful once real branding exists to composite a logo onto.

## Product photos: real upload flow + a bug fix

Uploaded via the actual admin UI flow (`resizeToWebp()` client-side →
`POST /api/admin/upload`), not a new script — per the constraint that
individual product photos must go through the same path a human admin
would use. In the process, found and fixed a real bug that predates this
session: **`uploadMedia()` in `worker/index.js` was writing the file to R2
but never updating the product's `image_key`/`thumb_key` columns in D1** —
so an uploaded image would sit in R2 forever invisible to the public site
and the health-check panel, which both read those columns, not R2 directly.
Fixed by having `uploadMedia()` run an `UPDATE products SET image_key = ...
WHERE id = ...` (or `thumb_key` for the thumb variant) right after the R2
`put()` succeeds. Both sample products now have real photos with
`image_key`/`thumb_key` set and pass Health Check.

## Homepage redesign (site/index.html + site/admin.html)

The public site got a full structural/visual redesign, loosely modeled on
bluebottlecoffee.com's *structure and interaction patterns only* (hero
carousel, best-sellers, featured band, category tiles, footer) — no copied
copy, colors, or markup. Palette is now **"Cream & Cobalt"** (`--ink
#1D1B17`, `--paper #F3EEE3`, `--coffee #2C4A6E`, `--tea #B98A2E`), applied to
both `index.html` and `admin.html`.

- **Utility bar + sticky nav** that condenses on scroll; a "Shop" dropdown
  (Coffee/Tea), Best Sellers, and two honest placeholder sections
  (Subscriptions, Find Us) — both clearly marked "coming soon" with a code
  comment on the backend work each would need (subscription/billing model;
  locations table), not live nav items pointing at nothing.
- **Hero carousel** (3 slides, autoplay + pause-on-hover/focus, dot/arrow
  controls, crossfade), **best sellers** (client-side proxy: lowest
  `stock_count` among active products — no order/sales table exists yet),
  **featured band** (most recently added active product), **category
  tiles**, a brand-story band (placeholder copy, clearly marked), and the
  existing full catalog grid.
- **Product detail is now a full in-page view**, not the old modal —
  hash-routed (`#/product/{id}`), toggles `#home-view` / `#product-view`
  the same way `admin.html` already show/hides its panel sections. Note:
  hiding `#home-view` to reveal the much-shorter `#product-view` triggers
  the browser's CSS scroll-anchoring, which silently overrides a plain
  `scrollTo()` reset — fixed by setting `overflow-anchor: none` on `body`
  plus a direct `scrollTop = 0` assignment. If you ever see the product
  view open mid-scroll instead of at the top, this is why.
- **Cart is a UI-only stub** (slide-in drawer, `sessionStorage`-backed,
  quantity/remove controls, subtotal) — checkout is intentionally not
  wired to anything real, per the payment-scope note below.
- **Real product photography** now lives in `site/assets/marketing/` (5
  images) and is wired into the coffee hero slide, the best-sellers hero
  slide, and the Coffee category tile via CSS `background-image`. **No tea
  photography exists yet** — the tea hero slide and Tea category tile still
  use the ochre gradient placeholder on purpose; swap once tea photos exist
  (see the CSS rules for `.hero-slide[data-slide="1"]` and
  `.category-tile.tea`).

## Newsletter capture (real) vs. sending (not built)

- A popup (shows once per browser via `localStorage`, dismissible) and a
  footer form both POST to `/api/newsletter/subscribe`, which writes to a
  real `newsletter_subscribers` D1 table (see `db/schema.sql`). This part
  works end-to-end today.
- The admin dashboard has a **Newsletter** panel: a real subscriber list
  (`GET /api/admin/newsletter/subscribers`), CSV export (client-side, no
  backend needed), and per-row removal (`DELETE
  /api/admin/newsletter/subscribers/:email`).
- **Actually sending a campaign is NOT built.** The admin "Compose & send"
  form is left in place for drafting copy, but the Send button is
  deliberately disabled — sending needs an email provider (e.g. Resend,
  Mailchannels) added as a Worker secret plus a send route in
  `worker/index.js`. Don't wire a fake "sent" state; the honest disabled
  button + explanation is intentional, matching how Turnstile is stubbed.

## Git repo note

This project did **not** have its own git repo — `.git` was accidentally
sitting at the user's home directory root (tracking an unrelated project's
history on a different branch). Initialized a fresh repo scoped to
`coffee-tea-site/` itself; the home-directory repo was left untouched.

## What's actually implemented (not just stubbed)

- **Worker API** (`worker/index.js`): public catalog reads, admin login with
  hashed-password + opaque session tokens in D1, full product CRUD, R2 image
  upload endpoint, R2-backed media serving at `/media/*`, a health-check
  endpoint that HEAD-checks R2 for missing images, the full Sheets
  push/diff/restore trio with the "never auto-delete" rule enforced in code
  (`sheetsRestore` only ever calls insert/update, never delete), and
  newsletter capture (`POST /api/newsletter/subscribe` public,
  `GET`/`DELETE /api/admin/newsletter/subscribers` admin-only) — sending is
  not implemented, see below.
- **Public site** (`site/index.html`): full homepage redesign (see below) —
  fetches `/api/products` and renders best sellers, a featured product, the
  full filterable coffee/tea catalog, and a hash-routed product detail view.
  No framework, single file.
- **Admin dashboard** (`site/admin.html`): login gate → product list →
  create/edit form → health-check panel → Sheets sync panel → Newsletter
  panel, all as show/hide sections in one file. Includes client-side image
  resize + WebP conversion (Canvas API, produces both full and thumbnail
  variants before upload) and an inline cost/price margin calculator.
- **Apps Script** (`apps-script/Code.gs`): Web App with `doGet` (list) and
  `doPost` (push) — see the file's header comment for the exact deploy steps,
  they're easy to get wrong (especially: redeploy as a **new version**, not
  just save, after any edit).
- **D1 schema** (`db/schema.sql`): a `products` table covering both coffee
  and tea fields (nullable per category), a `sessions` table for auth, and a
  `newsletter_subscribers` table (email capture only). Ships with 2 sample
  products so the UI isn't empty on first run.

## What's intentionally NOT built yet

- **Real branding.** Site now says "Coffee & Tea". Palette (CSS custom
  properties at the top of `index.html`'s `<style>`) and remaining copy
  still to confirm once the client's discovery-form answers are in.
- **Payment/checkout.** Brief says: no payment processor unless the project
  needs one, Stripe (pay-per-transaction) over subscription platforms if it
  does. Confirm with the client whether launch is showcase-only or direct
  sale before building this — it's a meaningfully different scope.
- **Turnstile is not wired to any route yet** — `verifyTurnstile()` exists
  in `worker/index.js` but nothing calls it, because there's no public form
  (contact/inquiry) built yet that would need bot protection.
- **Custom domain routing** — `wrangler.jsonc` has an empty `routes` array.
  Deploy to the `workers.dev` subdomain first, confirm it works, then wire
  the real domain once DNS is pointed at Cloudflare.
- **`admin.html` has no access restriction beyond the login gate itself** —
  anyone can load the page (they just can't do anything without logging in,
  since every `/api/admin/*` call requires a valid session token). Fine for
  now; if the client wants the admin URL itself hidden, consider Cloudflare
  Access in front of `/admin.html` as a follow-up, not a blocker for launch.
- **Order management.** The admin "Orders" tab is layout-only — see the
  Site Media/Orders section above for what it actually needs.

## Known gotchas

- **Cloudflare is folding Pages into Workers.** This project deliberately
  uses a Worker + static-assets binding, not a separate Pages project — see
  `ARCHITECTURE.md` §1 for why. Don't "helpfully" split this into a Pages
  project + separate Worker; that's the pattern being phased out.
- **Apps Script Web Apps can't easily return a non-200 HTTP status.**
  `sheetsPush`/`sheetsDiff` in the Worker check `resp.ok`, which will be true
  even on a logical failure from Apps Script. If Sheets sync silently "works"
  but data looks wrong, check the response body's shape, not just the status.
- **D1 money fields are integer cents**, never floats. The admin form's
  margin calculator works in dollars for human readability but converts to
  cents (`Math.round(dollars * 100)`) before it's sent to the API — keep that
  conversion if you touch that code path.
- **Account/repo ownership plan** (see `ARCHITECTURE.md` §8): this is being
  built in a Cloudflare account and GitHub repo the freelancer controls, to
  be handed to the client later via Super Admin invite (Cloudflare) and
  repo ownership transfer (GitHub) — not by migrating resources. Don't build
  automation that assumes resources will be copied between accounts.

## Suggested next steps, in order

1. ~~Create the actual Cloudflare account, D1 database, and R2 bucket~~ — done.
2. ~~Set secrets, run `npm run db:init:remote`, deploy to staging~~ — done.
3. ~~Deploy the initial (pre-redesign) build to production~~ — done.
4. ~~Homepage redesign + newsletter capture~~ — done.
5. ~~Deploy the redesign to production~~ — done, with explicit go-ahead.
6. ~~Currency to PHP, font pairing, hero copy, marketing photo pipeline,
   product photo uploads~~ — done, see the sections above. Confirm with the
   client whether this pass also needs to go to production (check
   `git log` / actually load both URLs — don't assume from this doc alone).
7. Get the client discovery-form answers back to confirm remaining copy —
   brand name is now "Coffee & Tea"; currency/fonts/photos are also real
   decisions.
9. Wire a real email provider for the Newsletter "Send" button, if the
   client wants in-house sending rather than exporting the CSV into
   something like Mailchimp.
10. Deploy the Apps Script Web App, set `SHEETS_WEBHOOK_URL`, test
    push/diff/restore against a real Sheet.
11. Confirm with the client whether checkout is in scope for launch before
    building anything payment-related.
12. Connect the real domain once it's decided whether it stays on Namecheap
    (DNS-only, pointed at Cloudflare) or moves to Cloudflare Registrar.
