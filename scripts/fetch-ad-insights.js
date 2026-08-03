import { applyProxy } from "./proxy-shim.js";
await applyProxy();
// Downloads lifetime spend/impressions/clicks per ad from the Meta ad
// accounts into data/ad-insights.json, keyed by ad id (currency: account
// currency, EGP for these accounts).

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
const TOKEN = process.env.META_ACCESS_TOKEN;
const V = process.env.GRAPH_API_VERSION || "v23.0";
const ACCOUNTS = (process.env.META_AD_ACCOUNTS || "act_313116676153272,act_862207901570702")
  .split(",").map((s) => s.trim()).filter(Boolean);
if (!TOKEN) { console.error("No META_ACCESS_TOKEN in .env"); process.exit(1); }

const map = {};
for (const acct of ACCOUNTS) {
  console.log(`Fetching insights from ${acct}...`);
  let url =
    `https://graph.facebook.com/${V}/${acct}/insights` +
    `?level=ad&fields=ad_id,spend,impressions,clicks&date_preset=maximum&limit=500` +
    `&access_token=${encodeURIComponent(TOKEN)}`;
  let count = 0;
  while (url) {
    const res = await fetch(url);
    const json = await res.json();
    if (json.error) throw new Error(`Meta API error: ${json.error.message}`);
    for (const row of json.data || []) {
      map[row.ad_id] = {
        spend: parseFloat(row.spend || 0),
        impressions: parseInt(row.impressions || 0, 10),
        clicks: parseInt(row.clicks || 0, 10),
        account: acct,
      };
      count++;
    }
    process.stdout.write(`\r  ${count} ads...`);
    url = json.paging?.next || null;
  }
  console.log(`\r  ${count} ads with insights from ${acct}.`);
}
fs.writeFileSync(path.join(DATA_DIR, "ad-insights.json"), JSON.stringify(map, null, 1));
const totalSpend = Object.values(map).reduce((s, v) => s + v.spend, 0);
console.log(`Done. ${Object.keys(map).length} ads, total lifetime spend ${totalSpend.toFixed(0)} (account currency) -> data/ad-insights.json`);
