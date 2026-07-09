# Coffee & Tea Site

Vanilla-JS site + API on a Cloudflare-only, zero-recurring-cost stack. Read
`AGENT_HANDOFF.md` first if you're picking this project up fresh —
it's the canonical "what's done, what's not" doc. `ARCHITECTURE.md` covers
the full system design and reasoning.

## Quick start

```bash
npm install                        # installs the wrangler CLI only — no bundler
wrangler login                     # authenticate to the Cloudflare account this project lives in

wrangler d1 create coffee-tea-db   # then paste the printed database_id into wrangler.jsonc
wrangler r2 bucket create coffee-tea-media

npm run db:init:remote             # applies db/schema.sql (includes 2 sample products)

wrangler secret put ADMIN_USERNAME
wrangler secret put ADMIN_PASSWORD_HASH   # sha256 hex of the password — see note below
wrangler secret put SHEETS_WEBHOOK_URL    # from apps-script/Code.gs deployment, see that file's header
wrangler secret put TURNSTILE_SECRET_KEY  # not wired to a route yet — see worker/index.js

npm run dev                        # local dev server
npm run deploy:staging              # deploy to staging first, always
npm run deploy:prod                 # only after explicit human go-ahead
```

**Generating `ADMIN_PASSWORD_HASH`:** the Worker checks a SHA-256 hex digest,
not a plaintext password. Generate one with:

```bash
echo -n "your-chosen-password" | shasum -a 256
```

## Project layout

```
site/index.html      public single-page catalog (fetches /api/products)
site/admin.html       admin dashboard (auth, CRUD, health-check, Sheets sync)
worker/index.js       all API routes + static asset / media serving
db/schema.sql         D1 schema, run once via wrangler d1 execute
apps-script/Code.gs   Google Apps Script Web App — Sheets sync backend
wrangler.jsonc        Worker config: assets binding, D1, R2, routes
ARCHITECTURE.md        system design + the account-ownership handoff plan
AGENT_HANDOFF.md        start here for a fresh session
```

## Non-negotiables (carried over from the build brief)

- No React/Vue/build step. Plain HTML/CSS/JS only.
- No paid services. Everything here fits comfortably in free tiers at
  low-thousands-of-requests/day scale.
- No secrets in the repo — Worker secrets only, set via `wrangler secret put`.
- Never deploy to production without explicit confirmation. Staging first.
- Never `git push --force` on `main`.
