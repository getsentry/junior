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
const compiledAppRoot = "/__junior_content__/app";
const compiledNodeModulesRoot = "/__junior_content__/node_modules";

function fail(message) {
  throw new Error(`Vercel output check failed: ${message}`);
}

function requireFile(filePath) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    fail(`missing file ${path.relative(appRoot, filePath)}`);
  }
}

function rejectFile(filePath) {
  if (existsSync(filePath) && statSync(filePath).isFile()) {
    fail(`unexpected copied file ${path.relative(appRoot, filePath)}`);
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

function readVirtualContent(functionDir) {
  const virtualContentPath = path.join(functionDir, "_virtual", "content.mjs");
  requireFile(virtualContentPath);
  const raw = readFileSync(virtualContentPath, "utf8");
  const match =
    /^export const content = (.*);\n?$/s.exec(raw) ??
    /(?:^|\n)const content = (\{[\s\S]*\});\n\/\/#endregion\nexport \{ content \};\n?$/.exec(
      raw,
    );
  if (!match) {
    fail(
      `${path.relative(appRoot, virtualContentPath)} does not export a compiled content graph`,
    );
  }

  return JSON.parse(match[1]);
}

function requireCompiledFile(content, virtualPath, functionDir) {
  if (typeof content?.files?.[virtualPath] !== "string") {
    fail(
      `${path.relative(appRoot, functionDir)} is missing compiled file ${virtualPath}`,
    );
  }
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
  const content = readVirtualContent(functionDir);
  if (content.appRoot !== compiledAppRoot) {
    fail(`${path.relative(appRoot, functionDir)} has an unexpected app root`);
  }

  requireCompiledFile(content, `${compiledAppRoot}/SOUL.md`, functionDir);
  rejectFile(path.join(functionDir, "app", "SOUL.md"));
  requireCompiledFile(
    content,
    `${compiledAppRoot}/plugins/example-bundle/plugin.yaml`,
    functionDir,
  );
  requireCompiledFile(
    content,
    `${compiledAppRoot}/skills/example-local/SKILL.md`,
    functionDir,
  );

  for (const packageName of pluginPackages) {
    requireCompiledFile(
      content,
      `${compiledNodeModulesRoot}/${packageName}/plugin.yaml`,
      functionDir,
    );
    rejectFile(
      path.join(functionDir, "node_modules", packageName, "plugin.yaml"),
    );
  }

  return content;
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

const compiledGraphs = [];
for (const functionDir of [serverFunctionDir, queueFunctionDir]) {
  compiledGraphs.push(
    assertFunctionHasJuniorContent(functionDir, pluginPackages),
  );
}

if (JSON.stringify(compiledGraphs[0]) !== JSON.stringify(compiledGraphs[1])) {
  fail("primary and queue functions have different compiled content graphs");
}

console.log(
  `Verified compiled Junior content for ${pluginPackages.length} plugin package(s) in primary and queue functions.`,
);
