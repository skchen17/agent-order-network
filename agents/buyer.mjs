import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { id, keccak256, toUtf8Bytes } from "ethers";
import { openAgent, sleep, recoverStateRace } from "../src/agent-runtime.mjs";
import { WEB_EXTRACT_V1, STATUS } from "../src/order-client.mjs";
import { encodeInline, decodeInline } from "../src/inline-payload.mjs";
import { snapshotDigest, validateProduct } from "../src/product-profile.mjs";
import { LIVE_PROFILE, WEB_FETCH_PRODUCTS_V1, validateManifest, verifyProducts } from "../src/live-products.mjs";

async function run() {
  const a = await openAgent("buyer");
  try {
    const { config, state, client, token, persist } = a;
    let requestedTask;
    if (a.values.task) requestedTask = validateManifest(JSON.parse(await readFile(a.values.task, "utf8")), a.webPolicy);
    if (state.requestId && requestedTask && JSON.stringify(requestedTask) !== JSON.stringify(state.manifest)) {
      throw new Error("Existing state belongs to another task. Use --state with a new path for a new order.");
    }
    if (!state.requestId) {
      const now = await a.now();
      const inputHtml = requestedTask ? undefined : (await readFile(config.inputPath, "utf8")).trim();
      if (requestedTask && !a.payloads) throw new Error("Live tasks require a configured payload bulletin");
      const request = {
        requestId: id(randomUUID()), taskType: WEB_EXTRACT_V1,
        description: "Extract product fields from the supplied public inline HTML snapshot.",
        inputURI: requestedTask ? await a.payloads.writeJSON(requestedTask) : encodeInline(inputHtml, "text/html"),
        acceptanceCriteria: JSON.stringify(requestedTask ? { profile: LIVE_PROFILE, verification: "independent-refetch", maxAgeSeconds: requestedTask.maxAgeSeconds } :
          { profile: "web.extract.product.v1", snapshotSha256: snapshotDigest(inputHtml) }),
        maxPrice: config.maxSpend, acceptUntil: now + config.acceptSeconds,
        latestDeliveryAt: now + config.latestDeliverySeconds,
        reviewPeriod: config.reviewPeriod, arbitrationPeriod: config.arbitrationPeriod, evaluator: config.evaluator
      };
      if (requestedTask) {
        request.taskType = WEB_FETCH_PRODUCTS_V1;
        request.description = `Collect public product data from ${requestedTask.urls.length} specified URL(s); buyer independently re-fetches before approval.`;
      }
      await persist("prepared", { requestId: request.requestId, request, inputHtml, manifest: requestedTask,
        quoteCursor: (await a.provider.getBlock("latest")).number, quotes: [] });
    }
    if (!state.orderId) {
      const recovered = await client.contract.orderForRequest(config.address, state.requestId);
      const orderId = recovered !== 0n ? recovered : await client.publish(state.request);
      await persist("published", { orderId: orderId.toString() });
      if (a.values["pause-after-publish"]) return;
    }
    const orderId = BigInt(state.orderId);
    for (;;) {
      const order = await client.contract.getOrder(orderId);
      const now = await a.now();
      const status = Number(order.status);
      try {
      if (status === 0) {
        if (now >= Number(order.acceptUntil)) {
          await (await client.contract.expireOpen(orderId)).wait();
          continue;
        }
        const quoteHead = (await a.provider.getBlock("latest")).number;
        const newQuotes = await client.getQuotes(orderId, Number(state.quoteCursor ?? config.deploymentBlock - 1) + 1, quoteHead);
        const quotes = [...(state.quotes ?? []), ...newQuotes].filter(({ quote }) =>
          quote.termsHash === order.termsHash && BigInt(quote.price) <= BigInt(config.maxSpend) &&
          Number(quote.validUntil) > now && Number(quote.deliverBy) > now
        ).sort((left, right) => BigInt(left.quote.price) < BigInt(right.quote.price) ? -1 : BigInt(left.quote.price) > BigInt(right.quote.price) ? 1 : 0).slice(0, 100);
        if (quoteHead !== state.quoteCursor) await persist("quotes_synced", { quoteCursor: quoteHead, quotes });
        if (quotes.length) {
          const selected = quotes[0];
          if (await token.allowance(config.address, config.contract) < selected.quote.price) {
            await (await token.approve(config.contract, selected.quote.price)).wait();
          }
          await client.accept(selected, config.maxSpend);
          await persist("funded", { price: selected.quote.price.toString() });
        }
      } else if (status === 1) {
        if (now >= Number(order.deliverBy)) {
          await (await client.contract.refundExpired(orderId)).wait();
          await persist("refund_requested", { reason: "nondelivery" });
        }
      } else if (status === 2) {
        let validation;
        let result;
        try {
          const text = state.manifest ? (await a.payloads.readJSON(order.resultURI)).text : decodeInline(order.resultURI, "application/json");
          if (keccak256(toUtf8Bytes(text)) !== order.resultHash) throw new Error("result_hash_mismatch");
          result = JSON.parse(text);
          validation = state.manifest ? await verifyProducts(result, state.manifest, a.webPolicy, a.fetchPage) : validateProduct(result, state.inputHtml, `order:${orderId}`);
        } catch (error) { validation = { ok: false, reason: error.message }; }
        if (validation.ok) {
          await (await client.contract.approveResult(orderId)).wait();
          await persist("approved", { result, resultHash: order.resultHash, verification: validation });
        } else if (now < Number(order.reviewUntil)) {
          await (await client.contract.disputeResult(orderId, id(validation.reason))).wait();
          await persist("disputed", { reason: validation.reason, validationFailure: validation.reason });
        } else {
          throw new Error("Invalid result observed after review deadline; automatic settlement may already be possible");
        }
      } else if (status === 3) {
        if (now >= Number(order.disputeUntil)) {
          await (await client.contract.refundExpired(orderId)).wait();
          await persist("refund_requested", { reason: "evaluator_timeout" });
        }
      } else {
        const credit = await client.contract.credits(config.address);
        if (credit > 0n) await (await client.contract.withdraw()).wait();
        await persist("done", { status: STATUS[status], balance: (await token.balanceOf(config.address)).toString() });
        return;
      }
      } catch (error) { await recoverStateRace(a, orderId, status, error); }
      await sleep(config.pollMs);
    }
  } finally { await a.close(); }
}

run().catch(error => { console.error(`Buyer failed: ${error.shortMessage ?? error.message}`); process.exitCode = 1; });
