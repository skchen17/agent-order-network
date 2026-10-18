import { Contract, keccak256, toUtf8Bytes, toUtf8String } from "ethers";
import { scanEvents } from "./log-scan.mjs";
import { encodeInline, decodeInline } from "./inline-payload.mjs";

export class PayloadClient {
  constructor({ address, abi, signer, chainId, fromBlock }) {
    Object.assign(this, { address, signer, chainId, fromBlock });
    this.contract = new Contract(address, abi, signer);
    this.cache = new Map();
  }

  async writeJSON(value) {
    const text = JSON.stringify(value);
    try { return encodeInline(text, "application/json"); } catch { /* bounded on-chain bulletin */ }
    const bytes = toUtf8Bytes(text);
    if (bytes.length > 32768) throw new Error("Public payload exceeds 32 KiB pilot limit");
    const digest = keccak256(bytes);
    if (!await this.contract.published(digest)) {
      if (this.transact) await this.transact("publish_payload", this.contract, "put", [bytes]);
      else await (await this.contract.put(bytes)).wait();
    }
    return `evmdata:${this.chainId}:${this.address}:${digest}`;
  }

  async readJSON(uri) {
    let text;
    if (uri.startsWith("data:")) text = decodeInline(uri, "application/json");
    else {
      const match = /^evmdata:(\d+):(0x[0-9a-fA-F]{40}):(0x[0-9a-fA-F]{64})$/.exec(uri);
      if (!match || Number(match[1]) !== this.chainId || match[2].toLowerCase() !== this.address.toLowerCase()) {
        throw new Error("Unapproved payload chain or contract");
      }
      const digest = match[3];
      text = this.cache.get(digest);
      if (!text) {
        const end = (await this.signer.provider.getBlock("latest")).number;
        const events = await scanEvents(this.contract, this.contract.filters.PayloadPublished(digest), this.fromBlock, end);
        if (events.length !== 1 || keccak256(events[0].args.data) !== digest) throw new Error("Missing or invalid payload");
        text = toUtf8String(events[0].args.data);
        if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value);
        this.cache.set(digest, text);
      }
    }
    return { value: JSON.parse(text), text };
  }
}
