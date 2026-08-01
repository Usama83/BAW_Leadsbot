// Imports a contacts CSV exported from the Rasayel UI (Contacts -> Export)
// into the bot's data. The export contains the referral columns the public
// API withholds, so this is the road to attributing historical leads.
//
// Usage: node scripts/import-contacts.js [file.csv]
// Without an argument, uses the newest .csv found in the bot folder.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const PAYLOAD_LOG = path.join(DATA_DIR, "payloads.jsonl");
fs.mkdirSync(DATA_DIR, { recursive: true });

// --- find the CSV ---
let file = process.argv[2];
if (!file) {
  const csvs = fs.readdirSync(ROOT)
    .filter((f) => f.toLowerCase().endsWith(".csv"))
    .map((f) => ({ f, t: fs.statSync(path.join(ROOT, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (csvs.length) file = path.join(ROOT, csvs[0].f);
}
if (!file || !fs.existsSync(file)) {
  console.error("No CSV file found.");
  console.error("Export your contacts from Rasayel (Contacts -> Export), save the");
  console.error("file into the bot folder, then run this again.");
  process.exit(1);
}
console.log(`Importing: ${file}`);

// --- tiny CSV parser (handles quotes, commas and newlines in quotes, BOM) ---
function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [], cell = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQ = false;
      } else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== "")) rows.push(row);
  return rows;
}

const rows = parseCSV(fs.readFileSync(file, "utf8"));
if (rows.length < 2) {
  console.error("The CSV appears to be empty.");
  process.exit(1);
}
const headers = rows[0].map((h) => h.trim());
console.log(`Columns found: ${headers.join(" | ")}`);

const findIdx = (re) => headers.findIndex((h) => re.test(h));
const phoneIdx = findIdx(/phone/i);
const nameIdx = findIdx(/display\s*name/i) !== -1 ? findIdx(/display\s*name/i) : findIdx(/name/i);
const createdIdx = findIdx(/created/i);
if (phoneIdx === -1) {
  console.error("Could not find a phone column — send the column list above to the Claude chat.");
  process.exit(1);
}

// --- dedupe/upgrade map, same policy as fetch-history ---
function hasReferralData(c) {
  return (c.contactFields || []).some((f) => /referral/i.test(f.name) && f.value != null && f.value !== "");
}
const known = new Map(); // phone -> already has referral
if (fs.existsSync(PAYLOAD_LOG)) {
  for (const line of fs.readFileSync(PAYLOAD_LOG, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const c = JSON.parse(line)?.body?.data?.contact;
      const phone = c?.identifiers?.find?.((i) => i.category === "PHONE")?.sourceId || c?.phone;
      if (phone) known.set(String(phone), known.get(String(phone)) === true || hasReferralData(c));
    } catch { /* skip */ }
  }
}

let imported = 0, withAd = 0, skipped = 0;
for (const row of rows.slice(1)) {
  const phone = String(row[phoneIdx] || "").replace(/[^\d+]/g, "");
  if (!phone) { skipped++; continue; }
  const contactFields = headers
    .map((h, i) => ({ name: h, value: (row[i] || "").trim() }))
    .filter((f) => f.value !== "" && f.value !== "-");
  const contact = {
    __typename: "ChannelUser",
    displayName: nameIdx !== -1 ? row[nameIdx] : null,
    identifiers: [{ sourceId: phone, category: "PHONE" }],
    contactFields,
    importedFrom: path.basename(file),
  };
  const withRef = hasReferralData(contact);
  const prev = known.get(phone);
  if (prev !== undefined && (prev === true || !withRef)) { skipped++; continue; }
  known.set(phone, withRef || prev === true);

  let when = new Date();
  if (createdIdx !== -1 && row[createdIdx]) {
    const d = new Date(row[createdIdx]);
    if (!isNaN(d)) when = d;
  }
  fs.appendFileSync(
    PAYLOAD_LOG,
    JSON.stringify({
      received_at: when.toISOString(),
      path: "/csv-import",
      headers: { "x-source": "import-contacts" },
      body: { event: "history.sync", data: { contact } },
    }) + "\n"
  );
  imported++;
  if (withRef && contactFields.some((f) => /referral.*type/i.test(f.name) && /^ad$/i.test(f.value))) withAd++;
}

console.log(`Done. Imported ${imported} contacts (${withAd} marked as coming from an ad); ${skipped} already known/empty.`);
console.log("Start the bot and open http://localhost:3000/dashboard — ad leads show with their Meta ad names.");
