const LIMIT = 512;
const TYPES = new Set(["text/html", "application/json"]);

// Small public demo payloads only. Never fetches an arbitrary URL or reads a file.
export function encodeInline(text, mediaType) {
  if (!TYPES.has(mediaType)) throw new Error("Unsupported inline media type");
  const uri = `data:${mediaType};base64,${Buffer.from(text, "utf8").toString("base64")}`;
  if (Buffer.byteLength(uri, "utf8") > LIMIT) throw new Error("Inline payload exceeds on-chain URI limit");
  return uri;
}

export function decodeInline(uri, mediaType) {
  if (typeof uri !== "string" || Buffer.byteLength(uri, "utf8") > LIMIT || !TYPES.has(mediaType)) {
    throw new Error("Invalid inline payload");
  }
  const prefix = `data:${mediaType};base64,`;
  if (!uri.startsWith(prefix)) throw new Error("Expected inline data; external URLs are not supported");
  const encoded = uri.slice(prefix.length);
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw new Error("Invalid base64 encoding");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
