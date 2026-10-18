import test from "node:test";
import assert from "node:assert/strict";
import { runScenario } from "../scripts/p2p-scenario.mjs";
import { decodeInline } from "../src/inline-payload.mjs";

for (const scenario of ["success", "restart", "nondelivery", "invalid-result"]) {
  test(`independent buyer and seller: ${scenario}`, { timeout: 60_000 }, async () => {
    const result = await runScenario(scenario);
    const paid = scenario === "success" || scenario === "restart";
    assert.equal(result.status, paid ? "Completed" : "Refunded");
    assert.equal(result.sellerStatus, result.status);
    assert.equal(result.orderCount, "1", "restarts must not create duplicate orders");
    assert.equal(result.quoteCount, 1, "restarts must not publish duplicate quotes");
    assert.equal(result.escrow, "0");
    assert.equal(result.credits, "0");
    assert.equal(result.buyerBalance, paid ? "998500000" : "1000000000");
    assert.equal(result.sellerBalance, paid ? "1500000" : "0");
    assert.equal(result.relayServers, 0);
    const pids = [result.chainPid, ...result.buyerPids, ...result.sellerPids];
    assert.equal(new Set(pids).size, pids.length, "roles and restarted agents use separate OS processes");
    assert.ok(decodeInline(result.inputURI, "text/html").includes("Product"));
    if (paid) assert.equal(result.result.price, "49.90");
    if (scenario === "restart") {
      assert.equal(result.buyerPids.length, 2);
      assert.equal(result.sellerPids.length, 2);
    }
    if (scenario === "nondelivery") assert.equal(result.reason, "nondelivery");
    if (scenario === "invalid-result") {
      assert.equal(result.reason, "evaluator_timeout");
      assert.equal(result.validationFailure, "mismatch:price");
    }
  });
}
