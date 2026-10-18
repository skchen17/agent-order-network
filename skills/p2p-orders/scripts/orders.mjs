import { existsSync } from "node:fs";
const bundled = new URL("../runtime/src/agent-tools.mjs", import.meta.url);
const source = new URL("../../../src/agent-tools.mjs", import.meta.url);
const entry = existsSync(bundled) ? bundled : source;
if (!existsSync(entry)) throw new Error("Missing Skill runtime. Use the packaged Skill or run this script from the repository Skill folder.");
const { runAgentTool } = await import(entry.href);
process.exitCode = await runAgentTool();
