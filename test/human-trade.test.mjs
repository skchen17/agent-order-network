import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ContractFactory } from "ethers";
import { createLocalChain, loadArtifact } from "../scripts/local-chain.mjs";
import { readJSON } from "../src/agent-runtime.mjs";
import { OrderClient } from "../src/order-client.mjs";
import { PayloadClient } from "../src/payload-client.mjs";
import { TradeSession } from "../src/trade-session.mjs";
import { OrderIndex } from "../src/order-index.mjs";
import { DEMAND_TYPE, createDraft, digest } from "../src/demand.mjs";
import { HostInbox } from "../src/host-inbox.mjs";

async function fixture(t) {
  const c = await createLocalChain(); t.after(() => c.close());
  const artifact = await loadArtifact("OrderPayloads");
  const payload = await new ContractFactory(artifact.abi, artifact.bytecode, c.buyer).deploy(); await payload.waitForDeployment();
  const directory = path.resolve(".local-demo", "human-tests", randomUUID());
  async function session(role, signer) {
    const config = { role, chainId: 31337, deploymentId: directory, deploymentBlock: 0,
      contract: await c.network.getAddress(), paymentToken: await c.token.getAddress(),
      evaluator: await c.evaluator.getAddress(), address: await signer.getAddress() };
    const agent = { config, stateFile: path.join(directory, config.address, "state.json"), now: c.now,
      client: new OrderClient(config.contract, c.artifact.abi, signer), token: c.token.connect(signer),
      payloads: new PayloadClient({ address: await payload.getAddress(), abi: artifact.abi, signer, chainId: 31337, fromBlock: 0 }) };
    return new TradeSession(agent);
  }
  const buyer = await session("buyer", c.buyer), seller = await session("seller", c.seller);
  const second = await session("seller", c.secondSeller);
  const example = await readJSON(new URL("../examples/research-demand.json", import.meta.url));
  const draft = createDraft(example.sourceText, Object.fromEntries(Object.entries(example).filter(([key]) => !["profile", "draftId", "sourceText", "createdAt", "generator"].includes(key))));
  return { ...c, buyerSession: buyer, sellerSession: seller, secondSession: second, draft,
    async publish() { const p = await buyer.preparePublish(draft); return buyer.execute(p, p.approval); } };
}

test("human confirmation gates publication and binds exact terms, wallet and expiration", async t => {
  const c = await fixture(t), buyer = c.buyerSession;
  const p = await buyer.preparePublish(c.draft);
  assert.equal(await c.network.orderCount(), 0n);
  assert.equal(await c.network.totalEscrowed(), 0n);
  await assert.rejects(buyer.execute(p), /confirmation/);
  const tampered = structuredClone(p); tampered.ticket.data.draft.budget = "20";
  await assert.rejects(buyer.execute(tampered, p.approval), /confirmation/);
  await assert.rejects(c.sellerSession.execute(p, p.approval), /different wallet/);
  const expired = structuredClone(p); expired.ticket.expiresAt = Date.now() - 1; expired.approval = digest(expired.ticket);
  await assert.rejects(buyer.execute(expired, expired.approval), /expired/);
  const result = await buyer.execute(p, p.approval);
  assert.equal(result.status, "Open");
  assert.equal(result.demand.sourceText, c.draft.sourceText);
  assert.deepEqual(result.demand.conditions, c.draft.conditions);
  assert.equal(await c.network.totalEscrowed(), 0n);
  assert.equal((await buyer.execute(p, p.approval)).replayed, true);
  assert.equal(await c.network.orderCount(), 1n);
});

test("buyer chooses between independent supplier quotes and explicitly confirms payment and delivery", async t => {
  const c = await fixture(t), buyer = c.buyerSession, seller = c.sellerSession;
  const published = await c.publish();
  const capability = await readJSON(new URL("../examples/research-capabilities.json", import.meta.url));
  const matches = await seller.match(capability);
  assert.equal(matches.scanned, 1); assert.equal(matches.eligible, 1);
  assert.equal(matches.results[0].orderId, published.orderId);
  assert.equal(matches.policy.advertising, false);
  for (const [session, price] of [[seller, "1.5"], [c.secondSession, "1.8"]]) {
    const proposal = await session.prepareQuote(published.orderId, { price, hours: 4 });
    await session.execute(proposal, proposal.approval);
  }
  assert.equal(await c.network.totalEscrowed(), 0n);
  const quotes = await buyer.quotes(published.orderId); assert.equal(quotes.quotes.length, 2);
  // Choosing a provider is a user decision; no automatic cheapest-provider selection.
  const selected = quotes.quotes.find(q => q.amount === "1.8");
  const fund = await buyer.prepareFund(published.orderId, selected.digest);
  assert.equal(await c.network.totalEscrowed(), 0n);
  await assert.rejects(buyer.execute(fund), /confirmation/);
  await buyer.execute(fund, fund.approval);
  assert.equal((await c.network.getOrder(published.orderId)).provider, await c.secondSeller.getAddress());
  const selectedSeller = c.secondSession;
  const delivery = await selectedSeller.prepareDelivery(published.orderId, "报告交付：来源清单见正文。未知性能数据明确标注未知。此文本不会被执行。");
  await selectedSeller.execute(delivery, delivery.approval);
  assert.equal(await c.token.balanceOf(await c.secondSeller.getAddress()), 0n);
  const review = await buyer.prepareReview(published.orderId, "approve");
  assert.match(review.ticket.data.result.text, /未知/);
  await assert.rejects(buyer.execute(review), /confirmation/);
  await buyer.execute(review, review.approval);
  const withdraw = await selectedSeller.prepareAction("withdraw", undefined, { withdrawalScope: "orders", orderIds: [published.orderId] }); await selectedSeller.execute(withdraw, withdraw.approval);
  assert.equal(await c.token.balanceOf(await c.secondSeller.getAddress()), 1800000n);
  assert.equal(await c.network.totalEscrowed(), 0n); assert.equal(await c.network.totalCredits(), 0n);
});

test("a changed order invalidates a reviewed funding proposal before token approval", async t => {
  const c = await fixture(t), buyer = c.buyerSession, seller = c.sellerSession;
  const published = await c.publish();
  const quote = await seller.prepareQuote(published.orderId, { price: "1.5", hours: 3 }); await seller.execute(quote, quote.approval);
  const funding = await buyer.prepareFund(published.orderId, (await buyer.quotes(published.orderId)).quotes[0].digest);
  await (await c.network.cancelOrder(published.orderId)).wait();
  await assert.rejects(buyer.execute(funding, funding.approval), /Order changed/);
  assert.equal(await c.token.allowance(await c.buyer.getAddress(), await c.network.getAddress()), 0n);
});

test("funding failure clears the unused exact-amount allowance and never silently retries payment", async t => {
  const c = await fixture(t), buyer = c.buyerSession, seller = c.sellerSession;
  const published = await c.publish();
  const quote = await seller.prepareQuote(published.orderId, { price: "1.5", hours: 3 }); await seller.execute(quote, quote.approval);
  const funding = await buyer.prepareFund(published.orderId, (await buyer.quotes(published.orderId)).quotes[0].digest);
  let attempts = 0;
  buyer.agent.client.accept = async () => { attempts++; throw new Error("simulated network error"); };
  await assert.rejects(buyer.execute(funding, funding.approval), /未用授权已清零/);
  assert.equal(attempts, 1);
  assert.equal(await c.token.allowance(await c.buyer.getAddress(), await c.network.getAddress()), 0n);
  assert.equal(await c.network.totalEscrowed(), 0n);
});

test("matching checks all pages before ranking instead of hiding small budgets after the first 100", async t => {
  const c = await fixture(t), seller = c.sellerSession;
  const a = seller.agent;
  const index = await OrderIndex.open(a.stateFile + ".demands.sqlite", { client: a.client, deploymentBlock: 0,
    identity: a.config.deploymentId, taskTypes: [DEMAND_TYPE] });
  await index.sync();
  index.db.exec("CREATE TABLE demand_documents(uri TEXT PRIMARY KEY, document TEXT NOT NULL)");
  const now = await c.now();
  for (let i = 1; i <= 231; i++) {
    const demand = { ...c.draft, skills: i === 231 ? ["research", "chinese"] : ["unrelated"], budget: i === 231 ? "2" : "200" };
    const order = { id: String(i), taskType: DEMAND_TYPE, buyer: await c.buyer.getAddress(), status: 0,
      acceptUntil: now + 3600, latestDeliveryAt: now + 86400, maxPrice: i === 231 ? "2000000" : "200000000", inputURI: `synthetic:${i}` };
    index.db.prepare("INSERT INTO orders VALUES (?,?,?,?,?,?,?)").run(order.id, DEMAND_TYPE, order.buyer, 0, order.acceptUntil, order.maxPrice, JSON.stringify(order));
    index.db.prepare("INSERT INTO demand_documents VALUES (?,?)").run(order.inputURI, JSON.stringify(demand));
  }
  index.close();
  const matches = await seller.match({ skills: ["research", "chinese"] });
  assert.equal(matches.scanned, 231); assert.equal(matches.eligible, 1);
  assert.equal(matches.results[0].orderId, "231"); assert.equal(matches.excluded.length, 230);
});

async function completedOrder(c, label, { settle = true } = {}) {
  const buyer = c.buyerSession, seller = c.sellerSession;
  const draft = { ...c.draft, draftId: randomUUID(), title: label };
  const published = await buyer.preparePublish(draft);
  const order = await buyer.execute(published, published.approval);
  const quote = await seller.prepareQuote(order.orderId, { price: "1.5", hours: 4 });
  await seller.execute(quote, quote.approval);
  const fund = await buyer.prepareFund(order.orderId, (await buyer.quotes(order.orderId)).quotes[0].digest);
  const funded = await buyer.execute(fund, fund.approval);
  const delivery = await seller.prepareDelivery(order.orderId, "实际测试交付，仅用于协议回归测试。");
  await seller.execute(delivery, delivery.approval);
  const review = await buyer.prepareReview(order.orderId, "approve");
  if (settle) await buyer.execute(review, review.approval);
  return { order, funded, review, settle: () => buyer.execute(review, review.approval) };
}

test("write results contain canonical step receipts; replay after proposal expiry sends nothing", async t => {
  const c = await fixture(t), buyer = c.buyerSession;
  const proposal = await buyer.preparePublish(c.draft), result = await buyer.execute(proposal, proposal.approval);
  assert.equal(result.actionId, proposal.approval); assert.equal(result.executionStatus, "completed");
  assert.ok(result.receipts.some(r => r.events.some(e => e.name === "OrderCreated")));
  for (const receipt of result.receipts) {
    assert.equal(receipt.status, 1);
    assert.equal((await c.provider.getTransactionReceipt(receipt.transactionHash)).blockHash, receipt.blockHash);
  }
  const journal = await buyer.journal();
  const stored = journal.get(proposal.approval); assert.equal(stored.result.orderId, result.orderId); journal.close();
  const nonce = await c.provider.getTransactionCount(await c.buyer.getAddress());
  const originalNow = Date.now;
  Date.now = () => originalNow() + 360000;
  let replay;
  try { replay = await buyer.execute(proposal, proposal.approval); } finally { Date.now = originalNow; }
  assert.equal(replay.replayed, true); assert.deepEqual(replay.receipts, result.receipts);
  assert.equal(await c.provider.getTransactionCount(await c.buyer.getAddress()), nonce);
});

test("per-order withdrawals cannot include newly settled orders; all-balance guard is atomic", async t => {
  const c = await fixture(t), seller = c.sellerSession;
  const first = await completedOrder(c, "第一单");
  const second = await completedOrder(c, "第二单", { settle: false });
  await assert.rejects(seller.prepareAction("withdraw"), /withdrawalScope/);
  await assert.rejects(seller.prepareAction("withdraw", undefined, { withdrawalScope: "orders", orderIds: [first.order.orderId, first.order.orderId] }), /distinct/);
  const scoped = await seller.prepareAction("withdraw", undefined, { withdrawalScope: "orders", orderIds: [first.order.orderId] });
  const all = await seller.prepareAction("withdraw", undefined, { withdrawalScope: "all" });
  await second.settle();
  await assert.rejects(c.network.connect(c.seller).withdrawAll.staticCall(all.ticket.data.amount, all.ticket.data.creditVersion));
  const receipt = await seller.execute(scoped, scoped.approval);
  assert.equal(receipt.withdrawn, "1500000"); assert.equal(receipt.remainingCredits, "1500000");
  assert.equal(await c.token.balanceOf(await c.seller.getAddress()), 1500000n);
  assert.equal((await c.network.orderCredit(first.order.orderId)).amount, 0n);
  assert.equal((await c.network.orderCredit(second.order.orderId)).amount, 1500000n);
  // The total equals the old preview again, but it now belongs to a different order.
  assert.equal(await c.network.credits(await c.seller.getAddress()), BigInt(all.ticket.data.amount));
  await assert.rejects(c.network.connect(c.seller).withdrawAll.staticCall(all.ticket.data.amount, all.ticket.data.creditVersion));
  await assert.rejects(c.network.connect(c.seller).withdrawOrders.staticCall([second.order.orderId, second.order.orderId]));
  const rest = await seller.prepareAction("withdraw", undefined, { withdrawalScope: "all" });
  await seller.execute(rest, rest.approval);
  assert.equal((await c.network.orderCredit(second.order.orderId)).amount, 0n);
  assert.equal(await c.network.totalCredits(), 0n);
  await assert.rejects(c.network.connect(c.seller).withdrawOrders.staticCall([first.order.orderId]));
  await assert.rejects(c.network.connect(c.stranger).withdrawOrders.staticCall([second.order.orderId]));
  // A later epoch's credits cannot resurrect an already withdrawn order.
  const third = await completedOrder(c, "第三单");
  assert.equal((await c.network.orderCredit(second.order.orderId)).amount, 0n);
  assert.equal((await c.network.orderCredit(third.order.orderId)).amount, 1500000n);
  assert.equal(await c.token.balanceOf(await c.network.getAddress()), await c.network.totalEscrowed() + await c.network.totalCredits());
});

test("broadcast followed by lost response recovers from receipts and nonce without resending", async t => {
  const c = await fixture(t), seller = c.sellerSession, buyer = c.buyerSession;
  const order = await c.publish(), proposal = await seller.prepareQuote(order.orderId, { price: "1.5", hours: 4 });
  const originalSend = c.seller.sendTransaction.bind(c.seller);
  c.seller.sendTransaction = async tx => {
    const response = await originalSend(tx);
    return { hash: response.hash, wait: async () => { throw Object.assign(new Error("RPC disconnected after broadcast"), { code: "NETWORK_ERROR" }); } };
  };
  await assert.rejects(seller.execute(proposal, proposal.approval), error => {
    assert.equal(error.execution.executionStatus, "uncertain"); return true;
  });
  c.seller.sendTransaction = originalSend;
  const nonce = await c.provider.getTransactionCount(await c.seller.getAddress());
  const journal = await seller.journal(), record = journal.get(proposal.approval);
  // Simulate process death between RPC returning a hash and persisting it.
  delete record.steps[0].transactionHash; record.steps[0].status = "submitting";
  journal.put(record); journal.close();
  const recovered = await seller.recover(proposal.approval);
  assert.equal(recovered.executionStatus, "completed");
  assert.equal(recovered.receipts[0].events.some(e => e.name === "QuotePosted"), true);
  assert.equal((await buyer.quotes(order.orderId)).quotes.length, 1);
  assert.equal((await seller.execute(proposal, proposal.approval)).replayed, true);
  assert.equal(await c.provider.getTransactionCount(await c.seller.getAddress()), nonce);
});

test("interrupted funding recovers the approval only and never silently sends the acceptance", async t => {
  const c = await fixture(t), buyer = c.buyerSession, seller = c.sellerSession;
  const order = await c.publish(), quote = await seller.prepareQuote(order.orderId, { price: "1.5", hours: 4 });
  await seller.execute(quote, quote.approval);
  const funding = await buyer.prepareFund(order.orderId, (await buyer.quotes(order.orderId)).quotes[0].digest);
  const journal = await buyer.journal(), record = journal.begin(funding);
  await journal.transact(record, "approve_token", buyer.agent.token, "approve", [buyer.agent.config.contract, "1500000"]);
  record.ownerPid = 2147483647; journal.put(record); journal.close();
  const nonce = await c.provider.getTransactionCount(await c.buyer.getAddress());
  const recovered = await buyer.recover(funding.approval);
  assert.equal(recovered.executionStatus, "interrupted");
  assert.equal(await c.token.allowance(await c.buyer.getAddress(), await c.network.getAddress()), 1500000n);
  assert.equal(await c.network.totalEscrowed(), 0n);
  assert.equal(await c.provider.getTransactionCount(await c.buyer.getAddress()), nonce);
  await assert.rejects(buyer.execute(funding, funding.approval), /already attempted/);
  const refreshed = await buyer.prepareFund(order.orderId, (await buyer.quotes(order.orderId)).quotes[0].digest);
  const funded = await buyer.execute(refreshed, refreshed.approval);
  assert.deepEqual(funded.receipts.map(r => r.step), ["approve_token", "accept_quote"]);
  assert.equal(await c.network.totalEscrowed(), 1500000n);
});

test("unknown broadcast blocks new writes; canonical receipt invalidation cannot replay saved success", async t => {
  const c = await fixture(t), buyer = c.buyerSession;
  const snapshot = await c.rpc("evm_snapshot");
  const p = await buyer.preparePublish(c.draft); await buyer.execute(p, p.approval);
  await c.rpc("evm_revert", [snapshot]);
  await assert.rejects(buyer.execute(p, p.approval), /canonical/);
  assert.equal((await buyer.recover(p.approval)).executionStatus, "uncertain");
  const next = await buyer.preparePublish({ ...c.draft, draftId: randomUUID() });
  await assert.rejects(buyer.execute(next, next.approval), /Unfinished action/);
  assert.equal(await c.network.orderCount(), 0n);
});

test("durable inbox catches offline changes and deadline phases, deduplicates acknowledgments, never pays", async t => {
  const c = await fixture(t), buyer = c.buyerSession;
  const first = await completedOrder(c, "等待人工验收", { settle: false });
  let inbox = await HostInbox.open(buyer);
  inbox.watch({ orderIds: [first.order.orderId], reminderSeconds: 10 });
  const initial = await inbox.poll();
  assert.ok(initial.events.some(e => e.name === "OrderFunded"));
  assert.ok(initial.events.some(e => e.name === "ResultSubmitted"));
  inbox.close(); // Host exits without acknowledging; its next invocation receives the same pending ids.
  inbox = await HostInbox.open(buyer);
  assert.deepEqual((await inbox.poll()).events.map(e => e.eventId), initial.events.map(e => e.eventId));
  inbox.ack(initial.events.map(e => e.eventId));
  assert.equal((await inbox.poll()).events.length, 0);
  const order = await c.network.getOrder(first.order.orderId);
  await c.at(Number(order.reviewUntil) - 5);
  const upcoming = await inbox.poll();
  assert.ok(upcoming.events.some(e => e.type === "deadline" && e.phase === "upcoming"));
  inbox.ack(upcoming.events.map(e => e.eventId));
  assert.equal((await inbox.poll()).events.length, 0);
  await c.at(Number(order.reviewUntil));
  const passed = await inbox.poll();
  assert.ok(passed.events.some(e => e.type === "deadline" && e.phase === "passed"));
  assert.equal((await c.network.getOrder(first.order.orderId)).status, 2n);
  assert.equal(await c.network.credits(await c.seller.getAddress()), 0n);
  inbox.close();
});

test("poll failure preserves cursor and inbox; reorg rebuilds without retaining orphan events", async t => {
  const c = await fixture(t), buyer = c.buyerSession;
  const inbox = await HostInbox.open(buyer); t.after(() => inbox.close());
  inbox.watch({ discovery: true });
  await inbox.poll(); const cursor = inbox.meta("cursor");
  const original = c.provider.getBlock.bind(c.provider);
  c.provider.getBlock = async () => { throw new Error("connection lost"); };
  await assert.rejects(inbox.poll(), /connection lost/);
  c.provider.getBlock = original;
  assert.equal(inbox.meta("cursor"), cursor);
  const snapshot = await c.rpc("evm_snapshot");
  await c.publish(); const changed = await inbox.poll();
  assert.ok(changed.events.some(e => e.name === "OrderCreated"));
  await c.rpc("evm_revert", [snapshot]);
  const rebuilt = await inbox.poll(); assert.equal(rebuilt.reset, true);
  assert.equal(rebuilt.events.length, 0);
});

test("simultaneous executions of one proposal produce one write and keep its receipt hooks intact", async t => {
  const c = await fixture(t), buyer = c.buyerSession;
  const proposal = await buyer.preparePublish(c.draft);
  const attempts = await Promise.allSettled([buyer.execute(proposal, proposal.approval), buyer.execute(proposal, proposal.approval)]);
  assert.equal(attempts.filter(r => r.status === "fulfilled").length, 1);
  const result = attempts.find(r => r.status === "fulfilled").value;
  assert.ok(result.receipts.some(r => r.events.some(e => e.name === "OrderCreated")));
  assert.equal(await c.network.orderCount(), 1n);
});
