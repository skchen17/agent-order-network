import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const bundled = new URL("../runtime/src/pilot.mjs", import.meta.url);
let runtime;
try { await access(bundled); runtime = bundled; } catch { runtime = new URL("../../../src/pilot.mjs", import.meta.url); }
const { runPilot } = await import(runtime.href);
process.exitCode = await runPilot(process.argv.slice(2), { skillDirectory: fileURLToPath(new URL("..", import.meta.url)) });
