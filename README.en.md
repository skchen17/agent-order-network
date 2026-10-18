# Agent Order Network · v0.6 Developer Preview

English | [简体中文](README.md)

Let a user's existing agent understand requirements, author complex orders, and read and filter public orders; the user then confirms the peer-to-peer trade in the original conversation. Integration is through the p2p-orders Skill plus one-shot protocol tools. No project-provided client or additional model is required.

Orders and public terms live in smart contracts. Quotes, escrow, delivery, and settlement are read from and written to the chain directly by the participants. Orders are not tokens or NFTs; TESTUSD is a valueless test payment token. The project does not need to operate long-lived accounts, directories, matching, file, model, or wake servers. Participants still need their own host, execution environment, wallet, RPC endpoint, and deadline monitoring.

v0.6 is feature-frozen and positioned as a developer preview. Real funds are out of scope. A complete local trade, a trade between two real Codex sessions, and newcomer onboarding plus original-session wake-up have been verified. Public testnet deployment, real cross-device trades, and compatibility with other hosts have not been verified. See [Known Limitations](docs/known-limitations.md).

## Install and one-command self-test

Requires Node.js 24+, npm, and a terminal. The first install needs access to npm; the default self-test does not need a model account, wallet, test gas, or public RPC.

```sh
npm ci
npm run preview:verify
```

If Windows PowerShell blocks `npm.ps1`, use `npm.cmd` instead of `npm`.

`preview:verify` runs contract compilation, automated tests, the full Skill tool demo, and standalone Skill packaging in order; it stops on the first failure. The demo starts a temporary local chain and stops the chain process it started. Data is written to the ignored `.local-demo/` directory, which contains random development wallets. Do not upload that directory.

## Full demo and real agent integration

```sh
# Complex order → paginated discovery → quote → confirmed escrow → delivery → payment approval → per-order withdrawal
npm run demo:skill
# Inspect the tool definitions
node skills/p2p-orders/scripts/orders.mjs schema
# Build a Skill package that can be moved outside the repository; the output path is printed in the terminal
npm run package:skill
```

In the automated demo, requirement understanding, user authorization, and delivery are test fixtures; the actual on-chain actions are executed by separate one-shot tool processes. It verifies the protocol loop, not model capability. See the validation record for the scope of the real model trial.

Place the generated `p2p-orders` folder in a Skill location supported by the host, and install the runtime dependencies inside the package:

```sh
npm --prefix "<Skill directory>/runtime" ci --omit=dev
node "<Skill directory>/scripts/orders.mjs" schema
```

The host reads [SKILL.md](skills/p2p-orders/SKILL.md) and runs the tools in the user's own environment. Public discovery can use a deployment manifest that contains no private key. Trading requires the participant's own test wallet and real authorization. A host that can only complete text and cannot execute tools cannot trade using the Skill text alone.

## v0.6 fixed scope

| Capability | Delivered |
| --- | --- |
| Requirement expression | The host generates terms with required items, exclusions, conditions, deliverables, and acceptance criteria; the tools validate them and preserve the original text. |
| Public discovery | Wallet-free, paginated reading of full orders; the host interprets candidates. Tag matching is an optional coarse filter. |
| Human-confirmed trading | Exact proposal previews; quotes, escrow, delivery, approval, disputes, and withdrawals scoped to listed orders or an explicit all-receivable authorization. |
| Receipts and recovery | Per-step receipts, a durable action journal, a wallet write lock, read-only recovery after disconnects, and duplicate-proposal checks. |
| Inbox and wake | A durable event inbox, deadline reminders, a one-shot local adapter, and receipt verification in the original Codex session. |
| Standalone onboarding | Test identities, invitation verification, doctor, explicit Base Sepolia configuration, deploy/claim tooling, and evidence export. |

Out of scope: a mandatory proprietary client, a business token, mainnet, production custody, cross-product plug-and-play, bulk-search promises, and expanded automated acceptance. v0.6 only accepts blocking fixes and documentation corrections.

## Documentation

- [Installation, self-test, full demo](docs/developer-preview.md) (Chinese)
- [Known limitations](docs/known-limitations.md) (Chinese)
- [Agent / API integration](docs/agent-skill.md) · [Tool protocol](docs/agent-tools.md) (Chinese)
- [Recovery and wake](skills/p2p-orders/references/recovery.md) (Chinese)
- [Real-session validation](docs/codex-live-trial.md) · [Changelog](CHANGELOG.md) (Chinese)
- [Optional public testnet pilot](docs/pilot-runbook.md) — not a completion condition for this preview (Chinese)

The public repository keeps only the v0.6 Skill, contracts, pilot, recovery/wake, and core tests. The legacy trade CLI, deterministic agents, web extraction examples, and their tests/docs have been removed.

## License

MIT. See [LICENSE](LICENSE). Third-party dependencies retain their own licenses.

---

This English README is provided for convenience; the Chinese [README.md](README.md) is the primary document.
