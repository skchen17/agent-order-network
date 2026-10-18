// Real Codex CLI driver: does not generate terms, select orders, or simulate authorization.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  codex: { type: "string", default: "codex" }, directory: { type: "string" },
  prompt: { type: "string" }, phase: { type: "string", default: "initial" }, resume: { type: "string" }
} });
if (!values.directory || !values.prompt || !/^[a-z0-9-]+$/.test(values.phase)) throw new Error("Provide directory, prompt file and safe phase name");
const directory = path.resolve(values.directory);
const evidence = path.join(directory, "evidence");
await mkdir(evidence, { recursive: true });
const prefix = path.join(evidence, values.phase);
const events = createWriteStream(prefix + ".jsonl", { flags: "wx" });
const errors = createWriteStream(prefix + ".stderr.log", { flags: "wx" });
const common = ["exec", "--sandbox", "workspace-write", "-c", "sandbox_workspace_write.network_access=true",
  "-c", 'approval_policy="never"'];
const args = values.resume
  ? [...common, "resume", "--json", "--skip-git-repo-check", "--output-last-message", prefix + ".final.md", values.resume, "-"]
  : [...common, "--json", "--skip-git-repo-check", "--cd", directory, "--output-last-message", prefix + ".final.md", "-"];
const prompt = await readFile(path.resolve(values.prompt), "utf8");
const child = spawn(values.codex, args, { cwd: directory, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
console.log(JSON.stringify({ event: "codex_started", phase: values.phase, pid: child.pid, directory, resumed: values.resume ?? null }));
let pending = "", sessionId = values.resume ?? null;
child.stdout.on("data", chunk => {
  events.write(chunk); pending += chunk.toString("utf8");
  const lines = pending.split("\n"); pending = lines.pop();
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type === "thread.started") {
        sessionId = event.thread_id;
        console.log(JSON.stringify({ event: "thread_started", phase: values.phase, sessionId }));
      } else if (event.type === "error" || event.type === "turn.failed") console.log(JSON.stringify({ event: event.type, message: event.message ?? event.error?.message }));
    } catch { /* Preserve raw output in evidence. */ }
  }
});
child.stderr.on("data", chunk => errors.write(chunk));
child.stdin.on("error", () => {}); child.stdin.end(prompt);
process.on("SIGINT", () => child.kill()); process.on("SIGTERM", () => child.kill());
child.once("error", error => { console.error(error.message); process.exitCode = 1; });
child.once("close", async code => {
  events.end(); errors.end();
  console.log(JSON.stringify({ event: "codex_finished", phase: values.phase, sessionId, code, evidence: prefix }));
  try { console.log((await readFile(prefix + ".final.md", "utf8")).slice(-10000)); } catch { /* Startup failures may have no final message. */ }
  process.exitCode = code ?? 1;
});
