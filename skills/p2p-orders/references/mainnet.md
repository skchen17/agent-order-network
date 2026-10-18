# Base mainnet + USDC (Phase 1, unaudited)

Mainnet is opt-in and not approved for real funds. It requires all of:

- a public deployment manifest with `environment: "public-mainnet"`, `network: "base"`, `chainId: 8453`, `testOnly: false`, `allowMainnet: true`;
- canonical Base USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, 6 decimals;
- an external signer module on every writing participant;
- `--mainnet` for `prepare`, and `--allow-mainnet` for `deploy`, `join`, `verify`, and `invite`;
- the readiness gates in the repository's `docs/mainnet-readiness.md` before real funds.

The contracts are immutable and unaudited. Base USDC can be frozen or paused by Circle; the contract has no admin, rescue, or pause. Review silence can pay the provider; arbitration timeout refunds the buyer. There is no automatic arbitrator.

## External signer module

The config stores a descriptor, never a private key:

```json
{
  "externalSigner": {
    "type": "module",
    "module": "/absolute/path/to/signer.mjs",
    "options": { "keyReference": "kms-or-hardware-reference" }
  }
}
```

The module must export:

```js
export async function createSigner({ provider, options, role, address }) {
  // Return an ethers-compatible signer with:
  // getAddress(), getNonce(), sendTransaction(), signTransaction(), signTypedData(), provider
}
```

`options` may contain non-secret references such as a KMS key ID or hardware-wallet account path. Do not put a private key or mnemonic in the config. The repository provides `examples/signers/template.mjs` as a starting point and `docs/deployer-responsibilities.md`; neither is included in the packaged Skill and neither is a production key-management service. `examples/signers/local-file-dev.mjs` is local/testnet-only and refuses Base mainnet.

## Deployer flow

```text
node "<skill>/scripts/pilot.mjs" prepare --mainnet --out "<pilot directory>" --address "<deployer address>" --evaluator "<evaluator address>" --signer-module "<absolute module path>" --max-order-amount 2000000
node "<skill>/scripts/pilot.mjs" doctor --config "<pilot directory>/deployer.json" --state-dir "<pilot directory>/deployer-state"
node "<skill>/scripts/pilot.mjs" deploy --wallet "<pilot directory>/deployer.json" --out "<pilot directory>/public" --allow-mainnet
node "<skill>/scripts/pilot.mjs" verify --deployment "<pilot directory>/public/deployment.json" --allow-mainnet
node "<skill>/scripts/pilot.mjs" invite --deployment "<pilot directory>/public/deployment.json" --out "<pilot directory>/public/invitation.txt" --allow-mainnet
```

Mainnet `deploy` deploys only `OrderNetwork` + `OrderPayloads` against existing USDC. It never deploys `PilotPaymentToken` and does not use a faucet. `maxOrderAmount` is a positive integer in USDC base units (6 decimals; 2 USDC = `2000000`).

## Participant flow

```text
node "<skill>/scripts/pilot.mjs" join --deployment "<deployment.json>" --fingerprint "<fingerprint>" --role buyer|seller --address "<participant address>" --signer-module "<absolute module path>" --allow-mainnet --out "<new participant directory>"
node "<skill>/scripts/pilot.mjs" doctor --config "<participant directory>/config.json" --state-dir "<participant directory>/state"
```

The participant funds only their own address with real ETH for gas and USDC for orders. There is no `claim` on mainnet. Each state directory, wallet, and signer module belongs to one participant; never share them.

## Verification and warnings

`verify --allow-mainnet` checks the chain ID, deployment block hash, confirmation depth (minimum 10), runtime code for `OrderNetwork` and `OrderPayloads`, USDC code presence, symbol, decimals, canonical address, payment-token link, and EIP-712 signing domain. It does not pin USDC bytecode because USDC is a proxy.

Warnings returned by `verify` and included in mainnet invitations:

- unaudited contracts, immutable, no admin/rescue/pause;
- Circle can freeze or pause USDC, including escrowed funds;
- review silence can pay the provider and arbitration timeout refunds the buyer;
- no automatic arbitrator and no project-operated keeper/monitoring.

Do not proceed to real funds until the repository's mainnet readiness gates close.
