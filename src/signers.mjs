import path from "node:path";
import { pathToFileURL } from "node:url";
import { NonceManager, VoidSigner, Wallet } from "ethers";

const SIGNER_METHODS = ["getAddress", "getNonce", "sendTransaction", "signTransaction", "signTypedData"];
const SECRET_KEYS = ["privateKey", "mnemonic", "seedPhrase"];

export function assertNoSecretOptions(options, label = "externalSigner.options") {
  if (options === undefined) return;
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error(`${label} must be a JSON object`);
  for (const key of SECRET_KEYS) {
    if (key in options) throw new Error(`Do not put ${key} in ${label}; use a KMS, HSM, or hardware-wallet reference`);
  }
}

export async function createExternalSigner(config, provider) {
  const descriptor = config.externalSigner;
  if (descriptor?.type !== "module" || typeof descriptor.module !== "string" || !path.isAbsolute(descriptor.module)) {
    throw new Error('Base mainnet requires externalSigner { type: "module", module: "<absolute path>" }');
  }
  assertNoSecretOptions(descriptor.options);
  const module = await import(pathToFileURL(descriptor.module).href);
  if (typeof module.createSigner !== "function") {
    throw new Error("Signer module must export createSigner({ provider, options, role, address })");
  }
  const signer = await module.createSigner({
    provider,
    options: descriptor.options ?? {},
    role: config.role,
    address: config.address
  });
  for (const method of SIGNER_METHODS) {
    if (typeof signer?.[method] !== "function") throw new Error(`Signer module result is missing ${method}()`);
  }
  if (!signer.provider) throw new Error("Signer module result must expose provider");
  const address = await signer.getAddress();
  if (!config.address || address.toLowerCase() !== config.address.toLowerCase()) {
    throw new Error("Signer module address does not match config.address");
  }
  return descriptor.nonceManager ? new NonceManager(signer) : signer;
}

export async function resolveSigner(config, provider, { readOnly = false } = {}) {
  if (readOnly) return new VoidSigner(config.address, provider);
  if (config.privateKey && config.externalSigner) {
    throw new Error("Do not combine externalSigner with a plaintext privateKey");
  }
  if (config.environment === "public-mainnet") {
    if (config.privateKey) throw new Error("Base mainnet rejects plaintext privateKey; configure externalSigner");
    if (!config.externalSigner) throw new Error("Base mainnet requires an externalSigner module");
    return createExternalSigner(config, provider);
  }
  if (config.externalSigner) return createExternalSigner(config, provider);
  if (!config.privateKey) throw new Error("Provide a development privateKey or an externalSigner module");
  const wallet = new Wallet(config.privateKey, provider);
  const address = await wallet.getAddress();
  if (!config.address || address.toLowerCase() !== config.address.toLowerCase()) {
    throw new Error("Wallet identity mismatch");
  }
  return new NonceManager(wallet);
}
