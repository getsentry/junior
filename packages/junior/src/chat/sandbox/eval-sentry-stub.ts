/** Build the eval-only Sentry CLI shim copied into sandbox test environments. */
export function buildEvalSentryCliStub(): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const args = process.argv.slice(2);
const fallbackBinaries = ["/usr/bin/sentry", "/usr/local/bin/sentry", "/bin/sentry"];

function hasFlag(name) {
  return args.includes(name) || args.some((value) => value.startsWith(name + "="));
}

function outputJson(value) {
  fs.writeFileSync(process.stdout.fd, JSON.stringify(value, null, 2) + "\\n");
}

function outputText(value) {
  fs.writeFileSync(process.stdout.fd, value);
}

function fallbackToRealSentry() {
  for (const binary of fallbackBinaries) {
    if (!fs.existsSync(binary)) {
      continue;
    }
    const result = spawnSync(binary, args, { stdio: "inherit" });
    process.exit(result.status ?? 1);
  }
  process.stderr.write("sentry stub: unsupported command\\n");
  process.exit(1);
}

if (args.length === 0 || args[0] === "--version" || args[0] === "version") {
  outputText("sentry-cli 2.0.0 (junior-eval)\\n");
  process.exit(0);
}

if (args[0] === "issues" && args[1] === "list") {
  if (hasFlag("--json")) {
    outputJson([]);
  } else {
    outputText("No issues found.\\n");
  }
  process.exit(0);
}

if (args[0] === "organizations" && args[1] === "list") {
  if (hasFlag("--json")) {
    outputJson([{ slug: "getsentry", name: "Sentry" }]);
  } else {
    outputText("getsentry\\n");
  }
  process.exit(0);
}

fallbackToRealSentry();
`;
}
