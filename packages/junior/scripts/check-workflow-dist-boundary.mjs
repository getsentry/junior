#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { builtinModules } from "node:module";

const projectRoot = process.cwd();
const distRoot = path.join(projectRoot, "dist");
const sourceExts = [".js", ".mjs", ".cjs"];
const disallowedRuntimePatterns = [
  { regex: /from ["']@slack\/web-api["']/, reason: "@slack/web-api import" },
  { regex: /require\(\s*["']@slack\/web-api["']\s*\)/, reason: "@slack/web-api require" },
  { regex: /from ["']@chat-adapter\/slack["']/, reason: "@chat-adapter/slack import" },
  { regex: /require\(\s*["']@chat-adapter\/slack["']\s*\)/, reason: "@chat-adapter/slack require" },
  { regex: /from ["'](?:node:)?async_hooks["']/, reason: "async_hooks import" },
  { regex: /require\(\s*["'](?:node:)?async_hooks["']\s*\)/, reason: "async_hooks require" },
  { regex: /\bAsyncLocalStorage\b/, reason: "AsyncLocalStorage reference" },
  { regex: /from ["'](?:node:)?crypto["']/, reason: "crypto import" },
  { regex: /require\(\s*["'](?:node:)?crypto["']\s*\)/, reason: "crypto require" },
  { regex: /\brandomUUID\s*\(/, reason: "randomUUID call in workflow bundle" }
];

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
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
      continue;
    }
    if (sourceExts.some((ext) => entry.name.endsWith(ext))) {
      files.push(full);
    }
  }
  return files;
}

function extractStaticImports(source) {
  const imports = [];
  const importFromRegex = /(^|\n)\s*import\s+[^;\n]*?from\s+["']([^"']+)["']/g;
  const sideEffectRegex = /(^|\n)\s*import\s+["']([^"']+)["']/g;
  const exportFromRegex = /(^|\n)\s*export\s+[^;\n]*?from\s+["']([^"']+)["']/g;

  for (const regex of [importFromRegex, sideEffectRegex, exportFromRegex]) {
    let match;
    while ((match = regex.exec(source)) !== null) {
      imports.push(match[2]);
    }
  }
  return imports;
}

function hasWorkflowSignal(source) {
  return (
    /(^|\n)\s*["']use workflow["']\s*;?/.test(source) ||
    source.includes('from "workflow/api"') ||
    source.includes("from 'workflow/api'") ||
    source.includes('from "workflow"') ||
    source.includes("from 'workflow'")
  );
}

async function resolveRelativeImport(fromFile, specifier) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    return undefined;
  }

  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, ...sourceExts.map((ext) => `${base}${ext}`)];
  for (const ext of sourceExts) {
    candidates.push(path.join(base, `index${ext}`));
  }

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) {
        return candidate;
      }
    } catch {
      // ignore
    }
  }

  return undefined;
}

try {
  await fs.access(distRoot);
} catch {
  console.error("dist/ does not exist. Run 'pnpm run build:pkg' first.");
  process.exit(1);
}

const distFiles = await walk(distRoot);
const entryFiles = [];
for (const file of distFiles) {
  const source = await fs.readFile(file, "utf8");
  if (hasWorkflowSignal(source)) {
    entryFiles.push(file);
  }
}

const visited = new Set();
const queue = [...entryFiles];
const violations = [];
const contentViolations = [];

while (queue.length > 0) {
  const file = queue.shift();
  if (!file || visited.has(file)) {
    continue;
  }
  visited.add(file);

  const source = await fs.readFile(file, "utf8");
  for (const pattern of disallowedRuntimePatterns) {
    if (pattern.regex.test(source)) {
      contentViolations.push({ file, reason: pattern.reason });
    }
  }
  const imports = extractStaticImports(source);
  for (const specifier of imports) {
    if (isNodeBuiltin(specifier)) {
      violations.push({ file, specifier });
      continue;
    }

    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      const resolved = await resolveRelativeImport(file, specifier);
      if (resolved) {
        queue.push(resolved);
      }
    }
  }
}

if (violations.length > 0 || contentViolations.length > 0) {
  console.error("Workflow dist boundary check failed:\n");
  for (const violation of violations) {
    const rel = path.relative(projectRoot, violation.file);
    console.error(`- ${rel}: imports Node builtin '${violation.specifier}'`);
  }
  for (const violation of contentViolations) {
    const rel = path.relative(projectRoot, violation.file);
    console.error(`- ${rel}: contains disallowed runtime pattern (${violation.reason})`);
  }
  process.exit(1);
}

console.log(`Workflow dist boundary check passed: ${entryFiles.length} entries, ${visited.size} linked files inspected.`);
