// Reference AWS KMS signer for Base mainnet.
//
// Requirements:
//   - an AWS KMS key with key spec ECC_SECG_P256K1 and key usage SIGN_VERIFY;
//   - IAM permission for kms:GetPublicKey and kms:Sign on that key;
//   - `npm install @aws-sdk/client-kms` in the environment that runs this module.
//
// Config:
//   "externalSigner": {
//     "type": "module",
//     "module": "/absolute/path/to/aws-kms.mjs",
//     "options": { "region": "us-east-1", "keyId": "arn:aws:kms:..." }
//   }
//
// No key material is stored here or in the config. AWS credentials come from the
// standard provider chain (environment, role, profile, etc.). Restrict the key
// policy to the minimum required operations and monitor kms:Sign calls.

import {
  AbstractSigner,
  Signature,
  Transaction,
  TypedDataEncoder,
  getAddress,
  getBytes,
  hashMessage,
  hexlify,
  keccak256,
  recoverAddress
} from "ethers";

function readTlv(bytes, offset) {
  if (offset + 2 > bytes.length) throw new Error("Invalid DER");
  const tag = bytes[offset++];
  let length = bytes[offset++];
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4 || offset + count > bytes.length) throw new Error("Invalid DER length");
    length = 0;
    for (let i = 0; i < count; i++) length = (length << 8) | bytes[offset++];
  }
  if (offset + length > bytes.length) throw new Error("Truncated DER");
  return { tag, value: bytes.slice(offset, offset + length), start: offset, next: offset + length };
}

export function addressFromPublicKey(der) {
  const root = readTlv(der, 0);
  if (root.tag !== 0x30) throw new Error("Invalid SubjectPublicKeyInfo");
  const algorithm = readTlv(der, root.start);
  const bitString = readTlv(der, algorithm.next);
  if (bitString.tag !== 0x03 || bitString.value[0] !== 0) throw new Error("Invalid public key bit string");
  const point = bitString.value.slice(1);
  if (point.length !== 65 || point[0] !== 4) throw new Error("Expected an uncompressed secp256k1 public key");
  return getAddress("0x" + keccak256(point.slice(1)).slice(-40));
}

function parseDerSignature(der) {
  const root = readTlv(der, 0);
  if (root.tag !== 0x30) throw new Error("Invalid DER signature");
  const r = readTlv(der, root.start);
  const s = readTlv(der, r.next);
  if (r.tag !== 0x02 || s.tag !== 0x02) throw new Error("Invalid ECDSA signature integers");
  const to32 = value => {
    let start = 0;
    while (start < value.length - 1 && value[start] === 0) start++;
    const trimmed = value.slice(start);
    if (trimmed.length > 32) throw new Error("ECDSA integer too large");
    const out = new Uint8Array(32);
    out.set(trimmed, 32 - trimmed.length);
    return hexlify(out);
  };
  return { r: to32(r.value), s: to32(s.value) };
}

class AwsKmsSigner extends AbstractSigner {
  constructor(provider, { address, keyId, kms }) {
    super(provider);
    this.address = getAddress(address);
    this.keyId = keyId;
    this.kms = kms;
  }

  async getAddress() { return this.address; }

  async signDigest(digest) {
    const der = await this.kms.signDigest(getBytes(digest));
    const { r, s } = parseDerSignature(der);
    for (const yParity of [0, 1]) {
      const signature = Signature.from({ r, s, yParity });
      if (recoverAddress(digest, signature).toLowerCase() === this.address.toLowerCase()) return signature;
    }
    throw new Error("KMS signature does not match the configured address");
  }

  async signTransaction(tx) {
    const parsed = Transaction.from(tx);
    parsed.signature = await this.signDigest(parsed.unsignedHash);
    return parsed.serialized;
  }

  async signTypedData(domain, types, value) {
    return (await this.signDigest(TypedDataEncoder.hash(domain, types, value))).serialized;
  }

  async signMessage(message) {
    return (await this.signDigest(hashMessage(message))).serialized;
  }

  connect(provider) {
    return new AwsKmsSigner(provider, { address: this.address, keyId: this.keyId, kms: this.kms });
  }

  async sendTransaction(tx) {
    const populated = await this.populateTransaction(tx);
    const signed = await this.signTransaction(populated);
    return this.provider.broadcastTransaction(signed);
  }
}

export async function createKmsSigner({ provider, address, keyId, kms }) {
  const publicKey = await kms.getPublicKey();
  const derived = addressFromPublicKey(publicKey);
  if (!address || derived.toLowerCase() !== getAddress(address).toLowerCase()) {
    throw new Error(`KMS public key derives ${derived}, not config.address ${address}`);
  }
  return new AwsKmsSigner(provider, { address: derived, keyId, kms });
}

export async function createSigner({ provider, options, address }) {
  if (!options?.keyId || !options?.region) {
    throw new Error('Configure { region, keyId } in externalSigner.options; no key material is accepted');
  }
  let sdk;
  try {
    sdk = await import("@aws-sdk/client-kms");
  } catch {
    throw new Error("Install @aws-sdk/client-kms in the signer environment, or use a KMS adapter from your custody provider");
  }
  const client = new sdk.KMSClient({ region: options.region });
  const kms = {
    getPublicKey: async () => (await client.send(new sdk.GetPublicKeyCommand({ KeyId: options.keyId }))).PublicKey,
    signDigest: async digest => (await client.send(new sdk.SignCommand({
      KeyId: options.keyId,
      Message: digest,
      MessageType: "DIGEST",
      SigningAlgorithm: "ECDSA_SHA_256"
    }))).Signature
  };
  return createKmsSigner({ provider, address, keyId: options.keyId, kms });
}
