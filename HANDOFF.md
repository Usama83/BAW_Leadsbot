# BAW Leadsbot — System Handoff

Complete handoff for integrating the Rasayel ↔ Meta ↔ Odoo ad-attribution system
into the main Brass & Wood infrastructure. Written for the developer or team who
takes this over.

---

## 1. What the system does

Answers, per Meta ad: **which WhatsApp customers did it bring, and how many
sales orders did they place.**

```
Meta ads (2 accounts)          Rasayel (WhatsApp inbox)              Odoo (ERP)
      │                                 │                                │
      │  fetch-ad-names.js              │  sync-ad-conversations.js      │  sync-odoo.js
      │  fetch-ad-insights.js           │  fetch-history.js              │
      ▼                                 ▼                                ▼
  ad catalog + spend  ◄──── match ────  ad-attributed leads  ◄── phone ──  sales orders
  (data/ad-names.json,                 (data/payloads.jsonl)            (data/ad-so-join.json)
   data/ad-insights.json)
                                        │
                                        ▼
                          Express server + dashboard (server.js, public/dashboard.html)
```

**Core discovery this is built on:** Rasayel records ad provenance as message
text inside each conversation. Two fingerprint forms (both verified on live data):
1. `Contact clicked the following Facebook Ad: <ad name>. (Click [link](<fb post url>) to view ad)`
2. An ad-echo message ending `Source link: <instagram/fb.me url>`

The contact-level referral *values* are NOT exposed by Rasayel's public API
(labels only — verified exhaustively); the message fingerprints are the
reliable source.

## 2. Repository map

| File | Purpose |
|---|---|
| `server.js` | Express server: webhook receiver, dashboard, JSON APIs, auto-sync scheduler |
| `public/dashboard.html` | Live leads dashboard (ad chips, Meta name matching) |
| `scripts/sync-ad-conversations.js` | **The attribution engine** — crawls Rasayel conversations, extracts ad fingerprints |
| `scripts/fetch-history.js` | Syncs Rasayel contacts (schema-introspecting, newest-first) |
| `scripts/fetch-ad-names.js` | Meta ad catalog: names, campaigns, creative thumbnails, story ids, Instagram permalinks |
| `scripts/fetch-ad-insights.js` | Meta lifetime spend/impressions/clicks per ad |
| `scripts/sync-odoo.js` | Pulls Odoo sales orders, joins to leads by phone → per-ad SOs/revenue |
| `scripts/resolve-fbme.js` | Resolves fb.me short links to real Facebook URLs |
| `scripts/classify-ad.js` | Furniture category/product classifier (Arabic + English keywords) |
| `scripts/check-referral.js`, `scripts/study-conversations.js` | Diagnostic tools |
| `scripts/import-contacts.js` | Rasayel UI CSV export importer (fallback path) |
| `scripts/proxy-shim.js` | Routes Node fetch through HTTPS_PROXY when present (cloud sandboxes) |
| `*.bat` | One-click Windows wrappers for every script + self-updater |

## 3. Credentials (`.env` — never committed; repo is PUBLIC)

```
RASAYEL_API_TOKEN=   # Rasayel JWT. Auth is HTTP Basic base64(<jti-claim>:<token>) — scripts derive this automatically
META_ACCESS_TOKEN=   # Meta Graph token, ads_read. ~60-day expiry — generated late June 2026, EXPIRES ~LATE AUG 2026
META_AD_ACCOUNTS=act_313116676153272,act_862207901570702   # optional, this is the default
ODOO_URL=https://brassandwood.odoo.com
ODOO_DB=ntscompany-brassandwood-production-6405950
ODOO_LOGIN=<odoo user email>
ODOO_API_KEY=<odoo api key>
PORT=3000            # optional
SYNC_DAYS=3          # optional, auto-sync window
```

⚠️ **The Meta token must be regenerated ~every 60 days** (Business settings →
system user token with `ads_read` is the durable option). `fetch-ad-names.js`
prints a clear error when it expires.

## 4. Data model (all files under `data/`, gitignored)

- **`payloads.jsonl`** — append-only event log, one JSON per line:
  `{received_at, path, headers, body:{event, data:{conversationId?, contact}}}`.
  Contact: `{__typename, displayName, identifiers:[{sourceId, category}],
  contactFields:[{name, value}]}` — attribution rides in contactFields:
  `Referral source type=ad`, `Ad name`, `Ad post URL`, `Ad source URL`, `Ad text`.
  Sources: `/webhooks/rasayel` (live), `/history-sync`, `/conversation-sync`, `/csv-import`.
- **`ad-names.json`** — `{adId: {name, campaign, adset, status, account, storyId, instagramUrl, thumbnailUrl, imageUrl, body}}`
- **`ad-insights.json`** — `{adId: {spend, impressions, clicks, account}}` (account currency = EGP)
- **`fbme-map.json`** — `{fbmeUrl: resolvedFacebookUrl}`
- **`ad-so-join.json`** — per-ad rows `{label, cat, leads, sos, quotes, rev:{CUR: amount}}` + totals

**Ad matching chain** (dashboard + sync-odoo, in priority order):
referral/ad id → Facebook post URL → catalog `storyId` (`PAGE_POST`) → Instagram
permalink → resolved fb.me URL matched by post-id **suffix** (story ids use a
different page-id namespace, so match the post part only) → exact ad name.

**Attribution model:** first-touch — the earliest ad conversation for a phone
number owns that customer. Phone normalization: digits only, last 9 digits.

## 5. Integration points for the main system

The server exposes everything as JSON — poll or proxy these from the main system:

| Endpoint | Returns |
|---|---|
| `GET /payloads` | raw event log (all leads with attribution fields) |
| `GET /ad-names` | Meta ad catalog |
| `GET /ad-sos` | per-ad leads/SOs/revenue join |
| `GET /fbme-map` | resolved short links |
| `POST /webhooks/rasayel` | Rasayel webhook intake (register this URL in Rasayel) |
| `GET /dashboard`, `/diag`, `/study` | human pages |

Alternative integration: run the scripts on a schedule and read the `data/*.json`
files directly, or import `payloads.jsonl` into the main DB (each line is one event).

## 6. Deployment (VPS runbook)

Target: any Linux VPS (Namecheap etc.), Node ≥ 18.

```bash
git clone https://github.com/Usama83/BAW_Leadsbot.git /opt/leadsbot
cd /opt/leadsbot && npm install --omit=dev
cp .env.example .env && nano .env          # fill all credentials (section 3)
npm i -g pm2
pm2 start server.js --name leadsbot && pm2 save && pm2 startup
# nginx reverse proxy + TLS (certbot) on e.g. leads.brassandwood.net → :3000
```

Cron (server auto-runs ad-names + 3-day history on start and daily; add the rest):

```cron
0 3 * * *  cd /opt/leadsbot && node scripts/sync-ad-conversations.js  >> log/sync.log 2>&1
15 3 * * * cd /opt/leadsbot && node scripts/resolve-fbme.js           >> log/sync.log 2>&1
30 3 * * * cd /opt/leadsbot && node scripts/fetch-ad-insights.js      >> log/sync.log 2>&1
45 3 * * * cd /opt/leadsbot && node scripts/sync-odoo.js              >> log/sync.log 2>&1
```

Then register `https://<host>/webhooks/rasayel` in Rasayel → live capture, no ngrok.

## 7. Known limitations & caveats

- **SO counts are a floor**: matching is by phone; buyers using a different
  number or purchasing in-store are missed.
- **~40% of historical leads** trace to ads deleted from Meta (mostly 2023-era
  fb.me links) — they group under resolved post URLs, not catalog names.
- CPL for long-lived/reused creatives mixes years of leads against lifetime
  spend — treat very low CPLs as approximations.
- Rasayel API quirks handled in code: root queries live under `app`; auth is
  Basic `jti:token`; `properties` values need per-concrete-type inline
  fragments; connections rejected in bulk may accept field-by-field selection.
- The conversation crawl is idempotent (dedupes by conversation id) — safe to
  re-run any time.
- Multi-currency revenue is reported per currency; no FX conversion applied.

## 8. Current results snapshot (2026-08-03)

65,572 conversations · 27,904 ad-attributed leads (43%) · 17,101 matched to the
1,009-ad catalog · 3.24M EGP spend on lead-generating ads (~190 EGP avg CPL) ·
443 confirmed SOs + 728 quotations from 272 ad-lead buyers · 642 ads with
7.6M EGP spend and no matched WhatsApp lead (audit list).

## 9. Backlog / next steps

1. VPS deployment (section 6, or run `deploy.sh` — one command) — makes
   everything permanent and self-updating
2. **Main-system UI requirement (owner request):** merge the existing
   **Marketing** and **WhatsApp** tabs into a single **Marketing** tab that
   contains all sections from both, PLUS the new sections produced by this
   system: leads-per-ad with creative previews and links, sales orders per ad
   (Odoo join), leads-per-month by category, arrival heatmap, cost-per-lead,
   and the zero-lead spend audit — all behind the shared filter bar (period
   presets + custom month range, category, market KSA/Global, ad-name search).
   A complete reference implementation of every new section and the filter
   logic is the master report (`scratchpad` build; embedded-data variant of
   `public/dashboard.html` + `/ad-sos` + `/ad-names` + `/payloads` feeds).
   The main system's tab code was not accessible from this project — the
   integrating developer should reuse those endpoints/sections inside the
   main system's own tab framework.
3. Live webhook attribution end-to-end test (one real ad-click while deployed)
4. Response-time, geography (phone country code), creative-fatigue analyses
5. FX-normalize revenue; Telegram daily digest (bot token exists)
6. Regenerate Meta token before late Aug 2026
