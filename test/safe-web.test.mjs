import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { checkTarget, publicAddress, createWebFetcher } from "../src/safe-web.mjs";

test("web policy rejects unapproved hosts, credentials, nonstandard ports and private IPs", () => {
  const policy = { allowedHosts: ["shop.example"] };
  assert.throws(() => checkTarget("https://evil.example/", policy), /allowlist/);
  assert.throws(() => checkTarget("https://user:secret@shop.example/", policy), /Credentials/);
  assert.throws(() => checkTarget("https://shop.example:8080/", policy), /standard HTTPS/);
  assert.throws(() => checkTarget("http://shop.example/", policy), /standard HTTPS/);
  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.1", "::1", "::ffff:127.0.0.1", "fc00::1"]) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress("1.1.1.1"), true);
});

test("DNS is checked and pinned; mixed or rebound private destinations are rejected", async () => {
  let requested;
  const fetch = createWebFetcher({ allowedHosts: ["shop.example"], minIntervalMs: 0 }, {
    resolveDNS: async () => [{ address: "1.1.1.1", family: 4 }],
    request: async (_url, addresses) => { requested = addresses; return { bytes: Buffer.from("<h1>ok</h1>") }; }
  });
  assert.equal((await fetch("https://shop.example/")).finalURL, "https://shop.example/");
  assert.equal(requested[0].address, "1.1.1.1");
  const blocked = createWebFetcher({ allowedHosts: ["shop.example"], minIntervalMs: 0 }, {
    resolveDNS: async () => [{ address: "1.1.1.1", family: 4 }, { address: "127.0.0.1", family: 4 }],
    request: async () => { throw new Error("must not connect"); }
  });
  await assert.rejects(() => blocked("https://shop.example/"), /Non-public/);
});

test("redirect targets are rechecked against the host policy", async () => {
  const fetch = createWebFetcher({ allowedHosts: ["shop.example"], minIntervalMs: 0 }, {
    resolveDNS: async () => [{ address: "1.1.1.1", family: 4 }],
    request: async () => ({ redirect: "http://169.254.169.254/latest/meta-data" })
  });
  await assert.rejects(() => fetch("https://shop.example/"), /standard HTTPS/);
});

test("bounded HTTP fetch works for an explicitly configured test origin and rejects oversized responses", async t => {
  const server = createServer((_request, response) => { response.writeHead(200, { "Content-Type": "text/html" }); response.end("<h1>Product</h1>"); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const fetch = createWebFetcher({ testFixtureOrigin: origin, minIntervalMs: 0, maxBytes: 100 });
  assert.ok((await fetch(origin + "/product")).bytes.includes("Product"));
  const small = createWebFetcher({ testFixtureOrigin: origin, minIntervalMs: 0, maxBytes: 2 });
  await assert.rejects(() => small(origin + "/product"), /maximum response size/);
  await assert.rejects(() => fetch("http://127.0.0.1:1/"), /standard HTTPS/);
});
