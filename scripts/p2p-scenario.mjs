import { fork } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { JsonRpcProvider, Contract } from "ethers";
import { readJSON, saveJSON, sleep } from "../src/agent-runtime.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCENARIOS = new Set(["success", "restart", "nondelivery", "invalid-result", "live", "live-invalid"]);

function launch(file, args, quiet) {
  const child = fork(path.join(ROOT, file), args, {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true
  });
  const events = [];
  let output = "";
  let result;
  child.on("message", message => events.push(message));
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => {
    output = (output + chunk).slice(-32_000);
    if (!quiet) process.stdout.write(chunk);
  });
  const exited = new Promise(resolve => {
    child.on("error", error => { result = { code: -1, error: error.message }; resolve(result); });
    child.on("exit", (code, signal) => { result = { code, signal }; resolve(result); });
  });
  return {
    child, events, exited,
    async waitFor(predicate, timeout = 30_000) {
      const until = Date.now() + timeout;
      while (Date.now() < until) {
        const event = events.find(predicate);
        if (event) return event;
        if (result) throw new Error(`${file} exited before expected event: ${JSON.stringify(result)}\n${output}`);
        await sleep(30);
      }
      throw new Error(`${file} timed out waiting for progress\n${output}`);
    },
    async expectExit(timeout = 30_000) {
      let timer;
      try {
        const end = await Promise.race([exited, new Promise(resolve => {
          timer = setTimeout(() => resolve({ code: -1, error: "process timeout" }), timeout);
        })]);
        if (end.code !== 0) throw new Error(`${file} failed: ${JSON.stringify(end)}\n${output}`);
      } finally { clearTimeout(timer); }
    },
    async stop() {
      if (result) return;
      if (file.endsWith("start-local.mjs") && child.connected) child.send({ type: "stop" });
      else child.kill("SIGTERM");
      let timer;
      try { await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 1500); })]); }
      finally { clearTimeout(timer); }
      if (!result) { child.kill("SIGKILL"); await exited; }
    }
  };
}

export async function runScenario(scenario = "success", { directory, quiet = true, taskFile, webPolicy, repeatOrders = 1 } = {}) {
  if (!SCENARIOS.has(scenario)) throw new Error("Unknown scenario");
  if (!Number.isInteger(repeatOrders) || repeatOrders < 1 || repeatOrders > 3 || (repeatOrders > 1 && !["success", "live"].includes(scenario))) throw new Error("Invalid repeat order scenario");
  const runDir = path.resolve(directory ?? path.join(ROOT, ".local-demo", "runs", `${scenario}-${randomUUID()}`));
  const children = [];
  let provider;
  const start = (file, args) => {
    const process = launch(file, args, quiet);
    children.push(process);
    return process;
  };
  try {
    const node = start("scripts/start-local.mjs", ["--out", runDir, "--port", "0"]);
    const deployment = await node.waitFor(event => event.type === "ready");
    provider = new JsonRpcProvider(deployment.rpcUrl, undefined, { cacheTimeout: -1 });
    provider.pollingInterval = 50;
    const buyerConfig = path.join(runDir, "buyer", "config.json");
    const sellerConfig = path.join(runDir, "seller", "config.json");
    if (webPolicy) for (const file of [buyerConfig, sellerConfig]) {
      const config = await readJSON(file);
      await saveJSON(file, { ...config, webPolicy });
    }
    const live = scenario.startsWith("live");
    if (live && !taskFile) throw new Error("Live scenario requires a task file");
    let buyer = start("agents/buyer.mjs", ["--config", buyerConfig, ...(live ? ["--task", taskFile] : []), ...(scenario === "restart" ? ["--pause-after-publish"] : [])]);
    const buyerPids = [buyer.child.pid];
    const sellerPids = [];
    const published = await buyer.waitFor(event => event.event === "published");
    if (scenario === "restart") {
      await buyer.expectExit();
      buyer = start("agents/buyer.mjs", ["--config", buyerConfig]);
      buyerPids.push(buyer.child.pid);
    }
    let seller = start("agents/seller.mjs", ["--config", sellerConfig,
      ...(repeatOrders > 1 ? ["--serve", "--max-orders", String(repeatOrders)] : []),
      ...(scenario === "restart" ? ["--pause-before-delivery"] : []),
      ...(scenario === "nondelivery" ? ["--mode", "withhold"] : []),
      ...(["invalid-result", "live-invalid"].includes(scenario) ? ["--mode", "invalid"] : [])
    ]);
    sellerPids.push(seller.child.pid);
    const artifact = await readJSON(new URL("../artifacts/OrderNetwork.json", import.meta.url));
    const tokenArtifact = await readJSON(new URL("../artifacts/MockPaymentToken.json", import.meta.url));
    const contract = new Contract(deployment.contract, artifact.abi, provider);
    const token = new Contract(deployment.paymentToken, tokenArtifact.abi, provider);
    let orderId = BigInt(published.orderId);
    const orderIds = [orderId.toString()];
    let buyerStateFile = path.join(runDir, "buyer", "state.json");

    if (scenario === "restart") {
      await seller.waitFor(event => event.event === "paused_before_delivery");
      await seller.expectExit();
      seller = start("agents/seller.mjs", ["--config", sellerConfig]);
      sellerPids.push(seller.child.pid);
    } else if (scenario === "nondelivery") {
      await buyer.waitFor(event => event.event === "funded");
      const order = await contract.getOrder(orderId);
      // Only the harness controls development-chain time. Agents use ordinary RPC calls.
      await provider.send("evm_setNextBlockTimestamp", [Number(order.deliverBy)]);
      await provider.send("evm_mine", []);
    } else if (["invalid-result", "live-invalid"].includes(scenario)) {
      await buyer.waitFor(event => event.event === "disputed");
      const order = await contract.getOrder(orderId);
      await provider.send("evm_setNextBlockTimestamp", [Number(order.disputeUntil)]);
      await provider.send("evm_mine", []);
    }
    for (let iteration = 1; iteration < repeatOrders; iteration++) {
      await buyer.expectExit();
      buyerStateFile = path.join(runDir, "buyer", `state-${iteration + 1}.json`);
      buyer = start("agents/buyer.mjs", ["--config", buyerConfig, "--state", buyerStateFile, ...(live ? ["--task", taskFile] : [])]);
      buyerPids.push(buyer.child.pid);
      const next = await buyer.waitFor(event => event.event === "published");
      orderId = BigInt(next.orderId);
      orderIds.push(orderId.toString());
    }
    await Promise.all([buyer.expectExit(), seller.expectExit()]);
    const buyerState = await readJSON(buyerStateFile);
    const sellerState = await readJSON(path.join(runDir, "seller", "state.json"));
    const order = await contract.getOrder(orderId);
    const quotes = await contract.queryFilter(contract.filters.QuotePosted(orderId));
    const summary = {
      scenario, directory: runDir, localOnly: true, chainPid: node.child.pid, buyerPids, sellerPids,
      orderId: orderId.toString(), orderIds, orderCount: (await contract.orderCount()).toString(),
      quoteCount: quotes.length, status: buyerState.status,
      chainStatus: Number(order.status), buyerBalance: (await token.balanceOf(deployment.buyer)).toString(),
      sellerBalance: (await token.balanceOf(deployment.seller)).toString(),
      escrow: (await contract.totalEscrowed()).toString(), credits: (await contract.totalCredits()).toString(),
      inputURI: order.inputURI, resultURI: order.resultURI, resultHash: order.resultHash,
      result: buyerState.result ?? null, verification: buyerState.verification ?? null,
      reason: buyerState.reason ?? null, validationFailure: buyerState.validationFailure ?? null,
      sellerStatus: sellerState.status, processed: sellerState.processed,
      transport: live ? "on-chain-bulletin-and-independent-web-fetch" : "on-chain-events-and-inline-data", relayServers: 0
    };
    await saveJSON(path.join(runDir, "summary.json"), summary);
    return summary;
  } finally {
    provider?.destroy();
    await Promise.allSettled(children.reverse().map(child => child.stop()));
  }
}
