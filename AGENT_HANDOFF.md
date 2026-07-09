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
- **Production:** https://coffee-tea-site.johncolastre.workers.dev — running
  the **pre-redesign** version (original small tasting-card catalog + modal).
  Not yet updated with the homepage redesign described below — needs an
  explicit go-ahead before `npm run deploy:prod` ships it.
- **Staging:** https://coffee-tea-site-staging.johncolastre.workers.dev —
  running the **current redesign** (see below), verified end-to-end.

**Not yet done:** `SHEETS_WEBHOOK_URL` / `TURNSTILE_SECRET_KEY` secrets
(Sheets sync and Turnstile untested), real branding (name/copy), custom
domain, production deploy of the redesign. See "Suggested next steps" below.

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

- **Real branding.** Site currently says "Ember & Leaf" — a placeholder.
  Swap name, palette (CSS custom properties at the top of `index.html`'s
  `<style>`), and copy once the client's discovery-form answers are in.
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
4. ~~Homepage redesign + newsletter capture~~ — done, live on staging only.
5. Deploy the redesign to production (`npm run deploy:prod`) — only after
   explicit go-ahead, per the non-negotiables in `README.md`.
6. Get tea product photography (coffee photography already exists in
   `site/assets/marketing/`); get the client discovery-form answers back to
   update brand name/copy.
7. Wire a real email provider for the Newsletter "Send" button, if the
   client wants in-house sending rather than exporting the CSV into
   something like Mailchimp.
8. Deploy the Apps Script Web App, set `SHEETS_WEBHOOK_URL`, test push/diff/
   restore against a real Sheet.
9. Confirm with the client whether checkout is in scope for launch before
   building anything payment-related.
10. Connect the real domain once it's decided whether it stays on Namecheap
    (DNS-only, pointed at Cloudflare) or moves to Cloudflare Registrar.
