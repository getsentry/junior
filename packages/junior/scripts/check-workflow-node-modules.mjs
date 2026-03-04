#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const projectRoot = process.cwd();
const srcRoot = path.join(projectRoot, "src");
const allowedExternal = new Set(["workflow", "workflow/api"]);

const sourceExts = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];

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

function hasWorkflowDirective(source) {
  return /(^|\n)\s*["']use workflow["']\s*;?/.test(source);
}

function extractStaticImports(source) {
  const imports = [];
  const importFromRegex = /(^|\n)\s*import\s+(?!type\b)[^;\n]*?from\s+["']([^"']+)["']/g;
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

async function fileExists(filepath) {
  try {
    await fs.access(filepath);
    return true;
  } catch {
    return false;
  }
}

async function resolveLocalImport(fromFile, specifier) {
  const candidates = [];
  if (specifier.startsWith("@/")) {
    const rel = specifier.slice(2);
    candidates.push(path.join(srcRoot, rel));
  } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    candidates.push(path.resolve(path.dirname(fromFile), specifier));
  } else {
    return undefined;
  }

  const resolvedCandidates = [];
  for (const base of candidates) {
    resolvedCandidates.push(base);
    for (const ext of sourceExts) {
      resolvedCandidates.push(`${base}${ext}`);
      resolvedCandidates.push(path.join(base, `index${ext}`));
    }
  }

  for (const candidate of resolvedCandidates) {
    if (await fileExists(candidate)) {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) {
        return candidate;
      }
    }
  }

  return undefined;
}

function isExternalImport(specifier) {
  return !specifier.startsWith("@/") && !specifier.startsWith("./") && !specifier.startsWith("../");
}

const allSourceFiles = await walk(srcRoot);
const workflowEntryFiles = [];
for (const file of allSourceFiles) {
  const source = await fs.readFile(file, "utf8");
  if (hasWorkflowDirective(source)) {
    workflowEntryFiles.push(file);
  }
}

const queue = [...workflowEntryFiles];
const visited = new Set();
const violations = [];

while (queue.length > 0) {
  const file = queue.shift();
  if (!file || visited.has(file)) {
    continue;
  }
  visited.add(file);

  const source = await fs.readFile(file, "utf8");
  const imports = extractStaticImports(source);

  for (const specifier of imports) {
    if (isExternalImport(specifier)) {
      if (!allowedExternal.has(specifier)) {
        violations.push({ file, specifier });
      }
      continue;
    }

    const resolvedLocal = await resolveLocalImport(file, specifier);
    if (!resolvedLocal) {
      violations.push({ file, specifier, missing: true });
      continue;
    }
    queue.push(resolvedLocal);
  }
}

if (violations.length > 0) {
  console.error("Workflow boundary check failed. Disallowed imports reachable from 'use workflow' files:\n");
  for (const violation of violations) {
    const relFile = path.relative(projectRoot, violation.file);
    if (violation.missing) {
      console.error(`- ${relFile}: cannot resolve import '${violation.specifier}'`);
    } else {
      console.error(`- ${relFile}: disallowed external import '${violation.specifier}'`);
    }
  }
  console.error("\nAllowed external imports in workflow graph: workflow, workflow/api");
  process.exit(1);
}

console.log(`Workflow boundary check passed for ${workflowEntryFiles.length} workflow entr${workflowEntryFiles.length === 1 ? "y" : "ies"}.`);
