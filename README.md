# BAW Leadsbot — Rasayel Ad Attribution Bot

Tracks which Facebook/Instagram ad each WhatsApp customer came from, using
Rasayel webhooks. Built in phases; **currently at Phase 0**.

## Phase 0 — raw webhook capture (current)

A minimal server that receives Rasayel webhook calls and records the complete
raw payload, so we can see exactly which ad-referral fields Rasayel sends
before building attribution logic on top.

### Run locally

```bash
npm install
npm start
```

The server listens on port 3000 (or `$PORT`):

- `POST /webhooks/rasayel` — webhook receiver; logs and stores every payload
- `GET /payloads` — view all captured payloads as JSON
- `GET /` — health check

### Deploy (Railway or Render, free tier)

1. Create an account at railway.app or render.com and connect this GitHub repo.
2. Deploy — both platforms auto-detect Node and run `npm start`.
3. Note your public URL, e.g. `https://baw-leadsbot.up.railway.app`.

### Point Rasayel at it

In Rasayel: **Settings → Integrations → Webhooks** (or via API using
`npm run register-webhook` with the env vars from `.env.example`).
Webhook URL: `https://<your-host>/webhooks/rasayel`
Subscribe to message/conversation events.

### Capture a test payload

Have someone click one of your click-to-WhatsApp ads and send a message,
then open `https://<your-host>/payloads` — the raw payload appears there.
That payload is the Phase 0 deliverable: it tells us the exact field names
for the ad referral data (ad id, headline, click id) to build Phase 1 on.

## Later phases (planned)

- Phase 1: parse payloads, extract contact + ad referral fields via Rasayel API
- Phase 2: store leads (name, phone, ad) persistently
- Phase 3: notifications / CRM sync
- Phase 4b: lead attribution dashboard (visual reference: `lead-attribution-dashboard.html`)
