import path from "node:path";
import { mkdir, open, unlink, access, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Wallet, ContractFactory, Contract, getCreateAddress, ZeroAddress, isAddress, keccak256 } from "ethers";
import { BASE_SEPOLIA, BASE_MAINNET, networkPolicy, verifyRuntime, createProvider, readTokenMetadata, ERC20_ABI, profileFor } from "./networks.mjs";
import { resolveSigner, assertNoSecretOptions } from "./signers.mjs";
import { readJSON, saveJSON, json, connectAgent } from "./agent-runtime.mjs";
import { digest } from "./demand.mjs";
import { TradeSession } from "./trade-session.mjs";
import { ActionJournal } from "./action-journal.mjs";
import { DatabaseSync } from "node:sqlite";

const build = name => readJSON(new URL(`../artifacts/${name}.json`, import.meta.url));
const manifestKeys = ["environment", "network", "testOnly", "chainId", "rpcUrl", "confirmations", "deploymentId", "contract", "paymentToken", "payloadStore", "evaluator", "deploymentBlock", "deploymentBlockHash", "codeHashes", "protocolVersion", "maxOrderAmount", "indexBlockSpan", "explorer", "paymentSymbol", "paymentDecimals", "paymentTokenSource", "allowMainnet"];
export const publicDeployment = source => Object.fromEntries(manifestKeys.filter(k => source[k] !== undefined).map(k => [k, source[k]]));
export const deploymentFingerprint = source => digest(Object.fromEntries(Object.entries(publicDeployment(source)).filter(([k]) => k !== "rpcUrl")));
const validManifest = deployment => {
  const external = deployment.paymentTokenSource === "external";
  const codeKeys = external ? ["contract", "payloadStore"] : ["contract", "paymentToken", "payloadStore"];
  return ["contract", "paymentToken", "payloadStore", "evaluator"].every(key => isAddress(deployment[key] ?? "") && deployment[key] !== ZeroAddress) &&
    Number.isSafeInteger(deployment.deploymentBlock) && deployment.deploymentBlock >= 0 &&
    /^0x[0-9a-f]{64}$/i.test(deployment.deploymentBlockHash ?? "") &&
    deployment.codeHashes && codeKeys.every(key => /^0x[0-9a-f]{64}$/i.test(deployment.codeHashes[key] ?? "")) &&
    (!external || (typeof deployment.paymentSymbol === "string" && Number.isSafeInteger(deployment.paymentDecimals) && deployment.paymentDecimals > 0));
};
async function newDirectory(directory) {
  const target = path.resolve(directory);
  await mkdir(path.dirname(target), { recursive: true });
  await mkdir(target); // Never overwrite an existing wallet or participant directory.
  return target;
}
function providerFor(config) {
  return createProvider(config);
}
export async function preparePilot(directory, rpcUrl, { mainnet = false, address, evaluator, signerModule, signerOptions = {}, maxOrderAmount = "2000000" } = {}) {
  if (mainnet) {
    if (!isAddress(address ?? "") || !isAddress(evaluator ?? "") || !path.isAbsolute(signerModule ?? "")) {
      throw new Error("Base mainnet prepare requires --address, --evaluator and an absolute --signer-module");
    }
    assertNoSecretOptions(signerOptions, "--signer-options");
    if (!/^(?:0|[1-9]\d*)$/.test(String(maxOrderAmount)) || BigInt(maxOrderAmount) <= 0n) {
      throw new Error("maxOrderAmount must be a positive integer in USDC base units");
    }
  }
  const target = await newDirectory(directory);
  if (!mainnet) {
    const config = { ...BASE_SEPOLIA, network: BASE_SEPOLIA.name, testOnly: true, role: "deployer", deploymentId: randomUUID(), rpcUrl: rpcUrl ?? BASE_SEPOLIA.rpcUrl };
    delete config.name;
    networkPolicy(config);
    const deployer = Wallet.createRandom(), evaluatorWallet = Wallet.createRandom();
    await saveJSON(path.join(target, "deployer-wallet.json"), { ...config, address: deployer.address, privateKey: deployer.privateKey });
    await saveJSON(path.join(target, "evaluator-wallet.json"), { ...config, role: "evaluator", address: evaluatorWallet.address, privateKey: evaluatorWallet.privateKey });
    const prepared = { status: "needs-test-gas", network: config.network, chainId: config.chainId, testOnly: true, realFunds: false,
      directory: target, deployer: deployer.address, evaluator: evaluatorWallet.address, walletFile: path.join(target, "deployer-wallet.json"),
      fundsGuide: BASE_SEPOLIA.fundsGuide, evaluatorPolicy: "No automatic arbitrator. Pilot participants must accept the disclosed arbitration-timeout refund rule.",
      next: "Use an official-listed faucet to send Base Sepolia test ETH to the deployer address. Do not send mainnet ETH or buy funds. Then run deploy. No contracts have been deployed." };
    await saveJSON(path.join(target, "preparation.json"), prepared);
    await saveJSON(path.join(target, "invitation.pending.json"), { status: "not-deployed", network: config.network, chainId: config.chainId,
      testOnly: true, realFunds: false, protocolVersion: "0.6.0", joinEnabled: false,
      next: "This is not a deployment invitation. Once test gas is available, deploy and distribute public/deployment.json with its fingerprint." });
    return prepared;
  }

  const config = { ...BASE_MAINNET, network: BASE_MAINNET.name, testOnly: false, allowMainnet: true, role: "deployer", deploymentId: randomUUID(),
    rpcUrl: rpcUrl ?? BASE_MAINNET.rpcUrl, address, evaluator, maxOrderAmount: String(maxOrderAmount),
    paymentTokenSource: "external", paymentSymbol: "USDC", paymentDecimals: 6,
    externalSigner: { type: "module", module: signerModule, options: signerOptions } };
  delete config.name;
  networkPolicy(config);
  await saveJSON(path.join(target, "deployer.json"), config);
  const prepared = { status: "needs-real-funds", network: "base", chainId: 8453, testOnly: false, realFunds: true,
    directory: target, deployer: address, evaluator, walletFile: path.join(target, "deployer.json"),
    paymentToken: BASE_MAINNET.paymentToken, paymentSymbol: "USDC", paymentDecimals: 6, maxOrderAmount: String(maxOrderAmount),
    evaluatorPolicy: "No automatic arbitrator. Mainnet participants must accept the disclosed arbitration-timeout refund rule.",
    next: "This is an unaudited mainnet path. Fund the deployer with real ETH for gas and USDC for the per-order cap only after the readiness gates are met. Run doctor, then deploy." };
  await saveJSON(path.join(target, "preparation.json"), prepared);
  await saveJSON(path.join(target, "invitation.pending.json"), { status: "not-deployed", network: "base", chainId: 8453,
    testOnly: false, realFunds: true, protocolVersion: "0.6.0", joinEnabled: false,
    next: "This is not a deployment invitation. Do not distribute until verify passes and the mainnet readiness/audit gates are met." });
  return prepared;
}

export async function deployPilot(walletFile, directory, { providerFactory = providerFor, signerFactory = resolveSigner, existingPaymentToken, allowMainnet = false, knownPaymentTokens } = {}) {
  const config = await readJSON(walletFile), policy = networkPolicy(config);
  if (policy.local || config.role !== "deployer") throw new Error("Use the dedicated deployer config generated by prepare");
  const externalToken = policy.mainnet;
  const tokenAddress = externalToken ? (existingPaymentToken ?? config.paymentToken) : null;
  if (externalToken) {
    if (!allowMainnet) throw new Error("Base mainnet deployment requires --allow-mainnet");
    const allowed = knownPaymentTokens ?? [BASE_MAINNET.paymentToken];
    if (!tokenAddress || !allowed.some(address => address.toLowerCase() === tokenAddress.toLowerCase())) {
      throw new Error("Base mainnet deployment requires canonical Base USDC");
    }
    if (!/^(?:0|[1-9]\d*)$/.test(config.maxOrderAmount ?? "") || BigInt(config.maxOrderAmount) <= 0n) {
      throw new Error("Mainnet deployer config requires maxOrderAmount as a positive integer in USDC base units");
    }
  }
  const provider = providerFactory(config);
  const target = path.resolve(directory);
  let journal;
  try {
    if (BigInt(await provider.send("eth_chainId", [])) !== BigInt(config.chainId)) throw new Error("RPC returned a different network");
    const signer = await signerFactory(config, provider);
    const walletAddress = await signer.getAddress();
    if (externalToken) {
      const metadata = await readTokenMetadata(provider, tokenAddress);
      if (metadata.symbol !== "USDC" || metadata.decimals !== 6) throw new Error("Base mainnet payment token must be USDC with 6 decimals");
    }
    if (await provider.getBalance(walletAddress) === 0n) {
      return { status: externalToken ? "needs-real-gas" : "needs-test-gas", address: walletAddress,
        fundsGuide: externalToken ? null : BASE_SEPOLIA.fundsGuide, realFunds: externalToken, transactionsSent: 0 };
    }
    await mkdir(target, { recursive: true });
    const planFile = path.join(target, "deployment-plan.json");
    let plan;
    try { plan = await readJSON(planFile); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const artifactNames = externalToken ? ["OrderNetwork", "OrderPayloads"] : ["PilotPaymentToken", "OrderNetwork", "OrderPayloads"];
    const artifacts = await Promise.all(artifactNames.map(build));
    const mode = externalToken ? "external-token" : "test-token";
    const evaluator = config.evaluator ?? (await readJSON(path.join(path.dirname(path.resolve(walletFile)), "preparation.json"))).evaluator;
    if (!plan) {
      const nonce = await provider.getTransactionCount(walletAddress, "pending");
      if (nonce !== await provider.getTransactionCount(walletAddress, "latest")) throw new Error("Deployer has pending transactions; recover them first");
      const addresses = artifacts.map((_, index) => getCreateAddress({ from: walletAddress, nonce: nonce + index }));
      plan = { mode, context: { chainId: config.chainId, address: walletAddress, deploymentId: config.deploymentId, contract: ZeroAddress, paymentToken: tokenAddress ?? ZeroAddress },
        nonce, addresses, evaluator, paymentToken: tokenAddress,
        buildHashes: artifacts.map(a => keccak256(a.bytecode)), createdAt: new Date().toISOString() };
      plan.proposal = { ticket: { kind: "deploy-pilot", context: plan.context, data: { mode, addresses, paymentToken: tokenAddress, buildHashes: plan.buildHashes } } };
      plan.proposal.approval = digest(plan.proposal.ticket);
      await saveJSON(planFile, plan);
    }
    if (plan.mode !== mode || plan.context.address.toLowerCase() !== walletAddress.toLowerCase() || plan.context.deploymentId !== config.deploymentId ||
      plan.addresses.length !== artifacts.length ||
      (externalToken && (plan.paymentToken ?? "").toLowerCase() !== tokenAddress.toLowerCase()) ||
      digest(plan.buildHashes) !== digest(artifacts.map(a => keccak256(a.bytecode)))) {
      throw new Error("Deployment plan wallet/build/token changed; do not reuse this directory");
    }
    journal = await ActionJournal.open(path.join(target, "deployment.actions.sqlite"), plan.context, provider,
      artifacts.map((a, i) => [plan.addresses[i], new Contract(plan.addresses[i], a.abi, provider).interface]), policy);
    let record = journal.get(plan.proposal.approval);
    if (record) {
      const recovery = await journal.recover(record.actionId);
      if (recovery.executionStatus === "uncertain") return { status: "uncertain", ...recovery, next: "Keep the deployment directory and run deploy again later; nothing was resent." };
      record = journal.get(record.actionId);
      if (record.steps.some(s => s.status !== "confirmed")) throw new Error("A deployment transaction failed/replaced; inspect the journal before preparing a different deployment");
      record.status = "running"; record.ownerPid = process.pid; journal.put(record);
    } else record = journal.begin(plan.proposal);
    try {
      const steps = externalToken ? ["deploy_orders", "deploy_payloads"] : ["deploy_token", "deploy_orders", "deploy_payloads"];
      const orderIndex = externalToken ? 0 : 1, payloadIndex = externalToken ? 1 : 2;
      for (let i = 0; i < steps.length; i++) {
        if (record.steps.some(s => s.step === steps[i] && s.status === "confirmed")) continue;
        if (await provider.getTransactionCount(walletAddress, "pending") !== plan.nonce + i) throw new Error("Deployer nonce changed outside this deployment; stop and inspect");
        const factory = new ContractFactory(artifacts[i].abi, artifacts[i].bytecode, signer);
        const args = i === orderIndex ? [externalToken ? tokenAddress : plan.addresses[0]] : [];
        const tx = await factory.getDeployTransaction(...args);
        const estimate = await provider.estimateGas({ ...tx, from: walletAddress });
        const fee = await provider.getFeeData();
        if (await provider.getBalance(walletAddress) < estimate * (fee.maxFeePerGas ?? fee.gasPrice ?? 0n)) {
          throw new Error(externalToken
            ? "Insufficient real ETH for the next contract; retain this directory and fund the same deployer"
            : "Insufficient test gas for the next contract; retain this directory and fund the same deployer");
        }
        const receipt = await journal.transact(record, steps[i], { runner: signer, deploy: { populateTransaction: async () => tx } }, "deploy", []);
        if (receipt.contractAddress?.toLowerCase() !== plan.addresses[i].toLowerCase()) throw new Error("Unexpected deployed address");
      }
      const orderReceipt = record.steps.find(s => s.step === "deploy_orders").receipt;
      const deployment = { ...publicDeployment(config), protocolVersion: "0.6.0",
        contract: plan.addresses[orderIndex], paymentToken: externalToken ? tokenAddress : plan.addresses[0], payloadStore: plan.addresses[payloadIndex],
        evaluator: plan.evaluator, deploymentBlock: orderReceipt.blockNumber, deploymentBlockHash: orderReceipt.blockHash,
        rpcUrl: config.rpcUrl, maxOrderAmount: externalToken ? config.maxOrderAmount : (config.maxOrderAmount ?? "2000000"),
        indexBlockSpan: config.indexBlockSpan ?? 500, explorer: config.explorer ?? (externalToken ? BASE_MAINNET.explorer : BASE_SEPOLIA.explorer),
        paymentTokenSource: externalToken ? "external" : "deployed", paymentSymbol: externalToken ? "USDC" : "TESTUSD",
        paymentDecimals: 6, allowMainnet: externalToken, testOnly: !externalToken, codeHashes: {} };
      const hashTargets = externalToken ? [["contract", 0], ["payloadStore", 1]] : [["contract", 1], ["paymentToken", 0], ["payloadStore", 2]];
      for (const [key, i] of hashTargets) deployment.codeHashes[key] = await verifyRuntime(provider, plan.addresses[i], artifacts[i]);
      deployment.fingerprint = deploymentFingerprint(deployment);
      await saveJSON(path.join(target, "deployment.json"), deployment);
      record.status = "completed"; record.result = { deployment }; journal.put(record);
      return { status: "deployed", deploymentFile: path.join(target, "deployment.json"), fingerprint: deployment.fingerprint,
        realFunds: externalToken, ...journal.summary(record), explorer: `${deployment.explorer}/address/${deployment.contract}` };
    } catch (error) { journal.fail(record); error.execution = journal.summary(record); throw error; }
  } finally { journal?.close(); provider.destroy(); }
}

export async function joinPilot({ deploymentFile, role, directory, fingerprint, rpcUrl, address, signerModule, signerOptions = {}, allowMainnet = false, providerFactory = providerFor }) {
  if (!["buyer", "seller"].includes(role)) throw new Error("Choose buyer or seller");
  const source = await readJSON(deploymentFile), deployment = publicDeployment(source);
  if (rpcUrl) deployment.rpcUrl = rpcUrl;
  const policy = networkPolicy(deployment);
  if (!validManifest(deployment)) throw new Error("Invitation is not deployed or incomplete; obtain public/deployment.json after deployment, not preparation or wallet files");
  if (!policy.local && fingerprint !== deploymentFingerprint(deployment)) throw new Error("Deployment fingerprint mismatch; verify the public invitation fingerprint before creating a wallet");
  if (policy.mainnet) {
    if (!allowMainnet) throw new Error("Base mainnet join requires --allow-mainnet");
    if (!isAddress(address ?? "") || !path.isAbsolute(signerModule ?? "")) throw new Error("Base mainnet join requires --address and an absolute --signer-module");
    assertNoSecretOptions(signerOptions, "--signer-options");
    const probe = providerFactory(deployment);
    try {
      const identity = { ...deployment, address, role, externalSigner: { type: "module", module: signerModule, options: signerOptions } };
      await resolveSigner(identity, probe);
    } finally { probe.destroy(); }
  }
  // Verify the protocol before accepting the invitation, without installing any supplied private key.
  const reader = await connectAgent("reader", { config: deploymentFile, configData: deployment, readOnly: true,
    state: path.join(path.resolve(directory), "preflight-state.json"), providerFactory });
  await reader.close();
  const target = await newDirectory(directory);
  let config, participantAddress;
  if (policy.mainnet) {
    participantAddress = address;
    config = { ...deployment, role, address, allowMainnet: true,
      externalSigner: { type: "module", module: signerModule, options: signerOptions } };
  } else {
    const wallet = Wallet.createRandom();
    participantAddress = wallet.address;
    config = { ...deployment, role, address: wallet.address, privateKey: wallet.privateKey };
  }
  await saveJSON(path.join(target, "config.json"), config);
  await saveJSON(path.join(target, "deployment.json"), { ...deployment, rpcUrl: deployment.rpcUrl, fingerprint: deploymentFingerprint(deployment) });
  const participant = { version: "0.6.0", participantId: randomUUID(), deviceId: randomUUID(), createdAt: new Date().toISOString(),
    role, address: participantAddress, realFunds: policy.mainnet, paymentSymbol: deployment.paymentSymbol ?? "TESTUSD", paymentDecimals: deployment.paymentDecimals ?? 6,
    deploymentFingerprint: deploymentFingerprint(deployment), stateDir: path.join(target, "state"),
    configFile: path.join(target, "config.json"), deploymentFile: path.join(target, "deployment.json"),
    status: policy.mainnet ? "needs-real-funds" : "needs-test-gas",
    next: policy.mainnet
      ? "Run doctor. Fund only this address with real ETH for gas and USDC for the per-order cap. This deployment is unaudited; do not proceed until the mainnet readiness and audit gates are met. Share only the public deployment and fingerprint, never another participant's wallet/config."
      : "Run doctor. Fund only this newly generated test wallet with test gas; claim the valueless pilot tokens if buying. Share only the public deployment and fingerprint, never another participant's wallet/config." };
  await saveJSON(path.join(target, "participant.json"), participant);
  return participant;
}

export async function doctor(configFile, stateDir, { providerFactory = providerFor } = {}) {
  const config = await readJSON(configFile), checks = [], policy = networkPolicy(config), realFunds = policy.mainnet;
  const add = (name, ok, next) => checks.push({ name, ok, ...(ok ? {} : { next }) });
  add("node", Number(process.versions.node.split(".")[0]) >= 24, "Install Node.js 24+ in this host environment");
  const state = path.resolve(stateDir);
  try { await mkdir(state, { recursive: true }); const probe = path.join(state, ".doctor-" + randomUUID()); const f = await open(probe, "wx", 0o600); await f.close(); await unlink(probe); add("state-writable", true); }
  catch { add("state-writable", false, "Select a persistent directory within the host's writable workspace"); }
  let agent, provider, balances;
  try {
    if (config.role === "deployer") {
      provider = providerFactory(config);
      add("chain", BigInt(await provider.send("eth_chainId", [])) === BigInt(config.chainId), "Use the expected RPC");
      balances = { gasWei: String(await provider.getBalance(config.address)) };
      if (realFunds) {
        try {
          const signer = await resolveSigner(config, provider);
          add("signer-module", (await signer.getAddress()).toLowerCase() === config.address.toLowerCase(), "Configure externalSigner for this deployer address");
        } catch (error) { add("signer-module", false, error.shortMessage ?? error.message); }
        if (config.paymentToken) {
          const metadata = await readTokenMetadata(provider, config.paymentToken);
          const token = new Contract(config.paymentToken, ERC20_ABI, provider);
          balances.payment = String(await token.balanceOf(config.address));
          balances.paymentSymbol = metadata.symbol;
          balances.paymentDecimals = metadata.decimals;
        }
      }
    } else {
      agent = await connectAgent("reader", { config: configFile, readOnly: true, identityAddress: config.address, providerFactory });
      add("deployment-and-code", true);
      balances = { gasWei: String(await agent.provider.getBalance(config.address ?? ZeroAddress)), payment: String(await agent.token.balanceOf(config.address ?? ZeroAddress)),
        paymentSymbol: config.paymentSymbol ?? "TESTUSD", paymentDecimals: config.paymentDecimals ?? 6 };
      const block = await agent.provider.getBlock("latest");
      add("deployment-confirmations", block.number - config.deploymentBlock + 1 >= policy.confirmations, "Wait for deployment confirmations and retry");
    }
    if (config.address) {
      add("gas", BigInt(balances.gasWei) > 0n, realFunds
        ? `Send real ETH to ${config.address} for gas; never send testnet funds`
        : `Claim test ETH for ${config.address} from the official funds guide; never send mainnet funds`);
      if (config.role === "buyer") {
        const required = BigInt(config.maxOrderAmount ?? 0);
        add("payment-cap", required > 0n, "The deployment manifest must include a positive maxOrderAmount in payment-token base units");
        add("payment-balance", BigInt(balances.payment ?? 0) >= required, realFunds
          ? `Acquire USDC for ${config.address}; the per-order cap is ${config.maxOrderAmount ?? "unset"} base units`
          : "Run claim with this participant config to claim 100 valueless TESTUSD using your test gas");
      }
    }
  } catch { add("rpc-or-deployment", false, realFunds
    ? "Check RPC, chain ID, signer module, deployment fingerprint and matching Skill build; no transactions were sent"
    : "Check RPC reachability, network identity, deployment fingerprint and matching Skill build; no transactions were sent"); }
  finally { await agent?.close(); provider?.destroy(); }
  const report = { ready: checks.every(c => c.ok), role: config.role ?? "reader", address: config.address ?? null,
    network: config.network ?? "local", chainId: config.chainId, stateDir: state, confirmations: policy.confirmations, checks, balances,
    checkedAt: new Date().toISOString(), testOnly: !realFunds, realFunds, auditStatus: realFunds ? "unaudited" : null, transactionsSent: 0,
    wake: "Separate readiness check: configure your existing host session and local scheduler, then test one real wake. A loaded Skill alone does not schedule work." };
  if (checks.find(c => c.name === "state-writable")?.ok) await saveJSON(path.join(state, "doctor.json"), report);
  return report;
}

export async function claimPilotTokens(configFile, stateDir) {
  const config = await readJSON(configFile), policy = networkPolicy(config);
  if (policy.local || policy.mainnet || !["buyer", "seller"].includes(config.role)) throw new Error("Claim is only for a participant's dedicated Base Sepolia test wallet");
  const agent = await connectAgent(config.role, { config: configFile, state: path.join(stateDir, `${config.role}.json`) });
  agent.hostStateBase = path.join(path.resolve(stateDir), "host");
  let journal, record;
  try {
    if (await agent.token.claimed(config.address)) return { status: "already-claimed", balance: String(await agent.token.balanceOf(config.address)), transactionsSent: 0 };
    const session = new TradeSession(agent), proposal = session.proposal("claim-test-tokens", { amount: "100000000", beneficiary: config.address, asset: config.paymentToken });
    journal = await session.journal(); record = journal.begin(proposal);
    await journal.transact(record, "claim_test_tokens", agent.token, "claim", []);
    record.status = "completed"; record.result = { balance: String(await agent.token.balanceOf(config.address)) }; journal.put(record);
    return { ...record.result, ...journal.summary(record), testOnly: true };
  } catch (error) { if (record) { journal.fail(record); error.execution = journal.summary(record); } throw error; }
  finally { journal?.close(); await agent.close(); }
}

export async function bindCodex(participantFile, { sessionId, codex, skillDirectory, allowNonGit = false }) {
  const participant = await readJSON(participantFile);
  if (!/^[0-9a-f-]{36}$/i.test(sessionId ?? "") || !path.isAbsolute(codex ?? "")) throw new Error("Provide the explicit current session UUID and absolute Codex executable path");
  const workspace = path.dirname(path.resolve(participantFile));
  const bindingFile = path.join(workspace, "codex-binding.json"), adapterFile = path.join(workspace, "wake-adapter.json");
  await saveJSON(bindingFile, { sessionId, codex, workspace, configFile: participant.configFile, stateDir: participant.stateDir,
    skillFile: path.join(skillDirectory, "SKILL.md"), allowNonGit });
  await saveJSON(adapterFile, { command: process.execPath, args: [path.join(skillDirectory, "scripts/codex-wake.mjs"), "--binding", bindingFile], cwd: workspace });
  const args = [path.join(skillDirectory, "scripts/wake.mjs"), "--config", participant.configFile, "--state-dir", participant.stateDir, "--adapter", adapterFile, "--timeout-seconds", "300"];
  const shellQuote = text => "'" + text.replaceAll("'", "'\\''") + "'";
  const schedule = { participantId: participant.participantId, execute: process.execPath, args, intervalMinutes: 1,
    windowsTask: { user: "current interactive user", runLevel: "limited", missedRunPolicy: "start when available", multipleInstances: "ignore new", wakeComputer: false },
    cronLine: "* * * * * " + [process.execPath, ...args].map(shellQuote).join(" "),
    installed: false, next: "Participant's own Agent may register this command with their existing scheduler after explaining the persistent task. No project server. Sleep/offline prevents execution; inspect attention.json for user decisions." };
  await saveJSON(path.join(workspace, "wake-schedule.json"), schedule);
  return { bindingFile, adapterFile, scheduleFile: path.join(workspace, "wake-schedule.json"), command: { execute: process.execPath, args },
    realWakeTestRequired: true, installedSystemTask: false, sessionId };
}

export async function exportPilotEvidence(participantFile, outputFile) {
  const participant = await readJSON(participantFile), config = await readJSON(participant.configFile);
  const report = { version: "0.6.0", exportedAt: new Date().toISOString(), participantId: participant.participantId, deviceId: participant.deviceId,
    role: participant.role, address: participant.address, chainId: config.chainId, deploymentFingerprint: deploymentFingerprint(config), actions: [],
    scope: "Participant-supplied evidence. Device IDs are self-reported identifiers, not proof of separate physical devices. No keys, RPC credentials, local paths or model transcripts included." };
  const file = path.join(participant.stateDir, "host.actions.sqlite");
  try {
    await access(file); const db = new DatabaseSync(file, { readOnly: true });
    try {
      for (const row of db.prepare("SELECT body FROM actions ORDER BY rowid").all()) {
        const record = JSON.parse(row.body);
        report.actions.push({ actionId: record.actionId, action: record.kind, executionStatus: record.status, orderId: record.orderId,
          createdAt: record.createdAt, updatedAt: record.updatedAt, receipts: record.steps.filter(s => s.receipt).map(s => {
            const { transactionHash, blockNumber, blockHash, status, gasUsed, step } = s.receipt;
            return { transactionHash, blockNumber, blockHash, status, gasUsed, step };
          }) });
      }
    } finally { db.close(); }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  try {
    const attention = await readJSON(path.join(participant.stateDir, "attention.json"));
    report.lastWake = { sessionId: attention.sessionId, acceptedEventIds: attention.acceptedEventIds,
      completedAt: attention.completedAt, requiresUserAction: attention.requiresUserAction };
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await mkdir(path.dirname(path.resolve(outputFile)), { recursive: true });
  const handle = await open(outputFile, "wx", 0o600);
  try { await handle.writeFile(json(report) + "\n"); } finally { await handle.close(); }
  return { outputFile: path.resolve(outputFile), actions: report.actions.length, keysExported: false, modelTranscriptsExported: false };
}

export async function verifyPilot(deploymentFile, rpcUrl, { providerFactory = providerFor, allowMainnet = false, knownPaymentTokens } = {}) {
  const source = await readJSON(deploymentFile);
  const deployment = publicDeployment(source);
  if (rpcUrl) deployment.rpcUrl = rpcUrl;
  const policy = networkPolicy(deployment);
  if (policy.mainnet && !allowMainnet) throw new Error("Base mainnet verification requires --allow-mainnet");
  const external = deployment.paymentTokenSource === "external";
  const fingerprint = deploymentFingerprint(deployment);
  const checks = [];
  const add = (name, ok, next, detail) => checks.push({
    name, ok, ...(ok || !next ? {} : { next }), ...(detail === undefined ? {} : { detail })
  });
  add("manifest", validManifest(deployment), "Use the public deployment.json produced by pilot deploy, not a preparation or wallet file");
  add("fingerprint", !source.fingerprint || source.fingerprint === fingerprint,
    "The manifest fingerprint does not match its contents; verify the invitation out of band");
  if (!validManifest(deployment)) return { ready: false, fingerprint, checks, transactionsSent: 0 };

  const provider = providerFactory(deployment);
  try {
    const chainId = BigInt(await provider.send("eth_chainId", []));
    add("chain-id", chainId === BigInt(deployment.chainId), "Connect to the RPC for the manifest chain");
    const block = await provider.getBlock(deployment.deploymentBlock);
    add("deployment-block", block?.hash === deployment.deploymentBlockHash,
      "The deployment block hash changed; do not use this manifest",
      { number: deployment.deploymentBlock, hash: block?.hash ?? null });
    const latest = await provider.getBlock("latest");
    const depth = latest.number - deployment.deploymentBlock + 1;
    add("confirmations", depth >= policy.confirmations, `Wait for ${policy.confirmations} confirmations`,
      { depth, required: policy.confirmations });

    const artifacts = {
      contract: await build("OrderNetwork"),
      paymentToken: external ? { abi: ERC20_ABI } : await build("PilotPaymentToken"),
      payloadStore: await build("OrderPayloads")
    };
    const actualHashes = {};
    let codeOk = true;
    const hashKeys = external ? ["contract", "payloadStore"] : ["contract", "paymentToken", "payloadStore"];
    for (const key of hashKeys) {
      try {
        actualHashes[key] = await verifyRuntime(provider, deployment[key], artifacts[key]);
        if (actualHashes[key] !== deployment.codeHashes[key]) codeOk = false;
      } catch {
        actualHashes[key] = null;
        codeOk = false;
      }
    }
    add("code-hashes", codeOk, "The runtime code does not match this Skill build or the manifest",
      { expected: deployment.codeHashes, actual: actualHashes });

    const contract = new Contract(deployment.contract, artifacts.contract.abi, provider);
    const token = new Contract(deployment.paymentToken, artifacts.paymentToken.abi, provider);
    let linkedToken = null;
    try { linkedToken = await contract.paymentToken(); } catch { /* reported as a failed check */ }
    add("payment-token-link", linkedToken?.toLowerCase() === deployment.paymentToken.toLowerCase(),
      "OrderNetwork does not use the manifest payment token", { linkedToken });

    let domain = null;
    try { domain = await contract.eip712Domain(); } catch { /* reported as a failed check */ }
    add("signing-domain", Boolean(domain) && domain.name === "AgentOrderNetwork" && domain.version === "1" &&
      domain.chainId === BigInt(deployment.chainId) &&
      domain.verifyingContract?.toLowerCase() === deployment.contract.toLowerCase(),
      "The contract signing domain does not match the manifest",
      { name: domain?.name ?? null, version: domain?.version ?? null, chainId: domain?.chainId?.toString?.() ?? null, verifyingContract: domain?.verifyingContract ?? null });

    let symbol = null, decimals = null, tokenCode = "0x";
    try {
      [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
      tokenCode = await provider.getCode(deployment.paymentToken);
    } catch { /* reported below */ }
    const expectedSymbol = deployment.paymentSymbol ?? (external ? "USDC" : null);
    const expectedDecimals = Number(deployment.paymentDecimals ?? 6);
    add("payment-asset", decimals !== null && Number(decimals) === expectedDecimals && (!expectedSymbol || symbol === expectedSymbol),
      `The payment asset must be ${expectedSymbol ?? "the manifest token"} with ${expectedDecimals} decimals`,
      { symbol, decimals: decimals?.toString?.() ?? null });
    if (external) {
      add("payment-token-code", tokenCode !== "0x", "The payment token has no contract code at the manifest address");
      const allowed = knownPaymentTokens ?? (deployment.chainId === 8453 ? [BASE_MAINNET.paymentToken] : []);
      add("payment-token-canonical", allowed.some(address => address.toLowerCase() === deployment.paymentToken.toLowerCase()),
        "The payment token is not in the canonical allowlist for this deployment",
        { allowed });
    }

    const explorerBase = deployment.explorer ?? profileFor(deployment)?.explorer ?? BASE_SEPOLIA.explorer;
    const explorer = {
      contract: `${explorerBase}/address/${deployment.contract}`,
      paymentToken: `${explorerBase}/address/${deployment.paymentToken}`,
      payloadStore: `${explorerBase}/address/${deployment.payloadStore}`
    };
    return {
      ready: checks.every(check => check.ok), fingerprint, network: deployment.network, chainId: deployment.chainId,
      confirmations: policy.confirmations, deploymentBlock: deployment.deploymentBlock, latestBlock: latest.number, depth,
      contracts: { orders: deployment.contract, paymentToken: deployment.paymentToken, payloadStore: deployment.payloadStore },
      evaluator: deployment.evaluator, explorer, checks, codeHashes: actualHashes, transactionsSent: 0,
      realFunds: policy.mainnet, auditStatus: policy.mainnet ? "unaudited" : null,
      warnings: policy.mainnet ? [
        "Base USDC can be frozen or paused by Circle; this immutable contract has no rescue or pause.",
        "This deployment is unaudited. Do not use real funds until the mainnet readiness gates are met."
      ] : []
    };
  } finally { provider.destroy(); }
}

export async function invitePilot(deploymentFile, outputFile, { allowMainnet = false } = {}) {
  const source = await readJSON(deploymentFile);
  const deployment = publicDeployment(source);
  const policy = networkPolicy(deployment);
  if (policy.mainnet && !allowMainnet) throw new Error("Base mainnet invitation requires --allow-mainnet");
  if (!validManifest(deployment)) throw new Error("Deployment manifest is incomplete; use the public deployment.json produced by pilot deploy");
  const fingerprint = deploymentFingerprint(deployment);
  if (source.fingerprint && source.fingerprint !== fingerprint) throw new Error("Deployment fingerprint mismatch; do not distribute this invitation");

  const target = path.resolve(outputFile);
  await mkdir(path.dirname(target), { recursive: true });
  const mainnetText = `# OrderPact — Base mainnet USDC invitation

**Real funds. Unaudited. Do not proceed until the mainnet readiness gates are met.**

This invitation is for a Base mainnet deployment using USDC. USDC has real value. The contracts are immutable and unaudited; Circle can freeze or pause USDC, and there is no admin, rescue, or pause.

## Deployment

- Network: ${deployment.network} (chainId ${deployment.chainId})
- Protocol: ${deployment.protocolVersion ?? "0.6.0"}
- OrderNetwork: ${deployment.contract}
- Payment token: ${deployment.paymentSymbol ?? "USDC"} (${deployment.paymentDecimals ?? 6} decimals) at ${deployment.paymentToken}
- Payload store: ${deployment.payloadStore}
- Evaluator: ${deployment.evaluator} (offline by default; arbitration timeout refunds the buyer)
- Deployment block: ${deployment.deploymentBlock}
- Deployment block hash: ${deployment.deploymentBlockHash}
- Required confirmations: ${policy.confirmations}
- Max order amount: ${deployment.maxOrderAmount ?? "unset"} in USDC base units
- Fingerprint: ${fingerprint}

Verify this fingerprint out of band with the inviter before joining. Use only the attached public deployment file (${path.basename(deploymentFile)}); never accept a wallet, private key, or participant config from someone else.

## What you need

- The matching p2p-orders Skill package.
- The public deployment.json attached to this invitation.
- Your own host with Node.js 24+, a writable persistent state directory, and an RPC endpoint.
- An external signer module backed by KMS, HSM, or a hardware wallet. Plaintext private keys are rejected on mainnet.
- Real ETH for gas and USDC for orders. Never send testnet funds.
- Your own buyer or seller intent. Do not reuse another participant's wallet or state directory.

## Join and check

\`\`\`text
node "<skill>/scripts/pilot.mjs" join --deployment "<deployment.json>" --fingerprint "${fingerprint}" --role buyer|seller --address "<your address>" --signer-module "<absolute signer module path>" --allow-mainnet --out "<new participant directory>"
node "<skill>/scripts/pilot.mjs" doctor --config "<participant directory>/config.json" --state-dir "<participant directory>/state"
\`\`\`

## Rules

- Real funds. USDC has value. This deployment is unaudited.
- USDC can be frozen or paused by Circle. The immutable contract has no rescue or pause.
- Orders and deliveries are public. Use only public tasks; never put secrets or personal data on-chain.
- Review silence can pay the provider; arbitration timeout refunds the buyer.
- There is no automatic arbitrator. The evaluator is offline by default.
- Deadlines continue while your host is offline. Run your own scheduler and keep the state directory.
- The approval digest binds content but is not proof of human consent. Keep your own authorization boundary.
- Never share wallets, private keys, session logs, or state directories.

## Verify the deployment

\`\`\`text
node "<skill>/scripts/pilot.mjs" verify --deployment "<deployment.json>" --allow-mainnet
\`\`\`
`;

  const testnetText = `# OrderPact — Base Sepolia pilot invitation

This is an invitation to a test-only peer-to-peer order pilot. ${deployment.paymentSymbol ?? "TESTUSD"} has no value and no USD redemption. Never send mainnet assets.

## Deployment

- Network: ${deployment.network} (chainId ${deployment.chainId})
- Protocol: ${deployment.protocolVersion ?? "0.6.0"}
- OrderNetwork: ${deployment.contract}
- Payment token: ${deployment.paymentSymbol ?? "TESTUSD"} (${deployment.paymentDecimals ?? 6} decimals)
- Payload store: ${deployment.payloadStore}
- Evaluator: ${deployment.evaluator} (offline by default; arbitration timeout refunds the buyer)
- Deployment block: ${deployment.deploymentBlock}
- Deployment block hash: ${deployment.deploymentBlockHash}
- Required confirmations: ${policy.confirmations}
- Fingerprint: ${fingerprint}

Verify this fingerprint out of band with the inviter before joining. Use only the attached public deployment file (${path.basename(deploymentFile)}); never accept a wallet, private key, or participant config from someone else.

## What you need

- The matching p2p-orders Skill package.
- The public deployment.json attached to this invitation.
- Your own host with Node.js 24+, a writable persistent state directory, and an RPC endpoint.
- Your own buyer or seller intent. Do not reuse another participant's wallet or state directory.

## Join and check

\`\`\`text
node "<skill>/scripts/pilot.mjs" join --deployment "<deployment.json>" --fingerprint "${fingerprint}" --role buyer|seller --out "<new participant directory>"
node "<skill>/scripts/pilot.mjs" doctor --config "<participant directory>/config.json" --state-dir "<participant directory>/state"
\`\`\`

If test gas is missing, show only your new public address and the official Base Sepolia funds guide. Never buy test tokens or send mainnet funds. A buyer with test gas can claim 100 valueless TESTUSD once:

\`\`\`text
node "<skill>/scripts/pilot.mjs" claim --config "<participant directory>/config.json" --state-dir "<participant directory>/state"
\`\`\`

## Rules

- Testnet only. TESTUSD has no value.
- Orders and deliveries are public. Use only small public tasks; never put secrets or personal data on-chain.
- Review silence can pay the provider; arbitration timeout refunds the buyer.
- There is no automatic arbitrator. The evaluator is offline by default.
- Deadlines continue while your host is offline. Run your own scheduler and keep the state directory.
- The approval digest binds content but is not proof of human consent. Keep your own authorization boundary.
- Never share wallets, private keys, session logs, or state directories.

## Verify the deployment

\`\`\`text
node "<skill>/scripts/pilot.mjs" verify --deployment "<deployment.json>"
\`\`\`

The verify command checks the chain ID, deployment block hash, confirmation depth, runtime code hashes, payment token link, signing domain, and 6-decimal payment asset.`;

  try {
    await writeFile(target, policy.mainnet ? mainnetText : testnetText, { flag: "wx", mode: 0o644 });
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("Invitation file already exists; choose a new --out path");
    throw error;
  }
  return {
    fingerprint, outFile: target, network: deployment.network, chainId: deployment.chainId,
    contract: deployment.contract, paymentToken: deployment.paymentToken, evaluator: deployment.evaluator,
    deploymentBlock: deployment.deploymentBlock, realFunds: policy.mainnet, auditStatus: policy.mainnet ? "unaudited" : null, transactionsSent: 0,
    next: policy.mainnet
      ? "Share only after the readiness gates. Never share wallets, private keys, or state directories."
      : "Share this invitation, the public deployment.json, and the matching Skill package. Never share wallets, private keys, or state directories."
  };
}

export async function runPilot(argv = process.argv.slice(2), { output = process.stdout,
  skillDirectory = fileURLToPath(new URL("../skills/p2p-orders", import.meta.url)) } = {}) {
  try {
    const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: { out: { type: "string" }, wallet: { type: "string" },
      config: { type: "string" }, "state-dir": { type: "string" }, deployment: { type: "string" }, role: { type: "string" }, fingerprint: { type: "string" }, rpc: { type: "string" },
      participant: { type: "string" }, session: { type: "string" }, codex: { type: "string" }, "allow-non-git": { type: "boolean", default: false },
      mainnet: { type: "boolean", default: false }, "allow-mainnet": { type: "boolean", default: false },
      address: { type: "string" }, evaluator: { type: "string" }, "signer-module": { type: "string" }, "signer-options": { type: "string" },
      "payment-token": { type: "string" }, "max-order-amount": { type: "string" } } });
    const command = positionals[0]; let result;
    let signerOptions = {};
    if (values["signer-options"]) {
      try { signerOptions = JSON.parse(values["signer-options"]); } catch { throw new Error("--signer-options must be a JSON object"); }
      if (!signerOptions || typeof signerOptions !== "object" || Array.isArray(signerOptions)) throw new Error("--signer-options must be a JSON object");
    }
    if (command === "prepare" && values.out) result = await preparePilot(values.out, values.rpc, { mainnet: values.mainnet, address: values.address,
      evaluator: values.evaluator, signerModule: values["signer-module"], signerOptions, maxOrderAmount: values["max-order-amount"] ?? "2000000" });
    else if (command === "deploy" && values.wallet && values.out) result = await deployPilot(values.wallet, values.out, { existingPaymentToken: values["payment-token"], allowMainnet: values["allow-mainnet"] });
    else if (command === "verify" && values.deployment) result = await verifyPilot(values.deployment, values.rpc, { allowMainnet: values["allow-mainnet"] });
    else if (command === "invite" && values.deployment && values.out) result = await invitePilot(values.deployment, values.out, { allowMainnet: values["allow-mainnet"] });
    else if (command === "join" && values.deployment && values.role && values.out) result = await joinPilot({ deploymentFile: values.deployment, role: values.role,
      directory: values.out, fingerprint: values.fingerprint, rpcUrl: values.rpc, address: values.address, signerModule: values["signer-module"],
      signerOptions, allowMainnet: values["allow-mainnet"] });
    else if (command === "doctor" && values.config && values["state-dir"]) result = await doctor(values.config, values["state-dir"]);
    else if (command === "claim" && values.config && values["state-dir"]) result = await claimPilotTokens(values.config, values["state-dir"]);
    else if (command === "bind-codex" && values.participant) result = await bindCodex(values.participant, { sessionId: values.session, codex: values.codex, skillDirectory, allowNonGit: values["allow-non-git"] });
    else if (command === "export-evidence" && values.participant && values.out) result = await exportPilotEvidence(values.participant, values.out);
    else if (command === "status" && values.participant) {
      const p = await readJSON(values.participant);
      let attention = null; try { attention = await readJSON(path.join(p.stateDir, "attention.json")); } catch (error) { if (error.code !== "ENOENT") throw error; }
      result = { participantId: p.participantId, ...await doctor(p.configFile, p.stateDir), attention };
    } else throw new Error("Use prepare --out [--mainnet --address --evaluator --signer-module], deploy --wallet --out [--allow-mainnet], verify --deployment [--rpc] [--allow-mainnet], invite --deployment --out [--allow-mainnet], join --deployment --fingerprint --role --out [--address --signer-module --allow-mainnet], doctor/claim --config --state-dir, bind-codex --participant --session --codex, or status --participant");
    output.write(json({ ok: true, command, result }) + "\n"); return 0;
  } catch (error) {
    const message = error.code && !["ENOENT", "EEXIST"].includes(error.code) ? "RPC or transaction operation failed; inspect your local state and retry reads before any new write" : error.message;
    output.write(json({ ok: false, error: { message: String(message).replace(/0x[0-9a-fA-F]{64}/g, "[redacted-32-byte-value]").slice(0, 1200), ...(error.execution ? { execution: error.execution } : {}) } }) + "\n"); return 1;
  }
}
