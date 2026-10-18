import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createDraft, generateDraft, validateDraft, matchDemand } from "../src/demand.mjs";

const example = JSON.parse(await readFile(new URL("../examples/research-demand.json", import.meta.url), "utf8"));
test("complex terms preserve branches, exclusions and original language without implying automatic enforceability", () => {
  assert.deepEqual(validateDraft(example, true), []);
  const draft = createDraft("请帮我调研，但不要擅自付费。");
  assert.ok(validateDraft(draft).includes("deliverables"));
  assert.throws(() => validateDraft(draft, true), /clarify/);
  assert.throws(() => validateDraft({ ...example, questions: ["预算是什么币种？"] }, true), /unresolved/);
  assert.throws(() => validateDraft({ ...example, budget: "1.0000001" }, true), /budget/);
  assert.throws(() => validateDraft({ ...example, deliveryHours: 1 }, true), /deliveryHours/);
  assert.throws(() => validateDraft({ ...example, payTo: "attacker" }), /Unknown/);
});

test("optional local model receives no wallet/tools and its output must pass the bounded schema", async () => {
  const body = Object.fromEntries(Object.entries(example).filter(([key]) => !["profile", "draftId", "sourceText", "createdAt", "generator"].includes(key)));
  let request;
  const draft = await generateDraft("调研三个协议，未知数字不要猜。", { model: "operator-installed-model", fetchImpl: async (url, options) => {
    assert.equal(url.hostname, "127.0.0.1"); request = JSON.parse(options.body);
    return Response.json({ done: true, message: { content: JSON.stringify(body) } });
  } });
  assert.equal(draft.generator, "ollama:operator-installed-model");
  assert.equal(draft.sourceText, "调研三个协议，未知数字不要猜。");
  assert.equal(request.tools, undefined);
  assert.equal(request.format.additionalProperties, false);
  assert.equal(JSON.stringify(request).includes("privateKey"), false);
  await assert.rejects(generateDraft("需求", { model: "m", endpoint: "https://remote.example" }), /local HTTP/);
  await assert.rejects(generateDraft("需求", { model: "m", fetchImpl: async () => Response.json({ done: true, message: { content: JSON.stringify({ ...body, tools: ["transfer"] }) } }) }), /schema/);
  await assert.rejects(generateDraft("需求", { model: "m", fetchImpl: async () => new Response("offline", { status: 503 }) }), /no fallback/);
});

test("local matching uses explicit capabilities and leaves complex clauses for user review", () => {
  const order = { maxPrice: "2000000", latestDeliveryAt: 100000 };
  const profile = { skills: ["RESEARCH", "chinese"], languages: ["zh"], minBudget: "1", neededHours: 3 };
  const result = matchDemand(example, order, profile, 1);
  assert.equal(result.matched, true);
  assert.ok(result.needsHumanReview.some(item => item.field === "conditions"));
  const missing = matchDemand(example, order, { ...profile, skills: ["research"], minBudget: "3" }, 1);
  assert.equal(missing.matched, false);
  assert.equal(missing.rejected.length, 2);
  assert.throws(() => matchDemand(example, order, { skills: [42] }, 1), /skill tags/);
});
