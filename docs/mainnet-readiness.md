# Base mainnet readiness

**Status: Phase 1 tooling only. No Base mainnet transaction has been sent and real funds are not approved.**

The repository now contains opt-in Base mainnet support for USDC. It is deliberately gated: mainnet is rejected unless the manifest/config sets `allowMainnet: true`; `prepare` requires `--mainnet`, and `deploy`, `join`, `verify`, and `invite` require `--allow-mainnet`. Plaintext private keys are rejected on mainnet; an external signer module is required.

## What Phase 1 provides

- `BASE_MAINNET` profile: chain ID `8453`, BaseScan explorer, 10 confirmations, canonical USDC.
- `networkPolicy` mainnet arm with HTTPS/credential checks and 10..100 confirmations.
- `src/signers.mjs`: external signer module interface; mainnet rejects `privateKey`.
- `pilot prepare --mainnet`: deployer config with an external signer descriptor and explicit evaluator; no private key.
- `pilot deploy --allow-mainnet`: deploys only `OrderNetwork` + `OrderPayloads` against existing USDC; no test token.
- `pilot join --allow-mainnet`: participant config with an external signer descriptor; no private key.
- `pilot verify --allow-mainnet`: checks chain, block hash, confirmations, runtime code for our contracts, USDC metadata/code, canonical address, payment link, signing domain.
- `pilot invite --allow-mainnet`: mainnet/USDC invitation with real-funds and audit warnings.
- Simulated `mainnetTest` (chain ID 8453) tests using a mock 6-decimal USDC; no public transactions.

## Trust assumptions and risks

| Area | Assumption / risk |
| --- | --- |
| Payment asset | Canonical Base USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, 6 decimals. A different token is rejected by default. |
| USDC control | Circle can freeze or pause USDC. The immutable contract has no admin, rescue, or pause. A contract-level freeze can make funds unrecoverable. |
| USDC upgrade | USDC is a proxy. Its code hash is not pinned; `verify` checks code presence, symbol, decimals, and canonical address, not bytecode. |
| Signing | Mainnet requires an external signer module backed by KMS, HSM, or a hardware wallet. The adapter is host-supplied and must be reviewed; the repository does not ship a production adapter. |
| Confirmations | 10 Base L2 blocks is a local policy threshold, not Ethereum L1 finality. Raise it for larger orders. |
| Contracts | `OrderNetwork` and `OrderPayloads` are unaudited, immutable, and have no administrator. Bugs cannot be patched in place; deploy a new version. |
| Disputes | The evaluator is offline by default. Review silence can pay the provider; arbitration timeout refunds the buyer. Both parties must accept this before trading. |
| Operations | No project-operated keeper, monitoring, RPC failover, or backup service. The operator must supply these. |

## Go / no-go

| Gate | Status |
| --- | --- |
| Phase 1 code, tests, and docs | Complete |
| Independent smart-contract audit and fixes | Required |
| Legal and compliance memo (USDC, money transmission, sanctions, tax, disputes) | Required |
| Production KMS/HSM/hardware signer adapter and disaster-recovery drill | Required |
| Written acceptance of USDC freeze/pause/proxy-upgrade and immutable no-rescue risk | Required |
| Keeper for `finalizeUnchallenged` / `refundExpired` / `expireOpen` | Required |
| RPC failover, monitoring, alerts, encrypted backups, incident runbook | Required |
| Evaluator operations/SLA or explicit timeout-rule acceptance | Required |
| Per-order cap, treasury monitoring, daily reconciliation | Required |
| Limited real-funds pilot | Only after all gates above |

## Non-goals

- No Base mainnet deployment or transaction is performed by Phase 1.
- `PilotPaymentToken` is never deployed on mainnet.
- The default mainnet guard is not removed or weakened.
- No admin, pause, rescue, or upgrade mechanics are added.
- No mainnet private key is stored in a config.
- The system is not described as audited or production-ready.
