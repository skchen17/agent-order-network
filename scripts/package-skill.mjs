import { cp, mkdir, access, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { out: { type: "string" } } });
const target = path.resolve(values.out ?? path.join(root, ".local-demo", "skill-packages", randomUUID(), "p2p-orders"));
try { await access(target); throw new Error("Choose a new output directory; existing Skill packages are not overwritten"); }
catch (error) { if (error.code !== "ENOENT") throw error; }
for (const name of ["OrderNetwork", "OrderPayloads", "MockPaymentToken", "PilotPaymentToken"]) await access(path.join(root, "artifacts", `${name}.json`));
await mkdir(path.dirname(target), { recursive: true });
await cp(path.join(root, "skills", "p2p-orders"), target, { recursive: true });
const runtime = path.join(target, "runtime");
await mkdir(path.join(runtime, "artifacts"), { recursive: true });
await cp(path.join(root, "src"), path.join(runtime, "src"), { recursive: true });
for (const name of ["OrderNetwork", "OrderPayloads", "MockPaymentToken", "PilotPaymentToken"]) await cp(path.join(root, "artifacts", `${name}.json`), path.join(runtime, "artifacts", `${name}.json`));
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
// Preserve exact lock/dependency graph. No dev dependencies are installed by --omit=dev.
pkg.scripts = {};
await writeFile(path.join(runtime, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
await cp(path.join(root, "package-lock.json"), path.join(runtime, "package-lock.json"));
console.log(JSON.stringify({ skill: target, runtime, containsWallets: false, containsNodeModules: false,
  next: "Install runtime dependencies with npm --prefix <runtime> ci --omit=dev, then place the Skill folder in your host's supported Skill location." }, null, 2));
