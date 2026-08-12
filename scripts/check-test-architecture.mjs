import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INTEGRATION_ROOT = "packages/junior/tests/integration";
const DEBT_PATH = "scripts/test-architecture-debt.json";

const RULES = [
  {
    id: "internal-module-mock",
    message: "integration tests must not mock Junior-owned @/ modules",
    pattern: /\bvi\.(?:doMock|mock)\(\s*["']@\//g,
  },
  {
    id: "pi-agent-mock",
    message: "integration tests must not mock Pi's agent",
    pattern:
      /\bvi\.(?:doMock|mock)\(\s*["']@earendil-works\/pi-agent-core["']/g,
  },
  {
    allowsDebt: true,
    id: "manufactured-agent-outcome",
    message:
      "integration tests must run the real agent instead of manufacturing agent outcomes",
    pattern: /\bcompletedAgentRun\b/g,
  },
  {
    allowsDebt: true,
    id: "scripted-agent-runner",
    message:
      "integration tests must use the model stream instead of a scripted agent runner",
    pattern:
      /\b(?:scriptedAssistantMessageRunner|createApiTurnScriptedRunner)\b/g,
  },
  {
    id: "unsafe-slack-cast",
    message:
      "integration tests must use typed Slack fixtures instead of double casts",
    pattern:
      /\bas\s+unknown\s+as\s+(?:SlackAdapter|Thread|Message)(?:\b|\s*<)/g,
  },
];

function countMatches(contents, pattern) {
  return Array.from(contents.matchAll(pattern)).length;
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

/** Report integration test violations and stale exception counts. */
export function checkIntegrationTestArchitecture(files, debt = {}) {
  const errors = [];
  const ruleIds = new Set(RULES.map((rule) => rule.id));

  for (const ruleId of Object.keys(debt)) {
    if (!ruleIds.has(ruleId)) {
      errors.push(`${DEBT_PATH}: unknown rule ${ruleId}`);
    }
  }

  for (const rule of RULES) {
    const configuredByPath = debt[rule.id] ?? {};
    if (!rule.allowsDebt && Object.keys(configuredByPath).length > 0) {
      errors.push(`${DEBT_PATH}: ${rule.id} does not allow exceptions`);
    }
    const allowedByPath = rule.allowsDebt ? configuredByPath : {};
    const actualByPath = new Map(
      files.map((file) => [
        file.path,
        countMatches(file.contents, rule.pattern),
      ]),
    );
    const paths = new Set([
      ...actualByPath.keys(),
      ...Object.keys(allowedByPath),
    ]);

    for (const filePath of paths) {
      const actual = actualByPath.get(filePath) ?? 0;
      const allowed = allowedByPath[filePath] ?? 0;
      if (
        Object.hasOwn(allowedByPath, filePath) &&
        !isPositiveInteger(allowed)
      ) {
        errors.push(
          `${DEBT_PATH}: ${rule.id} exception for ${filePath} must be a positive integer`,
        );
        continue;
      }
      if (actual > allowed) {
        errors.push(
          `${filePath}: ${rule.message} (${actual} found, ${allowed} allowed)`,
        );
      } else if (actual < allowed) {
        errors.push(
          `${DEBT_PATH}: ${rule.id} allows ${allowed} in ${filePath}, but ${actual} found; lower or remove the exception`,
        );
      }
    }
  }

  return errors;
}

function collectIntegrationTests(root) {
  const directory = path.join(root, INTEGRATION_ROOT);
  return fs
    .readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => {
      const absolutePath = path.join(entry.parentPath, entry.name);
      return {
        path: path.relative(root, absolutePath).split(path.sep).join("/"),
        contents: fs.readFileSync(absolutePath, "utf8"),
      };
    });
}

function readDebt(root) {
  return JSON.parse(fs.readFileSync(path.join(root, DEBT_PATH), "utf8"));
}

function main() {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(scriptDirectory, "..");
  const errors = checkIntegrationTestArchitecture(
    collectIntegrationTests(root),
    readDebt(root),
  );
  if (errors.length === 0) {
    console.log(
      "Integration tests do not add to known test architecture debt.",
    );
    return;
  }
  console.error(["Test architecture check failed:", ...errors].join("\n"));
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
