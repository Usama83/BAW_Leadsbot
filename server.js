// Phase 0 — raw webhook capture server.
// Receives Rasayel webhook calls, logs the complete raw payload, and appends
// each event to data/payloads.jsonl so we can inspect exactly what Rasayel
// sends (especially WhatsApp click-to-ad referral fields) before building
// the attribution logic on top of it.

import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const PAYLOAD_LOG = path.join(DATA_DIR, "payloads.jsonl");
const PORT = process.env.PORT || 3000;

fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();

// Keep the raw body alongside the parsed JSON — if Rasayel ever sends a
// signature header, verification needs the exact bytes.
app.use(
  express.json({
    limit: "2mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  })
);

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "baw-leadsbot", phase: 0 });
});

// Some webhook providers probe with GET before accepting a URL.
app.get("/webhooks/rasayel", (_req, res) => {
  res.status(200).send("OK");
});

app.post("/webhooks/rasayel", (req, res) => {
  const event = {
    received_at: new Date().toISOString(),
    headers: req.headers,
    body: req.body,
    raw_body: req.rawBody,
  };

  fs.appendFileSync(PAYLOAD_LOG, JSON.stringify(event) + "\n");
  console.log("=== Rasayel webhook received ===");
  console.log(JSON.stringify(event, null, 2));

  // Always 200 so Rasayel doesn't disable the webhook while we're inspecting.
  res.status(200).json({ received: true });
});

// View captured payloads in the browser: GET /payloads
app.get("/payloads", (_req, res) => {
  if (!fs.existsSync(PAYLOAD_LOG)) return res.json([]);
  const events = fs
    .readFileSync(PAYLOAD_LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  res.json(events);
});

app.listen(PORT, () => {
  console.log(`baw-leadsbot phase 0 listening on port ${PORT}`);
  console.log(`Webhook endpoint: POST /webhooks/rasayel`);
});
