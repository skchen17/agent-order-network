import { readFile } from "node:fs/promises";
import { BrowserProvider, ContractFactory } from "ethers";
import hre from "hardhat";

export async function loadArtifact(name) {
  return JSON.parse(await readFile(new URL(`../artifacts/${name}.json`, import.meta.url), "utf8"));
}

export async function createLocalChain() {
  const connection = await hre.network.create("local");
  const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 10;
  const signers = await Promise.all([0, 1, 2, 3, 4].map(index => provider.getSigner(index)));
  const [buyer, seller, evaluator, stranger, secondSeller] = signers;
  const tokenArtifact = await loadArtifact("MockPaymentToken");
  const artifact = await loadArtifact("OrderNetwork");
  const token = await new ContractFactory(tokenArtifact.abi, tokenArtifact.bytecode, buyer)
    .deploy(await buyer.getAddress(), 1_000_000_000n);
  await token.waitForDeployment();
  const network = await new ContractFactory(artifact.abi, artifact.bytecode, buyer).deploy(await token.getAddress());
  await network.waitForDeployment();
  const rpc = (method, params = []) => connection.provider.request({ method, params });
  return {
    provider, buyer, seller, evaluator, stranger, secondSeller, token, network, artifact, rpc,
    async now() { return Number((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp); },
    async at(timestamp) { await rpc("evm_setNextBlockTimestamp", [timestamp]); await rpc("evm_mine"); },
    async close() { provider.destroy(); await connection.close(); }
  };
}
