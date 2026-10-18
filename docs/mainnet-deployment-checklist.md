# Base mainnet deployment checklist

Use this only after reading [mainnet readiness](mainnet-readiness.md). Phase 1 is a dry run and sends no mainnet transaction. Do not start Phase 3 until every Phase 2 gate is closed.

## Phase 1: dry run, no transactions

1. Build and verify:

```sh
npm ci
npm run preview:verify
```

2. Decide the deployer address, evaluator address, and external signer module. Copy [examples/signers/template.mjs](../examples/signers/template.mjs) outside the repository and implement `createSigner({ provider, options, role, address })` for your KMS, HSM, or hardware wallet. Do not put a private key in the config. Review [deployer responsibilities](deployer-responsibilities.md) first.

3. Generate the deployer config:

```sh
node skills/p2p-orders/scripts/pilot.mjs prepare --mainnet --out <pilot directory> \
  --address <deployer address> --evaluator <evaluator address> \
  --signer-module <absolute signer module path> --max-order-amount 2000000
```

4. Inspect `<pilot directory>/deployer.json`: it must contain an `externalSigner` descriptor, `allowMainnet: true`, `chainId: 8453`, `paymentToken` USDC, and no `privateKey`.

5. Run doctor. It sends no transaction:

```sh
node skills/p2p-orders/scripts/pilot.mjs doctor --config <pilot directory>/deployer.json --state-dir <pilot directory>/deployer-state
```

Expected: chain, signer-module, and gas checks are visible; `auditStatus` is `unaudited`. Stop if the signer module or address does not match.

## Phase 2: external gates

Close all of these before funding a mainnet deployer:

- independent audit of `OrderNetwork` and `OrderPayloads`, with findings closed;
- legal/compliance memo covering USDC, money transmission, sanctions/AML, tax, and dispute liability;
- production KMS/HSM/hardware signer adapter, address pinning, and a disaster-recovery drill;
- written acceptance of USDC freeze/pause/proxy-upgrade and immutable no-rescue risk;
- keeper for `finalizeUnchallenged` / `refundExpired` / `expireOpen`;
- RPC failover, monitoring, alerts, encrypted backups, incident runbook, and bug bounty;
- evaluator operations/SLA, or explicit written acceptance of the timeout-refund rule;
- per-order cap, treasury monitoring, and daily reconciliation procedure.

## Phase 3: limited real-funds pilot

Only after Phase 2:

1. Fund the deployer with real ETH for gas. Do not send testnet funds.

2. Deploy against canonical USDC:

```sh
node skills/p2p-orders/scripts/pilot.mjs deploy --wallet <pilot directory>/deployer.json \
  --out <pilot directory>/public --allow-mainnet
```

Expected: two receipts (`deploy_orders`, `deploy_payloads`), `public/deployment.json`, and `realFunds: true`. No test token is deployed.

3. Wait for at least 10 confirmations, then verify:

```sh
node skills/p2p-orders/scripts/pilot.mjs verify --deployment <pilot directory>/public/deployment.json --allow-mainnet
```

Expected: `ready: true`, USDC metadata and canonical-address checks pass, runtime code hashes match, and warnings include unaudited/USDC freeze risk.

4. Create the invitation and share it only with allowlisted participants:

```sh
node skills/p2p-orders/scripts/pilot.mjs invite --deployment <pilot directory>/public/deployment.json \
  --out <pilot directory>/public/invitation.txt --allow-mainnet
```

5. Each participant joins with their own address and external signer module, and funds only their own address:

```sh
node "<skill>/scripts/pilot.mjs" join --deployment "<deployment.json>" --fingerprint "<fingerprint>" \
  --role buyer|seller --address "<participant address>" --signer-module "<absolute signer module path>" \
  --allow-mainnet --out "<new participant directory>"
node "<skill>/scripts/pilot.mjs" doctor --config "<participant directory>/config.json" --state-dir "<participant directory>/state"
```

6. Start with a low per-order cap and a small number of allowlisted participants. Reconcile treasury and credits daily.

## Stop conditions

Stop and do not continue if:

- the chain ID, deployment block hash, runtime code hash, USDC metadata, or signing domain does not match the manifest;
- the signer module address does not match the configured address;
- the deployer nonce changed outside the journal;
- an action remains `uncertain`;
- a participant's state directory belongs to another wallet or deployment;
- USDC is paused, a participant is frozen, or a transfer fails unexpectedly;
- monitoring, keeper, or reconciliation is unavailable.

There is no contract pause. Stopping means participants stop creating or funding new orders and settle or refund existing ones under the published rules.
