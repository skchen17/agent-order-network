import { fork, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { JsonRpcProvider, Contract } from "ethers";
import { writeFile } from "node:fs/promises";
import { runHostWake } from "../src/host-wake.mjs";
import { readJSON, saveJSON } from "../src/agent-runtime.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
export async function runSkillScenario() {
  const directory = path.join(root, ".local-demo", "skill-runs", randomUUID());
  const children = [], calls = []; let provider;
  const track = child => {
    const closed = new Promise(resolve => child.once("close", resolve)); children.push({ child, closed }); return child;
  };
  async function tool(name, input = {}, { role, approval, failure = false } = {}) {
    const config = role ? path.join(directory, role, "config.json") : path.join(directory, "deployment.json");
    const args = [path.join(root, "skills/p2p-orders/scripts/orders.mjs"), name, "--input", "-",
      ...(name === "draft_order" ? [] : ["--config", config, "--state-dir", path.join(directory, "states", role ?? "public")]), ...(approval ? ["--approval", approval] : [])];
    const child = track(spawn(process.execPath, args, { cwd: directory, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }));
    const result = await new Promise((resolve, reject) => {
      let stdout = "", stderr = "";
      const timer = setTimeout(() => { child.kill(); reject(new Error(`Tool ${name} timed out`)); }, 30000);
      child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => {
        clearTimeout(timer);
        try {
          const response = JSON.parse(stdout);
          if (failure ? code !== 1 || response.ok : code !== 0 || !response.ok) throw new Error(`${name}: ${stdout}\n${stderr}`);
          resolve(response);
        } catch (error) { reject(error); }
      });
      child.stdin.on("error", () => {}); child.stdin.end(JSON.stringify(input));
    });
    calls.push({ tool: name, pid: child.pid, role: role ?? "public-reader", response: result });
    await saveJSON(path.join(directory, "calls", `${calls.length}-${name}.json`), calls.at(-1));
    return result.result ?? result.error;
  }
  async function confirm(prepared, role) {
    return tool("execute_action", { proposal: prepared.proposal }, { role, approval: prepared.proposal.approval });
  }
  try {
    const node = track(fork(path.join(root, "scripts/start-local.mjs"), ["--out", directory, "--port", "0"], { cwd: root, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true }));
    let startup = "";
    for (const stream of [node.stdout, node.stderr]) stream.on("data", chunk => { startup += chunk; });
    const deployment = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Chain startup timeout: " + startup)), 30000);
      node.on("message", msg => { if (msg.type === "ready") { clearTimeout(timer); resolve(msg); } });
      node.once("error", error => { clearTimeout(timer); reject(error); });
      node.once("exit", code => { clearTimeout(timer); reject(new Error(`Chain startup failed ${code}: ${startup}`)); });
    });
    provider = new JsonRpcProvider(deployment.rpcUrl, undefined, { cacheTimeout: -1 }); provider.pollingInterval = 50;
    const contract = new Contract(deployment.contract, (await readJSON(new URL("../artifacts/OrderNetwork.json", import.meta.url))).abi, provider);
    const token = new Contract(deployment.paymentToken, (await readJSON(new URL("../artifacts/MockPaymentToken.json", import.meta.url))).abi, provider);
    const sample = await readJSON(new URL("../examples/research-demand.json", import.meta.url));
    const terms = Object.fromEntries(Object.entries(sample).filter(([key]) => !["profile", "draftId", "sourceText", "createdAt", "generator"].includes(key)));
    // Fixture represents a host Agent's structured output, not a model quality evaluation.
    const { draft } = await tool("draft_order", { sourceText: sample.sourceText, terms });
    const publish = await tool("prepare_action", { action: "publish", draft }, { role: "buyer" });
    await tool("execute_action", { proposal: publish.proposal }, { role: "buyer", failure: true });
    if (await contract.orderCount() !== 0n) throw new Error("Preparing or unconfirmed execution changed chain state");
    const created = await confirm(publish, "buyer");
    const { draft: second } = await tool("draft_order", { sourceText: "另一个公开设计任务", terms: { ...terms, title: "另一个设计任务", skills: ["design"], category: "design" } });
    await confirm(await tool("prepare_action", { action: "publish", draft: second }, { role: "buyer" }), "buyer");
    const info = await tool("network_info");
    const first = await tool("list_orders", { after: "0", limit: 1 });
    const next = await tool("list_orders", { after: first.nextCursor, limit: 1 });
    const end = await tool("list_orders", { after: next.nextCursor, limit: 1 });
    if (first.orders[0]?.orderId !== "1" || next.orders[0]?.orderId !== "2" || end.nextCursor !== null) throw new Error("Keyless paginated discovery lost an order");
    const quote = await tool("prepare_action", { action: "quote", orderId: created.orderId, price: "1.5", hours: 4 }, { role: "seller" });
    await confirm(quote, "seller");
    const offers = await tool("list_quotes", { orderId: created.orderId });
    const funding = await tool("prepare_action", { action: "fund", orderId: created.orderId, quoteDigest: offers.quotes[0].digest }, { role: "buyer" });
    if (await contract.totalEscrowed() !== 0n) throw new Error("Preparation funded the order");
    const funded = await confirm(funding, "buyer");
    await confirm(await tool("prepare_action", { action: "deliver", orderId: created.orderId, text: "测试交付：只验证宿主工具调用，不代表完成真实调研。" }, { role: "seller" }), "seller");
    const delivery = await tool("get_delivery", { orderId: created.orderId });
    // A host adapter is a local command accepting durable eventIds, not a simulated human payment confirmation.
    const adapterScript = path.join(directory, "test-host-adapter.mjs"), adapterFile = path.join(directory, "host-adapter.json");
    const adapterLog = path.join(directory, "adapter-calls.jsonl");
    await writeFile(adapterScript, `import { appendFile } from 'node:fs/promises';
let input='';for await (const chunk of process.stdin) input+=chunk;
const payload=JSON.parse(input);await appendFile(process.argv[2], JSON.stringify({mode:process.argv[3],eventIds:payload.events.map(e=>e.eventId)})+'\\n');
if(process.argv[3]==='timeout') await new Promise(()=>setInterval(()=>{},1000));
process.exitCode=process.argv[3]==='fail'?1:0;`);
    const wakeArgs = ["--config", path.join(directory, "buyer/config.json"), "--state-dir", path.join(directory, "states/buyer"), "--adapter", adapterFile, "--timeout-seconds", "1"];
    async function wake(mode) {
      await saveJSON(adapterFile, { command: process.execPath, args: [adapterScript, adapterLog, mode] });
      let text = "";
      const code = await runHostWake(wakeArgs, { output: { write: chunk => { text += chunk; } } });
      return { code, response: JSON.parse(text) };
    }
    if ((await wake("fail")).code !== 1) throw new Error("Failed host dispatch must remain pending");
    const pendingAfterFailure = await tool("poll_updates", {}, { role: "buyer" });
    if (!pendingAfterFailure.events.length) throw new Error("Wake failure lost pending events");
    if ((await wake("timeout")).code !== 1) throw new Error("Timed-out host must remain pending");
    const accepted = await wake("accept");
    if (accepted.code !== 0 || !accepted.response.dispatched) throw new Error("Host did not receive wake events");
    const idle = await wake("accept");
    if (idle.response.dispatched !== false || idle.response.events.length) throw new Error("Acknowledged events were dispatched again");
    const recoveredFunding = await tool("recover_action", { actionId: funding.proposal.approval }, { role: "buyer" });
    if (recoveredFunding.executionStatus !== "completed" || recoveredFunding.receipts.length !== 2) throw new Error("Read-only recovery lost funding receipts");
    await confirm(await tool("prepare_action", { action: "approve", orderId: created.orderId }, { role: "buyer" }), "buyer");
    await confirm(await tool("prepare_action", { action: "withdraw", withdrawalScope: "orders", orderIds: [created.orderId] }, { role: "seller" }), "seller");
    await confirm(await tool("prepare_action", { action: "cancel", orderId: "2" }, { role: "buyer" }), "buyer");
    const buyerConfig = await readJSON(path.join(directory, "buyer/config.json"));
    const sellerConfig = await readJSON(path.join(directory, "seller/config.json"));
    if (JSON.stringify(calls).includes(buyerConfig.privateKey) || JSON.stringify(calls).includes(sellerConfig.privateKey)) throw new Error("Tool output leaked a development key");
    const summary = { directory, chainPid: node.pid, toolPids: calls.map(c => c.pid), toolCalls: calls.length,
      keylessDiscovery: info.publicDiscoveryNeedsWallet === false, foundOrders: [first.orders[0].orderId, next.orders[0].orderId],
      fullTermsPreserved: JSON.stringify(first.orders[0].demand.conditions) === JSON.stringify(sample.conditions),
      deliveryVerified: delivery.delivery.text.includes("测试交付"), status: Number((await contract.getOrder(1)).status),
      cancelledSecondOrder: Number((await contract.getOrder(2)).status), sellerBalance: String(await token.balanceOf(deployment.seller)),
      escrow: String(await contract.totalEscrowed()), credits: String(await contract.totalCredits()),
      localOnly: true, permanentAppServers: 0, interactiveClients: 0, localModels: 0,
      unifiedReceipts: created.receipts.some(r => r.events.some(e => e.name === "OrderCreated")) && funded.receipts.length === 2,
      durableWake: true, failedWakeRetained: pendingAfterFailure.events.length, acceptedWakeEvents: accepted.response.acceptedEvents,
      recoveryReadOnly: recoveredFunding.executionStatus === "completed",
      authorization: "simulated test authorization only", hostInference: "fixture, not Codex/Claude cross-host evaluation" };
    await saveJSON(path.join(directory, "summary.json"), summary); return summary;
  } finally {
    provider?.destroy();
    for (const { child } of children.slice().reverse()) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      if (child.connected) child.send({ type: "stop" }); else child.kill();
    }
    await Promise.all(children.map(async ({ child, closed }) => {
      let timer;
      try { await Promise.race([closed, new Promise(resolve => { timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2000); })]); }
      finally { clearTimeout(timer); }
    }));
  }
}
