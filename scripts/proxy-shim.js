// Routes Node's fetch through HTTPS_PROXY when one is set (cloud sandboxes);
// a no-op on machines with direct internet.
export async function applyProxy() {
  if (!process.env.HTTPS_PROXY && !process.env.https_proxy) return;
  try {
    const { setGlobalDispatcher, EnvHttpProxyAgent } = await import("undici");
    setGlobalDispatcher(new EnvHttpProxyAgent());
  } catch { /* undici unavailable — direct fetch */ }
}
