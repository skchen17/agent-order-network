import test from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { callAgentTool, runAgentTool } from "../src/agent-tools.mjs";
import { readJSON } from "../src/agent-runtime.mjs";
import { runSkillScenario } from "../scripts/skill-scenario.mjs";

test("host agent tools assemble drafts without a model, wallet, or network and report ambiguity", async () => {
  const result = await callAgentTool("draft_order", { sourceText: "帮我做调研，不要付费，但预算和期限待定。", terms: { title: "调研", questions: ["预算和期限？"] } });
  assert.equal(result.draft.generator, "host-agent");
  assert.equal(result.published, false);
  assert.ok(result.missing.includes("unresolved questions"));
  await assert.rejects(callAgentTool("prepare_action", { action: "publish", draft: result.draft }), /config/);
  await assert.rejects(callAgentTool("execute_action", { proposal: {} }), /--approval/);
  await assert.rejects(callAgentTool("get_order", { orderId: "1", privateKey: "do not accept credentials in tool payload" }), /Unknown input/);
});

test("JSON CLI consumes stdin and emits exactly one structured success or error", async () => {
  let output = "";
  const sink = new Writable({ write(chunk, encoding, callback) { output += chunk; callback(); } });
  assert.equal(await runAgentTool(["draft_order", "--input", "-"], { input: Readable.from([JSON.stringify({ sourceText: "需求", terms: {} })]), output: sink }), 0);
  assert.equal(JSON.parse(output).result.draft.sourceText, "需求");
  output = "";
  assert.equal(await runAgentTool(["get_order", "--input", "-"], { input: Readable.from(["{bad json"]), output: sink }), 1);
  assert.equal(JSON.parse(output).ok, false);
});

test("Skill scripts perform keyless discovery and authorized P2P trades without clients or model services", { timeout: 60000 }, async () => {
  const result = await runSkillScenario();
  assert.equal(result.status, 4); assert.equal(result.cancelledSecondOrder, 5);
  assert.equal(result.sellerBalance, "1500000"); assert.equal(result.escrow, "0"); assert.equal(result.credits, "0");
  assert.equal(result.keylessDiscovery, true); assert.deepEqual(result.foundOrders, ["1", "2"]);
  assert.equal(result.fullTermsPreserved, true); assert.equal(result.deliveryVerified, true);
  assert.equal(result.unifiedReceipts, true); assert.equal(result.durableWake, true); assert.equal(result.recoveryReadOnly, true);
  assert.ok(result.failedWakeRetained > 0); assert.equal(result.acceptedWakeEvents, result.failedWakeRetained);
  assert.equal(result.interactiveClients, 0); assert.equal(result.localModels, 0); assert.equal(result.permanentAppServers, 0);
  // Windows may reuse an exited process PID in a later invocation.
  assert.equal(result.toolPids.length, result.toolCalls);
  assert.ok(new Set(result.toolPids).size > 1);
  const publicConfig = await readJSON(result.directory + "/deployment.json"); assert.equal(publicConfig.privateKey, undefined);
});
