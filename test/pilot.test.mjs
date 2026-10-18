import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { BrowserProvider, Contract, parseEther } from "ethers";
import hre from "hardhat";
import { BASE_SEPOLIA, networkPolicy, verifyRuntime } from "../src/networks.mjs";
import { preparePilot, deployPilot, verifyPilot, invitePilot, publicDeployment, deploymentFingerprint, bindCodex } from "../src/pilot.mjs";
import { readJSON, saveJSON } from "../src/agent-runtime.mjs";

test("testnet allowlist rejects mainnets, wrong profiles and insufficient confirmation depth", () => {
  const config = { ...BASE_SEPOLIA, network: "base-sepolia", testOnly: true };
  assert.equal(networkPolicy(config).local, false);
  for (const changes of [{ chainId: 8453 }, { chainId: 1 }, { testOnly: false }, { confirmations: 1 }, { rpcUrl: "http://sepolia.base.org" }, { rpcUrl: "https://127.0.0.1" }, { environment: "local-development" }]) {
    assert.throws(() => networkPolicy({ ...config, ...changes }));
  }
});

test("pilot preparation creates fresh test identities without disclosing keys or overwriting; invitation is public only", async () => {
  const directory = path.resolve(".local-demo/pilot-tests", randomUUID());
  const result = await preparePilot(directory);
  const wallet = await readJSON(result.walletFile);
  assert.equal(result.status, "needs-test-gas"); assert.equal(wallet.chainId, 84532);
  assert.ok(!JSON.stringify(result).includes(wallet.privateKey));
  await assert.rejects(preparePilot(directory), /exist/);
  const invitation = publicDeployment({ ...wallet, privateKey: "secret", inputPath: "private", address: "private", contract: "example" });
  assert.equal(invitation.privateKey, undefined); assert.equal(invitation.address, undefined); assert.equal(invitation.inputPath, undefined);
  assert.equal(deploymentFingerprint(invitation), deploymentFingerprint({ ...invitation, rpcUrl: "https://other.example" }));
  assert.notEqual(deploymentFingerprint(invitation), deploymentFingerprint({ ...invitation, contract: "changed" }));
});

test("public deployment workflow is restartable on simulated 84532, pins code, and needs no token faucet server", { timeout: 60000 }, async t => {
  const connection = await hre.network.create("pilotTest");
  const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 }); provider.pollingInterval = 20;
  const deployer = await provider.getSigner(0);
  const directory = path.resolve(".local-demo/pilot-tests", randomUUID());
  const preparation = await preparePilot(directory);
  await (await deployer.sendTransaction({ to: preparation.deployer, value: parseEther("1") })).wait();
  const mining = setInterval(() => { connection.provider.request({ method: "evm_mine", params: [] }).catch(() => {}); }, 75);
  t.after(async () => { clearInterval(mining); provider.destroy(); await connection.close(); });
  const factory = () => { const p = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 }); p.pollingInterval = 20; return p; };
  const output = path.join(directory, "public");
  const deployed = await deployPilot(preparation.walletFile, output, { providerFactory: factory });
  assert.equal(deployed.status, "deployed"); assert.equal(deployed.receipts.length, 3);
  const manifest = await readJSON(deployed.deploymentFile);
  assert.equal(manifest.privateKey, undefined); assert.equal(manifest.rpcUrl, BASE_SEPOLIA.rpcUrl);
  assert.equal(manifest.fingerprint, deploymentFingerprint(manifest));
  const tokenArtifact = await readJSON(new URL("../artifacts/PilotPaymentToken.json", import.meta.url));
  const token = new Contract(manifest.paymentToken, tokenArtifact.abi, await provider.getSigner(1));
  await (await token.claim()).wait();
  assert.equal(await token.balanceOf(await (await provider.getSigner(1)).getAddress()), 100000000n);
  await assert.rejects(token.claim.staticCall());
  assert.equal(await verifyRuntime(provider, manifest.paymentToken, tokenArtifact), manifest.codeHashes.paymentToken);
  await assert.rejects(verifyRuntime(provider, manifest.contract, tokenArtifact), /runtime/);
  const again = await deployPilot(preparation.walletFile, output, { providerFactory: factory });
  assert.equal(again.receipts.length, 3); assert.equal(again.fingerprint, deployed.fingerprint);
  const network = new Contract(manifest.contract, (await readJSON(new URL("../artifacts/OrderNetwork.json", import.meta.url))).abi, provider);
  assert.equal(await network.orderCount(), 0n);

  for (let i = 0; i < 5; i++) await connection.provider.request({ method: "evm_mine", params: [] });
  const verified = await verifyPilot(deployed.deploymentFile, undefined, { providerFactory: factory });
  assert.equal(verified.ready, true);
  assert.equal(verified.fingerprint, deployed.fingerprint);
  assert.equal(verified.contracts.orders.toLowerCase(), manifest.contract.toLowerCase());
  assert.ok(verified.checks.every(check => check.ok));
  assert.equal(verified.transactionsSent, 0);

  const invitationFile = path.join(directory, "public", "invitation.txt");
  const invited = await invitePilot(deployed.deploymentFile, invitationFile);
  assert.equal(invited.fingerprint, deployed.fingerprint);
  const invitation = await readFile(invitationFile, "utf8");
  assert.ok(invitation.includes(deployed.fingerprint));
  assert.ok(invitation.includes(manifest.contract));
  assert.ok(!invitation.includes("privateKey"));
  await assert.rejects(invitePilot(deployed.deploymentFile, invitationFile), /exists/);
});

test("session binding is explicit, local, and exports a scheduler command without installing a task", async () => {
  const directory = path.resolve(".local-demo/pilot-tests", randomUUID());
  const participantFile = path.join(directory, "participant.json");
  await saveJSON(participantFile, { participantId: randomUUID(), configFile: path.join(directory, "config.json"), stateDir: path.join(directory, "state") });
  const result = await bindCodex(participantFile, { sessionId: randomUUID(), codex: process.execPath, skillDirectory: path.resolve("skills/p2p-orders") });
  assert.equal(result.installedSystemTask, false);
  const schedule = await readJSON(result.scheduleFile);
  assert.equal(schedule.intervalMinutes, 1); assert.equal(schedule.installed, false);
  await assert.rejects(bindCodex(participantFile, { sessionId: "--last", codex: "codex", skillDirectory: "." }), /explicit/);
});
