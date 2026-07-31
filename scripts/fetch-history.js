// Pulls contacts (channel users) from the Rasayel API — including their ad
// referral fields — and merges them into the bot's data so the dashboard
// shows historical leads, not only live webhooks.
//
// Reads RASAYEL_API_TOKEN from .env (see .env.example). Optional env vars:
//   HISTORY_FROM=2026-07-01  HISTORY_TO=2026-07-31   (defaults: July 2026)
//
// The script adapts itself to Rasayel's schema at runtime: it introspects the
// contacts query and its node type, selects every scalar field that exists
// (so referral source id/url/type are picked up under whatever names Rasayel
// uses), and paginates through all contacts.

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

function unwrap(t) {
  while (t && (t.kind === "NON_NULL" || t.kind === "LIST")) t = t.ofType;
  return t;
}

async function typeFields(name) {
  const d = await gql(
    `query($n: String!) { __type(name: $n) { name kind fields {
       name
       args { name }
       type { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
     } } }`,
    { n: name }
  );
  return d.__type;
}

function toDate(v) {
  if (v == null) return null;
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v);
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

function appendEvent(contact, when) {
  const event = {
    received_at: (when || new Date()).toISOString(),
    path: "/history-sync",
    headers: { "x-source": "fetch-history" },
    body: { event: "history.sync", data: { contact } },
  };
  fs.appendFileSync(PAYLOAD_LOG, JSON.stringify(event) + "\n");
}

async function main() {
  console.log(`Fetching Rasayel contacts ${FROM.toISOString().slice(0, 10)} .. ${TO.toISOString().slice(0, 10)}`);
  console.log("Checking API access...");
  await gql("{ __typename }");
  console.log("API reachable, token accepted.");

  // 1. Find the contacts query on the Query type.
  const q = await typeFields("Query");
  const candidates = q.fields.filter((f) => /^(channelUsers|contacts|channel_users)$/i.test(f.name));
  const target = candidates[0] || q.fields.find((f) => /channelUser|contact/i.test(f.name));
  if (!target) {
    console.error("Could not find a contacts query. Available queries:");
    console.error(q.fields.map((f) => f.name).join(", "));
    process.exit(1);
  }
  console.log(`Using query: ${target.name}`);

  // 2. Inspect the returned connection type to find nodes/edges and the node type.
  const connName = unwrap(target.type)?.name;
  const conn = await typeFields(connName);
  const hasNodes = conn.fields.some((f) => f.name === "nodes");
  const hasEdges = conn.fields.some((f) => f.name === "edges");
  const hasPageInfo = conn.fields.some((f) => f.name === "pageInfo");
  let nodeTypeName;
  if (hasNodes) {
    nodeTypeName = unwrap(conn.fields.find((f) => f.name === "nodes").type)?.name;
  } else if (hasEdges) {
    const edgeType = unwrap(conn.fields.find((f) => f.name === "edges").type)?.name;
    const edge = await typeFields(edgeType);
    nodeTypeName = unwrap(edge.fields.find((f) => f.name === "node").type)?.name;
  } else {
    nodeTypeName = connName; // plain list
  }
  console.log(`Contact type: ${nodeTypeName}`);

  // 3. Select every scalar/enum field the contact type has (referral fields included).
  const nodeType = await typeFields(nodeTypeName);
  let scalarFields = nodeType.fields
    .filter((f) => !f.args?.length)
    .filter((f) => ["SCALAR", "ENUM"].includes(unwrap(f.type)?.kind))
    .map((f) => f.name);
  const hasIdentifiers = nodeType.fields.some((f) => f.name === "identifiers");
  console.log(`Fields found: ${scalarFields.join(", ")}${hasIdentifiers ? ", identifiers" : ""}`);

  const acceptsFirst = target.args.some((a) => a.name === "first");
  const acceptsAfter = target.args.some((a) => a.name === "after");

  const buildQuery = () => {
    const sel = [
      "__typename",
      ...scalarFields,
      hasIdentifiers ? "identifiers { sourceId category }" : "",
    ].filter(Boolean).join("\n            ");
    const args = acceptsFirst ? `(first: 50${acceptsAfter ? ", after: $after" : ""})` : "";
    const body = hasNodes
      ? `nodes { ${sel} } ${hasPageInfo ? "pageInfo { hasNextPage endCursor }" : ""}`
      : hasEdges
        ? `edges { node { ${sel} } } ${hasPageInfo ? "pageInfo { hasNextPage endCursor }" : ""}`
        : sel;
    return `query${acceptsAfter ? "($after: String)" : ""} { ${target.name}${args} { ${body} } }`;
  };

  // 4. Paginate through everything, dropping any field the API refuses.
  let after = null;
  let fetched = 0;
  let kept = 0;
  let retriesLeft = 5;
  while (true) {
    let data;
    try {
      data = await gql(buildQuery(), acceptsAfter ? { after } : {});
    } catch (err) {
      // Drop fields the server complains about and retry.
      const bad = [...String(err.message).matchAll(/'([A-Za-z_][A-Za-z0-9_]*)'/g)].map((m) => m[1]);
      const before = scalarFields.length;
      scalarFields = scalarFields.filter((f) => !bad.includes(f));
      if (scalarFields.length < before && retriesLeft-- > 0) {
        console.log(`Retrying without field(s): ${bad.join(", ")}`);
        continue;
      }
      throw err;
    }
    const root = data[target.name];
    const nodes = hasNodes ? root.nodes : hasEdges ? root.edges.map((e) => e.node) : root;
    for (const node of nodes || []) {
      fetched++;
      const created = toDate(node.createdAt || node.created_at);
      if (!created || (created >= FROM && created <= TO)) {
        appendEvent(node, created);
        kept++;
      }
    }
    process.stdout.write(`\rFetched ${fetched} contacts, ${kept} in range...`);
    const pi = hasPageInfo ? root.pageInfo : null;
    if (!pi?.hasNextPage || !acceptsAfter) break;
    after = pi.endCursor;
  }
  console.log(`\nDone. ${kept} contacts added to the dashboard data.`);
  console.log("Start the bot and open http://localhost:3000/dashboard to see them.");
}

main().catch((err) => {
  console.error("\nFailed:", err.message);
  console.error("\nCopy this whole window's text and paste it in the Claude chat to adapt the script.");
  process.exit(1);
});
