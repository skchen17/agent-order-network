import { access } from "node:fs/promises";
const bundled = new URL("../runtime/src/codex-wake.mjs", import.meta.url);
let runtime;
try { await access(bundled); runtime = bundled; } catch { runtime = new URL("../../../src/codex-wake.mjs", import.meta.url); }
const { runCodexWake } = await import(runtime.href);
process.exitCode = await runCodexWake();
