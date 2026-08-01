// Phase 0 — raw webhook capture server.
// Receives Rasayel webhook calls, logs the complete raw payload, and appends
// each event to data/payloads.jsonl so we can inspect exactly what Rasayel
// sends (especially WhatsApp click-to-ad referral fields) before building
// the attribution logic on top of it.

import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

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
  res.json({ ok: true, service: "baw-leadsbot", phase: 0, dashboard: "/dashboard" });
});

app.get("/dashboard", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

// id -> {name, campaign, ...} map produced by scripts/fetch-ad-names.js
app.get("/ad-names", (_req, res) => {
  const p = path.join(DATA_DIR, "ad-names.json");
  if (fs.existsSync(p)) {
    res.type("json").send(fs.readFileSync(p, "utf8"));
  } else {
    res.json({});
  }
});

// Diagnostics: everything needed to debug attribution, in one screenshotable page.
app.get("/diag", (_req, res) => {
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const sections = [];

  const schemaPath = path.join(DATA_DIR, "rasayel-schema-summary.json");
  sections.push(
    "<h2>1. Rasayel schema summary</h2>" +
      (fs.existsSync(schemaPath)
        ? `<pre>${esc(fs.readFileSync(schemaPath, "utf8"))}</pre>`
        : "<p>(file missing — run fetch-history.bat first)</p>")
  );

  let events = [];
  if (fs.existsSync(PAYLOAD_LOG)) {
    events = fs.readFileSync(PAYLOAD_LOG, "utf8").split("\n").filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  }
  const referralCount = events.filter((e) => /referral/i.test(JSON.stringify(e.body || {}))).length;
  sections.push(
    `<h2>2. Stored events</h2><p>Total: ${events.length} — containing the word "referral" anywhere: <b>${referralCount}</b></p>`
  );

  const lastContactEv = [...events].reverse().find((e) => e.body?.data?.contact);
  sections.push(
    "<h2>3. Newest synced contact (raw)</h2>" +
      (lastContactEv
        ? `<pre>${esc(JSON.stringify(lastContactEv.body.data.contact, null, 2))}</pre>`
        : "<p>(no history-sync contacts stored)</p>")
  );

  const lastWebhookEv = [...events].reverse().find((e) => e.path !== "/history-sync");
  sections.push(
    "<h2>4. Newest live webhook event (raw body)</h2>" +
      (lastWebhookEv
        ? `<pre>${esc(JSON.stringify(lastWebhookEv.body, null, 2)).slice(0, 8000)}</pre>`
        : "<p>(no live webhook events stored)</p>")
  );

  const checkPath = path.join(DATA_DIR, "referral-check.json");
  sections.push(
    "<h2>5. Referral check result</h2>" +
      (fs.existsSync(checkPath)
        ? `<pre>${esc(fs.readFileSync(checkPath, "utf8"))}</pre>`
        : "<p>(not run yet — double-click check-referral.bat)</p>")
  );

  res.type("html").send(
    `<!doctype html><meta charset="utf-8"><title>BAW Leadsbot diagnostics</title>
     <style>body{font-family:system-ui;margin:24px;max-width:1000px}pre{background:#f4f4f2;padding:12px;border-radius:8px;overflow-x:auto;font-size:12px}h2{margin-top:28px}</style>
     <h1>Diagnostics</h1>${sections.join("")}`
  );
});

// Some webhook providers probe with GET before accepting a URL.
app.get("/webhooks/rasayel", (_req, res) => {
  res.status(200).send("OK");
});

// Capture POSTs on any path — webhook URLs are often configured without the
// intended /webhooks/rasayel suffix, and losing those deliveries to a 404
// defeats the purpose of Phase 0.
app.post(/.*/, (req, res) => {
  const event = {
    received_at: new Date().toISOString(),
    path: req.path,
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

// Automatic syncs: refresh the Meta ad catalog and pull recent Rasayel
// contacts on startup and daily, using tokens from .env if present. Each
// runs in a child process so a sync failure never takes the bot down.
function envHasKey(key) {
  const envFile = path.join(__dirname, ".env");
  if (process.env[key]) return true;
  if (!fs.existsSync(envFile)) return false;
  return new RegExp(`^\\s*${key}\\s*=\\s*\\S`, "m").test(fs.readFileSync(envFile, "utf8"));
}

function runSync() {
  if (envHasKey("META_ACCESS_TOKEN")) {
    spawn(process.execPath, [path.join(__dirname, "scripts", "fetch-ad-names.js")], {
      stdio: "inherit",
    }).on("error", (e) => console.error("ad-names sync failed to start:", e.message));
  }
  if (envHasKey("RASAYEL_API_TOKEN")) {
    spawn(process.execPath, [path.join(__dirname, "scripts", "fetch-history.js")], {
      stdio: "inherit",
      env: { ...process.env, HISTORY_DAYS: process.env.SYNC_DAYS || "3" },
    }).on("error", (e) => console.error("history sync failed to start:", e.message));
  }
}

app.listen(PORT, () => {
  console.log(`baw-leadsbot phase 0 listening on port ${PORT}`);
  console.log(`Webhook endpoint: POST /webhooks/rasayel`);
  runSync();
  setInterval(runSync, 24 * 60 * 60 * 1000);
});
