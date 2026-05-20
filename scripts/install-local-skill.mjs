#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCatalog } from "../skills/eks-maturity-advisor/scripts/generate_catalog.mjs";
import { writeFileSync } from "node:fs";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const source = path.join(root, "skills/eks-maturity-advisor");
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const destination = path.join(codexHome, "skills/eks-maturity-advisor");
const force = process.argv.includes("--force");

if (existsSync(destination) && !force) {
  console.error(`Skill already exists at ${destination}. Re-run with --force to replace it.`);
  process.exit(1);
}

const catalogPath = path.join(source, "references/catalog.json");
writeFileSync(catalogPath, `${JSON.stringify(buildCatalog({ root }), null, 2)}\n`, "utf8");

if (existsSync(destination)) {
  rmSync(destination, { recursive: true, force: true });
}

mkdirSync(path.dirname(destination), { recursive: true });
cpSync(source, destination, { recursive: true });

console.log(`Installed eks-maturity-advisor to ${destination}`);
console.log("Restart Codex to pick up new skills.");
