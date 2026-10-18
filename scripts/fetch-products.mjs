import { parseArgs } from "node:util";
import { readJSON, saveJSON, json } from "../src/agent-runtime.mjs";
import { collectProducts } from "../src/live-products.mjs";
import { createWebFetcher } from "../src/safe-web.mjs";

const { values } = parseArgs({ options: {
  task: { type: "string", default: "examples/live-products.task.json" },
  out: { type: "string", default: ".local-demo/live-products.json" },
  hosts: { type: "string", default: "books.toscrape.com" }
} });
const policy = { allowedHosts: values.hosts.split(","), maxPages: 10, timeoutMs: 15000, minIntervalMs: 1000 };
const result = await collectProducts(await readJSON(values.task), policy, createWebFetcher(policy));
await saveJSON(values.out, result);
console.log(json({ output: values.out, products: result.items.map(({ source, name, price, currency }) => ({ source, name, price, currency })) }));
