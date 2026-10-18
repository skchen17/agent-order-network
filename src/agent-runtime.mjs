import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { JsonRpcProvider, Wallet, NonceManager, Contract, VoidSigner, ZeroAddress } from "ethers";
import { OrderClient } from "./order-client.mjs";
import { PayloadClient } from "./payload-client.mjs";
import { networkPolicy, verifyRuntime, createProvider } from "./networks.mjs";

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const json = value => JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2);

export async function readJSON(file) { return JSON.parse(await readFile(file, "utf8")); }
export async function saveJSON(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, json(value) + "\n", { mode: 0o600 });
  await rename(temp, file);
}

export function progress(role, event, extra = {}) {
  const record = { role, event, pid: process.pid, ...extra };
  console.log(JSON.stringify(record));
  if (process.connected) process.send(record);
}

export async function recoverStateRace(agent, orderId, observedStatus, error) {
  if (error.code !== "CALL_EXCEPTION") throw error;
  const latest = await agent.client.contract.getOrder(orderId);
  if (Number(latest.status) === observedStatus) throw error;
  // A concurrent on-chain transition may invalidate gas estimation. Refresh the local nonce too.
  agent.signer.reset();
  progress(agent.config.role, "state_changed_retry", { orderId: orderId.toString() });
}

export async function openAgent(role) {
  const { values } = parseArgs({ options: {
    config: { type: "string" }, state: { type: "string" },
    "pause-after-publish": { type: "boolean", default: false },
    "pause-before-delivery": { type: "boolean", default: false },
    task: { type: "string" }, serve: { type: "boolean", default: false },
    "max-orders": { type: "string", default: "0" },
    mode: { type: "string", default: "normal" }
  } });
  return connectAgent(role, values);
}

// Also used by the human-confirmed local client; it supplies its own CLI arguments.
export async function connectAgent(role, values) {
  if (!values.config) throw new Error("Use --config <your-role-config.json>");
  if (values.mode && !["normal", "withhold", "invalid"].includes(values.mode)) throw new Error("Unknown test mode");
  if (values.configData && !values.readOnly) throw new Error("Inline deployment descriptors are only accepted for keyless reads");
  const config = values.configData ? structuredClone(values.configData) : await readJSON(path.resolve(values.config));
  if (values.readOnly) {
    // Public discovery needs only a deployment descriptor, never a private key.
    delete config.privateKey;
    config.role = "reader";
    config.address = values.identityAddress ?? ZeroAddress;
  }
  const policy = networkPolicy(config);
  if (config.role !== role) throw new Error("Role-specific configuration required");
  const provider = createProvider(config);
  try {
    if (BigInt(await provider.send("eth_chainId", [])) !== BigInt(config.chainId)) throw new Error("Wrong chain");
    const deploymentBlock = await provider.getBlock(config.deploymentBlock);
    if (deploymentBlock?.hash !== config.deploymentBlockHash) throw new Error("Deployment changed; use a new config and state directory");
    const wallet = values.readOnly ? new VoidSigner(config.address, provider) : new Wallet(config.privateKey, provider);
    if (wallet.address.toLowerCase() !== config.address.toLowerCase()) throw new Error("Wallet identity mismatch");
    const signer = values.readOnly ? wallet : new NonceManager(wallet);
    const artifact = await readJSON(new URL("../artifacts/OrderNetwork.json", import.meta.url));
    const tokenArtifact = await readJSON(new URL(`../artifacts/${policy.local ? "MockPaymentToken" : "PilotPaymentToken"}.json`, import.meta.url));
    const client = new OrderClient(config.contract, artifact.abi, signer);
    if ((await client.contract.paymentToken()).toLowerCase() !== config.paymentToken.toLowerCase()) throw new Error("Wrong payment asset");
    const token = new Contract(config.paymentToken, tokenArtifact.abi, signer);
    const payloadArtifact = await readJSON(new URL("../artifacts/OrderPayloads.json", import.meta.url));
    if (!policy.local) {
      if (!config.codeHashes || !config.payloadStore) throw new Error("Verified public deployment descriptor required");
      for (const [key, address, build] of [["contract", config.contract, artifact], ["paymentToken", config.paymentToken, tokenArtifact], ["payloadStore", config.payloadStore, payloadArtifact]]) {
        if (await verifyRuntime(provider, address, build) !== config.codeHashes[key]) throw new Error("Deployment code fingerprint changed");
      }
      const domain = await client.contract.eip712Domain();
      if (domain.chainId !== BigInt(config.chainId) || domain.verifyingContract.toLowerCase() !== config.contract.toLowerCase()) throw new Error("Wrong signing domain");
    }
    const payloads = config.payloadStore ? new PayloadClient({ address: config.payloadStore, abi: payloadArtifact.abi, signer,
      chainId: config.chainId, fromBlock: config.deploymentBlock }) : null;
    const stateFile = path.resolve(values.state ?? path.join(path.dirname(values.config), "state.json"));
    let state;
    try { state = await readJSON(stateFile); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (state && (state.deploymentId !== config.deploymentId || state.address !== config.address || state.role !== role)) {
      throw new Error("State belongs to a different identity or deployment");
    }
    state ??= { role, deploymentId: config.deploymentId, address: config.address };
    async function persist(event, extra = {}) {
      Object.assign(state, extra, { event, pid: process.pid });
      await saveJSON(stateFile, state);
      progress(role, event, { orderId: state.orderId, status: state.status, reason: state.reason });
    }
    return { config, policy, values, provider, signer, client, token, payloads, state, stateFile, persist,
      async now() { return Number((await provider.getBlock("latest")).timestamp); },
      async close() { provider.destroy(); if (process.connected) process.disconnect(); }
    };
  } catch (error) { provider.destroy(); throw error; }
}
