import type { PluginCommandProxy } from "@/chat/plugins/types";
import {
  COMMAND_PROXY_ACTIVE_PROVIDERS_ENV,
  COMMAND_PROXY_AUTH_REQUIRED_PROVIDERS_ENV,
} from "@/chat/sandbox/command-proxy-env";

function jsString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Build a sandbox command wrapper that requires host egress activation before exec.
 */
export function buildCommandProxyWrapper(proxy: PluginCommandProxy): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const command = ${jsString(proxy.command)};
const provider = ${jsString(proxy.provider)};
const activeProvidersEnv = ${jsString(COMMAND_PROXY_ACTIVE_PROVIDERS_ENV)};
const authRequiredProvidersEnv = ${jsString(COMMAND_PROXY_AUTH_REQUIRED_PROVIDERS_ENV)};
const args = process.argv.slice(2);

function fail(message, code = 126) {
  process.stderr.write(message.endsWith("\\n") ? message : message + "\\n");
  process.exit(code);
}

function resolveRealCommand() {
  const selfPath = fs.realpathSync(process.argv[1]);
  const selfDir = path.dirname(selfPath);
  const pathEntries = (process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);

  for (const entry of pathEntries) {
    let resolvedDir;
    try {
      resolvedDir = fs.realpathSync(entry);
    } catch {
      continue;
    }
    if (resolvedDir === selfDir) {
      continue;
    }
    const candidate = path.join(entry, command);
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) {
        continue;
      }
      fs.accessSync(candidate, fs.constants.X_OK);
      const resolvedCandidate = fs.realpathSync(candidate);
      if (resolvedCandidate !== selfPath) {
        return candidate;
      }
    } catch {}
  }

  return undefined;
}

function providersFromEnv(name) {
  return new Set(
    (process.env[name] || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function requireActivatedProvider() {
  if (providersFromEnv(activeProvidersEnv).has(provider)) {
    return;
  }
  if (providersFromEnv(authRequiredProvidersEnv).has(provider)) {
    fail(
      "No " +
        provider +
        " credentials available. Connect " +
        provider +
        " and retry.\\nJUNIOR_COMMAND_PROXY_AUTH_REQUIRED provider=" +
        provider,
      91
    );
  }
  fail(
    "Junior command proxy has no active host egress credentials for provider " +
      provider
  );
}

(() => {
  requireActivatedProvider();
  const realCommand = resolveRealCommand();
  if (!realCommand) {
    fail("Junior command proxy could not find real command: " + command);
  }
  const result = spawnSync(realCommand, args, {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) {
    fail(result.error.message);
  }
  if ((result.status ?? 1) !== 0) {
    process.stderr.write(
      "\\nJUNIOR_COMMAND_PROXY_PROVIDER provider=" + provider + "\\n"
    );
  }
  process.exit(result.status ?? 1);
})();
`;
}
