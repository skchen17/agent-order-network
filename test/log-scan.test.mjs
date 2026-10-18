import test from "node:test";
import assert from "node:assert/strict";
import { scanEvents } from "../src/log-scan.mjs";

test("log scanner reduces RPC ranges without skipping blocks", async () => {
  const successful = [];
  const contract = { async queryFilter(_filter, from, to) {
    if (to - from + 1 > 2) throw new Error("range limit");
    successful.push([from, to]);
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
  } };
  assert.deepEqual(await scanEvents(contract, null, 1, 7, 8), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(successful, [[1, 2], [3, 4], [5, 6], [7, 7]]);
});

test("log scanner rejects invalid spans and propagates errors on a single block", async () => {
  const contract = { async queryFilter() { throw new Error("RPC unavailable"); } };
  await assert.rejects(() => scanEvents(contract, null, 1, 2, 0), /Invalid/);
  await assert.rejects(() => scanEvents(contract, null, 1, 1), /RPC unavailable/);
});
