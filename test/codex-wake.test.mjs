import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { id } from "ethers";
import { runCodexWake } from "../src/codex-wake.mjs";
import { readJSON, saveJSON } from "../src/agent-runtime.mjs";
import { exportPilotEvidence } from "../src/pilot.mjs";

test("Codex adapter requires completed turn and exact event receipts, persists before ack, deduplicates re-delivery", async () => {
  const directory = path.resolve(".local-demo/codex-adapter-tests", randomUUID()); await mkdir(directory, { recursive: true });
  const stub = path.join(directory, "stub.mjs");
  await writeFile(stub, `import { writeFile, appendFile, readFile } from 'node:fs/promises';
const mode=await readFile('mode.txt','utf8');let prompt='';for await(const c of process.stdin)prompt+=c;
const payload=JSON.parse(prompt.split('事件数据：\\n').at(-1));const args=process.argv;
await appendFile('calls.txt','called\\n');
await writeFile(args[args.indexOf('--output-last-message')+1],JSON.stringify({acceptedEventIds:mode==='bad-ids'?['wrong']:payload.events.map(e=>e.eventId),summary:'只读检查完成',requiresUserAction:true}));
console.log(JSON.stringify({type:'thread.started',thread_id:args.at(-2)}));
if(mode!=='no-completion')console.log(JSON.stringify({type:'turn.completed'}));`);
  const binding = { sessionId: randomUUID(), codex: process.execPath, codexPrefixArgs: [stub], workspace: directory,
    configFile: path.join(directory, "config.json"), stateDir: path.join(directory, "state"), skillFile: path.resolve("skills/p2p-orders/SKILL.md"), allowNonGit: true };
  const bindingFile = path.join(directory, "binding.json"); await saveJSON(bindingFile, binding);
  const payload = { type: "p2p-orders-wake.v1", configFile: binding.configFile, stateDir: binding.stateDir,
    events: [{ eventId: id("first"), orderId: "1" }] };
  const run = () => runCodexWake(["--binding", bindingFile], { input: Readable.from([JSON.stringify(payload)]), output: { write() {} } });
  await writeFile(path.join(directory, "mode.txt"), "no-completion"); assert.equal(await run(), 1);
  await writeFile(path.join(directory, "mode.txt"), "bad-ids"); assert.equal(await run(), 1);
  await writeFile(path.join(directory, "mode.txt"), "ok"); assert.equal(await run(), 0);
  const attention = await readJSON(path.join(binding.stateDir, "attention.json"));
  assert.equal(attention.moneyAuthorization, false); assert.deepEqual(attention.acceptedEventIds, [id("first")]);
  assert.equal(await run(), 0);
  assert.equal((await readFile(path.join(directory, "calls.txt"), "utf8")).trim().split("\n").length, 3);
  const wrong = { ...payload, stateDir: path.join(directory, "other-identity") };
  assert.equal(await runCodexWake(["--binding", bindingFile], { input: Readable.from([JSON.stringify(wrong)]), output: { write() {} } }), 1);
});

test("participant evidence export excludes wallet keys, RPC credentials, model text and local paths", async () => {
  const directory = path.resolve(".local-demo/codex-adapter-tests", randomUUID()), participantFile = path.join(directory, "participant.json");
  const configFile = path.join(directory, "config.json"), stateDir = path.join(directory, "state");
  await saveJSON(configFile, { chainId: 84532, environment: "public-testnet", network: "base-sepolia", privateKey: "SECRET-KEY", rpcUrl: "https://private.example/SECRET-RPC" });
  await saveJSON(participantFile, { participantId: randomUUID(), deviceId: randomUUID(), address: "public-address", role: "seller", configFile, stateDir });
  await saveJSON(path.join(stateDir, "attention.json"), { sessionId: randomUUID(), acceptedEventIds: [], summary: "PRIVATE-MODEL-CONTEXT", evidenceDirectory: directory });
  const output = path.join(directory, "share.json"); await exportPilotEvidence(participantFile, output);
  const text = await readFile(output, "utf8");
  for (const secret of ["SECRET-KEY", "SECRET-RPC", "PRIVATE-MODEL-CONTEXT", directory]) assert.ok(!text.includes(secret));
  await assert.rejects(exportPilotEvidence(participantFile, output), /exist/);
});
