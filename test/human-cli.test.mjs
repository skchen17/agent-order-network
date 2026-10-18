import test from "node:test";
import assert from "node:assert/strict";
import { runHumanScenario } from "../scripts/human-scenario.mjs";
test("independent human-driven clients discover, quote, cancel, fund, approve and withdraw", { timeout: 60000 }, async () => {
  const result = await runHumanScenario();
  assert.equal(new Set([result.chainPid, result.buyerPid, result.sellerPid]).size, 3);
  assert.equal(result.status, 4);
  assert.equal(result.sellerBalance, "1500000");
  assert.equal(result.escrow, "0"); assert.equal(result.credits, "0");
  assert.equal(result.relayServers, 0);
  assert.deepEqual(result.testedCancellations, ["publish", "fund"]);
});
