import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extractProduct, validateProduct } from "../src/product-profile.mjs";

const html = await readFile(new URL("../fixtures/product.html", import.meta.url), "utf8");
const source = "fixture://product.html";

test("profile extracts the fixture and validates its source-bound values", () => {
  const result = extractProduct(html, source);
  assert.equal(result.price, "49.90");
  assert.equal(result.currency, "USD");
  assert.deepEqual(validateProduct(result, html, source), { ok: true });
});

test("schema-valid wrong prices and snapshot substitutions fail verification", () => {
  const result = extractProduct(html, source);
  assert.deepEqual(validateProduct({ ...result, price: "1.00" }, html, source), { ok: false, reason: "mismatch:price" });
  assert.deepEqual(validateProduct(result, html.replace("49.90", "39.90"), source), { ok: false, reason: "mismatch:snapshotSha256" });
  assert.deepEqual(validateProduct(result, html, "fixture://other.html"), { ok: false, reason: "mismatch:source" });
});

test("malformed output and unsupported HTML are rejected", () => {
  assert.deepEqual(validateProduct({}, html, source), { ok: false, reason: "invalid_shape" });
  assert.throws(() => extractProduct("<html></html>", source), /No supported/);
});
