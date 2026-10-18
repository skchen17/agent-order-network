import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { id } from "ethers";
import { createLocalChain } from "../scripts/local-chain.mjs";
import { OrderClient, WEB_EXTRACT_V1 } from "../src/order-client.mjs";
import { OrderIndex } from "../src/order-index.mjs";

async function setup(t) {
  const chain = await createLocalChain(); t.after(() => chain.close());
  const client = new OrderClient(await chain.network.getAddress(), chain.artifact.abi, chain.buyer);
  const calls = { logs: 0, reads: 0 };
  const indexedClient = { signer: chain.buyer, contract: {
    filters: chain.network.filters, interface: chain.network.interface,
    async queryFilter(...args) { calls.logs++; return chain.network.queryFilter(...args); },
    async getOrder(...args) { calls.reads++; return chain.network.getOrder(...args); }
  } };
  const file = path.resolve(".local-demo", "index-tests", randomUUID(), "orders.sqlite");
  const options = { client: indexedClient, deploymentBlock: 0, identity: await chain.network.getAddress(), taskTypes: [WEB_EXTRACT_V1], blockSpan: 2 };
  let index = await OrderIndex.open(file, options);
  t.after(() => index.close());
  const now = await chain.now();
  async function publish(patch = {}) {
    return client.publish({ requestId: id(randomUUID()), taskType: WEB_EXTRACT_V1, description: "Product extraction", inputURI: "fixture://product",
      acceptanceCriteria: "match snapshot", maxPrice: 2_000_000n, acceptUntil: now + 600, latestDeliveryAt: now + 1200,
      reviewPeriod: 60, arbitrationPeriod: 60, evaluator: await chain.evaluator.getAddress(), ...patch });
  }
  return { chain, client, calls, get index() { return index; }, publish,
    async reopen(patch = {}) { index.close(); index = await OrderIndex.open(file, { ...options, ...patch }); return index; } };
}

test("local index scans only supported creation events, persists its cursor and skips unchanged history", async t => {
  const c = await setup(t);
  const first = await c.publish();
  await c.publish({ taskType: id("unrelated.task.v1") });
  await c.publish();
  assert.equal((await c.index.sync()).updated, 2);
  assert.equal(c.calls.reads, 2);
  const before = { ...c.calls };
  assert.equal((await c.index.sync()).updated, 0);
  assert.deepEqual(c.calls, before);
  await c.reopen();
  assert.equal((await c.index.sync()).updated, 0);
  assert.deepEqual(c.calls, before);
  await (await c.chain.network.cancelOrder(first)).wait();
  await c.index.sync();
  assert.equal(c.index.candidates({ now: await c.chain.now() }).length, 1);
});

test("index rebuilds after a reverted branch rather than retaining ghost orders", async t => {
  const c = await setup(t);
  const first = await c.publish(); await c.index.sync();
  const snapshot = await c.chain.rpc("evm_snapshot");
  await c.publish(); await c.index.sync();
  assert.equal(c.index.candidates({ now: await c.chain.now() }).length, 2);
  await c.chain.rpc("evm_revert", [snapshot]);
  const synced = await c.index.sync();
  assert.equal(synced.reset, true);
  assert.deepEqual(c.index.candidates({ now: await c.chain.now() }).map(item => item.orderId), [first]);
});

test("changing local capabilities reconsiders previously excluded orders without rescanning history", async t => {
  const c = await setup(t);
  const first = await c.publish(); await c.index.sync();
  c.index.exclude(first, "unsupported target");
  assert.equal(c.index.candidates({ now: await c.chain.now() }).length, 0);
  const before = { ...c.calls };
  await c.reopen({ capabilityKey: "new-host-allowlist" });
  await c.index.sync();
  assert.deepEqual(c.calls, before);
  assert.equal(c.index.candidates({ now: await c.chain.now() }).length, 1);
});

test("SQLite filters large candidate sets exactly without bigint rounding or starvation by unsupported orders", async t => {
  const c = await setup(t);
  const evaluator = await c.chain.evaluator.getAddress();
  c.index.db.exec("BEGIN");
  const insert = c.index.db.prepare("INSERT INTO orders VALUES (?,?,?,?,?,?,?)");
  for (let i = 1; i <= 5000; i++) {
    const budget = (10n ** 24n + BigInt(i)).toString();
    const order = { id: String(i), evaluator, maxPrice: budget };
    insert.run(String(i), WEB_EXTRACT_V1, "buyer", 0, 2000, budget, JSON.stringify(order));
  }
  c.index.db.exec("COMMIT");
  const top = c.index.candidates({ now: 1000, minBudget: 10n ** 24n + 4990n, allowedEvaluators: [evaluator], limit: 3 });
  assert.deepEqual(top.map(item => item.orderId), [5000n, 4999n, 4998n]);
  for (let i = 5000; i >= 4980; i--) c.index.exclude(i, "unsupported hostname");
  assert.equal(c.index.candidates({ now: 1000, limit: 1 })[0].orderId, 4979n);
  assert.equal(c.index.candidates({ now: 2000 }).length, 0);
});
