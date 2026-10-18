import path from "node:path";
import { keccak256, toUtf8Bytes } from "ethers";
import { openAgent, sleep, recoverStateRace } from "../src/agent-runtime.mjs";
import { WEB_EXTRACT_V1, STATUS } from "../src/order-client.mjs";
import { encodeInline, decodeInline } from "../src/inline-payload.mjs";
import { snapshotDigest, extractProduct } from "../src/product-profile.mjs";
import { OrderIndex } from "../src/order-index.mjs";
import { WEB_FETCH_PRODUCTS_V1, LIVE_PROFILE, validateManifest, collectProducts } from "../src/live-products.mjs";

async function chooseOrder(a, index) {
  await index.sync();
  const candidates = index.candidates({ now: await a.now(), minBudget: a.config.price,
    allowedBuyer: a.config.allowedBuyer, allowedEvaluators: [a.config.evaluator], limit: 20 });
  for (const candidate of candidates) {
    try {
      let manifest;
      if (candidate.order.taskType === WEB_FETCH_PRODUCTS_V1) {
        manifest = validateManifest((await a.payloads.readJSON(candidate.order.inputURI)).value, a.webPolicy);
        const terms = JSON.parse(candidate.order.acceptanceCriteria);
        if (terms.profile !== LIVE_PROFILE || terms.verification !== "independent-refetch" || terms.maxAgeSeconds !== manifest.maxAgeSeconds) {
          throw new Error("Unsupported live acceptance conditions");
        }
      } else {
        const html = decodeInline(candidate.order.inputURI, "text/html");
        const criteria = JSON.parse(candidate.order.acceptanceCriteria);
        if (criteria.profile !== "web.extract.product.v1" || criteria.snapshotSha256 !== snapshotDigest(html)) throw new Error("Unsupported snapshot terms");
      }
      const current = await a.client.contract.getOrder(candidate.orderId);
      if (Number(current.status) !== 0 || Number(current.acceptUntil) <= await a.now()) continue;
      await a.persist("discovered", { orderId: candidate.orderId.toString(), manifest, executionError: null });
      return true;
    } catch (error) {
      if (error.code) throw error;
      index.exclude(candidate.orderId, error.message);
      const skipped = { ...a.state.skipped, [candidate.orderId.toString()]: error.message };
      if (Object.keys(skipped).length > 100) delete skipped[Object.keys(skipped)[0]];
      await a.persist("order_skipped", { skipped });
    }
  }
  return false;
}

async function run() {
  const a = await openAgent("seller");
  let index;
  try {
    const { config, state, client, token, persist } = a;
    const maxOrders = Number(a.values["max-orders"]);
    if (!Number.isInteger(maxOrders) || maxOrders < 0) throw new Error("Invalid max-orders");
    index = await OrderIndex.open(path.join(path.dirname(a.stateFile), "orders.sqlite"), {
      client, deploymentBlock: config.deploymentBlock, identity: config.deploymentId,
      taskTypes: [WEB_EXTRACT_V1, WEB_FETCH_PRODUCTS_V1], blockSpan: config.indexBlockSpan ?? 500,
      capabilityKey: JSON.stringify({ webPolicy: a.webPolicy, price: config.price, buyer: config.allowedBuyer, evaluator: config.evaluator })
    });
    for (;;) {
      if (!state.orderId && !await chooseOrder(a, index)) { await sleep(config.pollMs); continue; }
      const orderId = BigInt(state.orderId);
      const order = await client.contract.getOrder(orderId);
      const now = await a.now();
      const status = Number(order.status);
      try {
        if (status === 0) {
          if (now >= Number(order.acceptUntil)) { await (await client.contract.expireOpen(orderId)).wait(); continue; }
          if (!state.signedQuote || Number(state.signedQuote.quote.validUntil) <= now) {
            const signedQuote = await client.quote(orderId, {
              price: config.price, deliverBy: Math.min(Number(order.latestDeliveryAt), now + config.deliverySeconds),
              validUntil: Math.min(Number(order.acceptUntil), now + 120)
            });
            await persist("quote_prepared", { signedQuote });
          }
          const digest = await client.contract.quoteDigest(state.signedQuote.quote);
          if (!await client.contract.postedQuotes(digest)) await client.postQuote(state.signedQuote);
          if (state.event !== "quoted") await persist("quoted");
        } else if (status === 1) {
          if (order.provider.toLowerCase() !== config.address.toLowerCase()) {
            await persist("not_selected", { status: "NotSelected" });
            if (!a.values.serve) return;
            await persist("ready_for_next", { orderId: null, signedQuote: null, manifest: null, executionError: null, status: null });
            continue;
          }
          if (a.values["pause-before-delivery"]) { await persist("paused_before_delivery"); return; }
          if (a.values.mode === "withhold") {
            if (state.event !== "withholding") await persist("withholding");
          } else if (now < Number(order.deliverBy) && !state.executionError) {
            try {
              const result = state.manifest ? await collectProducts(state.manifest, a.webPolicy, a.fetchPage) :
                extractProduct(decodeInline(order.inputURI, "text/html"), `order:${orderId}`);
              if (a.values.mode === "invalid") {
                if (state.manifest) result.items[0].price = "0.01";
                else result.price = "0.01";
              }
              const text = JSON.stringify(result);
              const resultHash = keccak256(toUtf8Bytes(text));
              const uri = state.manifest ? await a.payloads.writeJSON(result) : encodeInline(text, "application/json");
              await client.submit(orderId, resultHash, uri);
              await persist("submitted", { resultHash });
            } catch (error) {
              if (error.code === "CALL_EXCEPTION") throw error;
              await persist("execution_failed", { executionError: error.message });
            }
          }
        } else if (status === 2) {
          if (now >= Number(order.reviewUntil)) await (await client.contract.finalizeUnchallenged(orderId)).wait();
        } else if (status === 3) {
          // No permanent evaluation server is needed for the agreed timeout fallback.
        } else {
          const credit = await client.contract.credits(config.address);
          if (credit > 0n) await (await client.contract.withdraw()).wait();
          const processed = state.lastCompletedOrder === state.orderId ? Number(state.processed ?? 0) : Number(state.processed ?? 0) + 1;
          await persist("done", { status: STATUS[status], balance: (await token.balanceOf(config.address)).toString(), processed, lastCompletedOrder: state.orderId });
          if (!a.values.serve) return;
          if (maxOrders && processed >= maxOrders) return;
          await persist("ready_for_next", { processed, orderId: null, signedQuote: null, manifest: null, executionError: null, status: null });
        }
      } catch (error) { await recoverStateRace(a, orderId, status, error); }
      await sleep(config.pollMs);
    }
  } finally { index?.close(); await a.close(); }
}

run().catch(error => { console.error(`Seller failed: ${error.shortMessage ?? error.message}`); process.exitCode = 1; });
