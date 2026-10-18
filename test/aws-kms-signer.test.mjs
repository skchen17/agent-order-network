import test from "node:test";
import assert from "node:assert/strict";
import { Wallet, Transaction, TypedDataEncoder, getAddress, getBytes, hashMessage, recoverAddress } from "ethers";
import { addressFromPublicKey, createKmsSigner } from "../examples/signers/aws-kms.mjs";

function derInteger(bytes) {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  let value = Buffer.from(bytes.slice(start));
  if (value[0] & 0x80) value = Buffer.concat([Buffer.from([0]), value]);
  return Buffer.concat([Buffer.from([0x02, value.length]), value]);
}

function derSignature(signature) {
  const body = Buffer.concat([derInteger(getBytes(signature.r)), derInteger(getBytes(signature.s))]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

function spki(publicKey) {
  const algorithm = Buffer.from("301006072a8648ce3d020106052b8104000a", "hex");
  const bitString = Buffer.concat([Buffer.from([0x03, 0x42, 0x00]), Buffer.from(publicKey)]);
  const body = Buffer.concat([algorithm, bitString]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

test("AWS KMS signer derives the address and signs typed data, messages, and transactions", async () => {
  const wallet = Wallet.createRandom();
  const publicKey = getBytes(wallet.signingKey.publicKey);
  const publicKeyDer = spki(publicKey);
  assert.equal(addressFromPublicKey(publicKeyDer).toLowerCase(), wallet.address.toLowerCase());

  const kms = {
    getPublicKey: async () => publicKeyDer,
    signDigest: async digest => derSignature(wallet.signingKey.sign(digest))
  };
  const signer = await createKmsSigner({ provider: null, address: wallet.address, keyId: "test-key", kms });
  assert.equal(await signer.getAddress(), getAddress(wallet.address));

  const domain = { name: "AgentOrderNetwork", version: "1", chainId: 8453, verifyingContract: "0x0000000000000000000000000000000000000001" };
  const types = { Quote: [
    { name: "orderId", type: "uint256" },
    { name: "termsHash", type: "bytes32" },
    { name: "provider", type: "address" },
    { name: "price", type: "uint256" },
    { name: "deliverBy", type: "uint64" },
    { name: "validUntil", type: "uint64" }
  ] };
  const value = { orderId: 1n, termsHash: "0x" + "11".repeat(32), provider: wallet.address,
    price: 1_500_000n, deliverBy: 2_000_000_000n, validUntil: 1_900_000_000n };
  const typedSignature = await signer.signTypedData(domain, types, value);
  assert.equal(recoverAddress(TypedDataEncoder.hash(domain, types, value), typedSignature).toLowerCase(), wallet.address.toLowerCase());

  const messageSignature = await signer.signMessage("agent order network");
  assert.equal(recoverAddress(hashMessage("agent order network"), messageSignature).toLowerCase(), wallet.address.toLowerCase());

  const transaction = Transaction.from({
    to: "0x0000000000000000000000000000000000000002", value: 1n, nonce: 0, gasLimit: 21000n,
    maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, chainId: 8453, type: 2
  });
  const signed = await signer.signTransaction(transaction);
  assert.equal(Transaction.from(signed).from.toLowerCase(), wallet.address.toLowerCase());

  await assert.rejects(
    createKmsSigner({ provider: null, address: Wallet.createRandom().address, keyId: "test-key", kms }),
    /derives/
  );
});
