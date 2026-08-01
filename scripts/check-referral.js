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
  console.log("Referral check — scanning newest contacts for ad leads");
  await connect();
  log(`Connected: ${ENDPOINT}`);

  // 1. Introspect the Properties node type and DataAttribute fully.
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

  // 2. Probe properties subfields against a page of newest contacts —
  //    schema validation doesn't depend on which contact is in the page.
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
        await gql(`query { app { channelUsers(last: 3) { nodes { properties(first: 5) { nodes { ${sel} } } } } } }`);
        accepted.push(sel);
      } catch { log(`properties subfield rejected: ${f.name}`); }
    }
    log(`Accepted properties subfields: ${accepted.join(", ") || "(none)"}`);
  }

  // 3. Scan newest-first for contacts whose dataAttributes carry referral
  //    labels — those are the ad leads — and pull everything for them.
  const adLeads = [];
  let cursor = null;
  let scanned = 0;
  while (adLeads.length < 5 && scanned < 2000) {
    const d = await gql(
      `query($cursor: String) { app { channelUsers(last: 50, before: $cursor) {
         pageInfo { hasPreviousPage startCursor }
         nodes {
           id displayName createdAt identifiers { sourceId category }
           dataAttributes { attrId attrType name standard editable userId }
           ${accepted.length ? `properties(first: 50) { nodes { ${accepted.join(" ")} } }` : ""}
         } } } }`,
      { cursor }
    );
    const conn = d.app?.channelUsers;
    const nodes = conn?.nodes || [];
    scanned += nodes.length;
    for (const n of nodes) {
      if ((n.dataAttributes || []).some((a) => /referral/i.test(a?.name || ""))) {
        adLeads.push(n);
      }
    }
    process.stdout.write(`\rScanned ${scanned} contacts, ${adLeads.length} with referral labels...`);
    if (!conn?.pageInfo?.hasPreviousPage || !nodes.length) break;
    cursor = conn.pageInfo.startCursor;
  }
  console.log("");
  report.scanned = scanned;
  report.adLeads = adLeads;

  if (!adLeads.length) {
    report.verdict = "NO REFERRAL-LABELED CONTACTS IN SCAN";
    log("======================================================");
    log("VERDICT: no contacts with referral labels were found in");
    log(`the newest ${scanned} contacts. Ad leads may be older.`);
    log("======================================================");
    finish(0);
    return;
  }

  console.log("\n----- RAW DATA OF AD-LEAD CONTACTS -----");
  console.log(JSON.stringify(adLeads, null, 2).slice(0, 6000));
  console.log("----------------------------------------\n");

  // 4. Verdict.
  const values = adLeads.flatMap((c) => findReferralValues(c));
  report.referralValues = values;
  if (values.length) {
    report.verdict = "REFERRAL VALUES FOUND";
    log("==========================================");
    log("VERDICT: REFERRAL VALUES FOUND VIA THE API");
    values.slice(0, 10).forEach((v) => log(`  ${v.label} = ${v.value}`));
    log("==========================================");
  } else {
    report.verdict = "NOT EXPOSED ON CONTACTS";
    log("=====================================================");
    log("VERDICT PART 1: contact records do NOT return referral");
    log(`values (${adLeads.length} contact(s) have labels, no values).`);
    log("Trying PART 2: message-level referral...");
    log("=====================================================");
    await checkMessageReferral(adLeads);
  }
  finish(0);
}

// PART 2 — WhatsApp attaches ad referral to the customer's FIRST message;
// Rasayel's message objects may expose it even though contact properties don't.
async function checkMessageReferral(adLeads) {
  // 1. What referral-ish fields do message types carry?
  const msgTypeCandidates = ["TextMessage", "Message", "ImageMessage", "TemplateMessage"];
  const refFieldsByType = {};
  for (const tn of msgTypeCandidates) {
    try {
      const t = await typeInfo(tn);
      if (!t?.fields) continue;
      const hits = [];
      for (const f of t.fields) {
        // Referral fields AND the message content itself — the ad quote
        // ("Source link: https://fb.me/...") often lives in the body/context.
        if (!/referral|ctwa|ad(Id|_id)|sourceUrl|source_url|^body$|caption|context|quoted|preview|headline|forward/i.test(f.name)) continue;
        const u = unwrap(f.type);
        if (["SCALAR", "ENUM"].includes(u?.kind)) {
          hits.push(f.name);
        } else if (u?.kind === "OBJECT") {
          try {
            const it = await typeInfo(u.name);
            const scalars = (it.fields || [])
              .filter((x) => !(x.args || []).length && ["SCALAR", "ENUM"].includes(unwrap(x.type)?.kind))
              .map((x) => x.name);
            if (scalars.length) hits.push(`${f.name} { ${scalars.join(" ")} }`);
          } catch { /* skip */ }
        }
      }
      if (hits.length) refFieldsByType[tn] = hits;
    } catch { /* type absent */ }
  }
  report.messageReferralFields = refFieldsByType;
  log(`Message types with referral-ish fields: ${JSON.stringify(refFieldsByType) || "{}"}`);
  if (!Object.keys(refFieldsByType).length) {
    report.verdict = "NOT EXPOSED ANYWHERE — WEBHOOK REQUIRED";
    log("==========================================================");
    log("VERDICT PART 2: message types carry no referral fields either.");
    log("=> Attribution must come from the live webhook for new leads.");
    log("==========================================================");
    return;
  }

  // 2. Find a conversation id for an ad lead.
  let convId = null;
  try {
    const d = await gql(
      `query { app { channelUsers(last: 100) { nodes {
         dataAttributes { name }
         sessions { nodes { conversationId } }
       } } } }`
    );
    for (const n of d.app?.channelUsers?.nodes || []) {
      if ((n.dataAttributes || []).some((a) => /referral/i.test(a?.name || ""))) {
        convId = n.sessions?.nodes?.[0]?.conversationId || convId;
      }
    }
  } catch (err) { log(`Session lookup failed: ${String(err.message).slice(0, 150)}`); }
  if (!convId) {
    log("Could not find a conversation id for an ad lead — cannot test message referral directly.");
    report.verdict = "MESSAGE FIELDS EXIST — UNTESTED";
    return;
  }
  log(`Testing conversation ${convId}...`);

  // 3. Reach that conversation's messages.
  const fragSel = Object.entries(refFieldsByType)
    .map(([tn, hits]) => `... on ${tn} { ${hits.join(" ")} }`)
    .join(" ");
  const attempts = [
    `query($id: ID!) { app { conversation(id: $id) { messages(first: 10) { nodes { __typename createdAt direction ${fragSel} } } } } }`,
    `query($id: ID!) { app { conversations(ids: [$id], first: 1) { nodes { messages(first: 10) { nodes { __typename createdAt direction ${fragSel} } } } } } }`,
    `query($id: ID!) { app { conversations(first: 1, id: $id) { nodes { messages(first: 10) { nodes { __typename createdAt direction ${fragSel} } } } } } }`,
  ];
  let messages = null;
  for (const q of attempts) {
    try {
      const d = await gql(q, { id: String(convId) });
      const conv = d.app?.conversation || d.app?.conversations?.nodes?.[0];
      messages = conv?.messages?.nodes || null;
      if (messages) break;
    } catch (err) {
      report.steps.push(`conversation query rejected: ${String(err.message).slice(0, 150)}`);
    }
  }
  if (!messages) {
    log("Could not query the conversation's messages (attempts logged in report).");
    report.verdict = "MESSAGE FIELDS EXIST — CONVERSATION QUERY BLOCKED";
    return;
  }
  console.log("\n----- MESSAGES OF AN AD-LEAD CONVERSATION -----");
  console.log(JSON.stringify(messages, null, 2).slice(0, 4000));
  console.log("-----------------------------------------------\n");
  report.messages = messages;

  const values = findReferralValues(messages);
  report.referralValues = values;
  const msgText = JSON.stringify(messages);
  const adLink = msgText.match(/https?:\/\/fb\.me\/[A-Za-z0-9_-]+/);
  const sourceLine = msgText.match(/Source link[^"]{0,120}/i);
  if (values.length) {
    report.verdict = "REFERRAL FOUND ON MESSAGES";
    log("=================================================");
    log("VERDICT PART 2: REFERRAL VALUES FOUND ON MESSAGES");
    values.slice(0, 10).forEach((v) => log(`  ${v.label} = ${v.value}`));
    log("=================================================");
  } else if (adLink || sourceLine) {
    report.verdict = "AD LINK FOUND IN MESSAGE TEXT";
    report.adLink = adLink?.[0] || null;
    log("====================================================");
    log("VERDICT PART 2: AD LINK FOUND INSIDE THE MESSAGE TEXT");
    if (adLink) log(`  ${adLink[0]}`);
    if (sourceLine) log(`  ${sourceLine[0]}`);
    log("=> Attribution possible by matching ad text/link to Meta.");
    log("====================================================");
  } else {
    report.verdict = "NOT EXPOSED ANYWHERE — WEBHOOK REQUIRED";
    log("==========================================================");
    log("VERDICT PART 2: messages returned but carry no referral data.");
    log("=> Attribution must come from the live webhook for new leads.");
    log("==========================================================");
  }
}

function finish(code) {
  fs.writeFileSync(path.join(DATA_DIR, "referral-check.json"), JSON.stringify(report, null, 2));
  console.log("\nFull report saved to data/referral-check.json (also shown at /diag).");
  process.exit(code);
}

main().catch((err) => { console.error("Failed:", err.message); finish(1); });
