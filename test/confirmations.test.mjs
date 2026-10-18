import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ContractFactory, id } from "ethers";
import { createLocalChain, loadArtifact } from "../scripts/local-chain.mjs";
import { ActionJournal } from "../src/action-journal.mjs";

test("a mined testnet-style call remains unresolved until the configured confirmation depth; recovery never repeats it", async t => {
  const c = await createLocalChain(); t.after(() => c.close());
  const artifact = await loadArtifact("PilotPaymentToken");
  const token = await new ContractFactory(artifact.abi, artifact.bytecode, c.buyer).deploy(); await token.waitForDeployment();
  const context = { chainId: 31337, address: await c.seller.getAddress(), contract: await token.getAddress(), paymentToken: await token.getAddress(), deploymentId: randomUUID() };
  const journal = await ActionJournal.open(path.resolve(".local-demo/confirmation-tests", randomUUID(), "journal.sqlite"), context, c.provider,
    [[context.contract, token.interface]], { confirmations: 3, timeoutMs: 150 });
  t.after(() => journal.close());
  const record = journal.begin({ approval: id(randomUUID()), ticket: { kind: "claim-test-tokens", data: {} } });
  await assert.rejects(journal.transact(record, "claim_test_tokens", token.connect(c.seller), "claim", []));
  journal.fail(record);
  assert.equal((await journal.recover(record.actionId)).executionStatus, "uncertain");
  assert.equal(await token.balanceOf(context.address), 100000000n);
  const nonce = await c.provider.getTransactionCount(context.address);
  await c.rpc("evm_mine"); await c.rpc("evm_mine");
  assert.equal((await journal.recover(record.actionId)).executionStatus, "completed");
  assert.equal(await c.provider.getTransactionCount(context.address), nonce);
});
