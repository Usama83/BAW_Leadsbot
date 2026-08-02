import { applyProxy } from "./proxy-shim.js";
await applyProxy();
// Resolves fb.me short links found in conversation ad fingerprints to their
// real facebook.com URLs (one redirect hop), so leads can be matched to ads
// by story/video id. Results cached in data/fbme-map.json.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const PAYLOAD_LOG = path.join(DATA_DIR, "payloads.jsonl");
const MAP_FILE = path.join(DATA_DIR, "fbme-map.json");
fs.mkdirSync(DATA_DIR, { recursive: true });

const map = fs.existsSync(MAP_FILE) ? JSON.parse(fs.readFileSync(MAP_FILE, "utf8")) : {};

const links = new Set();
if (fs.existsSync(PAYLOAD_LOG)) {
  for (const line of fs.readFileSync(PAYLOAD_LOG, "utf8").split("\n")) {
    for (const m of line.matchAll(/https:\/\/fb\.me\/[A-Za-z0-9]+/g)) links.add(m[0]);
  }
}
const todo = [...links].filter((u) => !(u in map));
console.log(`${links.size} distinct fb.me links, ${todo.length} to resolve...`);

let done = 0;
const CONCURRENCY = 10;
async function worker(queue) {
  while (queue.length) {
    const u = queue.pop();
    try {
      const res = await fetch(u, { redirect: "manual" });
      const loc = res.headers.get("location");
      map[u] = loc || null;
    } catch { map[u] = null; }
    done++;
    if (done % 50 === 0) {
      process.stdout.write(`\r${done}/${todo.length} resolved...`);
      fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 1));
    }
  }
}
const queue = [...todo];
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));
fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 1));
const ok = Object.values(map).filter(Boolean).length;
console.log(`\nDone. ${ok}/${Object.keys(map).length} resolved to real Facebook URLs -> data/fbme-map.json`);
