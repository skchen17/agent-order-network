import test from "node:test";
import assert from "node:assert/strict";
import { ContractFactory, id, keccak256, toUtf8Bytes, ZeroHash } from "ethers";
import { createLocalChain } from "../scripts/local-chain.mjs";
import { OrderClient, WEB_EXTRACT_V1, QUOTE_TYPES } from "../src/order-client.mjs";

async function fixture(t) {
  const c = await createLocalChain();
  t.after(() => c.close());
  c.buyerClient = new OrderClient(await c.network.getAddress(), c.artifact.abi, c.buyer);
  c.sellerClient = new OrderClient(await c.network.getAddress(), c.artifact.abi, c.seller);
  const now = await c.now();
  c.request = {
    requestId: id("request-1"), taskType: WEB_EXTRACT_V1,
    description: "Extract product price from a supplied snapshot", inputURI: "fixture://product.html",
    acceptanceCriteria: "Match the supplied snapshot and web.extract.product.v1 schema",
    maxPrice: 2_000_000n, acceptUntil: now + 600, latestDeliveryAt: now + 1200,
    reviewPeriod: 60, arbitrationPeriod: 60, evaluator: await c.evaluator.getAddress()
  };
  c.orderId = await c.buyerClient.publish(c.request);
  c.signed = await c.sellerClient.quote(c.orderId, {
    price: 1_500_000n, deliverBy: now + 900, validUntil: now + 300
  });
  c.fund = async () => {
    await (await c.token.approve(await c.network.getAddress(), c.signed.quote.price)).wait();
    await c.buyerClient.accept(c.signed, 2_000_000n);
  };
  c.submit = async () => c.sellerClient.submit(c.orderId, id("result"), "fixture://result.json");
  return c;
}

async function rejects(contract, action, expected) {
  await assert.rejects(action, error => {
    let name = error.revert?.name;
    const candidates = [error.data, error.info?.error?.data, error.error?.data];
    for (let data of candidates) {
      if (data && typeof data === "object") data = data.data;
      if (typeof data === "string") {
        try { name = contract.interface.parseError(data)?.name ?? name; } catch { /* try next */ }
      }
    }
    assert.equal(name, expected, error.shortMessage ?? error.message);
    return true;
  });
}

async function solvent(c) {
  const balance = await c.token.balanceOf(await c.network.getAddress());
  const liability = await c.network.totalEscrowed() + await c.network.totalCredits();
  assert.ok(balance >= liability, "escrow and withdrawal credits must be backed");
}

test("public order retains full terms and can be discovered without an application database", async t => {
  const c = await fixture(t);
  const order = await c.network.getOrder(c.orderId);
  assert.equal(order.description, c.request.description);
  assert.equal(order.acceptanceCriteria, c.request.acceptanceCriteria);
  assert.equal(order.status, 0n);
  assert.notEqual(order.termsHash, ZeroHash);
  const found = await c.sellerClient.discover(WEB_EXTRACT_V1);
  assert.deepEqual(found.map(item => item.orderId), [c.orderId]);
  await rejects(c.network, () => c.network.createOrder.staticCall(c.request), "InvalidRequest");
  await rejects(c.network, () => c.network.getOrder(999), "UnknownOrder");
});

test("signed quote funds escrow, buyer approves, supplier withdraws exactly once", async t => {
  const c = await fixture(t);
  const start = await c.token.balanceOf(await c.buyer.getAddress());
  await c.fund();
  assert.equal(await c.network.totalEscrowed(), c.signed.quote.price);
  assert.equal(await c.token.balanceOf(await c.buyer.getAddress()), start - c.signed.quote.price);
  assert.equal((await c.sellerClient.discover(WEB_EXTRACT_V1)).length, 0);
  await c.submit();
  await (await c.network.approveResult(c.orderId)).wait();
  assert.equal((await c.network.getOrder(c.orderId)).status, 4n);
  assert.equal(await c.network.credits(await c.seller.getAddress()), c.signed.quote.price);
  await solvent(c);
  await (await c.network.connect(c.seller).withdraw()).wait();
  assert.equal(await c.token.balanceOf(await c.seller.getAddress()), c.signed.quote.price);
  assert.equal(await c.network.totalCredits(), 0n);
  await rejects(c.network, () => c.network.connect(c.seller).withdraw.staticCall(), "NothingToWithdraw");
  await rejects(c.network, () => c.network.approveResult.staticCall(c.orderId), "WrongStatus");
  await solvent(c);
});

test("tampering with price, provider, or frozen terms invalidates a quote", async t => {
  const c = await fixture(t);
  for (const changes of [{ price: 1_000_000n }, { termsHash: id("changed") }, { provider: await c.secondSeller.getAddress() }]) {
    await rejects(c.network, () => c.network.acceptQuote.staticCall({ ...c.signed.quote, ...changes }, c.signed.signature), "InvalidQuote");
  }
});

test("EIP-712 quote cannot be replayed on another contract or chain", async t => {
  const c = await fixture(t);
  const other = await new ContractFactory(c.artifact.abi, c.artifact.bytecode, c.buyer).deploy(await c.token.getAddress());
  await other.waitForDeployment();
  await (await other.createOrder(c.request)).wait();
  await rejects(other, () => other.acceptQuote.staticCall(c.signed.quote, c.signed.signature), "InvalidQuote");
  const signature = await c.seller.signTypedData({
    name: "AgentOrderNetwork", version: "1", chainId: 1, verifyingContract: await c.network.getAddress()
  }, QUOTE_TYPES, c.signed.quote);
  await rejects(c.network, () => c.network.acceptQuote.staticCall(c.signed.quote, signature), "InvalidQuote");
});

test("expired quote cannot be selected even while the order is still open", async t => {
  const c = await fixture(t);
  await c.at(c.signed.quote.validUntil);
  await rejects(c.network, () => c.network.acceptQuote.staticCall(c.signed.quote, c.signed.signature), "DeadlinePassed");
});

test("on-chain quote bulletin authenticates supplier and never reserves work", async t => {
  const c = await fixture(t);
  await rejects(c.network, () => c.network.postQuote.staticCall(c.signed.quote, c.signed.signature), "Unauthorized");
  await c.sellerClient.postQuote(c.signed);
  const quotes = await c.buyerClient.getQuotes(c.orderId);
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].quote.provider, await c.seller.getAddress());
  assert.equal(quotes[0].signature, c.signed.signature);
  assert.equal((await c.network.getOrder(c.orderId)).status, 0n);
  assert.equal(await c.network.totalEscrowed(), 0n);
  await rejects(c.network, () => c.network.connect(c.seller).postQuote.staticCall(c.signed.quote, c.signed.signature), "DuplicateQuote");
  await c.fund();
  await rejects(c.network, () => c.network.connect(c.seller).postQuote.staticCall(c.signed.quote, c.signed.signature), "WrongStatus");
});

test("on-chain quote bulletin rejects tampering and expired publications", async t => {
  const c = await fixture(t);
  await rejects(c.network, () => c.network.connect(c.seller).postQuote.staticCall({ ...c.signed.quote, price: 1n }, c.signed.signature), "InvalidQuote");
  await c.at(c.signed.quote.validUntil);
  await rejects(c.network, () => c.network.connect(c.seller).postQuote.staticCall(c.signed.quote, c.signed.signature), "DeadlinePassed");
});

test("buyer identity, budget and delivery deadline are enforced", async t => {
  const c = await fixture(t);
  await rejects(c.network, () => c.network.connect(c.stranger).acceptQuote.staticCall(c.signed.quote, c.signed.signature), "Unauthorized");
  const tooExpensive = await c.sellerClient.quote(c.orderId, { ...c.signed.quote, price: 3_000_000n });
  await rejects(c.network, () => c.network.acceptQuote.staticCall(tooExpensive.quote, tooExpensive.signature), "InvalidQuote");
  const late = await c.sellerClient.quote(c.orderId, { ...c.signed.quote, deliverBy: c.request.latestDeliveryAt + 1 });
  await rejects(c.network, () => c.network.acceptQuote.staticCall(late.quote, late.signature), "InvalidQuote");
  await assert.rejects(() => c.buyerClient.accept(c.signed, 1_000_000n), /Local spend limit exceeded/);
});

test("failed funding rolls back selection and escrow accounting", async t => {
  const c = await fixture(t);
  await assert.rejects(() => c.network.acceptQuote(c.signed.quote, c.signed.signature));
  const order = await c.network.getOrder(c.orderId);
  assert.equal(order.status, 0n);
  assert.equal(order.price, 0n);
  assert.equal(await c.network.totalEscrowed(), 0n);
  await c.fund();
  await solvent(c);
});

test("a funded order cannot be selected twice or cancelled by the buyer", async t => {
  const c = await fixture(t);
  await c.fund();
  const second = new OrderClient(await c.network.getAddress(), c.artifact.abi, c.secondSeller);
  const alternative = await second.quote(c.orderId, c.signed.quote);
  await rejects(c.network, () => c.network.acceptQuote.staticCall(alternative.quote, alternative.signature), "WrongStatus");
  await rejects(c.network, () => c.network.cancelOrder.staticCall(c.orderId), "WrongStatus");
});

test("only the buyer cancels an open order, and no quote revives it", async t => {
  const c = await fixture(t);
  await rejects(c.network, () => c.network.connect(c.stranger).cancelOrder.staticCall(c.orderId), "Unauthorized");
  await (await c.network.cancelOrder(c.orderId)).wait();
  await rejects(c.network, () => c.network.acceptQuote.staticCall(c.signed.quote, c.signed.signature), "WrongStatus");
  assert.equal(await c.network.totalEscrowed(), 0n);
});

test("any caller expires an unselected order at the acceptance deadline", async t => {
  const c = await fixture(t);
  await rejects(c.network, () => c.network.expireOpen.staticCall(c.orderId), "TooEarly");
  await c.at(c.request.acceptUntil);
  await rejects(c.network, () => c.network.acceptQuote.staticCall(c.signed.quote, c.signed.signature), "DeadlinePassed");
  await (await c.network.connect(c.stranger).expireOpen(c.orderId)).wait();
  assert.equal((await c.network.getOrder(c.orderId)).status, 5n);
});

test("nondelivery refunds buyer at exact deadline and blocks late submission", async t => {
  const c = await fixture(t);
  await c.fund();
  await rejects(c.network, () => c.network.refundExpired.staticCall(c.orderId), "TooEarly");
  await c.at(c.signed.quote.deliverBy);
  await rejects(c.network, () => c.network.connect(c.seller).submitResult.staticCall(c.orderId, id("result"), "fixture://result"), "DeadlinePassed");
  await (await c.network.connect(c.stranger).refundExpired(c.orderId)).wait();
  assert.equal((await c.network.getOrder(c.orderId)).status, 6n);
  assert.equal(await c.network.credits(await c.buyer.getAddress()), c.signed.quote.price);
  await rejects(c.network, () => c.network.refundExpired.staticCall(c.orderId), "WrongStatus");
  await (await c.network.withdraw()).wait();
  assert.equal(await c.token.balanceOf(await c.buyer.getAddress()), 1_000_000_000n);
  await solvent(c);
});

test("only selected provider submits and deliverable must have hash and location", async t => {
  const c = await fixture(t);
  await c.fund();
  await rejects(c.network, () => c.network.submitResult.staticCall(c.orderId, id("result"), "fixture://result"), "Unauthorized");
  await rejects(c.network, () => c.network.connect(c.seller).submitResult.staticCall(c.orderId, ZeroHash, "fixture://result"), "InvalidDelivery");
  await rejects(c.network, () => c.network.connect(c.seller).submitResult.staticCall(c.orderId, id("result"), ""), "InvalidDelivery");
  await c.submit();
  await rejects(c.network, () => c.network.connect(c.seller).submitResult.staticCall(c.orderId, id("result"), "fixture://result"), "WrongStatus");
});

test("submission prevents a nondelivery refund; review silence pays provider", async t => {
  const c = await fixture(t);
  await c.fund();
  await c.submit();
  await rejects(c.network, () => c.network.refundExpired.staticCall(c.orderId), "WrongStatus");
  await rejects(c.network, () => c.network.finalizeUnchallenged.staticCall(c.orderId), "TooEarly");
  const order = await c.network.getOrder(c.orderId);
  await c.at(Number(order.reviewUntil));
  await rejects(c.network, () => c.network.disputeResult.staticCall(c.orderId, id("evidence")), "DeadlinePassed");
  await (await c.network.connect(c.stranger).finalizeUnchallenged(c.orderId)).wait();
  assert.equal(await c.network.credits(await c.seller.getAddress()), c.signed.quote.price);
  await solvent(c);
});

test("only buyer can approve or dispute, and an evaluator cannot bypass undisputed review", async t => {
  const c = await fixture(t);
  await c.fund();
  await c.submit();
  await rejects(c.network, () => c.network.connect(c.seller).approveResult.staticCall(c.orderId), "Unauthorized");
  await rejects(c.network, () => c.network.connect(c.stranger).disputeResult.staticCall(c.orderId, id("evidence")), "Unauthorized");
  await rejects(c.network, () => c.network.disputeResult.staticCall(c.orderId, ZeroHash), "InvalidDelivery");
  await rejects(c.network, () => c.network.connect(c.evaluator).resolveDispute.staticCall(c.orderId, true), "WrongStatus");
});

for (const payProvider of [true, false]) {
  test(`agreed evaluator resolves a dispute to ${payProvider ? "provider" : "buyer"}`, async t => {
    const c = await fixture(t);
    await c.fund();
    await c.submit();
    await (await c.network.disputeResult(c.orderId, id("evidence"))).wait();
    await rejects(c.network, () => c.network.resolveDispute.staticCall(c.orderId, payProvider), "Unauthorized");
    await rejects(c.network, () => c.network.finalizeUnchallenged.staticCall(c.orderId), "WrongStatus");
    await (await c.network.connect(c.evaluator).resolveDispute(c.orderId, payProvider)).wait();
    const beneficiary = payProvider ? c.seller : c.buyer;
    assert.equal(await c.network.credits(await beneficiary.getAddress()), c.signed.quote.price);
    await solvent(c);
  });
}

test("evaluator outage has a bounded buyer-refund fallback and rejects late ruling", async t => {
  const c = await fixture(t);
  await c.fund();
  await c.submit();
  await (await c.network.disputeResult(c.orderId, id("evidence"))).wait();
  await rejects(c.network, () => c.network.refundExpired.staticCall(c.orderId), "TooEarly");
  const order = await c.network.getOrder(c.orderId);
  await c.at(Number(order.disputeUntil));
  await rejects(c.network, () => c.network.connect(c.evaluator).resolveDispute.staticCall(c.orderId, true), "DeadlinePassed");
  await (await c.network.connect(c.stranger).refundExpired(c.orderId)).wait();
  assert.equal(await c.network.credits(await c.buyer.getAddress()), c.signed.quote.price);
  await solvent(c);
});

test("invalid request periods, evaluator, and empty terms are rejected", async t => {
  const c = await fixture(t);
  for (const patch of [
    { reviewPeriod: 0 }, { arbitrationPeriod: 604801 }, { evaluator: await c.buyer.getAddress() },
    { description: "" }, { acceptanceCriteria: "" }, { maxPrice: 0 }, { latestDeliveryAt: c.request.acceptUntil }
  ]) {
    await rejects(c.network, () => c.network.createOrder.staticCall({ ...c.request, requestId: id("new"), ...patch }), "InvalidRequest");
  }
});

test("multiple orders maintain separate liabilities and withdrawals", async t => {
  const c = await fixture(t);
  await c.fund();
  const id2 = await c.buyerClient.publish({ ...c.request, requestId: id("request-2") });
  const quote2 = await c.sellerClient.quote(id2, { ...c.signed.quote, price: 1_000_000n });
  await (await c.token.approve(await c.network.getAddress(), quote2.quote.price)).wait();
  await c.buyerClient.accept(quote2, 2_000_000n);
  await c.submit();
  await (await c.network.approveResult(c.orderId)).wait();
  await solvent(c);
  await (await c.network.connect(c.seller).withdraw()).wait();
  assert.equal(await c.network.totalEscrowed(), quote2.quote.price);
  await c.at(quote2.quote.deliverBy);
  await (await c.network.refundExpired(id2)).wait();
  await solvent(c);
  await (await c.network.withdraw()).wait();
  assert.equal(await c.token.balanceOf(await c.network.getAddress()), 0n);
});

test("token donations are not spendable by unrelated accounts", async t => {
  const c = await fixture(t);
  await c.fund();
  await (await c.token.transfer(await c.network.getAddress(), 100n)).wait();
  await rejects(c.network, () => c.network.connect(c.stranger).withdraw.staticCall(), "NothingToWithdraw");
  await solvent(c);
});
