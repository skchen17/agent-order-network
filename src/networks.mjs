import { keccak256, FetchRequest, JsonRpcProvider, Network, Contract } from "ethers";

export const BASE_SEPOLIA = Object.freeze({ name: "base-sepolia", chainId: 84532,
  environment: "public-testnet", rpcUrl: "https://sepolia.base.org", explorer: "https://sepolia.basescan.org",
  fundsGuide: "https://docs.base.org/get-started/get-funds", confirmations: 3 });

export const BASE_MAINNET = Object.freeze({ name: "base", chainId: 8453,
  environment: "public-mainnet", testOnly: false, allowMainnet: true,
  rpcUrl: "https://mainnet.base.org", explorer: "https://basescan.org", confirmations: 10,
  paymentToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", paymentSymbol: "USDC", paymentDecimals: 6 });

export const ERC20_ABI = Object.freeze([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function transferFrom(address,address,uint256) returns (bool)"
]);

export function profileFor(config) {
  if (config.environment === "public-mainnet") return BASE_MAINNET;
  if (config.environment === "public-testnet") return BASE_SEPOLIA;
  return null;
}

export function networkPolicy(config) {
  if (config.environment === "local-development" && config.chainId === 31337) {
    return { confirmations: 1, pollingInterval: 50, timeoutMs: 30000, local: true, mainnet: false };
  }
  if (config.environment === "public-mainnet") {
    if (config.chainId !== 8453 || config.network !== "base" || config.testOnly !== false || config.allowMainnet !== true) {
      throw new Error("Base mainnet requires environment public-mainnet, network base, chainId 8453, testOnly:false and allowMainnet:true");
    }
    let url;
    try { url = new URL(config.rpcUrl); } catch { throw new Error("Mainnet RPC must be a valid HTTPS URL"); }
    if (url.protocol !== "https:" || url.username || url.password || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      throw new Error("Mainnet RPC must be a credential-free HTTPS URL; localhost is not allowed");
    }
    if (!Number.isSafeInteger(config.confirmations) || config.confirmations < 10 || config.confirmations > 100) {
      throw new Error("Base mainnet requires 10..100 confirmations");
    }
    return { confirmations: config.confirmations, pollingInterval: 2000, timeoutMs: 120000, local: false, mainnet: true };
  }
  if (config.environment !== "public-testnet" || config.chainId !== 84532 || config.network !== "base-sepolia" || config.testOnly !== true) {
    throw new Error("Only local-development/31337, explicit Base Sepolia 84532, or explicitly configured Base mainnet 8453 is allowed");
  }
  const url = new URL(config.rpcUrl);
  if (url.protocol !== "https:" || url.username || url.password || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Public-testnet RPC must be a credential-free HTTPS URL; use the local-development profile for local chains");
  if (!Number.isSafeInteger(config.confirmations) || config.confirmations < 3 || config.confirmations > 30) throw new Error("Public testnet requires 3..30 confirmations");
  return { confirmations: config.confirmations, pollingInterval: 2000, timeoutMs: 120000, local: false, mainnet: false };
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

export async function readTokenMetadata(provider, address) {
  const code = await provider.getCode(address);
  if (!code || code === "0x") throw new Error("Payment token has no contract code");
  const token = new Contract(address, ERC20_ABI, provider);
  const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
  return { address, symbol, decimals: Number(decimals), decimalsBigInt: decimals, codeHash: keccak256(code) };
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
