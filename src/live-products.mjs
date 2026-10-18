import { loadBuffer } from "cheerio";
import { createHash } from "node:crypto";
import { id } from "ethers";
import { checkTarget } from "./safe-web.mjs";

export const LIVE_PROFILE = "web.fetch.products.v1";
export const WEB_FETCH_PRODUCTS_V1 = id(LIVE_PROFILE);

export function validateManifest(value, policy) {
  if (value?.profile !== LIVE_PROFILE || !["jsonld", "books-to-scrape"].includes(value.adapter) ||
      !Array.isArray(value.urls) || !value.urls.length || value.urls.length > (policy.maxPages ?? 10) ||
      !Number.isInteger(value.maxAgeSeconds) || value.maxAgeSeconds < 60 || value.maxAgeSeconds > 3600) {
    throw new Error("Unsupported live task manifest");
  }
  const urls = value.urls.map(url => checkTarget(url, policy).url.href);
  if (new Set(urls).size !== urls.length || urls.some((url, i) => url !== value.urls[i])) throw new Error("Task URLs must be canonical and unique");
  if (value.adapter === "books-to-scrape" && urls.some(url => {
    const parsed = new URL(url);
    return parsed.hostname !== "books.toscrape.com" && parsed.origin !== policy.testFixtureOrigin;
  })) throw new Error("Books adapter only supports the configured demonstration site");
  return value;
}

export function parseLiveProduct(bytes, adapter) {
  const $ = loadBuffer(Buffer.from(bytes));
  let fields;
  if (adapter === "books-to-scrape") {
    const name = $(".product_main h1").first().text().trim();
    const price = $(".product_main .price_color").first().text().trim();
    const availability = $(".product_main .availability").first().text().replace(/\s+/g, " ").trim();
    const match = /^£(\d+(?:\.\d+)?)$/.exec(price);
    if (!match) throw new Error("Unsupported book price format");
    fields = { name, price: match[1], currency: "GBP", availability };
  } else {
    const products = [];
    function walk(value, depth = 0) {
      if (!value || typeof value !== "object" || depth > 20) return;
      if (Array.isArray(value)) { value.forEach(item => walk(item, depth + 1)); return; }
      const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
      if (types.includes("Product")) products.push(value);
      if (value["@graph"]) walk(value["@graph"], depth + 1);
    }
    $("script[type='application/ld+json']").each((_, element) => {
      try { walk(JSON.parse($(element).text())); } catch { /* unrelated malformed JSON-LD */ }
    });
    if (products.length !== 1) throw new Error("Expected exactly one JSON-LD Product");
    const product = products[0];
    if (Array.isArray(product.offers) && product.offers.length !== 1) throw new Error("Ambiguous Product offers are not supported");
    const offer = Array.isArray(product.offers) ? product.offers[0] : product.offers;
    if (!offer) throw new Error("Missing Product offer");
    fields = { name: product.name, price: String(offer.price), currency: offer.priceCurrency, availability: offer.availability };
  }
  if (!["name", "price", "currency", "availability"].every(key => typeof fields[key] === "string" && fields[key].length > 0 && fields[key].length <= 500) ||
      !/^\d+(\.\d+)?$/.test(fields.price) || !/^[A-Z]{3}$/.test(fields.currency)) throw new Error("Invalid extracted product fields");
  return fields;
}

export async function collectProducts(manifest, policy, fetchPage) {
  validateManifest(manifest, policy);
  const items = [];
  for (const source of manifest.urls) {
    const page = await fetchPage(source);
    items.push({ source, finalURL: page.finalURL, fetchedAt: page.fetchedAt,
      snapshotSha256: createHash("sha256").update(page.bytes).digest("hex"),
      ...parseLiveProduct(page.bytes, manifest.adapter) });
  }
  return { schema: LIVE_PROFILE, collectedAt: new Date().toISOString(), items };
}

export async function verifyProducts(result, manifest, policy, fetchPage, now = Date.now()) {
  try {
    validateManifest(manifest, policy);
    if (result?.schema !== LIVE_PROFILE || !Array.isArray(result.items) || result.items.length !== manifest.urls.length) throw new Error("Wrong result coverage");
    const seen = new Set();
    for (const item of result.items) {
      if (!manifest.urls.includes(item.source) || seen.has(item.source)) throw new Error("Unexpected or duplicate source");
      seen.add(item.source);
      const timestamp = Date.parse(item.fetchedAt);
      if (!Number.isFinite(timestamp) || now - timestamp > manifest.maxAgeSeconds * 1000 || timestamp > now + 30_000) throw new Error("Stale or invalid timestamp");
      if (!/^[0-9a-f]{64}$/.test(item.snapshotSha256)) throw new Error("Invalid snapshot evidence");
      const independent = await fetchPage(item.source);
      const expected = parseLiveProduct(independent.bytes, manifest.adapter);
      for (const key of ["name", "price", "currency", "availability"]) if (item[key] !== expected[key]) throw new Error(`Independent verification mismatch:${key}`);
      if (item.finalURL !== independent.finalURL) throw new Error("Final URL changed");
    }
    return { ok: true, verifiedPages: seen.size, method: "independent-refetch" };
  } catch (error) { return { ok: false, reason: error.message }; }
}
