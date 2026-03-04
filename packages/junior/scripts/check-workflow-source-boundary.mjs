#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { builtinModules } from "node:module";

const projectRoot = process.cwd();
const workflowRoot = path.join(projectRoot, "src", "chat", "workflow");
const sourceExts = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];

const disallowedSpecifiers = new Set([
  "@/chat/bot",
  "@/chat/slack-actions/client",
  "@chat-adapter/slack",
  "@slack/web-api"
]);

const builtinSet = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => (name.startsWith("node:") ? name.slice(5) : `node:${name}`))
]);

function isNodeBuiltin(specifier) {
  return builtinSet.has(specifier) || specifier.startsWith("node:");
}

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(fullPath)));
      continue;
    }
    if (sourceExts.some((ext) => entry.name.endsWith(ext))) {
      files.push(fullPath);
    }
  }
  return files;
}

function extractImports(source) {
  const imports = [];
  const staticImportRegex = /(^|\n)\s*import\s+(?:type\s+)?[^;\n]*?from\s+["']([^"']+)["']/g;
  const sideEffectImportRegex = /(^|\n)\s*import\s+["']([^"']+)["']/g;
  const exportFromRegex = /(^|\n)\s*export\s+[^;\n]*?from\s+["']([^"']+)["']/g;
  const dynamicImportRegex = /import\(\s*["']([^"']+)["']\s*\)/g;

  for (const regex of [staticImportRegex, sideEffectImportRegex, exportFromRegex, dynamicImportRegex]) {
    let match;
    while ((match = regex.exec(source)) !== null) {
      imports.push(match[2] ?? match[1]);
    }
  }

  return imports;
}

const files = await walk(workflowRoot);
const violations = [];

for (const file of files) {
  const source = await fs.readFile(file, "utf8");
  const imports = extractImports(source);
  for (const specifier of imports) {
    if (!specifier) continue;
    if (disallowedSpecifiers.has(specifier) || isNodeBuiltin(specifier)) {
      violations.push({ file, specifier });
    }
  }
}

if (violations.length > 0) {
  console.error("Workflow source boundary check failed:\n");
  for (const violation of violations) {
    console.error(`- ${path.relative(projectRoot, violation.file)} imports '${violation.specifier}'`);
  }
  process.exit(1);
}

console.log(`Workflow source boundary check passed for ${files.length} files.`);
