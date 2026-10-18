import { readFile, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import solc from "solc";

const files = ["contracts/OrderNetwork.sol", "contracts/OrderPayloads.sol", "contracts/test/MockPaymentToken.sol", "contracts/test/PilotPaymentToken.sol", "contracts/test/MockUSDC.sol"];
const sources = Object.fromEntries(await Promise.all(files.map(async file => [file, { content: await readFile(file, "utf8") }])));
const input = {
  language: "Solidity", sources,
  settings: {
    optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "cancun",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "evm.deployedBytecode.immutableReferences"] } }
  }
};
const output = JSON.parse(solc.compile(JSON.stringify(input), {
  import: name => {
    try { return { contents: readFileSync(path.join("node_modules", name), "utf8") }; }
    catch { return { error: `Import not found: ${name}` }; }
  }
}));
for (const error of output.errors ?? []) {
  if (error.severity === "error") console.error(error.formattedMessage);
}
if (output.errors?.some(error => error.severity === "error")) process.exit(1);
await mkdir("artifacts", { recursive: true });
for (const file of files) {
  for (const [name, artifact] of Object.entries(output.contracts[file])) {
    const deployedBytes = artifact.evm.deployedBytecode.object.length / 2;
    if (deployedBytes > 24_576) throw new Error(`${name} exceeds EIP-170 size limit`);
    await writeFile(`artifacts/${name}.json`, JSON.stringify({
      contractName: name, compiler: solc.version(), abi: artifact.abi,
      bytecode: `0x${artifact.evm.bytecode.object}`, runtimeBytecode: `0x${artifact.evm.deployedBytecode.object}`,
      immutableReferences: artifact.evm.deployedBytecode.immutableReferences ?? {}, deployedBytes
    }, null, 2) + "\n");
    console.log(`Compiled ${name}: ${deployedBytes} runtime bytes`);
  }
}
