import { applyProxy } from "./proxy-shim.js";
await applyProxy();
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
    `query($n: String!) { __type(name: $n) { name kind possibleTypes { name } fields {
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

// Referral data may arrive on a later, deeper sync than the contact's first
// appearance — treat a contact as "known" only at its best data level, so a
// re-sync that finally carries referral info replaces silence with attribution.
function hasReferralData(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 6) return false;
  const label = node.field?.name || node.field?.label || node.name;
  if (typeof label === "string" && /referral/i.test(label) && node.value != null && node.value !== "") return true;
  for (const [k, v] of Object.entries(node)) {
    if (/referral/i.test(k) && v != null && typeof v !== "object" && v !== "") return true;
    if (v && typeof v === "object" && hasReferralData(v, depth + 1)) return true;
  }
  return false;
}

// Join custom-field VALUES (properties nodes, keyed by attrId) with their
// LABELS (dataAttributes definitions) into simple {name, value} pairs the
// dashboard reads directly.
function attachContactFields(node) {
  const defs = Array.isArray(node?.dataAttributes) ? node.dataAttributes : [];
  const nameByAttr = new Map(
    defs.filter((d) => d && d.attrId != null && d.name).map((d) => [String(d.attrId), d.name])
  );
  const out = [];
  const META_KEYS = new Set([
    "attrId", "id", "__typename", "name", "key", "label", "standard", "editable",
    "channelSpecific", "userId", "attrType", "createdAt", "updatedAt", "uuid", "position", "kind",
  ]);
  const scanArr = (arr) => {
    for (const e of arr || []) {
      if (!e || typeof e !== "object") continue;
      let val = e.value ?? e.stringValue ?? e.textValue ?? e.text ?? e.url ?? e.boolValue ?? e.numberValue;
      if (val == null || val === "") {
        // Typed value shapes (PropertiesTextType etc.) name their payload
        // differently — take the first non-meta scalar.
        for (const [k, v] of Object.entries(e)) {
          if (!META_KEYS.has(k) && v != null && v !== "" && typeof v !== "object") { val = v; break; }
          if (v && typeof v === "object" && !Array.isArray(v)) {
            for (const [k2, v2] of Object.entries(v)) {
              if (!META_KEYS.has(k2) && v2 != null && v2 !== "" && typeof v2 !== "object") { val = v2; break; }
            }
            if (val != null && val !== "") break;
          }
        }
      }
      if (val == null || val === "") continue;
      const label = (e.attrId != null && nameByAttr.get(String(e.attrId))) || e.name || e.key || null;
      if (label) out.push({ name: label, value: val });
    }
  };
  for (const v of Object.values(node || {})) {
    if (Array.isArray(v)) scanArr(v);
    else if (v && typeof v === "object" && Array.isArray(v.nodes)) scanArr(v.nodes);
  }
  if (out.length) node.contactFields = out;
}

const known = new Map(); // contact id -> already has referral data
if (fs.existsSync(PAYLOAD_LOG)) {
  for (const line of fs.readFileSync(PAYLOAD_LOG, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const ev = JSON.parse(line);
      const c = ev?.body?.data?.contact;
      if (c?.id != null) {
        const key = String(c.id);
        known.set(key, known.get(key) === true || hasReferralData(c));
      }
    } catch { /* ignore bad lines */ }
  }
}

function appendEvent(contact, when) {
  if (contact?.id != null) {
    const key = String(contact.id);
    const prev = known.get(key);
    const withRef = hasReferralData(contact);
    if (prev !== undefined && (prev === true || !withRef)) return false;
    known.set(key, withRef || prev === true);
  }
  const event = {
    received_at: (when || new Date()).toISOString(),
    path: "/history-sync",
    headers: { "x-source": "fetch-history" },
    body: { event: "history.sync", data: { contact } },
  };
  fs.appendFileSync(PAYLOAD_LOG, JSON.stringify(event) + "\n");
  return true;
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

  const skipRe = /conversation|message|team|assignee|channel|avatar/i;
  const typeCache = new Map();
  async function typeFieldsCached(name) {
    if (!typeCache.has(name)) typeCache.set(name, await typeFields(name));
    return typeCache.get(name);
  }

  // Selection of all argless scalar fields of a type, descending one level
  // into argless object subfields (e.g. value + field { name }). Interface
  // and union types (like Properties, whose value lives on concrete shapes
  // such as PropertiesTextType) get inline fragments per possible type.
  async function selectionForType(typeName, depth) {
    const t = await typeFieldsCached(typeName);
    if (!t) return null;
    const parts = [];
    for (const x of t.fields || []) {
      if (x.args?.length) continue;
      const ux = unwrap(x.type);
      if (["SCALAR", "ENUM"].includes(ux?.kind)) parts.push(x.name);
      else if (ux?.kind === "OBJECT" && depth > 0 && !skipRe.test(x.name)) {
        try {
          const inner = await selectionForType(ux.name, depth - 1);
          if (inner) parts.push(`${x.name} { ${inner} }`);
        } catch { /* skip */ }
      }
    }
    if ((t.kind === "INTERFACE" || t.kind === "UNION") && t.possibleTypes?.length) {
      for (const p of t.possibleTypes.slice(0, 15)) {
        try {
          const pt = await typeFieldsCached(p.name);
          const extra = (pt?.fields || [])
            .filter((x) => !x.args?.length && ["SCALAR", "ENUM"].includes(unwrap(x.type)?.kind))
            .map((x) => x.name)
            .filter((n) => !parts.includes(n));
          if (extra.length) parts.push(`... on ${p.name} { ${extra.join(" ")} }`);
        } catch { /* skip */ }
      }
    }
    return parts.length ? parts.join(" ") : null;
  }

  // Candidate deep selections: every non-scalar field on the contact type,
  // including paginated sub-connections (custom/contact fields live there).
  const nestedInfo = {};
  const extraCandidates = [];
  for (const f of nodeType.fields) {
    if (f.name === "identifiers" || skipRe.test(f.name)) continue;
    const u = unwrap(f.type);
    if (!u || ["SCALAR", "ENUM"].includes(u.kind)) continue;
    let sub;
    try { sub = await typeFieldsCached(u.name); } catch { continue; }
    if (!sub?.fields) continue;
    try {
      const nodesF = sub.fields.find((x) => x.name === "nodes");
      const edgesF = sub.fields.find((x) => x.name === "edges");
      if (nodesF || edgesF) {
        let innerTypeName;
        if (nodesF) {
          innerTypeName = unwrap(nodesF.type)?.name;
        } else {
          const edgeT = await typeFieldsCached(unwrap(edgesF.type)?.name);
          innerTypeName = unwrap(edgeT.fields.find((x) => x.name === "node").type)?.name;
        }
        const innerSel = await selectionForType(innerTypeName, 1);
        nestedInfo[f.name] = `connection of ${innerTypeName}`;
        if (!innerSel) continue;
        const argList = (f.args || []).some((a) => a.name === "first") ? "(first: 25)" : "";
        extraCandidates.push({
          name: f.name,
          sel: nodesF
            ? `${f.name}${argList} { nodes { ${innerSel} } }`
            : `${f.name}${argList} { edges { node { ${innerSel} } } }`,
        });
      } else {
        if (f.args?.length) continue;
        const innerSel = await selectionForType(u.name, 1);
        nestedInfo[f.name] = `object ${u.name}`;
        if (innerSel) extraCandidates.push({ name: f.name, sel: `${f.name} { ${innerSel} }` });
      }
    } catch { continue; }
  }

  // Test each candidate against a single contact; keep the ones the API accepts.
  const acceptedDeep = [];
  for (const c of extraCandidates) {
    const inner = `${target.name}(first: 1) { ${
      hasNodes ? `nodes { ${c.sel} }` : hasEdges ? `edges { node { ${c.sel} } }` : c.sel
    } }`;
    const probeQuery = `query { ${parentField ? `${parentField.name} { ${inner} }` : inner} }`;
    try {
      await gql(probeQuery);
      acceptedDeep.push(c);
      if (acceptedDeep.length >= 12) break;
    } catch (err) {
      nestedInfo[c.name] += ` | bulk probe rejected: ${String(err.message).slice(0, 120)}`;
    }
  }

  // Refine pass: a connection whose bulk selection was rejected may still be
  // partially readable — test its subfields one by one and keep the working
  // set. This is how the properties connection (where custom-field VALUES
  // live, joined to dataAttributes labels by attrId) gets recovered.
  for (const c of extraCandidates) {
    if (acceptedDeep.some((a) => a.name === c.name)) continue;
    const f = nodeType.fields.find((x) => x.name === c.name);
    const u = unwrap(f.type);
    let sub;
    try { sub = await typeFieldsCached(u.name); } catch { continue; }
    const nodesF = sub?.fields?.find((x) => x.name === "nodes");
    if (!nodesF) continue;
    const innerTypeName = unwrap(nodesF.type)?.name;
    let it;
    try { it = await typeFieldsCached(innerTypeName); } catch { continue; }
    const argList = (f.args || []).some((a) => a.name === "first") ? "(first: 25)" : "";
    const tryProbe = async (sel) => {
      const body = `${c.name}${argList} { nodes { ${sel} } }`;
      const inner = `${target.name}(first: 1) { ${
        hasNodes ? `nodes { ${body} }` : `edges { node { ${body} } }`
      } }`;
      await gql(`query { ${parentField ? `${parentField.name} { ${inner} }` : inner} }`);
    };
    try {
      await tryProbe("__typename");
    } catch (err) {
      nestedInfo[c.name] += ` | base probe failed: ${String(err.message).slice(0, 120)}`;
      continue;
    }
    const good = [];
    for (const x of it?.fields || []) {
      if (x.args?.length) continue;
      const ux = unwrap(x.type);
      let sel = null;
      if (["SCALAR", "ENUM"].includes(ux?.kind)) sel = x.name;
      else if (ux?.kind === "OBJECT" && !skipRe.test(x.name)) {
        try {
          const innerSel = await selectionForType(ux.name, 0);
          if (innerSel) sel = `${x.name} { ${innerSel} }`;
        } catch { /* skip */ }
      } else if (["INTERFACE", "UNION"].includes(ux?.kind)) {
        try {
          const innerSel = await selectionForType(ux.name, 0);
          if (innerSel) sel = `${x.name} { __typename ${innerSel} }`;
        } catch { /* skip */ }
      }
      if (!sel) continue;
      try {
        await tryProbe(sel);
        good.push(sel);
      } catch { nestedInfo[`${c.name}.${x.name}`] = "subfield rejected"; }
    }
    // Interface/union node types: test each concrete shape's fragment too.
    if (["INTERFACE", "UNION"].includes(it?.kind) && it?.possibleTypes?.length) {
      for (const p of it.possibleTypes.slice(0, 15)) {
        try {
          const pt = await typeFieldsCached(p.name);
          const scalars = (pt?.fields || [])
            .filter((x) => !x.args?.length && ["SCALAR", "ENUM"].includes(unwrap(x.type)?.kind))
            .map((x) => x.name)
            .filter((n) => !good.includes(n));
          if (!scalars.length) continue;
          const sel = `... on ${p.name} { ${scalars.join(" ")} }`;
          await tryProbe(sel);
          good.push(sel);
        } catch { nestedInfo[`${c.name}...${p.name}`] = "fragment rejected"; }
      }
    }
    if (good.length) {
      acceptedDeep.push({ name: c.name, sel: `${c.name}${argList} { nodes { ${good.join(" ")} } }` });
      console.log(`Recovered deep field: ${c.name} (${good.length} subfields kept)`);
    }
  }
  console.log(
    acceptedDeep.length
      ? `Deep data included: ${acceptedDeep.map((c) => c.name).join(", ")}`
      : "No deep data structures accepted by the API."
  );
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
    ...acceptedDeep,
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
        attachContactFields(node);
        if (appendEvent(node, created)) kept++;
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
  // Re-save the schema summary with probe outcomes for /diag.
  fs.writeFileSync(
    path.join(DATA_DIR, "rasayel-schema-summary.json"),
    JSON.stringify(
      {
        query: `${parentField ? parentField.name + " > " : ""}${target.name}`,
        args: target.args.map((a) => a.name),
        contactType: nodeTypeName,
        scalarFields,
        deepIncluded: selParts.filter((p) => /\{/.test(p.sel)).map((p) => p.name),
        nested: nestedInfo,
      },
      null,
      2
    )
  );
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
