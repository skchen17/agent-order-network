import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { BrowserProvider, ContractFactory, Wallet, parseEther } from "ethers";
import hre from "hardhat";
import { BASE_MAINNET, networkPolicy } from "../src/networks.mjs";
import { preparePilot, deployPilot, joinPilot, doctor, claimPilotTokens, verifyPilot, invitePilot } from "../src/pilot.mjs";
import { resolveSigner } from "../src/signers.mjs";
import { readJSON, saveJSON } from "../src/agent-runtime.mjs";

async function mainnetFixture(t) {
  const connection = await hre.network.create("mainnetTest");
  const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 20;
  const mining = setInterval(() => { connection.provider.request({ method: "evm_mine", params: [] }).catch(() => {}); }, 30);
  t.after(async () => { clearInterval(mining); provider.destroy(); await connection.close(); });
  const funder = await provider.getSigner(0);
  const wallet = Wallet.createRandom();
  await (await funder.sendTransaction({ to: wallet.address, value: parseEther("1") })).wait();
  const evaluator = Wallet.createRandom();
  const tokenArtifact = await readJSON(new URL("../artifacts/MockUSDC.json", import.meta.url));
  const token = await new ContractFactory(tokenArtifact.abi, tokenArtifact.bytecode, funder)
    .deploy(wallet.address, 1_000_000_000n);
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();
  const directory = path.resolve(".local-demo/mainnet-tests", randomUUID());
  const signerDirectory = path.join(directory, "signer");
  await mkdir(signerDirectory, { recursive: true });
  const signerModule = path.join(signerDirectory, "signer.mjs");
  const keyFile = path.join(signerDirectory, "key.txt");
  await writeFile(keyFile, wallet.privateKey, { mode: 0o600 });
  await writeFile(signerModule, `import { readFile } from "node:fs/promises";
import { Wallet } from "ethers";
export async function createSigner({ provider, options }) {
  const privateKey = (await readFile(options.keyFile, "utf8")).trim();
  return new Wallet(privateKey, provider);
}
`);
  const config = {
    environment: "public-mainnet", network: "base", testOnly: false, allowMainnet: true,
    chainId: 8453, rpcUrl: BASE_MAINNET.rpcUrl, confirmations: 10, explorer: BASE_MAINNET.explorer,
    deploymentId: randomUUID(), role: "deployer", address: wallet.address, evaluator: evaluator.address,
    paymentToken: tokenAddress, paymentTokenSource: "external", paymentSymbol: "USDC", paymentDecimals: 6,
    maxOrderAmount: "2000000", indexBlockSpan: 500,
    externalSigner: { type: "module", module: signerModule, options: { keyFile } }
  };
  const configFile = path.join(directory, "deployer.json");
  await saveJSON(configFile, config);
  const factory = () => {
    const p = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
    p.pollingInterval = 20;
    return p;
  };
  const mine = async count => {
    for (let i = 0; i < count; i++) await connection.provider.request({ method: "evm_mine", params: [] });
  };
  return { connection, provider, factory, mine, wallet, evaluator, token, tokenAddress, directory, configFile, config, signerModule, keyFile };
}

test("Base mainnet policy is opt-in and rejects unsafe profiles", () => {
  const base = { environment: "public-mainnet", network: "base", chainId: 8453, testOnly: false,
    allowMainnet: true, rpcUrl: "https://mainnet.base.org", confirmations: 10 };
  assert.equal(networkPolicy(base).mainnet, true);
  for (const patch of [
    { allowMainnet: undefined },
    { testOnly: true },
    { network: "base-mainnet" },
    { chainId: 84532 },
    { rpcUrl: "http://mainnet.base.org" },
    { rpcUrl: "https://localhost" },
    { rpcUrl: "https://user:pass@mainnet.base.org" },
    { confirmations: 9 },
    { confirmations: 101 }
  ]) {
    assert.throws(() => networkPolicy({ ...base, ...patch }), undefined, JSON.stringify(patch));
  }
});

test("mainnet rejects plaintext keys and accepts an external signer module", async t => {
  const f = await mainnetFixture(t);
  await assert.rejects(
    resolveSigner({ ...f.config, externalSigner: undefined, privateKey: f.wallet.privateKey }, f.provider),
    /plaintext privateKey|externalSigner/
  );
  const signer = await resolveSigner(f.config, f.provider);
  assert.equal((await signer.getAddress()).toLowerCase(), f.wallet.address.toLowerCase());
});

test("mainnet deploy uses existing USDC, verifies, invites, joins and refuses claim", { timeout: 60000 }, async t => {
  const f = await mainnetFixture(t);
  const output = path.join(f.directory, "public");
  const deployed = await deployPilot(f.configFile, output, { providerFactory: f.factory, allowMainnet: true, knownPaymentTokens: [f.tokenAddress] });
  assert.equal(deployed.status, "deployed");
  assert.equal(deployed.receipts.length, 2);
  assert.equal(deployed.realFunds, true);

  const manifest = await readJSON(deployed.deploymentFile);
  assert.equal(manifest.environment, "public-mainnet");
  assert.equal(manifest.testOnly, false);
  assert.equal(manifest.allowMainnet, true);
  assert.equal(manifest.paymentTokenSource, "external");
  assert.equal(manifest.paymentSymbol, "USDC");
  assert.equal(manifest.paymentDecimals, 6);
  assert.equal(manifest.paymentToken, f.tokenAddress);
  assert.equal(manifest.codeHashes.paymentToken, undefined);
  assert.ok(manifest.codeHashes.contract);
  assert.ok(manifest.codeHashes.payloadStore);
  assert.equal(manifest.privateKey, undefined);

  await f.mine(12);
  const verified = await verifyPilot(deployed.deploymentFile, undefined, {
    providerFactory: f.factory, allowMainnet: true, knownPaymentTokens: [f.tokenAddress]
  });
  assert.equal(verified.ready, true);
  assert.equal(verified.realFunds, true);
  assert.equal(verified.auditStatus, "unaudited");
  assert.ok(verified.checks.find(check => check.name === "payment-token-canonical").ok);
  assert.ok(verified.checks.find(check => check.name === "payment-token-code").ok);
  assert.ok(verified.warnings.length > 0);

  const invitationFile = path.join(output, "invitation.txt");
  const invited = await invitePilot(deployed.deploymentFile, invitationFile, { allowMainnet: true });
  assert.equal(invited.realFunds, true);
  const invitation = await readFile(invitationFile, "utf8");
  assert.ok(invitation.includes("Base mainnet"));
  assert.ok(invitation.includes("USDC"));
  assert.ok(invitation.includes("unaudited"));
  assert.ok(!invitation.includes("faucet"));
  assert.ok(!invitation.includes("claim"));
  await assert.rejects(invitePilot(deployed.deploymentFile, path.join(output, "invitation-2.txt")), /--allow-mainnet/);

  const participantDir = path.join(f.directory, "buyer");
  const participant = await joinPilot({
    deploymentFile: deployed.deploymentFile, role: "buyer", directory: participantDir,
    fingerprint: deployed.fingerprint, address: f.wallet.address, signerModule: f.signerModule,
    signerOptions: { keyFile: f.keyFile }, allowMainnet: true, providerFactory: f.factory
  });
  assert.equal(participant.realFunds, true);
  const participantConfig = await readJSON(path.join(participantDir, "config.json"));
  assert.equal(participantConfig.privateKey, undefined);
  assert.equal(participantConfig.externalSigner.module, f.signerModule);
  assert.equal(participantConfig.allowMainnet, true);

  const report = await doctor(f.configFile, path.join(f.directory, "doctor-state"), { providerFactory: f.factory });
  assert.equal(report.realFunds, true);
  assert.equal(report.testOnly, false);
  assert.equal(report.auditStatus, "unaudited");
  assert.ok(report.checks.find(check => check.name === "signer-module").ok);

  await assert.rejects(claimPilotTokens(f.configFile, path.join(f.directory, "state")), /Claim is only/);

  const prepared = await preparePilot(path.join(f.directory, "prepared"), undefined, {
    mainnet: true, address: f.wallet.address, evaluator: f.evaluator.address, signerModule: f.signerModule
  });
  assert.equal(prepared.realFunds, true);
  const preparedConfig = await readJSON(prepared.walletFile);
  assert.equal(preparedConfig.privateKey, undefined);
  assert.equal(preparedConfig.externalSigner.module, f.signerModule);
});
