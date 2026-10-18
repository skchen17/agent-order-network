import { lookup } from "node:dns/promises";
import https from "node:https";
import http from "node:http";
import ipaddr from "ipaddr.js";

export function checkTarget(input, policy) {
  const url = new URL(input);
  if (url.username || url.password || url.hash) throw new Error("Credentials and fragments are not accepted in task URLs");
  const isFixture = policy.testFixtureOrigin && url.origin === policy.testFixtureOrigin;
  if (!isFixture && (url.protocol !== "https:" || url.port)) throw new Error("Only standard HTTPS public URLs are supported");
  if (!isFixture && !policy.allowedHosts?.includes(url.hostname.toLowerCase())) throw new Error("Target hostname is outside the configured allowlist");
  if (isFixture && !["http:", "https:"].includes(url.protocol)) throw new Error("Invalid fixture protocol");
  return { url, isFixture };
}

export function publicAddress(address) {
  try { return ipaddr.process(address).range() === "unicast"; } catch { return false; }
}

function requestPage(url, addresses, { timeoutMs, maxBytes, signal }) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(url, {
      method: "GET", signal, autoSelectFamily: false,
      headers: { "User-Agent": "AgentOrderNetwork/0.2 (public product extraction pilot)", Accept: "text/html", "Accept-Encoding": "identity" },
      // Pin the checked DNS answer for this connection; don't perform a second resolution.
      lookup: (_host, options, callback) => options.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family)
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.destroy();
        resolve({ redirect: response.headers.location });
        return;
      }
      if (response.statusCode !== 200) { response.destroy(); reject(new Error(`HTTP status ${response.statusCode}`)); return; }
      if (!/^text\/html(?:;|$)/i.test(response.headers["content-type"] ?? "")) {
        response.destroy(); reject(new Error("Expected HTML content")); return;
      }
      if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") {
        response.destroy(); reject(new Error("Compressed response not accepted")); return;
      }
      let size = 0;
      const parts = [];
      response.on("data", chunk => {
        size += chunk.length;
        if (size > maxBytes) response.destroy(new Error("Page exceeds maximum response size"));
        else parts.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => resolve({ bytes: Buffer.concat(parts) }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("Page request timed out")));
    req.on("error", reject);
    req.end();
  });
}

export function createWebFetcher(policy, { resolveDNS = lookup, request = requestPage } = {}) {
  const lastRequest = new Map();
  return async function fetchPage(input) {
    const controller = new AbortController();
    const timeoutMs = policy.timeoutMs ?? 15_000;
    const timer = setTimeout(() => controller.abort(new Error("Total fetch deadline exceeded")), timeoutMs);
    try {
      let target = input;
      for (let redirects = 0; redirects <= 3; redirects++) {
        const { url, isFixture } = checkTarget(target, policy);
        const wait = (lastRequest.get(url.origin) ?? 0) + (policy.minIntervalMs ?? 1000) - Date.now();
        if (wait > 0) await new Promise((resolve, reject) => {
          const delay = setTimeout(resolve, wait);
          controller.signal.addEventListener("abort", () => { clearTimeout(delay); reject(controller.signal.reason); }, { once: true });
        });
        controller.signal.throwIfAborted();
        const addresses = await Promise.race([
          resolveDNS(url.hostname, { all: true }),
          new Promise((_, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true }))
        ]);
        if (!addresses.length || (!isFixture && addresses.some(record => !publicAddress(record.address)))) throw new Error("Non-public DNS destination rejected");
        lastRequest.set(url.origin, Date.now());
        const response = await request(url, addresses.sort((a, b) => a.family - b.family), {
          timeoutMs, maxBytes: policy.maxBytes ?? 1_048_576, signal: controller.signal
        });
        if (response.redirect) { target = new URL(response.redirect, url).href; continue; }
        return { bytes: response.bytes, finalURL: url.href, fetchedAt: new Date().toISOString() };
      }
      throw new Error("Too many redirects");
    } finally { clearTimeout(timer); }
  };
}
