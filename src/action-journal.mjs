import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { digest } from "./demand.mjs";

const plain = value => JSON.parse(JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v));
export function receiptView(receipt, step, interfaces) {
  const events = [];
  for (const log of receipt.logs) for (const [address, iface] of interfaces) {
    if (log.address.toLowerCase() !== address.toLowerCase()) continue;
    try {
      const event = iface.parseLog(log);
      if (event) events.push({ address: log.address, name: event.name,
        args: Object.fromEntries(event.fragment.inputs.map((field, i) => [field.name || String(i), plain(event.args[i])])) });
    } catch { /* Other events are not interpreted as protocol receipts. */ }
  }
  return { step, transactionHash: receipt.hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
    status: Number(receipt.status), gasUsed: String(receipt.gasUsed), events };
}

// SQLite transactions are short and never held across RPC calls. An unfinished action is a durable
// wallet lock, including after process death. Recovery reads chain state; it never broadcasts.
export class ActionJournal {
  static async open(file, context, provider, interfaces = [], policy = {}) {
    await mkdir(path.dirname(file), { recursive: true });
    return new ActionJournal(new DatabaseSync(file), context, provider, interfaces, policy);
  }
  constructor(db, context, provider, interfaces, policy) {
    Object.assign(this, { db, context, provider, interfaces, policy });
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS identity(value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY, status TEXT NOT NULL, body TEXT NOT NULL);`);
    const identity = digest(context), old = db.prepare("SELECT value FROM identity").get();
    if (old && old.value !== identity) { db.close(); throw new Error("Action journal belongs to another wallet/deployment"); }
    if (!old) db.prepare("INSERT INTO identity VALUES (?)").run(identity);
  }
  close() { this.db.close(); }
  get(id) { const row = this.db.prepare("SELECT body FROM actions WHERE id=?").get(id); return row ? JSON.parse(row.body) : null; }
  put(record) {
    record.updatedAt = new Date().toISOString();
    this.db.prepare("INSERT OR REPLACE INTO actions VALUES (?,?,?)").run(record.actionId, record.status, JSON.stringify(record));
  }
  begin(proposal) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.get(proposal.approval);
      if (previous) throw new Error(`Action already attempted; use recover_action with actionId ${previous.actionId}`);
      const unfinished = this.db.prepare("SELECT id FROM actions WHERE status IN ('running','uncertain') LIMIT 1").get();
      if (unfinished) throw new Error(`Unfinished action ${unfinished.id}; use recover_action before any new write`);
      const record = { actionId: proposal.approval, kind: proposal.ticket.kind, context: this.context,
        orderId: proposal.ticket.data.orderId ?? null, minConfirmations: this.policy.confirmations ?? 1,
        status: "running", ownerPid: process.pid, steps: [], createdAt: new Date().toISOString() };
      this.put(record); this.db.exec("COMMIT"); return record;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  async transact(record, step, contract, method, args) {
    const tx = await contract[method].populateTransaction(...args);
    const signer = contract.runner;
    const intent = { step, status: "submitting", to: tx.to, data: tx.data, value: String(tx.value ?? 0),
      nonce: tx.nonce ?? await signer.getNonce("pending"), fromBlock: (await this.provider.getBlock("latest")).number };
    record.steps.push(intent); this.put(record); // Persist intent before the first possible broadcast.
    let response;
    try {
      response = await signer.sendTransaction(tx);
      intent.transactionHash = response.hash; intent.status = "broadcast"; this.put(record);
      const receipt = await response.wait(record.minConfirmations ?? 1, this.policy.timeoutMs ?? 30000);
      intent.receipt = receiptView(receipt, step, this.interfaces);
      intent.status = receipt.status === 1 ? "confirmed" : "reverted"; this.put(record);
      if (receipt.status !== 1) throw new Error("Transaction reverted");
      return receipt;
    } catch (error) {
      if (error.receipt) {
        // A replacement/cancellation receipt is not proof that the reviewed call happened.
        try {
          const mined = await this.provider.getTransaction(error.receipt.hash);
          const same = mined && (mined.to?.toLowerCase() ?? null) === (intent.to?.toLowerCase() ?? null) && mined.data === intent.data &&
            mined.nonce === intent.nonce && mined.from.toLowerCase() === this.context.address.toLowerCase() && mined.value === BigInt(intent.value);
          const head = await this.provider.getBlock("latest");
          if (same && head.number - error.receipt.blockNumber + 1 >= (record.minConfirmations ?? 1)) {
            intent.transactionHash = error.receipt.hash; intent.receipt = receiptView(error.receipt, step, this.interfaces);
            intent.status = error.receipt.status === 1 ? "confirmed" : "reverted";
          }
        } catch { /* Leave the original intent unresolved for read-only recovery. */ }
      } else if (!response && ["ACTION_REJECTED", "INSUFFICIENT_FUNDS", "CALL_EXCEPTION"].includes(error.code)) {
        intent.status = "not-broadcast";
      } // Transport failures can mean the RPC accepted the transaction. Never infer rejection.
      this.put(record); throw error;
    }
  }
  summary(record) {
    return { actionId: record.actionId, action: record.kind, context: record.context, executionStatus: record.status,
      receipts: record.steps.filter(s => s.receipt).map(s => s.receipt),
      steps: record.steps.map(({ step, status, transactionHash }) => ({ step, status, transactionHash })),
      recovery: record.status === "uncertain" || record.status === "running" ? "Use recover_action; do not rebroadcast" : null };
  }
  fail(record) {
    record.status = record.steps.some(s => ["submitting", "broadcast"].includes(s.status)) ? "uncertain" : "interrupted";
    this.put(record);
  }
  async recover(actionId) {
    const record = this.get(actionId);
    if (!record) throw new Error("Unknown local action; use the original state directory");
    if (record.status === "running") {
      let alive = false;
      try { process.kill(record.ownerPid, 0); alive = true; } catch (error) { if (error.code !== "ESRCH") throw error; }
      if (alive) throw new Error("Action executor is still running; wait for it to exit before recovery");
    }
    // A saved success is still revalidated against canonical block hashes.
    for (const step of record.steps) {
      if (!step.transactionHash && step.status === "submitting") {
        // Close the send-return/persist gap using the recorded sender nonce and exact calldata.
        const head = await this.provider.getBlock("latest");
        if (head.number - step.fromBlock <= 2000) for (let n = step.fromBlock; n <= head.number; n++) {
          const block = await this.provider.getBlock(n, true);
          for (const tx of block.prefetchedTransactions) if (tx.from.toLowerCase() === this.context.address.toLowerCase() && tx.nonce === step.nonce) {
            if ((tx.to?.toLowerCase() ?? null) === (step.to?.toLowerCase() ?? null) && tx.data === step.data && tx.value === BigInt(step.value ?? 0)) step.transactionHash = tx.hash;
            else if (head.number - n + 1 >= (record.minConfirmations ?? 1)) step.status = "replaced";
          }
        }
      }
      if (!step.transactionHash) continue;
      const receipt = await this.provider.getTransactionReceipt(step.transactionHash);
      const block = receipt && await this.provider.getBlock(receipt.blockNumber);
      if (!receipt || block?.hash !== receipt.blockHash) { step.status = "broadcast"; delete step.receipt; continue; }
      step.receipt = receiptView(receipt, step.step, this.interfaces);
      const depth = (await this.provider.getBlock("latest")).number - receipt.blockNumber + 1;
      step.status = depth < (record.minConfirmations ?? 1) ? "broadcast" : receipt.status === 1 ? "confirmed" : "reverted";
    }
    const finalSteps = { publish: "create_order", quote: "post_quote", fund: "accept_quote", deliver: "submit_result",
      approve: "approve_result", dispute: "dispute_result", cancel: "cancel_order", refund: "refund_expired",
      finalize: "finalize_unchallenged", withdraw: "withdraw", "claim-test-tokens": "claim_test_tokens", "deploy-pilot": "deploy_payloads" };
    if (record.steps.some(s => ["broadcast", "submitting"].includes(s.status))) record.status = "uncertain";
    else if (record.steps.some(s => s.step === finalSteps[record.kind] && s.status === "confirmed")) record.status = "completed";
    else record.status = "interrupted";
    this.put(record);
    return { ...this.summary(record), result: record.status === "completed" ? record.result ?? null : null,
      next: record.status === "interrupted" ? "No pending transaction found. Inspect order and allowance, then prepare a new action within actual authorization; nothing was resent."
        : record.status === "uncertain" ? "Outcome unresolved; wallet remains blocked. Keep this journal and check again; do not resend or delete the lock." : "Confirmed from canonical receipts; nothing was resent." };
  }
}
