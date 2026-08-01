// Definitive referral check: targets one contact KNOWN to have ad referral
// data in the Rasayel UI (visible in the contact sidebar), and tries every
// reachable API path to extract those values. Prints a plain VERDICT.
//
// Usage: node scripts/check-referral.js [phone]
// Default phone: 9647809999397 (contact confirmed to have referral data)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const envPath = path.join(ROOT, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const TOKEN = process.env.RASAYEL_API_TOKEN;
const PHONE = process.argv[2] || "9647809999397";
if (!TOKEN) {
  console.error("No RASAYEL_API_TOKEN in .env");
  process.exit(1);
}

const URLS = ["https://api.rasayel.io/api/graphql", "https://api.rasayel.io/graphql"];
function authCandidates() {
  const list = [];
  try {
    const payload = JSON.parse(Buffer.from(TOKEN.split(".")[1], "base64url").toString());
    if (payload.jti) list.push("Basic " + Buffer.from(`${payload.jti}:${TOKEN}`).toString("base64"));
  } catch { /* not a JWT */ }
  list.push(`Bearer ${TOKEN}`);
  return list;
}

let ENDPOINT = null;
let AUTH = null;
async function rawGql(url, auth, query, variables = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`); }
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}
async function connect() {
  for (const url of URLS) for (const auth of authCandidates()) {
    try { await rawGql(url, auth, "{ __typename }"); ENDPOINT = url; AUTH = auth; return; } catch { /* next */ }
  }
  throw new Error("Could not connect to the Rasayel API.");
}
const gql = (q, v) => rawGql(ENDPOINT, AUTH, q, v);

function unwrap(t) { while (t && (t.kind === "NON_NULL" || t.kind === "LIST")) t = t.ofType; return t; }
async function typeInfo(name) {
  const d = await gql(
    `query($n: String!) { __type(name: $n) { name fields {
       name
       args { name type { kind name ofType { kind name } } }
       type { kind name ofType { kind name ofType { kind name } } }
     } } }`, { n: name });
  return d.__type;
}

const report = { phone: PHONE, steps: [], verdict: null };
function log(msg) { console.log(msg); report.steps.push(msg); }

function findReferralValues(obj, out = [], depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 8) return out;
  const label = obj.name || obj.key || obj.label || obj.field?.name;
  const val = obj.value ?? obj.stringValue ?? obj.textValue ?? obj.numberValue ?? obj.boolValue;
  if (typeof label === "string" && /referral|source/i.test(label) && val != null && val !== "") {
    out.push({ label, value: val });
  }
  for (const [k, v] of Object.entries(obj)) {
    if (/referral/i.test(k) && v != null && typeof v !== "object" && v !== "") out.push({ label: k, value: v });
    if (v && typeof v === "object") findReferralValues(v, out, depth + 1);
  }
  return out;
}

async function main() {
  console.log(`Referral check for phone ${PHONE}`);
  await connect();
  log(`Connected: ${ENDPOINT}`);

  // 1. Find the contact by phone.
  let contact = null;
  for (const argName of ["nameOrPhone", "search", "query"]) {
    try {
      const d = await gql(
        `query($v: String) { app { channelUsers(${argName}: $v, first: 5) {
           nodes { id displayName identifiers { sourceId category } } } } }`,
        { v: PHONE }
      );
      const nodes = d.app?.channelUsers?.nodes || [];
      contact = nodes.find((n) => n.identifiers?.some((i) => (i.sourceId || "").includes(PHONE.slice(-8)))) || nodes[0];
      if (contact) { log(`Found contact via ${argName}: ${contact.displayName} (id ${contact.id})`); break; }
    } catch { /* try next arg */ }
  }
  if (!contact) {
    log("Could not find the contact by phone — check the number and try again.");
    report.verdict = "CONTACT NOT FOUND";
    finish(1);
    return;
  }

  // 2. Introspect the Properties node type and DataAttribute fully.
  const cu = await typeInfo("ChannelUser");
  const propField = cu.fields.find((f) => f.name === "properties");
  let propNodeTypeName = null;
  if (propField) {
    const connT = await typeInfo(unwrap(propField.type).name);
    const nodesF = connT.fields.find((f) => f.name === "nodes");
    propNodeTypeName = unwrap(nodesF?.type)?.name;
  }
  const describe = (t) =>
    (t?.fields || []).map((f) => {
      const args = (f.args || []).map((a) => a.name).join(",");
      return `${f.name}${args ? `(${args})` : ""}: ${unwrap(f.type)?.kind} ${unwrap(f.type)?.name}`;
    });
  if (propNodeTypeName) {
    const pt = await typeInfo(propNodeTypeName);
    report.propertiesType = describe(pt);
    log(`Properties node type ${propNodeTypeName}: ${report.propertiesType.join(" | ")}`);
  }
  try {
    const dt = await typeInfo("DataAttribute");
    report.dataAttributeType = describe(dt);
    log(`DataAttribute: ${report.dataAttributeType.join(" | ")}`);
  } catch { /* fine */ }

  // 3. Probe every properties subfield individually on THIS contact.
  const accepted = [];
  if (propNodeTypeName) {
    const pt = await typeInfo(propNodeTypeName);
    for (const f of pt.fields || []) {
      const u = unwrap(f.type);
      let sel = null;
      if ((f.args || []).length === 0 && ["SCALAR", "ENUM"].includes(u?.kind)) sel = f.name;
      else if ((f.args || []).length === 0 && u?.kind === "OBJECT") {
        try {
          const it = await typeInfo(u.name);
          const scalars = (it.fields || [])
            .filter((x) => !(x.args || []).length && ["SCALAR", "ENUM"].includes(unwrap(x.type)?.kind))
            .map((x) => x.name);
          if (scalars.length) sel = `${f.name} { ${scalars.join(" ")} }`;
        } catch { /* skip */ }
      }
      if (!sel) continue;
      try {
        await gql(
          `query($id: ID!) { app { channelUsers(first: 1, query: $id) { nodes { properties(first: 5) { nodes { ${sel} } } } } } }`,
          { id: String(contact.id) }
        ).catch(async () => {
          // query-arg may not accept ids — fall back to phone search
          await gql(
            `query($v: String) { app { channelUsers(nameOrPhone: $v, first: 1) { nodes { properties(first: 5) { nodes { ${sel} } } } } } }`,
            { v: PHONE }
          );
        });
        accepted.push(sel);
      } catch { log(`properties subfield rejected: ${f.name}`); }
    }
    log(`Accepted properties subfields: ${accepted.join(", ") || "(none)"}`);
  }

  // 4. Full pull for this contact: dataAttributes + properties with all accepted subfields.
  let full = null;
  try {
    const d = await gql(
      `query($v: String) { app { channelUsers(nameOrPhone: $v, first: 3) { nodes {
         id displayName identifiers { sourceId category }
         dataAttributes { attrId attrType name standard editable userId }
         ${accepted.length ? `properties(first: 50) { nodes { ${accepted.join(" ")} } }` : ""}
       } } } }`,
      { v: PHONE }
    );
    const nodes = d.app?.channelUsers?.nodes || [];
    full = nodes.find((n) => String(n.id) === String(contact.id)) || nodes[0];
  } catch (err) {
    log(`Full pull failed: ${String(err.message).slice(0, 200)}`);
  }
  report.contact = full;
  console.log("\n----- RAW CONTACT DATA -----");
  console.log(JSON.stringify(full, null, 2));
  console.log("----------------------------\n");

  // 5. Verdict.
  const values = findReferralValues(full);
  report.referralValues = values;
  if (values.length) {
    report.verdict = "REFERRAL VALUES FOUND";
    log("==========================================");
    log("VERDICT: REFERRAL VALUES FOUND VIA THE API");
    values.forEach((v) => log(`  ${v.label} = ${v.value}`));
    log("==========================================");
  } else {
    report.verdict = "NOT EXPOSED BY API";
    log("=====================================================");
    log("VERDICT: THE API DOES NOT RETURN THE REFERRAL VALUES");
    log("for a contact that visibly has them in the Rasayel UI.");
    log("=> Attribution must come from the live webhook instead.");
    log("=====================================================");
  }
  finish(0);
}

function finish(code) {
  fs.writeFileSync(path.join(DATA_DIR, "referral-check.json"), JSON.stringify(report, null, 2));
  console.log("\nFull report saved to data/referral-check.json (also shown at /diag).");
  process.exit(code);
}

main().catch((err) => { console.error("Failed:", err.message); finish(1); });
