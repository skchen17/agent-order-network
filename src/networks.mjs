import { keccak256, FetchRequest, JsonRpcProvider, Network } from "ethers";

export const BASE_SEPOLIA = Object.freeze({ name: "base-sepolia", chainId: 84532,
  environment: "public-testnet", rpcUrl: "https://sepolia.base.org", explorer: "https://sepolia.basescan.org",
  fundsGuide: "https://docs.base.org/get-started/get-funds", confirmations: 3 });

export function networkPolicy(config) {
  if (config.environment === "local-development" && config.chainId === 31337) return { confirmations: 1, pollingInterval: 50, timeoutMs: 30000, local: true };
  if (config.environment !== "public-testnet" || config.chainId !== 84532 || config.network !== "base-sepolia" || config.testOnly !== true) {
    throw new Error("Only local-development/31337 or explicit Base Sepolia test-only pilot configuration is allowed; mainnets are disabled");
  }
  const url = new URL(config.rpcUrl);
  if (url.protocol !== "https:" || url.username || url.password || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Public-testnet RPC must be a credential-free HTTPS URL; use the local-development profile for local chains");
  if (!Number.isSafeInteger(config.confirmations) || config.confirmations < 3 || config.confirmations > 30) throw new Error("Public testnet requires 3..30 confirmations");
  return { confirmations: config.confirmations, pollingInterval: 2000, timeoutMs: 120000, local: false };
}

export function createProvider(config) {
  const policy = networkPolicy(config), request = new FetchRequest(config.rpcUrl);
  request.timeout = 15000;
  const network = Network.from(config.chainId);
  // Explicit eth_chainId and deployment checks at connection time are still required. A pinned
  // provider avoids automatic startup retry messages corrupting the one-object CLI output.
  const provider = new JsonRpcProvider(request, network, { staticNetwork: network, cacheTimeout: -1 });
  provider.pollingInterval = policy.pollingInterval;
  return provider;
}

export async function verifyRuntime(provider, address, artifact) {
  const actual = await provider.getCode(address);
  if (!artifact.runtimeBytecode || actual === "0x") throw new Error(`Missing or unsupported ${artifact.contractName} deployment`);
  const masked = code => {
    let bytes = code.slice(2);
    for (const positions of Object.values(artifact.immutableReferences ?? {})) for (const { start, length } of positions) {
      bytes = bytes.slice(0, start * 2) + "0".repeat(length * 2) + bytes.slice((start + length) * 2);
    }
    return "0x" + bytes;
  };
  if (keccak256(masked(actual)) !== keccak256(masked(artifact.runtimeBytecode))) throw new Error(`Unrecognized ${artifact.contractName} runtime; use the matching Skill build and verify the deployment fingerprint`);
  return keccak256(actual);
}
