import { createHash } from "node:crypto";

export function snapshotDigest(html) {
  return createHash("sha256").update(html, "utf8").digest("hex");
}

/// The demo accepts a supplied HTML snapshot, not arbitrary URLs or live browsing.
export function extractProduct(html, source) {
  const match = html.match(/<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/i);
  if (!match) throw new Error("No supported JSON-LD product found");
  const product = JSON.parse(match[1]);
  if (product["@type"] !== "Product" || !product.offers) throw new Error("Unsupported snapshot");
  const result = {
    schema: "web.extract.product.v1", source, snapshotSha256: snapshotDigest(html),
    name: product.name, price: String(product.offers.price), currency: product.offers.priceCurrency,
    availability: product.offers.availability
  };
  if (!validShape(result)) throw new Error("Invalid product fields");
  return result;
}

function validShape(result) {
  return result?.schema === "web.extract.product.v1" &&
    ["source", "snapshotSha256", "name", "price", "currency", "availability"].every(
      field => typeof result[field] === "string" && result[field].length > 0
    ) && /^\d+(\.\d+)?$/.test(result.price) && /^[A-Z]{3}$/.test(result.currency);
}

/// Checks consistency with the supplied snapshot; does not prove live-site truth.
export function validateProduct(result, html, source) {
  if (!validShape(result)) return { ok: false, reason: "invalid_shape" };
  try {
    const expected = extractProduct(html, source);
    for (const field of Object.keys(expected)) {
      if (result[field] !== expected[field]) return { ok: false, reason: `mismatch:${field}` };
    }
    return { ok: true };
  } catch { return { ok: false, reason: "unsupported_snapshot" }; }
}
