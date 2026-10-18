import { Contract } from "ethers";
import { scanEvents } from "./log-scan.mjs";

export const QUOTE_TYPES = {
  Quote: [
    { name: "orderId", type: "uint256" },
    { name: "termsHash", type: "bytes32" },
    { name: "provider", type: "address" },
    { name: "price", type: "uint256" },
    { name: "deliverBy", type: "uint64" },
    { name: "validUntil", type: "uint64" }
  ]
};
export const STATUS = ["Open", "Funded", "Submitted", "Disputed", "Completed", "Cancelled", "Refunded"];

/// Framework-independent adapter; a caller may expose these methods as agent tools.
export class OrderClient {
  constructor(address, abi, signer) {
    this.signer = signer;
    this.contract = new Contract(address, abi, signer);
  }

  async publish(request) {
    const receipt = await this.send("createOrder", [request], "create_order");
    const event = receipt.logs.map(log => {
      try { return this.contract.interface.parseLog(log); } catch { return null; }
    }).find(log => log?.name === "OrderCreated");
    if (!event) throw new Error("Missing OrderCreated event");
    return event.args.orderId;
  }

  async discover(taskType, fromBlock = 0, toBlock = "latest") {
    const events = await this.contract.queryFilter(
      this.contract.filters.OrderCreated(null, null, taskType), fromBlock, toBlock
    );
    const orders = [];
    const block = await this.signer.provider.getBlock("latest");
    for (const event of events) {
      const order = await this.contract.getOrder(event.args.orderId);
      if (Number(order.status) === 0 && order.acceptUntil > BigInt(block.timestamp)) {
        orders.push({ orderId: event.args.orderId, order });
      }
    }
    return orders;
  }

  async quote(orderId, { price, deliverBy, validUntil }) {
    const order = await this.contract.getOrder(orderId);
    const quote = { orderId, termsHash: order.termsHash, provider: await this.signer.getAddress(), price, deliverBy, validUntil };
    const { chainId } = await this.signer.provider.getNetwork();
    const domain = { name: "AgentOrderNetwork", version: "1", chainId, verifyingContract: await this.contract.getAddress() };
    return { quote, signature: await this.signer.signTypedData(domain, QUOTE_TYPES, quote) };
  }

  async postQuote(signedQuote) {
    return this.send("postQuote", [signedQuote.quote, signedQuote.signature], "post_quote");
  }

  async getQuotes(orderId, fromBlock = 0, toBlock = "latest") {
    const end = toBlock === "latest" ? (await this.signer.provider.getBlock("latest")).number : Number(toBlock);
    const events = await scanEvents(this.contract, this.contract.filters.QuotePosted(orderId), fromBlock, end);
    return events.map(({ args, blockNumber, transactionHash }) => ({
      quote: { orderId: args.orderId, provider: args.provider, termsHash: args.termsHash,
        price: args.price, deliverBy: args.deliverBy, validUntil: args.validUntil },
      signature: args.signature, blockNumber, transactionHash
    }));
  }

  /// Local per-call limit, not a persistent daily budget or an on-chain session policy.
  async accept(signedQuote, maxSpend) {
    if (BigInt(signedQuote.quote.price) > BigInt(maxSpend)) throw new Error("Local spend limit exceeded");
    return this.send("acceptQuote", [signedQuote.quote, signedQuote.signature], "accept_quote");
  }

  async submit(orderId, resultHash, resultURI) {
    return this.send("submitResult", [orderId, resultHash, resultURI], "submit_result");
  }

  async send(method, args, step) {
    return this.transact ? this.transact(step, this.contract, method, args) : (await this.contract[method](...args)).wait();
  }
}
