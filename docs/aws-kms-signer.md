# AWS KMS signer example

`examples/signers/aws-kms.mjs` is a reference adapter for the external signer interface in `src/signers.mjs`. It keeps the secp256k1 key inside AWS KMS and signs Ethereum transactions, EIP-712 typed data, and messages without exposing key material to the host.

This is an example, not an audited production key-management service. Review it, test it with a non-production key, and apply your own IAM and monitoring controls.

## Requirements

- AWS KMS key with key spec `ECC_SECG_P256K1` and key usage `SIGN_VERIFY`. Confirm `ECC_SECG_P256K1` is available in your region.
- IAM permission for `kms:GetPublicKey` and `kms:Sign` on that key only; do not grant broad KMS permissions.
- `@aws-sdk/client-kms` installed in the environment that runs the signer. It is not a project dependency.
- AWS credentials from the standard provider chain (environment, role, profile, etc.). Do not put credentials in the deployment config.
- A single writer for the wallet. KMS signing does not provide nonce coordination across machines.

## Install

```sh
npm install @aws-sdk/client-kms
```

Install it where the signer module runs. The repository's own test uses an injected mock KMS and does not need the SDK.

## Config

Copy the adapter outside the repository, then reference its absolute path:

```json
{
  "externalSigner": {
    "type": "module",
    "module": "/absolute/path/to/aws-kms.mjs",
    "options": {
      "region": "us-east-1",
      "keyId": "arn:aws:kms:us-east-1:111122223333:key/..."
    }
  }
}
```

`region` and `keyId` are non-secret references. The loader rejects `privateKey`, `mnemonic`, and `seedPhrase` in `options`.

## What the adapter does

- Reads the KMS public key with `GetPublicKey`, extracts the uncompressed secp256k1 point, and derives the Ethereum address.
- Refuses to start unless the derived address matches `config.address` (address pinning).
- Signs `Transaction.unsignedHash` with `kms:Sign` (`MessageType: DIGEST`, `ECDSA_SHA_256`), parses the DER signature, and recovers the correct `yParity`.
- Signs EIP-712 typed data by hashing with `TypedDataEncoder.hash` and signing the digest.
- Implements `getAddress`, `getNonce`, `sendTransaction`, `signTransaction`, `signTypedData`, and `provider` through an ethers `AbstractSigner`.

## Operational notes

- KMS adds latency and can throttle. Use a retry policy that never double-broadcasts; the action journal remains the source of truth for an uncertain transaction.
- If KMS is unavailable, stop new writes and recover the original action later. Do not switch to a different key or a plaintext fallback.
- Monitor `kms:Sign` with CloudTrail and alert on unexpected callers or spikes.
- Test key loss, IAM failure, throttling, nonce recovery, and state-directory restore before using real funds.
- The adapter signs the digest supplied by ethers. Review the EIP-712 domain and transaction fields; KMS does not interpret them.

## Verification

```sh
node --test test/aws-kms-signer.test.mjs
```

The test uses a local wallet as a mock KMS and verifies address derivation, typed-data signatures, message signatures, transaction signatures, and address-mismatch rejection.
