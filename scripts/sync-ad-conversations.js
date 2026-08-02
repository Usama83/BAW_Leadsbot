import { applyProxy } from "./proxy-shim.js";
await applyProxy();
// Attribution engine: crawls Rasayel conversations, extracts the ad
// fingerprints found in message bodies, and stores ad-attributed lead events.
//
// Fingerprints (verified against live data):
//   1. "Contact clicked the following Facebook Ad: <ad name>. (Click [link](<fb post url>) to view ad)"
//   2. An ad-echo message ending "Source link: <instagram/fb.me url>"
//
// Usage: node scripts/sync-ad-conversations.js [maxConversations]

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const PAYLOAD_LOG = path.join(DATA_DIR, "payloads.jsonl");
fs.mkdirSync(DATA_DIR, { recursive: true });

const envPath = path.join(ROOT, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const TOKEN = process.env.RASAYEL_API_TOKEN;
const MAX = Math.max(50, parseInt(process.argv[2], 10) || 1000000);
if (!TOKEN) { console.error("No RASAYEL_API_TOKEN in .env"); process.exit(1); }

function authHeader() {
  const payload = JSON.parse(Buffer.from(TOKEN.split(".")[1], "base64url").toString());
  return "Basic " + Buffer.from(`${payload.jti}:${TOKEN}`).toString("base64");
}
const AUTH = authHeader();
async function gql(query, variables = {}, retries = 3) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch("https://api.rasayel.io/api/graphql", {
        method: "POST",
        headers: { Authorization: AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
      const text = await res.text();
      const json = JSON.parse(text);
      if (json.errors) throw new Error(JSON.stringify(json.errors).slice(0, 300));
      return json.data;
    } catch (err) {
      if (i >= retries) throw err;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
}

const AD_CLICK_RE = /Contact clicked the following Facebook Ad:\s*([\s\S]+?)\s*\.?\s*\(Click \[link\]\((\S+?)\)/;
const SOURCE_RE = /Source link:\s*(\S+)/i;

// Conversations already recorded from previous runs.
const doneConvs = new Set();
if (fs.existsSync(PAYLOAD_LOG)) {
  for (const line of fs.readFileSync(PAYLOAD_LOG, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const ev = JSON.parse(line);
      if (ev?.body?.data?.conversationId != null) doneConvs.add(String(ev.body.data.conversationId));
    } catch { /* skip */ }
  }
}

const QUERY = `query($after: String) { app { conversations(first: 50, after: $after) {
  pageInfo { hasNextPage endCursor }
  nodes {
    id createdAt channelType
    participants { user { __typename ... on ChannelUser { displayName identifiers { sourceId category } } } }
    messages(first: 6) { nodes { __typename createdAt direction
      ... on TextMessage { body }
      ... on ImageMessage { caption }
      ... on VideoMessage { caption }
      ... on DocumentMessage { caption }
    } }
  } } } }`;

let after = null;
let scanned = 0;
let adLeads = 0;
let skipped = 0;
while (scanned < MAX) {
  const d = await gql(QUERY, { after });
  const conn = d.app?.conversations;
  const nodes = conn?.nodes || [];
  if (!nodes.length) break;
  for (const c of nodes) {
    scanned++;
    if (doneConvs.has(String(c.id))) { skipped++; continue; }
    const texts = (c.messages?.nodes || []).map((m) => m.body ?? m.caption ?? "").filter(Boolean);
    let adName = null, adPostUrl = null, adSourceUrl = null, adText = null;
    for (const t of texts) {
      const click = t.match(AD_CLICK_RE);
      if (click) { adName = click[1].replace(/\s+/g, " ").trim(); adPostUrl = click[2]; }
      const src = t.match(SOURCE_RE);
      if (src) { adSourceUrl = src[1]; adText = t.split(/Source link:/i)[0].replace(/\s+/g, " ").trim().slice(0, 200); }
    }
    if (!adName && !adSourceUrl) continue;

    const cu = (c.participants || []).map((p) => p.user).find((u) => u && u.__typename === "ChannelUser");
    const contactFields = [
      { name: "Referral source type", value: "ad" },
      adName && { name: "Ad name", value: adName },
      adPostUrl && { name: "Ad post URL", value: adPostUrl },
      adSourceUrl && { name: "Ad source URL", value: adSourceUrl },
      adText && { name: "Ad text", value: adText },
    ].filter(Boolean);
    const when = c.createdAt ? new Date(c.createdAt * (c.createdAt < 1e12 ? 1000 : 1)) : new Date();
    fs.appendFileSync(
      PAYLOAD_LOG,
      JSON.stringify({
        received_at: when.toISOString(),
        path: "/conversation-sync",
        headers: { "x-source": "sync-ad-conversations" },
        body: {
          event: "history.sync",
          data: {
            conversationId: c.id,
            contact: {
              __typename: "ChannelUser",
              displayName: cu?.displayName || null,
              identifiers: cu?.identifiers || [],
              contactFields,
            },
          },
        },
      }) + "\n"
    );
    doneConvs.add(String(c.id));
    adLeads++;
  }
  process.stdout.write(`\rScanned ${scanned} conversations — ${adLeads} ad leads found, ${skipped} already known...`);
  if (!conn.pageInfo?.hasNextPage) break;
  after = conn.pageInfo.endCursor;
}
console.log(`\nDone. ${adLeads} ad-attributed leads extracted from ${scanned} conversations.`);
