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

const URL_CANDIDATES = [
  ...new Set(
    [
      process.env.RASAYEL_API_URL,
      "https://api.rasayel.io/graphql",
      "https://api.rasayel.io/api/graphql",
      "https://app.rasayel.io/graphql",
    ].filter(Boolean)
  ),
];
const TOKEN = process.env.RASAYEL_API_TOKEN;
let FROM, TO;
const days = parseInt(process.env.HISTORY_DAYS, 10);
if (days > 0) {
  TO = new Date();
  FROM = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
} else {
  FROM = new Date(process.env.HISTORY_FROM || "2026-07-01T00:00:00Z");
  TO = new Date(process.env.HISTORY_TO ? process.env.HISTORY_TO + "T23:59:59Z" : "2026-07-31T23:59:59Z");
}

if (!TOKEN) {
  console.error("No RASAYEL_API_TOKEN found. Create a file named .env next to server.js");
  console.error("containing a line like:  RASAYEL_API_TOKEN=eyJhbGci...");
  process.exit(1);
}

// Rasayel deployments vary in the auth scheme they accept; the token's own
// jti claim is the key id used for HTTP Basic. Probe until one works.
function authCandidates() {
  const list = [{ label: "Bearer", header: `Bearer ${TOKEN}` }];
  try {
    const payload = JSON.parse(Buffer.from(TOKEN.split(".")[1], "base64url").toString());
    if (payload.jti) {
      list.push({
        label: "Basic (token-id:token)",
        header: "Basic " + Buffer.from(`${payload.jti}:${TOKEN}`).toString("base64"),
      });
    }
  } catch { /* not a JWT — skip Basic */ }
  list.push({ label: "raw token", header: TOKEN });
  return list;
}

let ENDPOINT = null;
let AUTH = null;

async function rawGql(url, authHeader, query, variables = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
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

async function connect() {
  const attempts = [];
  for (const url of URL_CANDIDATES) {
    for (const auth of authCandidates()) {
      try {
        await rawGql(url, auth.header, "{ __typename }");
        ENDPOINT = url;
        AUTH = auth.header;
        console.log(`Connected to ${url} using ${auth.label} authentication.`);
        return;
      } catch (err) {
        attempts.push(`  ${url} [${auth.label}]: ${String(err.message).slice(0, 120)}`);
      }
    }
  }
  throw new Error(`No endpoint/auth combination worked:\n${attempts.join("\n")}`);
}

async function gql(query, variables = {}) {
  return rawGql(ENDPOINT, AUTH, query, variables);
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
  await connect();

  // 1. Find the contacts query — either on the Query type directly, or nested
  //    one level down (Rasayel exposes app/currentAppUser at the root, with
  //    contacts living inside the app object).
  const pickContactField = (fields) =>
    fields.find((f) => /^(channelUsers|contacts|channel_users)$/i.test(f.name)) ||
    fields.find((f) => /channelUser|contact/i.test(f.name));

  const q = await typeFields("Query");
  let parentField = null;
  let target = pickContactField(q.fields);
  if (!target) {
    for (const f of q.fields) {
      const tName = unwrap(f.type)?.name;
      if (!tName) continue;
      let sub;
      try { sub = await typeFields(tName); } catch { continue; }
      if (!sub?.fields) continue;
      const cand = pickContactField(sub.fields);
      if (cand) {
        parentField = f;
        target = cand;
        break;
      }
      }
  }
  if (!target) {
    console.error("Could not find a contacts query. Available root queries:");
    console.error(q.fields.map((f) => f.name).join(", "));
    for (const f of q.fields) {
      const tName = unwrap(f.type)?.name;
      if (!tName) continue;
      try {
        const sub = await typeFields(tName);
        if (sub?.fields) console.error(`  ${f.name} -> ${sub.fields.map((x) => x.name).join(", ")}`);
      } catch { /* skip */ }
    }
    process.exit(1);
  }
  console.log(`Using query: ${parentField ? parentField.name + " > " : ""}${target.name}`);

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

  // 3. Select every scalar/enum field the contact type has, plus nested
  //    objects with scalar subfields — Rasayel keeps referral data (ad id,
  //    url, type) in nested structures, not as top-level contact columns.
  const nodeType = await typeFields(nodeTypeName);
  const scalarFields = nodeType.fields
    .filter((f) => !f.args?.length)
    .filter((f) => ["SCALAR", "ENUM"].includes(unwrap(f.type)?.kind))
    .map((f) => f.name);
  const hasIdentifiers = nodeType.fields.some((f) => f.name === "identifiers");
  console.log(`Fields found: ${scalarFields.join(", ")}${hasIdentifiers ? ", identifiers" : ""}`);

  const objectSelections = [];
  const skipRe = /conversation|message|team|assignee|channel/i;
  const nestedInfo = {};
  for (const f of nodeType.fields) {
    if (f.args?.length) continue;
    const u = unwrap(f.type);
    if (u?.kind !== "OBJECT" || f.name === "identifiers") continue;
    let sub;
    try { sub = await typeFields(u.name); } catch { continue; }
    const scalars = (sub?.fields || [])
      .filter((x) => !x.args?.length && ["SCALAR", "ENUM"].includes(unwrap(x.type)?.kind))
      .map((x) => x.name);
    nestedInfo[f.name] = scalars;
    if (skipRe.test(f.name)) continue;
    if (scalars.length && scalars.length <= 20) {
      objectSelections.push({ name: f.name, sel: `${f.name} { ${scalars.join(" ")} }` });
    }
  }
  if (objectSelections.length) {
    console.log(`Including nested data: ${objectSelections.map((o) => o.name).join(", ")}`);
  }
  console.log(`Query arguments available: ${target.args.map((a) => a.name).join(", ") || "(none)"}`);

  // Save a schema map for diagnosis if referral data still doesn't show up.
  fs.writeFileSync(
    path.join(DATA_DIR, "rasayel-schema-summary.json"),
    JSON.stringify(
      {
        query: `${parentField ? parentField.name + " > " : ""}${target.name}`,
        args: target.args.map((a) => a.name),
        contactType: nodeTypeName,
        scalarFields,
        nested: nestedInfo,
      },
      null,
      2
    )
  );

  let selParts = [
    { name: "__typename", sel: "__typename" },
    ...scalarFields.map((n) => ({ name: n, sel: n })),
    ...(hasIdentifiers ? [{ name: "identifiers", sel: "identifiers { sourceId category }" }] : []),
    ...objectSelections,
  ];

  const argNames = new Set(target.args.map((a) => a.name));
  // Newest-first pagination (last/before) lets us stop as soon as we pass the
  // start of the requested range instead of crawling the entire history.
  const backwards = argNames.has("last") && argNames.has("before") && hasPageInfo;
  const forwards = argNames.has("first");
  console.log(backwards ? "Fetching newest-first." : "Fetching oldest-first (no backwards pagination available).");

  const buildQuery = () => {
    const sel = selParts.map((p) => p.sel).join("\n            ");
    const args = backwards
      ? "(last: 50, before: $cursor)"
      : forwards
        ? `(first: 50${argNames.has("after") ? ", after: $cursor" : ""})`
        : "";
    const pageInfoSel = hasPageInfo ? "pageInfo { hasNextPage endCursor hasPreviousPage startCursor }" : "";
    const body = hasNodes
      ? `nodes { ${sel} } ${pageInfoSel}`
      : hasEdges
        ? `edges { node { ${sel} } } ${pageInfoSel}`
        : sel;
    const inner = `${target.name}${args} { ${body} }`;
    const wrapped = parentField ? `${parentField.name} { ${inner} }` : inner;
    const varDecl = args.includes("$cursor") ? "($cursor: String)" : "";
    return `query${varDecl} { ${wrapped} }`;
  };

  // 4. Paginate, dropping any selection the API refuses.
  let cursor = null;
  let fetched = 0;
  let kept = 0;
  let retriesLeft = 8;
  while (true) {
    let data;
    try {
      data = await gql(buildQuery(), { cursor });
    } catch (err) {
      const bad = [...String(err.message).matchAll(/'([A-Za-z_][A-Za-z0-9_]*)'/g)].map((m) => m[1]);
      const before = selParts.length;
      selParts = selParts.filter((p) => !bad.includes(p.name));
      if (selParts.length < before && retriesLeft-- > 0) {
        console.log(`Retrying without: ${bad.join(", ")}`);
        continue;
      }
      throw err;
    }
    const root = parentField ? data[parentField.name][target.name] : data[target.name];
    const nodes = hasNodes ? root.nodes : hasEdges ? root.edges.map((e) => e.node) : root;
    let oldestOnPage = null;
    for (const node of nodes || []) {
      fetched++;
      const created = toDate(node.createdAt || node.created_at);
      if (created && (!oldestOnPage || created < oldestOnPage)) oldestOnPage = created;
      if (created && created >= FROM && created <= TO) {
        appendEvent(node, created);
        kept++;
      }
    }
    process.stdout.write(`\rChecked ${fetched} contacts, ${kept} in the last days...`);
    const pi = hasPageInfo ? root.pageInfo : null;
    if (backwards) {
      // Once a page dips below the start of the range, older pages can't match.
      if (oldestOnPage && oldestOnPage < FROM) break;
      if (!pi?.hasPreviousPage) break;
      cursor = pi.startCursor;
    } else {
      if (!pi?.hasNextPage || !argNames.has("after")) break;
      cursor = pi.endCursor;
    }
  }
  console.log(`\nDone. ${kept} contacts from the selected period added to the dashboard data.`);
  console.log("Start the bot and open http://localhost:3000/dashboard to see them.");
  if (kept > 0) {
    console.log("\nIf leads show as 'Direct' that should be ads, send the file");
    console.log("data\\rasayel-schema-summary.json content to the Claude chat.");
  }
}

main().catch((err) => {
  console.error("\nFailed:", err.message);
  console.error("\nCopy this whole window's text and paste it in the Claude chat to adapt the script.");
  process.exit(1);
});
