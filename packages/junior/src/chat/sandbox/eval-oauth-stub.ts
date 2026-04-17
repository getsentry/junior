/** Build the eval-only generic OAuth CLI shim copied into sandbox eval environments. */
export function buildEvalOauthCliStub(): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");

const args = process.argv.slice(2);

function outputText(value) {
  fs.writeFileSync(process.stdout.fd, value);
}

if (args.length === 0 || args[0] === "--version" || args[0] === "version") {
  outputText("eval-oauth 1.0.0 (junior-eval)\\n");
  process.exit(0);
}

if (args[0] === "whoami") {
  outputText("eval-oauth-user\\n");
  process.exit(0);
}

process.stderr.write("eval-oauth stub: unsupported command\\n");
process.exit(1);
`;
}
