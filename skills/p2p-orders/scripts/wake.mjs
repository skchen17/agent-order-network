import { access } from "node:fs/promises";
const bundled = new URL("../runtime/src/host-wake.mjs", import.meta.url);
let runtime;
try { await access(bundled); runtime = bundled; } catch { runtime = new URL("../../../src/host-wake.mjs", import.meta.url); }
const { runHostWake } = await import(runtime.href);
process.exitCode = await runHostWake();
