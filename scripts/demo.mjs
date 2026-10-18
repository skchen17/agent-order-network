import { readFile } from "node:fs/promises";
import { id, keccak256, toUtf8Bytes, formatUnits } from "ethers";
import { createLocalChain } from "./local-chain.mjs";
import { OrderClient, WEB_EXTRACT_V1, STATUS } from "../src/order-client.mjs";
import { extractProduct, validateProduct, snapshotDigest } from "../src/product-profile.mjs";

const chain = await createLocalChain();
try {
  const address = await chain.network.getAddress();
  const buyer = new OrderClient(address, chain.artifact.abi, chain.buyer);
  const seller = new OrderClient(address, chain.artifact.abi, chain.seller);
  const html = await readFile(new URL("../fixtures/product.html", import.meta.url), "utf8");
  const source = "fixture://product.html";
  const now = await chain.now();
  const orderId = await buyer.publish({
    requestId: id("demo-request-1"), taskType: WEB_EXTRACT_V1,
    description: "Extract name, price, currency and availability from the supplied product snapshot.",
    inputURI: source,
    acceptanceCriteria: JSON.stringify({ profile: "web.extract.product.v1", snapshotSha256: snapshotDigest(html) }),
    maxPrice: 2_000_000n, acceptUntil: now + 600, latestDeliveryAt: now + 1200,
    reviewPeriod: 300, arbitrationPeriod: 600, evaluator: await chain.evaluator.getAddress()
  });
  console.log(`Published on local EVM: order #${orderId}, contract ${address}`);
  const found = await seller.discover(WEB_EXTRACT_V1);
  console.log(`Seller discovered ${found.length} open on-chain order(s).`);
  const quote = await seller.quote(orderId, { price: 1_500_000n, deliverBy: now + 900, validUntil: now + 300 });
  await (await chain.token.approve(address, quote.quote.price)).wait();
  await buyer.accept(quote, 2_000_000n);
  console.log("Selected signed quote; 1.50 TESTUSD locked in escrow.");

  const result = extractProduct(html, source);
  const resultHash = keccak256(toUtf8Bytes(JSON.stringify(result)));
  await seller.submit(orderId, resultHash, `fixture://results/${orderId}.json`);
  console.log("Provider submitted result commitment:", result);
  if (!validateProduct(result, html, source).ok) throw new Error("Validation failed");
  await (await chain.network.approveResult(orderId)).wait();
  await (await chain.network.connect(chain.seller).withdraw()).wait();
  const finalOrder = await chain.network.getOrder(orderId);
  console.log(`Final status: ${STATUS[Number(finalOrder.status)]}`);
  console.log(`Seller received: ${formatUnits(await chain.token.balanceOf(await chain.seller.getAddress()), 6)} TESTUSD`);
  console.log("Demo only: local accounts, fixture data, no real cryptocurrency or external AI model.");
} finally { await chain.close(); }
