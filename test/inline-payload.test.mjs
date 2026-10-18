import test from "node:test";
import assert from "node:assert/strict";
import { encodeInline, decodeInline } from "../src/inline-payload.mjs";

test("inline transport round trips public UTF-8 text", () => {
  const value = "公开测试 input";
  assert.equal(decodeInline(encodeInline(value, "text/html"), "text/html"), value);
});

test("inline transport rejects external URLs, malformed bytes and oversized payloads", () => {
  assert.throws(() => decodeInline("http://127.0.0.1/private", "application/json"), /external URLs/);
  assert.throws(() => decodeInline("data:application/json;base64,!!!", "application/json"), /base64/);
  assert.throws(() => decodeInline("data:text/html;base64,/w==", "text/html"));
  assert.throws(() => encodeInline("a".repeat(512), "application/json"), /exceeds/);
});
