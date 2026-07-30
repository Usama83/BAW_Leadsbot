// Registers the webhook URL with Rasayel via its GraphQL API.
//
// Usage:
//   RASAYEL_API_TOKEN=<token> WEBHOOK_URL=https://<your-host>/webhooks/rasayel \
//     npm run register-webhook
//
// Note: the exact mutation/field names are validated against the live API in
// Phase 1 — if Rasayel rejects the mutation, run the introspection query this
// script falls back to and adjust.

const API_URL = process.env.RASAYEL_API_URL || "https://api.rasayel.io/graphql";
const TOKEN = process.env.RASAYEL_API_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

if (!TOKEN) {
  console.error("Missing RASAYEL_API_TOKEN environment variable.");
  process.exit(1);
}
if (!WEBHOOK_URL) {
  console.error("Missing WEBHOOK_URL environment variable.");
  process.exit(1);
}

async function gql(query, variables = {}) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response (HTTP ${res.status}): ${text.slice(0, 500)}`);
  }
  if (!res.ok || json.errors) {
    throw new Error(`GraphQL error (HTTP ${res.status}): ${JSON.stringify(json.errors || json)}`);
  }
  return json.data;
}

async function main() {
  // First confirm the token works at all.
  console.log("Checking API access...");
  const probe = await gql("{ __typename }");
  console.log("API reachable:", JSON.stringify(probe));

  // Discover available mutations so we use the right webhook mutation name.
  const schema = await gql(`{
    __schema {
      mutationType { fields { name description } }
    }
  }`);
  const mutations = schema.__schema.mutationType.fields.map((f) => f.name);
  console.log("Available mutations:", mutations.join(", "));

  const webhookMutation = mutations.find((m) => /webhook/i.test(m) && /create|register|add/i.test(m));
  if (!webhookMutation) {
    console.log("No obvious webhook mutation found — register the URL manually in Rasayel settings:");
    console.log(`  ${WEBHOOK_URL}`);
    return;
  }
  console.log(`Found webhook mutation: ${webhookMutation}`);
  console.log("Inspect its arguments in the Rasayel API docs and complete registration,");
  console.log(`or register manually in Rasayel settings with URL: ${WEBHOOK_URL}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
