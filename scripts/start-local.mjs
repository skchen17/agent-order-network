import path from "node:path";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { JsonRpcProvider, Wallet, ContractFactory, parseEther } from "ethers";
import hre from "hardhat";
import { readJSON, saveJSON } from "../src/agent-runtime.mjs";

const { values } = parseArgs({ options: { out: { type: "string", default: ".local-demo/manual" }, port: { type: "string", default: "8545" } } });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port");
const out = path.resolve(values.out);
try {
  await readJSON(path.join(out, "deployment.json"));
  throw new Error("Output directory already contains a deployment. Choose a new --out directory.");
} catch (error) { if (error.code !== "ENOENT") throw error; }
const server = await hre.network.createServer("local", "127.0.0.1", port);
const bound = await server.listen();
const rpcUrl = `http://127.0.0.1:${bound.port}`;
const provider = new JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 });
provider.pollingInterval = 50;
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  provider.destroy();
  await server.close();
  if (process.connected) process.disconnect();
}
process.on("SIGINT", () => { close().catch(console.error); });
process.on("SIGTERM", () => { close().catch(console.error); });
process.on("message", message => { if (message?.type === "stop") close().catch(console.error); });
process.on("disconnect", () => { close().catch(console.error); });

try {
  const deployer = await provider.getSigner(0);
  const buyer = Wallet.createRandom();
  const seller = Wallet.createRandom();
  const evaluator = Wallet.createRandom();
  for (const wallet of [buyer, seller]) await (await deployer.sendTransaction({ to: wallet.address, value: parseEther("5") })).wait();
  const paymentArtifact = await readJSON(new URL("../artifacts/MockPaymentToken.json", import.meta.url));
  const orderArtifact = await readJSON(new URL("../artifacts/OrderNetwork.json", import.meta.url));
  const token = await new ContractFactory(paymentArtifact.abi, paymentArtifact.bytecode, deployer).deploy(buyer.address, 1_000_000_000n);
  await token.waitForDeployment();
  const contract = await new ContractFactory(orderArtifact.abi, orderArtifact.bytecode, deployer).deploy(await token.getAddress());
  const receipt = await contract.deploymentTransaction().wait();
  const payloadArtifact = await readJSON(new URL("../artifacts/OrderPayloads.json", import.meta.url));
  const payloads = await new ContractFactory(payloadArtifact.abi, payloadArtifact.bytecode, deployer).deploy();
  await payloads.waitForDeployment();
  const common = {
    environment: "local-development", deploymentId: randomUUID(), rpcUrl, chainId: 31337,
    contract: await contract.getAddress(), paymentToken: await token.getAddress(), payloadStore: await payloads.getAddress(), evaluator: evaluator.address,
    deploymentBlock: receipt.blockNumber, deploymentBlockHash: receipt.blockHash,
    pollMs: 100, deliverySeconds: 300, acceptSeconds: 600, latestDeliverySeconds: 1200,
    reviewPeriod: 120, arbitrationPeriod: 60,
    indexBlockSpan: 500
  };
  // Each role receives only its own random development key. Public deployment has no keys.
  await saveJSON(path.join(out, "deployment.json"), { ...common, buyer: buyer.address, seller: seller.address });
  await saveJSON(path.join(out, "buyer", "config.json"), {
    ...common, role: "buyer", address: buyer.address, privateKey: buyer.privateKey
  });
  await saveJSON(path.join(out, "seller", "config.json"), {
    ...common, role: "seller", address: seller.address, privateKey: seller.privateKey
  });
  const ready = { type: "ready", pid: process.pid, directory: out, ...common, buyer: buyer.address, seller: seller.address };
  console.log(JSON.stringify({ type: "ready", pid: process.pid, rpcUrl, directory: out, contract: common.contract }));
  if (process.connected) process.send(ready);
  else console.log("Local node ready. Start buyer and seller in separate terminals; Ctrl+C stops this temporary chain.");
  await server.afterClosed();
} catch (error) { await close(); throw error; }
