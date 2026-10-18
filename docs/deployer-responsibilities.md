# Deployer responsibilities

This repository provides a protocol, a Skill, and operator tooling. It does **not** custody funds, operate servers, or manage keys. If you deploy it with real funds, you are the deployer/operator and the responsibilities below are yours.

## Project vs deployer

| Area | Project repository | Deployer / operator |
| --- | --- | --- |
| Contracts and Skill code | Provides, unaudited | Reviews and accepts |
| Mainnet guard | Default off; explicit `allowMainnet` + `--allow-mainnet` | Uses only after accepting responsibility |
| External signer interface | Defines it in `src/signers.mjs`; provides a template | Implements KMS/HSM/hardware adapter and key policy |
| Independent audit | Not performed | Commissions and closes findings before real funds |
| Legal / compliance | Not provided | Obtains its own advice on USDC, money transmission, sanctions/AML, tax, disputes |
| Keeper, monitoring, RPC failover, backups | Not operated | Runs its own |
| Evaluator and dispute operations | No automatic arbitrator | Operates or explicitly accepts the timeout-refund rule |
| USDC freeze/pause risk | Documents it | Accepts it in writing |

## Before deployment

- [ ] Independent audit of `OrderNetwork` and `OrderPayloads`; findings fixed and retested.
- [ ] Legal/compliance review for your jurisdiction and the USDC use case.
- [ ] KMS/HSM/hardware-wallet adapter implemented from [the signer template](../examples/signers/template.mjs) or [the AWS KMS example](aws-kms-signer.md); address pinning and signing policy tested.
- [ ] Disaster-recovery drill: lost device, unavailable KMS, key rotation, nonce recovery, restored state directory.
- [ ] Written acceptance of USDC blacklist/pause/proxy-upgrade risk and the immutable no-rescue contract.
- [ ] RPC provider with a failover path; no credential in a public manifest.
- [ ] Keeper for `finalizeUnchallenged`, `refundExpired`, and `expireOpen`; monitoring and alerts for deadlines, failed transactions, and balance drift.
- [ ] Encrypted backups and an incident-response runbook.
- [ ] Evaluator identity and SLA, or explicit acceptance that the evaluator is offline and the timeout rule applies.
- [ ] Per-order cap, treasury monitoring, and daily reconciliation procedure.

## During deployment

1. Generate the deployer config with `prepare --mainnet`; confirm it has no private key and references your signer module.
2. Run `doctor` and inspect every check, especially signer address, chain ID, gas, and USDC metadata.
3. Deploy with `--allow-mainnet`; confirm two receipts and the public deployment manifest.
4. Run `verify --allow-mainnet`; confirm runtime code hashes, USDC metadata/canonical address, signing domain, and confirmation depth.
5. Generate the invitation with `invite --allow-mainnet`; share only the public deployment, fingerprint, invitation, and matching Skill.
6. Onboard allowlisted participants with their own addresses, signer modules, and state directories.

## After deployment

- Monitor orders, deadlines, settlement, refunds, and USDC status continuously.
- Reconcile contract balance against `totalEscrowed + totalCredits` and participant credits daily.
- Keep a single writer per wallet; do not use the same wallet from multiple machines.
- Investigate any `uncertain` action before allowing new writes.
- Export evidence and keep raw keys, session logs, and RPC credentials private.
- Stop new orders if USDC is paused, a participant is frozen, monitoring is unavailable, or balances do not reconcile. There is no contract pause, so stopping means participants stop creating/funding orders and settle or refund existing ones.

## Local-only example

`examples/signers/local-file-dev.mjs` reads a private key from a file and is disabled on Base mainnet. It exists only for local/testnet rehearsals. Do not use it with real funds.
