import test from "node:test";
import assert from "node:assert/strict";
import { collectProducts, verifyProducts, validateManifest, parseLiveProduct, LIVE_PROFILE } from "../src/live-products.mjs";

const source = "https://shop.example/product";
const policy = { allowedHosts: ["shop.example"], maxPages: 2 };
const manifest = { profile: LIVE_PROFILE, adapter: "jsonld", urls: [source], maxAgeSeconds: 600 };
const html = Buffer.from(`<script type="application/ld+json">{"@graph":[{"@type":"Product","name":"Keyboard","offers":{"price":"49.90","priceCurrency":"USD","availability":"InStock"}}]}</script>`);
const fetch = async url => ({ bytes: html, finalURL: url, fetchedAt: new Date().toISOString() });

test("live JSON-LD task collects source evidence and independently verifies fields", async () => {
  const result = await collectProducts(manifest, policy, fetch);
  assert.equal(result.items[0].price, "49.90");
  assert.match(result.items[0].snapshotSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(await verifyProducts(result, manifest, policy, fetch), { ok: true, verifiedPages: 1, method: "independent-refetch" });
});

test("independent refetch rejects schema-valid wrong prices, stale data and duplicate sources", async () => {
  const result = await collectProducts(manifest, policy, fetch);
  const wrong = structuredClone(result); wrong.items[0].price = "1.00";
  assert.equal((await verifyProducts(wrong, manifest, policy, fetch)).reason, "Independent verification mismatch:price");
  const stale = structuredClone(result); stale.items[0].fetchedAt = "2000-01-01T00:00:00Z";
  assert.match((await verifyProducts(stale, manifest, policy, fetch)).reason, /Stale/);
  const duplicate = structuredClone(result); duplicate.items.push(duplicate.items[0]);
  assert.equal((await verifyProducts(duplicate, manifest, policy, fetch)).ok, false);
});

test("manifest enforces domains, page count, canonical URLs and supported adapters", () => {
  assert.throws(() => validateManifest({ ...manifest, urls: [source, source] }, policy), /unique/);
  assert.throws(() => validateManifest({ ...manifest, urls: ["https://evil.example/"] }, policy), /allowlist/);
  assert.throws(() => validateManifest({ ...manifest, adapter: "run-shell" }, policy), /Unsupported/);
  assert.throws(() => parseLiveProduct(Buffer.from("<h1>No product</h1>"), "jsonld"), /exactly one/);
});

test("books adapter extracts price currency and availability from a product detail page", () => {
  const product = parseLiveProduct(Buffer.from('<meta charset="utf-8"><div class="product_main"><h1>Book</h1><p class="price_color">£12.34</p><p class="availability"> In stock (2 available) </p></div>'), "books-to-scrape");
  assert.deepEqual(product, { name: "Book", price: "12.34", currency: "GBP", availability: "In stock (2 available)" });
});
