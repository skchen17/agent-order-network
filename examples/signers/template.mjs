// Reference external signer module for Base mainnet.
//
// Copy this file outside the repository, implement createSigner with your
// KMS/HSM/hardware-wallet SDK, and point config.externalSigner.module at the
// absolute path of your copy.
//
// The loader in src/signers.mjs calls:
//   createSigner({ provider, options, role, address })
//
// It must return an ethers-compatible signer exposing:
//   getAddress(), getNonce(), sendTransaction(), signTransaction(),
//   signTypedData(), and provider.
//
// options may contain non-secret references such as a KMS key ID, HSM slot,
// or hardware-wallet account path. The loader rejects privateKey, mnemonic,
// and seedPhrase in options. Never store a private key in this file or in the
// deployment config.

export async function createSigner({ provider, options, role, address }) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("Configure non-secret signer options, such as { kmsKeyId } or { hardwareAccountPath }");
  }

  // TODO: implement your provider-specific adapter. The required shape is:
  //
  //   const signer = await createYourKmsOrHardwareSigner({
  //     provider,
  //     keyId: options.kmsKeyId,
  //     accountPath: options.hardwareAccountPath
  //   });
  //   const signerAddress = await signer.getAddress();
  //   if (signerAddress.toLowerCase() !== address.toLowerCase()) {
  //     throw new Error("Signer address does not match config.address");
  //   }
  //   return signer;
  //
  // The adapter must sign EIP-712 quotes (signTypedData) and Ethereum
  // transactions, and it must not silently switch keys or chains.

  throw new Error(
    `Signer template is not implemented for role ${role ?? "unknown"}. ` +
    "Implement a KMS/HSM/hardware adapter from examples/signers/template.mjs; " +
    "do not read a private key from options or config. " +
    "See docs/deployer-responsibilities.md."
  );
}
