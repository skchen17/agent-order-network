import { fork, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, JsonRpcProvider } from "ethers";
import { readJSON, saveJSON } from "../src/agent-runtime.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
export async function runHumanScenario() {
  const directory = path.join(root, ".local-demo", "human-runs", randomUUID());
  const children = []; let provider;
  function track(child) {
    const closed = new Promise(resolve => child.once("close", resolve));
    children.push({ child, closed }); return child;
  }
  function terminal(config) {
    const child = track(spawn(process.execPath, [path.join(root, "scripts/trade.mjs"), "--config", config], { cwd: root, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }));
    let output = ""; const pending = new Set();
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output += chunk; for (const check of pending) check(); });
    function waitFor(marker, from = 0) {
      return new Promise((resolve, reject) => {
        let timer;
        const finish = (error, value) => { clearTimeout(timer); pending.delete(check); child.off("close", ended); error ? reject(error) : resolve(value); };
        const check = () => { if (output.slice(from).includes(marker)) finish(null, output.slice(from)); };
        const ended = () => finish(new Error(`Client exited before ${marker}\n${output.slice(from)}`));
        timer = setTimeout(() => finish(new Error(`Client timed out: ${marker}\n${output.slice(from)}`)), 30000);
        pending.add(check); child.once("close", ended); check();
      });
    }
    return { child, ready: () => waitFor("输入命令"),
      async run(command, answers = [], confirmation) {
        const from = output.length;
        child.stdin.write([command, ...answers].join("\n") + "\n");
        if (confirmation !== undefined) {
          const preview = await waitFor("」，其他输入取消", from);
          const code = preview.match(/如同意请输入「(确认 [0-9a-f]{12})」/)[1];
          child.stdin.write((confirmation ? code : "取消") + "\n");
        }
        const result = await waitFor("输入命令", from);
        if (result.includes("未完成：")) throw new Error(result);
        return result;
      },
      async saveTranscript(file) { await saveJSON(file, { pid: child.pid, transcript: output }); }
    };
  }
  try {
    const node = track(fork(path.join(root, "scripts/start-local.mjs"), ["--out", directory, "--port", "0"], { cwd: root, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true }));
    let startup = "";
    for (const stream of [node.stdout, node.stderr]) stream.on("data", chunk => { startup += chunk; });
    const deployment = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Local chain startup timed out: " + startup)), 30000);
      node.on("message", message => { if (message.type === "ready") { clearTimeout(timer); resolve(message); } });
      node.once("error", error => { clearTimeout(timer); reject(error); });
      node.once("exit", code => { clearTimeout(timer); reject(new Error(`Local chain exited ${code}: ${startup}`)); });
    });
    provider = new JsonRpcProvider(deployment.rpcUrl, undefined, { cacheTimeout: -1 }); provider.pollingInterval = 50;
    const network = new Contract(deployment.contract, (await readJSON(new URL("../artifacts/OrderNetwork.json", import.meta.url))).abi, provider);
    const token = new Contract(deployment.paymentToken, (await readJSON(new URL("../artifacts/MockPaymentToken.json", import.meta.url))).abi, provider);
    const buyer = terminal(path.join(directory, "buyer/config.json"));
    const seller = terminal(path.join(directory, "seller/config.json"));
    await Promise.all([buyer.ready(), seller.ready()]);
    const draft = path.join(directory, "buyer", "draft.json");
    await buyer.run("new", [
      "帮我比较三个公开开源协议，交付中文报告。不能编造数据，不注册账号；来源不可用时说明。预算2 TESTUSD。",
      "三个协议的中文对比", "理解协议适用场景和限制", "research", "research;chinese",
      "关键结论附官方来源；不能编造数据", "中文Markdown报告；来源清单", "不注册账号；不购买服务",
      "来源不可访问时记录未知项", "买方检查报告内容后人工确认", "zh", "markdown", "2", "1", "24", "24", "24", draft
    ]);
    const created = await readJSON(draft);
    if (!created.sourceText.includes("不能编造") || created.conditions.length !== 1) throw new Error("Guided draft lost complex requirements");
    await buyer.run("publish", [draft], false);
    if (await network.orderCount() !== 0n) throw new Error("Cancellation published an order");
    await buyer.run("publish", [draft], true);
    const matched = await seller.run("match", [path.join(root, "examples/research-capabilities.json"), "relevance"]);
    if (!matched.includes("符合条件：1")) throw new Error("Seller could not discover demand");
    await seller.run("quote", ["1", "1.5", "4"], true);
    await buyer.run("fund", ["1", "1"], false);
    if (await network.totalEscrowed() !== 0n || await token.allowance(deployment.buyer, deployment.contract) !== 0n) throw new Error("Cancellation changed payment authority");
    await buyer.run("fund", ["1", "1"], true);
    await seller.run("deliver", ["1", "交互流程测试用交付：这段文字不代表已完成真实调研，买方在演示中明确确认。"], true);
    await buyer.run("review", ["1", "approve"], true);
    await seller.run("withdraw", ["1"], true);
    await buyer.saveTranscript(path.join(directory, "buyer/transcript.json"));
    await seller.saveTranscript(path.join(directory, "seller/transcript.json"));
    const summary = { directory, chainPid: node.pid, buyerPid: buyer.child.pid, sellerPid: seller.child.pid,
      confirmations: "scripted test inputs; real CLI waits for the user", testedCancellations: ["publish", "fund"],
      orderId: "1", status: Number((await network.getOrder(1)).status),
      sellerBalance: String(await token.balanceOf(deployment.seller)), escrow: String(await network.totalEscrowed()),
      credits: String(await network.totalCredits()), relayServers: 0, localOnly: true, modelInference: false };
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
