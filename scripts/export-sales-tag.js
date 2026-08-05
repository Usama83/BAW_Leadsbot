import { applyProxy } from "./proxy-shim.js";
await applyProxy();
// Exports confirmed sales orders carrying a given tag to CSV, matching the
// columns of the Odoo Quotations list view plus the customer's phone number.
//
//   node scripts/export-sales-tag.js ["Sales July 2026"] [out.csv]
//
// Requires in .env: ODOO_URL, ODOO_DB, ODOO_LOGIN, ODOO_API_KEY
// Optional: ODOO_TZ (defaults to the login user's timezone, else UTC)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

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

const TAG = process.argv[2] || "Sales July 2026";
const OUT = path.resolve(process.argv[3] || path.join(ROOT, "data", `sales-${TAG.toLowerCase().replace(/\s+/g, "-")}.csv`));

let rpcId = 0;
async function rpc(service, method, args) {
  const res = await fetch(`${ODOO_URL.replace(/\/$/, "")}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: ++rpcId, params: { service, method, args } }),
  });
  const j = await res.json();
  if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 500));
  return j.result;
}
const uid = await rpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_API_KEY, {}]);
if (!uid) { console.error("Odoo authentication failed."); process.exit(1); }
const exec = (model, method, ...a) => rpc("object", "execute_kw", [ODOO_DB, uid, ODOO_API_KEY, model, method, ...a]);

// ---- timezone: match what the Odoo web UI shows ----
const [me] = await exec("res.users", "read", [[uid]], { fields: ["tz"] });
const TZ = process.env.ODOO_TZ || me?.tz || "UTC";
const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});
// Odoo returns naive UTC datetimes ("2026-07-05 17:35:21").
const localDT = (s) => {
  if (!s) return "";
  const parts = fmt.formatToParts(new Date(s.replace(" ", "T") + "Z"))
    .reduce((a, p) => (a[p.type] = p.value, a), {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
};

// ---- resolve the tag ----
let tagIds = [];
for (const model of ["crm.tag", "account.analytic.tag", "res.partner.category"]) {
  try {
    const found = await exec(model, "search_read", [[["name", "ilike", TAG]]], { fields: ["name"], limit: 50 });
    if (found.length) { tagIds = found.map((t) => t.id); console.log(`Tag "${TAG}" -> ${model} ${JSON.stringify(found.map((t) => t.name))}`); break; }
  } catch { /* model not installed */ }
}
if (!tagIds.length) { console.error(`No tag matching "${TAG}" found.`); process.exit(1); }

// ---- which optional fields exist on sale.order in this database ----
const soFields = await exec("sale.order", "fields_get", [[], ["type", "string"]]);
const has = (f) => Object.prototype.hasOwnProperty.call(soFields, f);
const FIELDS = ["name", "create_date", "date_order", "partner_id", "team_id", "user_id",
                "tag_ids", "amount_total", "currency_id", "state"];
for (const f of ["warehouse_id", "partner_shipping_id"]) if (has(f)) FIELDS.push(f);
const CITY_FIELD = ["city", "partner_city", "x_city"].find(has) || null;
if (CITY_FIELD) FIELDS.push(CITY_FIELD);

// ---- pull the orders (Odoo's "Sales Orders" filter = state in sale/done) ----
const domain = [["tag_ids", "in", tagIds], ["state", "in", ["sale", "done"]]];
const total = await exec("sale.order", "search_count", [domain]);
console.log(`Matching sales orders: ${total}`);
const orders = [];
for (let off = 0; off < total; off += 500) {
  orders.push(...await exec("sale.order", "search_read", [domain], {
    fields: FIELDS, limit: 500, offset: off, order: "user_id, date_order",
  }));
  process.stdout.write(`\r${orders.length}/${total} orders...`);
}
console.log("");

// ---- customer phone + city ----
const pids = [...new Set(orders.flatMap((o) => [o.partner_id?.[0], o.partner_shipping_id?.[0]]).filter(Boolean))];
const partners = {};
const pFields = await exec("res.partner", "fields_get", [[], ["type"]]);
const wanted = ["phone", "mobile", "city"].filter((f) => Object.prototype.hasOwnProperty.call(pFields, f));
for (let i = 0; i < pids.length; i += 500) {
  for (const p of await exec("res.partner", "read", [pids.slice(i, i + 500)], { fields: wanted })) partners[p.id] = p;
}
console.log(`${pids.length} customers fetched.`);

// ---- tag names ----
const allTagIds = [...new Set(orders.flatMap((o) => o.tag_ids || []))];
const tagName = {};
if (allTagIds.length) {
  const tagModel = "crm.tag";
  for (let i = 0; i < allTagIds.length; i += 500) {
    for (const t of await exec(tagModel, "read", [allTagIds.slice(i, i + 500)], { fields: ["name"] })) tagName[t.id] = t.name;
  }
}

// ---- CSV ----
const HEADERS = ["City", "Creation Date", "Customer", "Order Date", "Order Reference", "Sales Team",
                 "Salesperson", "Tags", "Total", "Warehouse", "Currency/Currency Unit", "Customer Phone"];
const esc = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const rows = orders.map((o) => {
  const p = partners[o.partner_id?.[0]] || {};
  const ship = partners[o.partner_shipping_id?.[0]] || {};
  const city = (CITY_FIELD && (Array.isArray(o[CITY_FIELD]) ? o[CITY_FIELD][1] : o[CITY_FIELD])) || p.city || ship.city || "";
  // Odoo stores a leading "+" as text; keep it, but strip stray whitespace.
  const phone = [p.phone, p.mobile].map((x) => (x || "").trim()).filter(Boolean).join(" / ");
  return [
    city,
    localDT(o.create_date),
    o.partner_id?.[1] || "",
    localDT(o.date_order),
    o.name || "",
    o.team_id?.[1] || "",
    o.user_id?.[1] || "",
    (o.tag_ids || []).map((id) => tagName[id] || id).join(" - "),
    Number(o.amount_total || 0).toFixed(2),
    o.warehouse_id?.[1] || "",
    o.currency_id?.[1] || "",
    phone,
  ];
});

fs.mkdirSync(path.dirname(OUT), { recursive: true });
// UTF-8 BOM so Excel renders the Arabic customer/city names correctly.
fs.writeFileSync(OUT, "﻿" + [HEADERS, ...rows].map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n");
const withPhone = rows.filter((r) => r[11]).length;
console.log(`Wrote ${rows.length} rows to ${OUT}`);
console.log(`Phone present for ${withPhone}/${rows.length} customers. Timezone: ${TZ}.`);
