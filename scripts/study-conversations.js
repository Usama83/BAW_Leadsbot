import { applyProxy } from "./proxy-shim.js";
await applyProxy();
// Pulls the newest conversations with their messages from the Rasayel API,
// flags ad-related signals in message content, and saves a study report to
// data/conversations-study.json (rendered at http://localhost:3000/study).

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
const COUNT = Math.max(1, Math.min(50, parseInt(process.argv[2], 10) || 10));
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
let ENDPOINT = null, AUTH = null;
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
const typeCache = new Map();
async function typeInfo(name) {
  if (typeCache.has(name)) return typeCache.get(name);
  const d = await gql(
    `query($n: String!) { __type(name: $n) { name kind possibleTypes { name } fields {
       name
       args { name }
       type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }
     } } }`, { n: name });
  typeCache.set(name, d.__type);
  return d.__type;
}

const CONTENT_RE = /^(body|caption|text|title|headline|url|filename|referral|ctwa|sourceUrl|source_url|footer|buttons?|template)$/i;
const AD_SIGNAL_RE = /fb\.me\/|Source link|instagram\.com|facebook\.com|referral|wa\.me\/|إعلان/i;

async function main() {
  console.log(`Studying the last ${COUNT} conversations...`);
  await connect();
  console.log(`Connected: ${ENDPOINT}`);

  const appT = await typeInfo("App");
  const convField =
    (appT.fields || []).find((f) => f.name === "conversations") ||
    (appT.fields || []).find((f) => /conversation/i.test(f.name));
  if (!convField) throw new Error(`No conversations query. App fields: ${(appT.fields || []).map((f) => f.name).join(", ")}`);
  const convArgs = new Set((convField.args || []).map((a) => a.name));
  console.log(`Conversations query: ${convField.name}(${[...convArgs].join(", ")})`);

  const connT = await typeInfo(unwrap(convField.type).name);
  const nodesF = (connT.fields || []).find((x) => x.name === "nodes");
  const convTypeName = unwrap(nodesF?.type)?.name;
  const convT = await typeInfo(convTypeName);
  const convScalars = (convT.fields || [])
    .filter((f) => !f.args?.length && ["SCALAR", "ENUM"].includes(unwrap(f.type)?.kind))
    .map((f) => f.name);
  const msgsF =
    (convT.fields || []).find((x) => x.name === "messages") ||
    (convT.fields || []).find((x) => /messages/i.test(x.name));
  if (!msgsF) throw new Error(`Conversation has no messages field. Fields: ${(convT.fields || []).map((f) => f.name).join(", ")}`);
  const msgArgs = new Set((msgsF.args || []).map((a) => a.name));
  console.log(`Conversation fields: ${convScalars.join(", ")}`);
  console.log(`Messages field: ${msgsF.name}(${[...msgArgs].join(", ")})`);

  // Message selection: interface scalars + content fields of each concrete type.
  const msgConnT = await typeInfo(unwrap(msgsF.type).name);
  const msgNodesF = (msgConnT.fields || []).find((x) => x.name === "nodes");
  const msgTypeName = unwrap(msgNodesF?.type)?.name;
  const msgT = await typeInfo(msgTypeName);
  const msgBase = (msgT.fields || [])
    .filter((f) => !f.args?.length && ["SCALAR", "ENUM"].includes(unwrap(f.type)?.kind))
    .map((f) => f.name);
  const frags = [];
  if (msgT.possibleTypes?.length) {
    for (const p of msgT.possibleTypes.slice(0, 20)) {
      const pt = await typeInfo(p.name);
      const content = (pt?.fields || [])
        .filter((x) => !x.args?.length && ["SCALAR", "ENUM"].includes(unwrap(x.type)?.kind))
        .map((x) => x.name)
        .filter((n) => CONTENT_RE.test(n) && !msgBase.includes(n));
      if (content.length) frags.push(`... on ${p.name} { ${content.join(" ")} }`);
    }
  }
  console.log(`Message types found: ${(msgT.possibleTypes || []).map((p) => p.name).join(", ") || msgTypeName}`);

  // Participants (customer identity) — optional, dropped if rejected.
  let participantsSel =
    `participants { user { __typename ... on ChannelUser { displayName identifiers { sourceId category } } } }`;

  const buildQuery = (withParticipants, msgSel) => {
    const convCall = `${convField.name}${
      convArgs.has("last") ? `(last: ${COUNT})` : convArgs.has("first") ? `(first: ${COUNT})` : ""
    }`;
    return `query { app { ${convCall} { nodes {
      ${convScalars.join(" ")}
      ${withParticipants ? participantsSel : ""}
      ${msgsF.name}${msgArgs.has("first") ? "(first: 15)" : ""} { nodes { ${msgSel} } }
    } } } }`;
  };

  // Probe each content fragment individually so one rejected field doesn't
  // silence all message text.
  const probeSel = async (sel) => {
    await gql(`query { app { ${convField.name}(first: 1) { nodes { ${msgsF.name}(first: 1) { nodes { __typename ${sel} } } } } } }`);
  };
  const okFrags = [];
  for (const fr of frags) {
    try { await probeSel(fr); okFrags.push(fr); }
    catch { console.log(`fragment rejected: ${fr.slice(0, 60)}...`); }
  }
  let baseSel = msgBase.join(" ");
  try { await probeSel(baseSel); } catch {
    const okBase = [];
    for (const b of msgBase) { try { await probeSel(b); okBase.push(b); } catch { /* skip */ } }
    baseSel = okBase.join(" ");
  }
  const msgSelFull = `__typename ${baseSel} ${okFrags.join(" ")}`;
  console.log(`Message selection: base ${baseSel.split(" ").length} fields, ${okFrags.length}/${frags.length} fragments accepted.`);

  let data = null;
  let lastErr = null;
  for (const withP of [true, false]) {
    try {
      data = await gql(buildQuery(withP, msgSelFull));
      console.log(`Query accepted (participants: ${withP}).`);
      break;
    } catch (err) { lastErr = err; }
  }
  if (!data) throw new Error(`All query shapes rejected. Last error: ${String(lastErr?.message).slice(0, 300)}`);

  const convs = data.app?.[convField.name]?.nodes || [];
  const toDate = (v) => (v == null ? null : new Date(typeof v === "number" && v < 1e12 ? v * 1000 : v));
  const study = convs.map((c) => {
    const cu = (c.participants || [])
      .map((p) => p.user)
      .find((u) => u && u.__typename === "ChannelUser");
    const msgs = (c[msgsF.name]?.nodes || []).map((m) => {
      const text = m.body ?? m.caption ?? m.text ?? m.title ?? "";
      const extras = Object.entries(m)
        .filter(([k, v]) => CONTENT_RE.test(k) && v != null && v !== "" && typeof v !== "object" && k !== "body")
        .map(([k, v]) => `${k}=${v}`);
      return {
        type: m.__typename,
        direction: m.direction || null,
        at: toDate(m.createdAt)?.toISOString() || null,
        text: String(text).slice(0, 400),
        extras,
        adSignal: AD_SIGNAL_RE.test(JSON.stringify(m)),
      };
    });
    const adSignals = [];
    for (const m of msgs) {
      const s = `${m.text} ${m.extras.join(" ")}`;
      const link = s.match(/https?:\/\/(?:fb\.me|www\.instagram\.com|instagram\.com|www\.facebook\.com|facebook\.com|wa\.me)\/\S+/g);
      if (link) adSignals.push(...link);
      const src = s.match(/Source link[^\n"]{0,140}/i);
      if (src) adSignals.push(src[0]);
    }
    return {
      id: c.id,
      createdAt: toDate(c.createdAt)?.toISOString() || null,
      state: c.state || null,
      channelType: c.channelType || null,
      customer: cu?.displayName || null,
      phone: cu?.identifiers?.find((i) => i.category === "PHONE")?.sourceId || null,
      adSignals: [...new Set(adSignals)],
      messages: msgs,
    };
  });

  fs.writeFileSync(
    path.join(DATA_DIR, "conversations-study.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), conversations: study }, null, 2)
  );

  console.log(`\n===== STUDY OF ${study.length} CONVERSATIONS =====`);
  for (const c of study) {
    console.log(`\n— ${c.customer || "(unknown)"} ${c.phone || ""} · started ${c.createdAt || "?"}`);
    console.log(`  ad signals: ${c.adSignals.length ? c.adSignals.join(" | ") : "none"}`);
    for (const m of c.messages.slice(0, 4)) {
      console.log(`  [${m.direction || "?"} ${m.type}] ${m.text.replace(/\s+/g, " ").slice(0, 110)}${m.extras.length ? " | " + m.extras.join(" ") : ""}`);
    }
  }
  const withSignals = study.filter((c) => c.adSignals.length).length;
  console.log(`\nSummary: ${withSignals} of ${study.length} conversations contain ad signals.`);
  console.log("Full report saved. Open http://localhost:3000/study for the readable view.");
}

main().catch((err) => { console.error("Failed:", err.message); process.exit(1); });
