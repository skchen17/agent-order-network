import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { saveJSON } from "../src/agent-runtime.mjs";
import { LIVE_PROFILE } from "../src/live-products.mjs";
import { runScenario } from "../scripts/p2p-scenario.mjs";

for (const invalid of [false, true]) {
  test(`independent web collection and buyer refetch: ${invalid ? "wrong price is disputed" : "valid batch is paid"}`, { timeout: 60_000 }, async t => {
    let requests = 0;
    const server = createServer((request, response) => {
      requests++;
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`<meta charset="utf-8"><div class="product_main"><h1>Book ${request.url}</h1><p class="price_color">£12.34</p><p class="availability">In stock</p></div>`);
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    t.after(() => new Promise(resolve => server.close(resolve)));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const file = path.resolve(".local-demo", "live-tests", `${randomUUID()}.json`);
    await saveJSON(file, { profile: LIVE_PROFILE, adapter: "books-to-scrape", urls: [origin + "/one", origin + "/two"], maxAgeSeconds: 600 });
    const result = await runScenario(invalid ? "live-invalid" : "live", { taskFile: file,
      webPolicy: { allowedHosts: [], testFixtureOrigin: origin, maxPages: 2, minIntervalMs: 0, timeoutMs: 2000 } });
    assert.equal(result.status, invalid ? "Refunded" : "Completed");
    assert.equal(result.escrow, "0"); assert.equal(result.credits, "0");
    assert.ok(requests >= (invalid ? 3 : 4), "buyer must make its own HTTP request, not just trust submitted data");
    assert.ok(result.resultURI.startsWith("evmdata:"), "batch uses the public hash-addressed payload bulletin");
    if (invalid) assert.equal(result.validationFailure, "Independent verification mismatch:price");
    else { assert.equal(result.verification.verifiedPages, 2); assert.equal(result.result.items[0].price, "12.34"); }
  });
}

test("one serving supplier processes two separately published real HTTP tasks", { timeout: 60_000 }, async t => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end('<meta charset="utf-8"><script type="application/ld+json">{"@type":"Product","name":"Widget","offers":{"price":"9.50","priceCurrency":"USD","availability":"InStock"}}</script>');
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const file = path.resolve(".local-demo", "live-tests", `${randomUUID()}.json`);
  await saveJSON(file, { profile: LIVE_PROFILE, adapter: "jsonld", urls: [origin + "/product"], maxAgeSeconds: 600 });
  const result = await runScenario("live", { taskFile: file, repeatOrders: 2,
    webPolicy: { allowedHosts: [], testFixtureOrigin: origin, maxPages: 2, minIntervalMs: 0, timeoutMs: 2000 } });
  assert.equal(result.orderCount, "2"); assert.equal(result.processed, 2);
  assert.equal(result.sellerPids.length, 1); assert.equal(result.buyerPids.length, 2);
  assert.equal(result.sellerBalance, "3000000"); assert.equal(result.buyerBalance, "997000000");
  assert.equal(result.credits, "0"); assert.equal(result.escrow, "0");
});
