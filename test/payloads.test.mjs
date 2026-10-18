import test from "node:test";
import assert from "node:assert/strict";
import { ContractFactory } from "ethers";
import { createLocalChain, loadArtifact } from "../scripts/local-chain.mjs";
import { PayloadClient } from "../src/payload-client.mjs";

test("public payload bulletin carries larger results between independent signers with hash validation", async t => {
  const c = await createLocalChain(); t.after(() => c.close());
  const artifact = await loadArtifact("OrderPayloads");
  const contract = await new ContractFactory(artifact.abi, artifact.bytecode, c.buyer).deploy();
  await contract.waitForDeployment();
  const options = { address: await contract.getAddress(), abi: artifact.abi, chainId: 31337, fromBlock: 0 };
  const writer = new PayloadClient({ ...options, signer: c.buyer });
  const reader = new PayloadClient({ ...options, signer: c.seller });
  const value = { data: "product-data".repeat(300) };
  const uri = await writer.writeJSON(value);
  assert.ok(uri.startsWith("evmdata:31337:"));
  assert.deepEqual((await reader.readJSON(uri)).value, value);
  assert.equal(await writer.writeJSON(value), uri);
  assert.equal((await contract.queryFilter(contract.filters.PayloadPublished())).length, 1);
  await assert.rejects(() => reader.readJSON(uri.replace("31337", "1")), /Unapproved/);
  await assert.rejects(() => writer.writeJSON({ data: "x".repeat(32768) }), /32 KiB/);
  await assert.rejects(() => contract.put.staticCall("0x"));
});
