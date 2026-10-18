import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { digest, DEMAND_TYPE } from "./demand.mjs";
import { scanEvents } from "./log-scan.mjs";

const encode = value => JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v);
// All state is owned by this participant. Nothing is sent to a directory, relay or project server.
export class HostInbox {
  static async open(session) {
    const file = (session.agent.hostStateBase ?? session.agent.stateFile) + ".inbox.sqlite";
    await mkdir(path.dirname(file), { recursive: true });
    return new HostInbox(new DatabaseSync(file), session);
  }
  constructor(db, session) {
    Object.assign(this, { db, session });
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS watches(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY,body TEXT NOT NULL,ack INTEGER NOT NULL DEFAULT 0);`);
    const identity = digest(session.context());
    if (this.meta("identity") && this.meta("identity") !== identity) { db.close(); throw new Error("Inbox belongs to another identity/deployment"); }
    this.set("identity", identity);
  }
  close() { this.db.close(); }
  meta(key) { return this.db.prepare("SELECT value FROM meta WHERE key=?").get(key)?.value; }
  set(key, value) { this.db.prepare("INSERT OR REPLACE INTO meta VALUES (?,?)").run(key, String(value)); }
  watch({ orderIds = [], discovery, reminderSeconds } = {}) {
    if (!Array.isArray(orderIds) || orderIds.length > 100 || orderIds.some(id => !/^[1-9]\d*$/.test(id))) throw new Error("Watch up to 100 positive orderIds per call");
    if (discovery !== undefined && typeof discovery !== "boolean") throw new Error("discovery must be boolean");
    if (reminderSeconds !== undefined && (!Number.isSafeInteger(reminderSeconds) || reminderSeconds < 0 || reminderSeconds > 86400)) throw new Error("reminderSeconds must be 0..86400");
    for (const id of orderIds) this.db.prepare("INSERT OR IGNORE INTO watches VALUES (?)").run(id);
    if (discovery === true && this.meta("discovery") !== "1") { this.set("cursor", (this.session.agent.config.deploymentBlock ?? 0) - 1); this.set("blockHash", ""); }
    if (discovery !== undefined) this.set("discovery", discovery ? 1 : 0);
    if (reminderSeconds !== undefined) this.set("reminderSeconds", reminderSeconds);
    return { orderIds: this.db.prepare("SELECT id FROM watches ORDER BY length(id),id").all().map(r => r.id),
      discovery: this.meta("discovery") === "1", reminderSeconds: Number(this.meta("reminderSeconds") ?? 3600) };
  }
  add(id, event) { this.db.prepare("INSERT OR IGNORE INTO inbox(id,body) VALUES (?,?)").run(id, encode({ eventId: id, ...event })); }
  pending(limit = 100) {
    const events = this.db.prepare("SELECT body FROM inbox WHERE ack=0 ORDER BY rowid LIMIT ?").all(limit).map(r => JSON.parse(r.body));
    return { events, hasMore: this.db.prepare("SELECT count(*) AS n FROM inbox WHERE ack=0").get().n > events.length };
  }
  ack(eventIds) {
    if (!Array.isArray(eventIds) || eventIds.length > 100 || eventIds.some(id => typeof id !== "string" || !/^0x[0-9a-f]{64}$/i.test(id))) throw new Error("Acknowledge up to 100 exact eventIds");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of eventIds) this.db.prepare("UPDATE inbox SET ack=1 WHERE id=?").run(id);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { acknowledged: eventIds.length, ...this.pending() };
  }
  async poll() {
    const a = this.session.agent, contract = a.client.contract, provider = a.provider ?? a.client.signer.provider;
    const deploymentBlock = a.config.deploymentBlock ?? 0;
    const latest = await provider.getBlock("latest"), watches = this.watch();
    const target = latest.number - ((a.config.confirmations ?? 1) - 1);
    if (target < deploymentBlock) return { context: this.session.context(), ...this.pending(), nextPollAt: Math.floor(Date.now() / 1000) + 10,
      unreadable: [], waitingForConfirmations: true, reset: false };
    const head = await provider.getBlock(target);
    let cursor = Number(this.meta("cursor") ?? deploymentBlock - 1), reset = false;
    if (cursor >= deploymentBlock) {
      const anchor = await provider.getBlock(cursor);
      if (cursor > head.number || anchor?.hash !== this.meta("blockHash")) { cursor = deploymentBlock - 1; reset = true; }
    }
    const topics = ["OrderCreated", "QuotePosted", "OrderFunded", "ResultSubmitted", "OrderDisputed", "OrderClosed", "Withdrawn"]
      .map(name => contract.interface.getEvent(name).topicHash);
    const logs = cursor < head.number ? await scanEvents(contract, [topics], cursor + 1, head.number, 500) : [];
    const events = [];
    for (const log of logs) {
      const parsed = contract.interface.parseLog(log), orderId = parsed.args.orderId?.toString();
      if (!(orderId && watches.orderIds.includes(orderId)) &&
        !(watches.discovery && parsed.name === "OrderCreated" && parsed.args.taskType === DEMAND_TYPE) &&
        !(parsed.name === "Withdrawn" && parsed.args.beneficiary.toLowerCase() === a.config.address.toLowerCase())) continue;
      events.push({ id: digest([log.blockHash, log.transactionHash, log.index]), body: { type: "chain_event", name: parsed.name,
        orderId: orderId ?? null, transactionHash: log.transactionHash, blockNumber: log.blockNumber, blockHash: log.blockHash,
        instruction: "Read current order and any delivery with protocol tools; this event is not authorization to trade." } });
    }
    // Alerts use wall time as well as chain time: a quiet chain must not suppress a deadline alert.
    const now = Math.max(Math.floor(Date.now() / 1000), Number(head.timestamp));
    let nextPollAt = now + 60;
    const unreadable = [];
    for (const orderId of watches.orderIds) {
      try {
        const order = await contract.getOrder(orderId, { blockTag: head.number });
        events.push({ id: digest(["snapshot", orderId, order.toObject()]), body: { type: "order_snapshot", orderId,
          status: Number(order.status), blockNumber: head.number,
          instruction: "Re-read this order and quotes/delivery as appropriate. Snapshot is state information, not permission to trade." } });
        const status = Number(order.status), deadline = Number(status === 0 ? order.acceptUntil : status === 1 ? order.deliverBy : status === 2 ? order.reviewUntil : status === 3 ? order.disputeUntil : 0);
        if (!deadline) continue;
        const phase = now >= deadline ? "passed" : now >= deadline - watches.reminderSeconds ? "upcoming" : null;
        if (phase) events.push({ id: digest(["deadline", orderId, status, deadline, phase]), body: {
          type: "deadline", orderId, status, deadline, phase,
          instruction: status === 2 ? "Review deadline: silence can allow provider payment. Alert the user; do not approve or dispute automatically."
            : "Read authoritative chain time/state and alert the host; do not automatically settle, refund or withdraw." } });
        for (const t of [deadline - watches.reminderSeconds, deadline]) if (t > now) nextPollAt = Math.min(nextPollAt, t);
      } catch { unreadable.push({ orderId, reason: "Order could not be read; retry without assuming it is finished" }); }
    }
    if ((await provider.getBlock(head.number))?.hash !== head.hash) throw new Error("Chain changed during polling; cursor was not advanced");
    // A second simultaneous poll must not move a newer cursor backwards.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = Number(this.meta("cursor") ?? deploymentBlock - 1);
      if (current > cursor && !reset) throw new Error("Concurrent poll advanced the cursor; retry");
      if (reset) this.db.exec("DELETE FROM inbox");
      for (const event of events) this.add(event.id, event.body);
      this.set("cursor", head.number); this.set("blockHash", head.hash); this.set("nextPollAt", nextPollAt);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { context: this.session.context(), fromBlock: cursor + 1, toBlock: head.number, reset,
      nextPollAt, unreadable, ...this.pending(),
      delivery: "Durable at-least-once inbox. Ack only after the host handles an event. Polling never signs or sends transactions." };
  }
}
