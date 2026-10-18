import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { JsonRpcProvider, Contract } from "ethers";
import { readJSON, saveJSON } from "../src/agent-runtime.mjs";

const directory = path.resolve(process.argv[2]);
const deployment = await readJSON(path.join(directory, "network/deployment.json"));
const provider = new JsonRpcProvider(deployment.rpcUrl, undefined, { cacheTimeout: -1 });
try {
  const artifact = await readJSON(new URL("../artifacts/OrderNetwork.json", import.meta.url));
  const tokenArtifact = await readJSON(new URL("../artifacts/MockPaymentToken.json", import.meta.url));
  const network = new Contract(deployment.contract, artifact.abi, provider);
  const token = new Contract(deployment.paymentToken, tokenArtifact.abi, provider);
  const sessions = {};
  for (const role of ["buyer", "seller"]) {
    const folder = path.join(directory, role, "evidence");
    const files = (await readdir(folder)).filter(name => name.endsWith(".jsonl"));
    const phases = [];
    // Secret comparison stays inside this process; never return or print configuration/key bytes.
    const ownKey = (await readJSON(path.join(directory, "network", role, "config.json"))).privateKey;
    let secretObserved = false;
    for (const file of files) {
      const raw = await readFile(path.join(folder, file), "utf8");
      secretObserved ||= raw.toLowerCase().includes(ownKey.toLowerCase());
      // Live CLI may be part-way through its final JSONL chunk; keep raw evidence intact.
      const complete = raw.endsWith("\n") ? raw : raw.slice(0, raw.lastIndexOf("\n") + 1);
      const events = complete.split("\n").filter(Boolean).map(line => JSON.parse(line));
      const started = events.find(e => e.type === "thread.started");
      const finished = events.find(e => e.type === "turn.completed");
      phases.push({ phase: file.replace(".jsonl", ""), threadId: started?.thread_id,
        completed: !!finished, usage: finished?.usage ?? null,
        commands: events.filter(e => e.type === "item.completed" && e.item?.type === "command_execution").length,
        failedCommands: events.filter(e => e.type === "item.completed" && e.item?.type === "command_execution" && e.item.exit_code !== 0).length,
        loadedSkill: events.some(e => e.item?.type === "command_execution" && /Get-Content.*SKILL\.md/.test(e.item.command ?? "")) });
    }
    sessions[role] = { threadIds: [...new Set(phases.map(p => p.threadId).filter(Boolean))], phases, privateKeyObservedInTranscript: secretObserved };
  }
  const count = Number(await network.orderCount());
  const orders = [];
  for (let orderId = 1; orderId <= count; orderId++) {
    const order = await network.getOrder(orderId);
    orders.push({ orderId: String(orderId), title: order.description.split("\n")[0], status: Number(order.status),
      buyer: order.buyer, provider: order.provider, price: String(order.price), maxPrice: String(order.maxPrice),
      deliverBy: String(order.deliverBy), reviewUntil: String(order.reviewUntil), termsHash: order.termsHash, resultHash: order.resultHash,
      quotes: (await network.queryFilter(network.filters.QuotePosted(orderId), deployment.deploymentBlock)).map(e => ({ transactionHash: e.transactionHash, blockNumber: e.blockNumber, provider: e.args.provider, price: String(e.args.price) })) });
  }
  const eventTypes = ["OrderCreated", "OrderFunded", "ResultSubmitted", "OrderClosed", "Withdrawn"];
  const transactions = [];
  for (const type of eventTypes) for (const e of await network.queryFilter(network.filters[type](), deployment.deploymentBlock)) {
    const receipt = await provider.getTransactionReceipt(e.transactionHash);
    transactions.push({ event: type, transactionHash: e.transactionHash, blockNumber: e.blockNumber, gasUsed: String(receipt.gasUsed) });
  }
  const result = { directory, observedAt: new Date().toISOString(), sessions, orders, transactions,
    chainId: 31337, buyerBalance: String(await token.balanceOf(deployment.buyer)), sellerBalance: String(await token.balanceOf(deployment.seller)),
    escrow: String(await network.totalEscrowed()), credits: String(await network.totalCredits()),
    buyerAllowance: String(await token.allowance(deployment.buyer, deployment.contract)),
    contractTokenBalance: String(await token.balanceOf(deployment.contract)),
    limitations: ["same computer/account/SDK", "explicit Skill loading, not automatic discovery test", "role filesystem restrictions are instructions plus workspace sandbox, not independent OS users", "two distractors are fixtures; target order and matching are real Codex output", "do not infer public-chain throughput or cross-framework interoperability"] };
  await saveJSON(path.join(directory, "trial-result.json"), result);
  console.log(JSON.stringify({ observedAt: result.observedAt, sessions, orders: orders.map(({ orderId, title, status, price }) => ({ orderId, title, status, price })),
    escrow: result.escrow, credits: result.credits, sellerBalance: result.sellerBalance }, null, 2));
} finally { provider.destroy(); }
