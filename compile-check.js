const solc = require("solc");
const fs = require("fs");
const path = require("path");

function findImports(importPath) {
  try {
    let fullPath;
    if (importPath.startsWith("@openzeppelin")) {
      fullPath = path.join(__dirname, "node_modules", importPath);
    } else {
      fullPath = path.join(__dirname, "contracts", importPath);
    }
    return { contents: fs.readFileSync(fullPath, "utf8") };
  } catch (e) {
    return { error: "File not found: " + importPath };
  }
}

const files = ["GameRewards.sol"];
const sources = {};
for (const f of files) {
  sources[f] = { content: fs.readFileSync(path.join(__dirname, "contracts", f), "utf8") };
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "cancun",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));

let hasError = false;
if (output.errors) {
  for (const err of output.errors) {
    if (err.severity === "error") {
      hasError = true;
      console.log("ERROR:", err.formattedMessage);
    } else {
      console.log("WARN:", err.formattedMessage);
    }
  }
}

if (!hasError) {
  console.log("\n✅ Compilation succeeded with no errors.");
  for (const f of files) {
    for (const contractName of Object.keys(output.contracts[f])) {
      const bytecodeLen = output.contracts[f][contractName].evm.bytecode.object.length / 2;
      console.log(`  - ${contractName}: bytecode ${bytecodeLen} bytes`);
    }
  }
  // Save ABIs for reuse by backend/frontend
  const abis = {};
  for (const f of files) {
    for (const contractName of Object.keys(output.contracts[f])) {
      abis[contractName] = output.contracts[f][contractName].abi;
    }
  }
  fs.writeFileSync(path.join(__dirname, "abis.json"), JSON.stringify(abis, null, 2));
  console.log("\nSaved ABIs to abis.json");
} else {
  process.exit(1);
}
