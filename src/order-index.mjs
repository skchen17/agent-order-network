import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { scanEvents } from "./log-scan.mjs";

const stringify = value => JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item);

export class OrderIndex {
  static async open(file, options) {
    if (file !== ":memory:") await mkdir(path.dirname(file), { recursive: true });
    return new OrderIndex(new DatabaseSync(file), options);
  }

  constructor(db, { client, deploymentBlock, identity, taskTypes, blockSpan = 500, confirmations = 0, capabilityKey = "" }) {
    Object.assign(this, { db, client, deploymentBlock, taskTypes, blockSpan, confirmations });
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, taskType TEXT NOT NULL, buyer TEXT NOT NULL,
        status INTEGER NOT NULL, acceptUntil INTEGER NOT NULL, maxPrice TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS exclusions(id TEXT PRIMARY KEY, reason TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS available_orders ON orders(status,taskType,acceptUntil);`);
    const fingerprint = stringify({ identity, taskTypes: [...taskTypes].sort(), deploymentBlock });
    const existing = this.meta("identity");
    if (existing && existing !== fingerprint) { db.close(); throw new Error("Index belongs to another deployment or capability set"); }
    this.setMeta("identity", fingerprint);
    if (this.meta("capabilities") !== capabilityKey) {
      db.exec("DELETE FROM exclusions");
      this.setMeta("capabilities", capabilityKey);
    }
  }

  meta(key) { return this.db.prepare("SELECT value FROM meta WHERE key=?").get(key)?.value; }
  setMeta(key, value) { this.db.prepare("INSERT OR REPLACE INTO meta VALUES (?,?)").run(key, String(value)); }

  async sync() {
    const provider = this.client.signer.provider;
    const head = await provider.getBlock("latest");
    const target = Math.max(this.deploymentBlock - 1, head.number - this.confirmations);
    let cursor = Number(this.meta("cursor") ?? this.deploymentBlock - 1);
    let reset = false;
    if (cursor >= this.deploymentBlock) {
      const anchor = await provider.getBlock(cursor);
      if (cursor > target || anchor?.hash !== this.meta("blockHash")) {
        // Rebuild on rare reorgs; ordinary polls never scan old blocks.
        cursor = this.deploymentBlock - 1;
        reset = true;
      }
    }
    if (cursor >= target && !reset) return { fromBlock: cursor + 1, toBlock: target, updated: 0, reset: false };
    const beforeAnchor = await provider.getBlock(target);
    const contract = this.client.contract;
    const created = await scanEvents(contract, contract.filters.OrderCreated(null, null, this.taskTypes), cursor + 1, target, this.blockSpan);
    const stateTopics = ["OrderFunded", "ResultSubmitted", "OrderDisputed", "OrderClosed"].map(name => contract.interface.getEvent(name).topicHash);
    const changed = await scanEvents(contract, [stateTopics], cursor + 1, target, this.blockSpan);
    const ids = new Set(created.map(log => log.args.orderId.toString()));
    for (const log of changed) {
      const parsed = contract.interface.parseLog(log);
      const id = parsed.args.orderId.toString();
      if (!reset && this.db.prepare("SELECT 1 FROM orders WHERE id=?").get(id)) ids.add(id);
    }
    const records = [];
    for (const id of ids) {
      const result = await contract.getOrder(id, { blockTag: target });
      records.push({ id, ...JSON.parse(stringify(result.toObject())) });
    }
    const anchor = await provider.getBlock(target);
    if (anchor.hash !== beforeAnchor.hash) throw new Error("Chain changed during index sync; retry without advancing cursor");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (reset) this.db.exec("DELETE FROM orders; DELETE FROM exclusions");
      const insert = this.db.prepare("INSERT OR REPLACE INTO orders VALUES (?,?,?,?,?,?,?)");
      for (const order of records) insert.run(order.id, order.taskType, order.buyer.toLowerCase(), Number(order.status), Number(order.acceptUntil), order.maxPrice, stringify(order));
      this.setMeta("cursor", target);
      this.setMeta("blockHash", anchor.hash);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { fromBlock: cursor + 1, toBlock: target, updated: records.length, reset };
  }

  candidates({ now, minBudget = 0n, allowedBuyer, allowedEvaluators, taskTypes = this.taskTypes, limit = 20 }) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Candidate limit must be 1..100");
    if (!taskTypes.length) return [];
    const minimum = BigInt(minBudget).toString();
    const clauses = ["status=0", "acceptUntil>?", "id NOT IN (SELECT id FROM exclusions)", `taskType IN (${taskTypes.map(() => "?").join(",")})`,
      "(length(maxPrice)>length(?) OR (length(maxPrice)=length(?) AND maxPrice>=?))"];
    const params = [now, ...taskTypes, minimum, minimum, minimum];
    if (allowedBuyer) { clauses.push("buyer=?"); params.push(allowedBuyer.toLowerCase()); }
    if (allowedEvaluators?.length) {
      clauses.push(`lower(json_extract(payload,'$.evaluator')) IN (${allowedEvaluators.map(() => "?").join(",")})`);
      params.push(...allowedEvaluators.map(value => value.toLowerCase()));
    }
    const rows = this.db.prepare(`SELECT payload FROM orders WHERE ${clauses.join(" AND ")} ORDER BY length(maxPrice) DESC,maxPrice DESC,acceptUntil ASC LIMIT ?`)
      .all(...params, limit);
    return rows.map(row => JSON.parse(row.payload)).map(order => ({ orderId: BigInt(order.id), order }));
  }

  close() { this.db.close(); }

  // Keyset pagination without popularity/budget ordering or a hidden top-N cutoff.
  // `after` is a numeric order ID, not an offset into a mutable result set.
  page({ now, after = "0", limit = 100 }) {
    if (!/^\d+$/.test(String(after)) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid page");
    after = BigInt(after).toString();
    return this.db.prepare(`SELECT payload FROM orders WHERE status=0 AND acceptUntil>?
      AND (length(id)>length(?) OR (length(id)=length(?) AND id>?))
      ORDER BY length(id),id LIMIT ?`).all(now, after, after, after, limit)
      .map(row => JSON.parse(row.payload)).map(order => ({ orderId: BigInt(order.id), order }));
  }

  exclude(id, reason) { this.db.prepare("INSERT OR REPLACE INTO exclusions VALUES (?,?)").run(id.toString(), reason); }
}
