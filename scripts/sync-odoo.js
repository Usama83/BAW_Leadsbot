import { applyProxy } from "./proxy-shim.js";
await applyProxy();
// Joins ad-attributed WhatsApp leads to Odoo sales orders by phone number
// (first-touch attribution) and writes data/ad-so-join.json:
//   per ad: leads, confirmed SOs, quotations, revenue by currency.
//
// Requires in .env: ODOO_URL, ODOO_DB, ODOO_LOGIN, ODOO_API_KEY
// (plus the Rasayel/Meta data files produced by the other sync scripts).

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { classifyAd } from "./classify-ad.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const PAYLOAD_LOG = path.join(DATA_DIR, "payloads.jsonl");

const envPath = path.join(ROOT, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const { ODOO_URL, ODOO_DB, ODOO_LOGIN, ODOO_API_KEY } = process.env;
if (!ODOO_URL || !ODOO_DB || !ODOO_LOGIN || !ODOO_API_KEY) {
  console.error("Missing ODOO_URL / ODOO_DB / ODOO_LOGIN / ODOO_API_KEY in .env");
  process.exit(1);
}

let rpcId = 0;
async function rpc(service, method, args) {
  const res = await fetch(`${ODOO_URL.replace(/\/$/, "")}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: ++rpcId, params: { service, method, args } }),
  });
  const j = await res.json();
  if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 300));
  return j.result;
}
const uid = await rpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_API_KEY, {}]);
if (!uid) { console.error("Odoo authentication failed."); process.exit(1); }
const exec = (model, method, ...a) => rpc("object", "execute_kw", [ODOO_DB, uid, ODOO_API_KEY, model, method, ...a]);

// ---- pull orders ----
const total = await exec("sale.order", "search_count", [[]]);
console.log(`Sales orders in Odoo: ${total}`);
const orders = [];
for (let off = 0; off < total; off += 2000) {
  const page = await exec("sale.order", "search_read", [[]], {
    fields: ["name", "date_order", "state", "amount_total", "partner_id", "currency_id"],
    limit: 2000, offset: off,
  });
  orders.push(...page);
  process.stdout.write(`\r${orders.length}/${total} orders...`);
}
console.log("");
const pids = [...new Set(orders.map((o) => o.partner_id?.[0]).filter(Boolean))];
const partners = {};
for (let i = 0; i < pids.length; i += 1000) {
  const chunk = await exec("res.partner", "read", [pids.slice(i, i + 1000)], { fields: ["phone", "mobile"] });
  for (const p of chunk) partners[p.id] = p;
}
console.log(`${pids.length} customers fetched.`);

// ---- lead phones -> first-touch ad ----
const norm = (p) => {
  if (!p) return null;
  const d = String(p).replace(/\D/g, "").replace(/^0+/, "");
  return d.length < 8 ? null : d.slice(-9);
};
const adNames = fs.existsSync(path.join(DATA_DIR, "ad-names.json"))
  ? JSON.parse(fs.readFileSync(path.join(DATA_DIR, "ad-names.json"), "utf8")) : {};
const fbme = fs.existsSync(path.join(DATA_DIR, "fbme-map.json"))
  ? JSON.parse(fs.readFileSync(path.join(DATA_DIR, "fbme-map.json"), "utf8")) : {};
const byName = new Map(Object.entries(adNames).map(([id, a]) => [a.name?.trim().toLowerCase(), id]).filter(([k]) => k));
const byPostSuffix = new Map();
for (const [id, a] of Object.entries(adNames)) if (a.storyId?.includes("_")) byPostSuffix.set(a.storyId.split("_")[1], id);
const byInsta = new Map();
for (const [id, a] of Object.entries(adNames)) {
  const m = a.instagramUrl?.match(/\/p\/([A-Za-z0-9_-]+)/);
  if (m) byInsta.set(m[1], id);
}
function matchAd(f) {
  const name = f["Ad name"], post = f["Ad post URL"];
  const src = (f["Ad source URL"] && fbme[f["Ad source URL"]]) || f["Ad source URL"] || "";
  let m;
  if (post && (m = post.match(/facebook\.com\/(\d+)\/posts\/(\d+)/)) && byPostSuffix.has(m[2])) return byPostSuffix.get(m[2]);
  if ((m = String(src).match(/instagram\.com\/p\/([A-Za-z0-9_-]+)/)) && byInsta.has(m[1])) return byInsta.get(m[1]);
  for (const i of String(src).matchAll(/(?:story_fbid=|\/(?:videos|posts|reels)\/)(\d+)/g))
    if (byPostSuffix.has(i[1])) return byPostSuffix.get(i[1]);
  if (name && byName.has(name.trim().toLowerCase())) return byName.get(name.trim().toLowerCase());
  return null;
}
const leadAd = new Map();
for (const line of fs.readFileSync(PAYLOAD_LOG, "utf8").split("\n")) {
  if (!line.includes("sync-ad-conversations")) continue;
  let ev; try { ev = JSON.parse(line); } catch { continue; }
  const c = ev.body.data.contact;
  const phone = norm(c.identifiers?.find((i) => i.category === "PHONE")?.sourceId);
  if (!phone) continue;
  const t = new Date(ev.received_at).getTime();
  const prev = leadAd.get(phone);
  if (prev && prev.t <= t) continue;
  const f = Object.fromEntries((c.contactFields || []).map((x) => [x.name, x.value]));
  const id = matchAd(f);
  const label = id ? adNames[id].name : (f["Ad name"] || f["Ad source URL"] || "(unknown ad)");
  leadAd.set(phone, { t, key: id || label, label: String(label).slice(0, 70), matched: !!id });
}
console.log(`Ad-lead phones (first-touch): ${leadAd.size}`);

// ---- join ----
const perAd = new Map();
const get = (k, label, matched) => {
  if (!perAd.has(k)) perAd.set(k, { label, matched, leads: 0, sos: 0, quotes: 0, rev: {}, cat: null });
  return perAd.get(k);
};
for (const { key, label, matched } of leadAd.values()) get(key, label, matched).leads++;
let matchedSOs = 0, matchedQuotes = 0;
const buyers = new Set();
for (const o of orders) {
  if (o.state === "cancel") continue;
  const p = partners[o.partner_id?.[0]];
  const phone = norm(p?.phone) || norm(p?.mobile);
  const la = phone && leadAd.get(phone);
  if (!la) continue;
  const e = get(la.key, la.label, la.matched);
  const cur = o.currency_id?.[1] || "?";
  if (o.state === "sale" || o.state === "done") {
    e.sos++; matchedSOs++; buyers.add(phone);
    e.rev[cur] = (e.rev[cur] || 0) + o.amount_total;
  } else { e.quotes++; matchedQuotes++; }
}
for (const e of perAd.values()) e.cat = classifyAd({ name: e.label }).category;

const rows = [...perAd.values()].filter((e) => e.sos > 0 || e.leads >= 50).sort((a, b) => b.sos - a.sos);
fs.writeFileSync(
  path.join(DATA_DIR, "ad-so-join.json"),
  JSON.stringify({ rows, matchedSOs, matchedQuotes, totLeads: leadAd.size, buyers: buyers.size,
                   generatedAt: new Date().toISOString() }, null, 1)
);
console.log(`Done. ${matchedSOs} confirmed SOs + ${matchedQuotes} quotations from ${buyers.size} ad-lead buyers.`);
console.log("Saved data/ad-so-join.json (served at /ad-sos).");
