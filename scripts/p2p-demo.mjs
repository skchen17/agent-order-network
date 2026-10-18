import { parseArgs } from "node:util";
import { runScenario } from "./p2p-scenario.mjs";
import { saveJSON } from "../src/agent-runtime.mjs";

const { values } = parseArgs({ options: { scenario: { type: "string", default: "success" }, task: { type: "string" } } });
const scenarios = values.scenario === "all" ? ["success", "restart", "nondelivery", "invalid-result"] : [values.scenario];
const summaries = [];
for (const scenario of scenarios) {
  console.log(`\nRunning independent-process scenario: ${scenario}`);
  const summary = await runScenario(scenario, { quiet: false, taskFile: values.task });
  summaries.push(summary);
  console.log(`Scenario ${scenario}: ${summary.status}; buyer PID(s) ${summary.buyerPids.join(", ")}; seller PID(s) ${summary.sellerPids.join(", ")}`);
  console.log(`Escrow ${summary.escrow}, outstanding credits ${summary.credits}. Evidence: ${summary.directory}/summary.json`);
}
await saveJSON(".local-demo/last-run.json", summaries);
console.log("Finished. Temporary chain and all agent processes have stopped. No public-chain deployment or permanent relay was used.");
