#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

const PHASE_DIRS = [
  ["quick-wins", "Quick Wins"],
  ["foundational", "Foundational"],
  ["efficient", "Efficient"],
];

function readMarkdownFiles(dir) {
  if (!existsSync(dir)) return [];

  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const current = path.join(dir, entry.name);
    if (entry.isDirectory()) return readMarkdownFiles(current);
    if (!/\.(md|mdx)$/.test(entry.name) || entry.name === "index.mdx") return [];
    return [current];
  });
}

function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return [{}, text];
  return [yaml.load(match[1]) ?? {}, text.slice(match[0].length)];
}

function extractSection(text, headingPattern) {
  const match = headingPattern.exec(text);
  if (!match) return "";

  const start = match.index + match[0].length;
  const next = text.slice(start).search(/\n##\s+/);
  return next === -1 ? text.slice(start) : text.slice(start, start + next);
}

function extractChecks(text) {
  return [...text.matchAll(/^\s*-\s+\[\s?\]\s+(.+)$/gm)]
    .map((match) => match[1].trim())
    .filter(Boolean);
}

function extractVerifyCommands(text) {
  const verifySection = extractSection(text, /\n##\s+검증 방법\s*\n/);
  const source = verifySection || text;
  const commands = [];

  for (const match of source.matchAll(/```(?:bash|sh|shell|console)?\n([\s\S]*?)```/g)) {
    const command = match[1]
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .join("\n");

    if (/(kubectl|aws|terraform|curl|npm|helm)\b/.test(command)) {
      commands.push(command);
    }
  }

  return commands;
}

function itemIdFromSource(root, file) {
  const relative = path.relative(path.join(root, "src/content/docs"), file);
  return relative.replace(/\.(md|mdx)$/, "");
}

export function buildCatalog({ root = process.cwd() } = {}) {
  const docsRoot = path.join(root, "src/content/docs");
  const items = [];

  for (const [dirName, phase] of PHASE_DIRS) {
    for (const file of readMarkdownFiles(path.join(docsRoot, dirName))) {
      const text = readFileSync(file, "utf8");
      const [frontmatter, body] = parseFrontmatter(text);

      if (frontmatter.phase !== phase) continue;

      items.push({
        item_id: itemIdFromSource(root, file),
        phase,
        domain: frontmatter.domain ?? "미분류",
        title: frontmatter.title,
        difficulty: frontmatter.difficulty ?? "미정",
        href: `/${itemIdFromSource(root, file)}`,
        checks: extractChecks(body),
        verify_commands: extractVerifyCommands(body),
        source_reference: path.relative(root, file),
      });
    }
  }

  items.sort((a, b) => a.phase.localeCompare(b.phase) || a.domain.localeCompare(b.domain) || a.item_id.localeCompare(b.item_id));
  return {
    generated_from: ["src/content/docs/quick-wins", "src/content/docs/foundational", "src/content/docs/efficient", "src/data/maturity-items.json"],
    items,
  };
}

function parseArgs(argv) {
  const args = { root: process.cwd(), output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") args.root = argv[++index];
    if (arg === "--output") args.output = argv[++index];
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const catalog = buildCatalog({ root: path.resolve(args.root) });
  const json = `${JSON.stringify(catalog, null, 2)}\n`;

  if (args.output) {
    const outputPath = path.resolve(args.output);
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, json, "utf8");
  } else {
    process.stdout.write(json);
  }
}
