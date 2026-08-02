import { applyProxy } from "./proxy-shim.js";
await applyProxy();
// Downloads the id -> name map of all ads in the Meta ad accounts, so the
// dashboard can show real ad names next to leads instead of numeric ids.
//
// Reads META_ACCESS_TOKEN (and optionally META_AD_ACCOUNTS, GRAPH_API_VERSION)
// from .env. Writes data/ad-names.json.

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

if (!TOKEN) {
  console.error("No META_ACCESS_TOKEN in .env. Add a line like:");
  console.error("  META_ACCESS_TOKEN=EAA...(your token)");
  process.exit(1);
}

async function graphGet(url) {
  const res = await fetch(url);
  const json = await res.json().catch(() => null);
  if (!json) throw new Error(`Non-JSON response (HTTP ${res.status})`);
  if (json.error) {
    throw new Error(`Meta API error: ${json.error.message} (code ${json.error.code})`);
  }
  return json;
}

async function main() {
  const map = {};
  for (const acct of ACCOUNTS) {
    console.log(`Fetching ads from ${acct}...`);
    let url =
      `https://graph.facebook.com/${V}/${acct}/ads` +
      `?fields=id,name,status,campaign{name},adset{name},creative.thumbnail_width(320).thumbnail_height(320){effective_object_story_id,instagram_permalink_url,thumbnail_url,image_url,body}` +
      `&limit=50&access_token=${encodeURIComponent(TOKEN)}`;
    let count = 0;
    while (url) {
      const page = await graphGet(url);
      for (const ad of page.data || []) {
        map[ad.id] = {
          name: ad.name,
          campaign: ad.campaign?.name || null,
          adset: ad.adset?.name || null,
          status: ad.status,
          account: acct,
          storyId: ad.creative?.effective_object_story_id || null,
          instagramUrl: ad.creative?.instagram_permalink_url || null,
          thumbnailUrl: ad.creative?.thumbnail_url || null,
          imageUrl: ad.creative?.image_url || null,
          body: ad.creative?.body ? String(ad.creative.body).slice(0, 500) : null,
        };
        count++;
      }
      process.stdout.write(`\r  ${count} ads...`);
      url = page.paging?.next || null;
    }
    console.log(`\r  ${count} ads from ${acct}.`);
  }
  const out = path.join(DATA_DIR, "ad-names.json");
  fs.writeFileSync(out, JSON.stringify(map, null, 2));
  console.log(`Done. ${Object.keys(map).length} ads saved to data/ad-names.json`);
  console.log("The dashboard will now show ad names instead of id numbers.");
}

main().catch((err) => {
  console.error("Failed:", err.message);
  if (/expired|invalid|OAuth/i.test(err.message)) {
    console.error("The Meta access token may have expired (it lasts ~60 days).");
    console.error("Generate a new one and update the META_ACCESS_TOKEN line in .env.");
  }
  process.exit(1);
});
