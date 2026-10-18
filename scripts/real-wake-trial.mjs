// Opt-in live-model check. No fixture model responses or simulated human payment authorizations.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fork, spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { parseArgs } from "node:util";
import { JsonRpcProvider, Contract } from "ethers";
import { readJSON, saveJSON } from "../src/agent-runtime.mjs";
import { createDraft } from "../src/demand.mjs";
import { callAgentTool } from "../src/agent-tools.mjs";
import { bindCodex } from "../src/pilot.mjs";
import { runHostWake } from "../src/host-wake.mjs";

const { values } = parseArgs({ options: { codex: { type: "string" }, out: { type: "string" } } });
if (!values.codex || !values.out) throw new Error("Use --codex <absolute executable> --out <new trial directory>");
const root = fileURLToPath(new URL("..", import.meta.url)), directory = path.resolve(values.out);
await mkdir(directory);
const workspace = path.join(directory, "newcomer"); await mkdir(workspace);
const skillDirectory = path.join(root, "skills/p2p-orders");
const node = fork(path.join(root, "scripts/start-local.mjs"), ["--out", path.join(directory, "network"), "--port", "0"],
  { cwd: root, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
let provider;
try {
  let startup = ""; node.stdout.on("data", d => { startup += d; }); node.stderr.on("data", d => { startup += d; });
  const network = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Local fixture startup timeout")), 30000);
    node.once("error", reject); node.on("message", m => { if (m.type === "ready") { clearTimeout(timer); resolve(m); } });
    node.once("exit", () => { clearTimeout(timer); reject(new Error("Fixture node exited: " + startup.slice(-1000))); });
  });
  const deployment = path.join(directory, "network/deployment.json");
  const prompt = `我是第一次接入这个P2P网络的供应方用户，想让自己的Agent帮我找公开中文资料整理和源码检查任务。我不懂链上命令，也不要专用客户端。
我提供的Skill：${path.join(skillDirectory, "SKILL.md")}；公开邀请清单：${deployment}。
请按Skill自行接入：在当前目录的participant新目录生成我自己的专用测试身份，运行doctor，把结果用日常语言解释。当前是本地测试链，没有gas也可以先只读发现；不要索要或读取私钥正文，不复制他人的钱包，不安装软件。
这次不授权报价、接单、锁款、领取资产或任何交易。只开启discovery新订单待办，不关注具体订单。把participant.json的绝对路径保存到当前目录handoff.json的participantFile字段，供我自己的宿主恢复。不要启动常驻程序或注册系统任务。完成后停止。`;
  await saveJSON(path.join(directory, "initial-request.json"), { prompt, classification: "natural-language newcomer onboarding; no payment authorization" });
  console.log(JSON.stringify({ event: "starting_real_codex_onboarding", directory }));
  let sessionId, completed = false, buffer = "";
  const log = createWriteStream(path.join(directory, "initial.jsonl"), { flags: "wx" });
  const err = createWriteStream(path.join(directory, "initial.stderr.log"), { flags: "wx" });
  const initialCode = await new Promise((resolve, reject) => {
    const child = spawn(values.codex, ["exec", "--sandbox", "workspace-write", "-c", "sandbox_workspace_write.network_access=true", "-c", 'approval_policy="never"',
      "--json", "--skip-git-repo-check", "--output-last-message", path.join(workspace, "onboarding-reply.md"), "-"],
      { cwd: workspace, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => { child.kill(); reject(new Error("Newcomer session timed out")); }, 300000);
    child.stdout.on("data", chunk => { log.write(chunk); buffer += chunk; const lines = buffer.split("\n"); buffer = lines.pop();
      for (const line of lines) try { const e = JSON.parse(line); if (e.type === "thread.started") sessionId = e.thread_id; if (e.type === "turn.completed") completed = true; } catch {} });
    child.stderr.on("data", d => err.write(d)); child.stdin.on("error", () => {}); child.stdin.end(prompt);
    child.once("error", reject); child.once("close", code => { clearTimeout(timer); log.end(); err.end(); resolve(code); });
  });
  if (initialCode !== 0 || !sessionId || !completed) throw new Error("Real newcomer session did not complete");
  const handoff = await readJSON(path.join(workspace, "handoff.json")), participant = await readJSON(handoff.participantFile);
  if (!path.resolve(handoff.participantFile).startsWith(workspace + path.sep)) throw new Error("Newcomer participant escaped workspace");
  const doctor = await readJSON(path.join(participant.stateDir, "doctor.json"));
  const binding = await bindCodex(handoff.participantFile, { sessionId, codex: path.resolve(values.codex), skillDirectory, allowNonGit: true });
  const sample = await readJSON(path.join(root, "examples/research-demand.json"));
  const { profile, draftId, sourceText, createdAt, generator, ...terms } = sample;
  const draft = createDraft("只用于真实会话唤醒验证的公开订单夹具，不是实际采购。本次不授权报价、接单或付款。", { ...terms,
    title: "唤醒验证：公开中文源码检查需求", objective: "让休眠后的原Codex会话读取并解释新订单，不执行交易。" }, "explicit-test-fixture");
  const buyerOptions = { configFile: path.join(directory, "network/buyer/config.json"), stateDir: path.join(directory, "controller-state") };
  const prepared = await callAgentTool("prepare_action", { action: "publish", draft }, buyerOptions);
  const published = await callAgentTool("execute_action", { proposal: prepared.proposal }, { ...buyerOptions, approval: prepared.proposal.approval });
  console.log(JSON.stringify({ event: "resuming_real_codex_via_wake", sessionId, orderId: published.orderId }));
  let wakeOutput = "";
  const wakeCode = await runHostWake(binding.command.args.slice(1), { output: { write: d => { wakeOutput += d; } } });
  await saveJSON(path.join(directory, "wake-result.json"), JSON.parse(wakeOutput));
  if (wakeCode !== 0) throw new Error("Real Codex wake failed; inspect local host logs");
  const wake = JSON.parse(wakeOutput), attention = await readJSON(path.join(participant.stateDir, "attention.json"));
  provider = new JsonRpcProvider(network.rpcUrl, undefined, { cacheTimeout: -1 });
  const contract = new Contract(network.contract, (await readJSON(path.join(root, "artifacts/OrderNetwork.json"))).abi, provider);
  const pending = await callAgentTool("poll_updates", {}, { configFile: participant.configFile, stateDir: participant.stateDir });
  const initialTranscript = await readFile(path.join(directory, "initial.jsonl"), "utf8");
  const wakeTranscript = await readFile(wake.hostOutput.stdout, "utf8");
  const privateConfig = await readJSON(participant.configFile); // Compare internally; never print this value.
  const summary = { observedAt: new Date().toISOString(), directory, sessionId, role: participant.role,
    participantAddress: participant.address, newcomerGeneratedOwnWallet: participant.address !== network.seller && participant.address !== network.buyer,
    doctorChecked: doctor.checks.some(c => c.name === "deployment-and-code" && c.ok), missingGasDisclosed: !doctor.ready,
    realResumeCompleted: attention.sessionId === sessionId, acceptedEvents: wake.acceptedEvents, unacknowledgedEvents: pending.events.length,
    currentOrderRead: wakeTranscript.includes("get_order") && wakeTranscript.includes(published.orderId),
    summary: attention.summary, requiresUserAction: attention.requiresUserAction,
    participantNonce: await provider.getTransactionCount(participant.address), escrow: String(await contract.totalEscrowed()), credits: String(await contract.totalCredits()),
    privateKeyObservedInTranscript: initialTranscript.includes(privateConfig.privateKey) || wakeTranscript.includes(privateConfig.privateKey),
    scope: "Real Codex newcomer onboarding and original-session wake, on one computer and a temporary local fixture chain. Not public-testnet or cross-device proof.",
    publicTestnetVerified: false, crossDeviceVerified: false, systemTasksInstalled: false, fixtureOrderId: published.orderId };
  if (!summary.newcomerGeneratedOwnWallet || !summary.realResumeCompleted || !summary.currentOrderRead || summary.unacknowledgedEvents || summary.participantNonce || summary.escrow !== "0" || summary.credits !== "0" || summary.privateKeyObservedInTranscript) throw new Error("Live wake invariant failed; inspect raw evidence");
  await saveJSON(path.join(directory, "result.json"), summary);
  console.log(JSON.stringify(summary));
} finally {
  provider?.destroy();
  if (node.connected) node.send({ type: "stop" });
  await new Promise(resolve => { if (node.exitCode !== null) return resolve(); const timer = setTimeout(() => { node.kill(); resolve(); }, 3000); node.once("exit", () => { clearTimeout(timer); resolve(); }); });
}
