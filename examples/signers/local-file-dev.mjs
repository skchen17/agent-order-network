// Local/testnet only. This adapter reads a private key from a file and is
// deliberately disabled on Base mainnet (chainId 8453). Never use it for real
// funds. For Base mainnet, implement a KMS/HSM/hardware adapter from
// examples/signers/template.mjs.

import { readFile } from "node:fs/promises";
import { Wallet } from "ethers";

export async function createSigner({ provider, options, address }) {
  if (!options?.privateKeyFile || typeof options.privateKeyFile !== "string") {
    throw new Error('Provide { privateKeyFile: "<absolute path>" } in externalSigner.options');
  }
  const network = await provider.getNetwork();
  if (network.chainId === 8453n) {
    throw new Error("local-file-dev signer is disabled on Base mainnet; use a KMS/HSM/hardware adapter");
  }
  const privateKey = (await readFile(options.privateKeyFile, "utf8")).trim();
  const signer = new Wallet(privateKey, provider);
  const signerAddress = await signer.getAddress();
  if (!address || signerAddress.toLowerCase() !== address.toLowerCase()) {
    throw new Error("Signer address does not match config.address");
  }
  return signer;
}
