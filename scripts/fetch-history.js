// Pulls conversation history from the Rasayel API and merges it into the
// bot's data so the dashboard shows past leads, not only live webhooks.
//
// Reads RASAYEL_API_TOKEN from .env (see .env.example). Optional env vars:
//   HISTORY_FROM=2026-07-01  HISTORY_TO=2026-07-31   (defaults: July 2026)
//
// The exact Rasayel GraphQL schema hasn't been confirmed yet, so this script
// works in two stages: it attempts a best-guess conversations query modeled on
// the webhook payload shape; if the API rejects it, it saves a compact schema
// summary to data/rasayel-schema-summary.json for adapting the query.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const PAYLOAD_LOG = path.join(DATA_DIR, "payloads.jsonl");
fs.mkdirSync(DATA_DIR, { recursive: true });

// --- tiny .env loader (no dependency) ---
const envPath = path.join(ROOT, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const API_URL = process.env.RASAYEL_API_URL || "https://api.rasayel.io/graphql";
const TOKEN = process.env.RASAYEL_API_TOKEN;
const FROM = new Date(process.env.HISTORY_FROM || "2026-07-01T00:00:00Z");
const TO = new Date(process.env.HISTORY_TO ? process.env.HISTORY_TO + "T23:59:59Z" : "2026-07-31T23:59:59Z");

if (!TOKEN) {
  console.error("No RASAYEL_API_TOKEN found. Create a file named .env next to server.js");
  console.error("containing a line like:  RASAYEL_API_TOKEN=eyJhbGci...");
  process.exit(1);
}

async function gql(query, variables = {}) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch {
    throw new Error(`Non-JSON response (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return json.data;
}

function toDate(v) {
  if (v == null) return null;
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v);
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

function appendEvent(conversation, createdAt) {
  const event = {
    received_at: createdAt.toISOString(),
    path: "/history-sync",
    headers: { "x-source": "fetch-history" },
    body: { event: "history.sync", data: { conversation } },
  };
  fs.appendFileSync(PAYLOAD_LOG, JSON.stringify(event) + "\n");
}

async function saveSchemaSummary() {
  const data = await gql(`{
    __schema {
      queryType {
        fields {
          name
          args { name type { kind name ofType { kind name } } }
          type { kind name ofType { kind name } }
        }
      }
    }
  }`);
  const interesting = data.__schema.queryType.fields.filter((f) =>
    /conversation|contact|message|channel|lead/i.test(f.name)
  );
  const typeNames = new Set();
  for (const f of interesting) {
    let t = f.type;
    while (t) { if (t.name) typeNames.add(t.name); t = t.ofType; }
  }
  const typeDetails = {};
  for (const name of typeNames) {
    try {
      const td = await gql(
        `query($n: String!) { __type(name: $n) { name fields { name type { kind name ofType { kind name ofType { kind name } } } } } }`,
        { n: name }
      );
      if (td.__type) typeDetails[name] = td.__type.fields?.map((f) => f.name);
    } catch { /* skip */ }
  }
  const summary = { queries: interesting, types: typeDetails };
  const out = path.join(DATA_DIR, "rasayel-schema-summary.json");
  fs.writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(`\nSchema summary saved to: ${out}`);
  console.log("Open that file, copy its content, and paste it in the Claude chat");
  console.log("so the query can be adapted to Rasayel's exact API.");
}

async function main() {
  console.log(`Fetching Rasayel history ${FROM.toISOString().slice(0, 10)} .. ${TO.toISOString().slice(0, 10)}`);
  console.log("Checking API access...");
  await gql("{ __typename }");
  console.log("API reachable, token accepted.");

  const QUERY = `
    query($after: String) {
      conversations(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          createdAt
          channelType
          participants {
            user {
              __typename
              ... on ChannelUser {
                name
                firstName
                lastName
                displayName
                identifiers { sourceId category }
              }
            }
          }
        }
      }
    }`;

  let after = null;
  let fetched = 0;
  let kept = 0;
  try {
    while (true) {
      const data = await gql(QUERY, { after });
      const conn = data.conversations;
      for (const node of conn.nodes || []) {
        fetched++;
        const created = toDate(node.createdAt);
        if (created && created >= FROM && created <= TO) {
          appendEvent(node, created);
          kept++;
        }
      }
      process.stdout.write(`\rFetched ${fetched} conversations, ${kept} in range...`);
      if (!conn.pageInfo?.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }
    console.log(`\nDone. ${kept} conversations from the selected period added to the dashboard data.`);
    console.log("Open http://localhost:3000/dashboard to see them.");
  } catch (err) {
    console.error(`\nThe best-guess query was rejected by the API:\n${err.message}\n`);
    console.log("Falling back to schema discovery...");
    await saveSchemaSummary();
  }
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
