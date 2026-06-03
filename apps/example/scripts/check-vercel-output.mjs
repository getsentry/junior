import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(appRoot, "../..");
const outputRoot = path.join(appRoot, ".vercel", "output");
const functionsRoot = path.join(outputRoot, "functions");
const serverFunctionDir = path.join(functionsRoot, "__server.func");
const queueFunctionDir = path.join(
  functionsRoot,
  "api",
  "internal",
  "agent",
  "continue.func",
);

function fail(message) {
  throw new Error(`Vercel output check failed: ${message}`);
}

function requireFile(filePath) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    fail(`missing file ${path.relative(appRoot, filePath)}`);
  }
}

function requireDirectory(directoryPath) {
  if (!existsSync(directoryPath) || !statSync(directoryPath).isDirectory()) {
    fail(`missing directory ${path.relative(appRoot, directoryPath)}`);
  }
}

function readJson(filePath) {
  requireFile(filePath);
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function packageSourceHasPlugin(packageName) {
  const sourceDir = path.join(
    repoRoot,
    "packages",
    packageName.replace("@sentry/", ""),
  );
  return existsSync(path.join(sourceDir, "plugin.yaml"));
}

function expectedPluginPackages() {
  const packageJson = readJson(path.join(appRoot, "package.json"));
  return Object.keys(packageJson.dependencies ?? {})
    .filter((packageName) => packageName.startsWith("@sentry/junior-"))
    .filter((packageName) => packageSourceHasPlugin(packageName))
    .sort();
}

function assertQueueTrigger() {
  const vcConfig = readJson(path.join(queueFunctionDir, ".vc-config.json"));
  const triggers = Array.isArray(vcConfig.experimentalTriggers)
    ? vcConfig.experimentalTriggers
    : [];
  if (
    !triggers.some(
      (trigger) =>
        trigger?.type === "queue/v2beta" &&
        trigger?.topic === "junior_conversation_work",
    )
  ) {
    fail(
      "queue callback function is missing the junior_conversation_work trigger",
    );
  }
}

function assertFunctionHasJuniorContent(functionDir, pluginPackages) {
  requireFile(path.join(functionDir, "index.mjs"));
  requireFile(path.join(functionDir, "app", "SOUL.md"));
  requireFile(
    path.join(functionDir, "app", "plugins", "example-bundle", "plugin.yaml"),
  );
  requireFile(
    path.join(functionDir, "app", "skills", "example-local", "SKILL.md"),
  );

  for (const packageName of pluginPackages) {
    requireFile(
      path.join(functionDir, "node_modules", packageName, "plugin.yaml"),
    );
  }
}

if (existsSync(path.join(appRoot, "api"))) {
  fail(
    "apps/example/api exists; Vercel would route source functions before Nitro",
  );
}

requireDirectory(serverFunctionDir);
requireDirectory(queueFunctionDir);
assertQueueTrigger();

const pluginPackages = expectedPluginPackages();
if (pluginPackages.length === 0) {
  fail("no plugin package fixtures were discovered for output validation");
}

for (const functionDir of [serverFunctionDir, queueFunctionDir]) {
  assertFunctionHasJuniorContent(functionDir, pluginPackages);
}

console.log(
  `Verified Vercel output for ${pluginPackages.length} plugin package(s) in primary and queue functions.`,
);
