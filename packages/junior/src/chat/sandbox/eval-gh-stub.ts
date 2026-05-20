/** Build the eval-only GitHub CLI shim copied into sandbox test environments. */
export function buildEvalGitHubCliStub(): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const args = process.argv.slice(2);
const statePath = "/vercel/sandbox/.junior/eval-gh-state.json";
const fallbackBinaries = ["/usr/bin/gh", "/usr/local/bin/gh", "/bin/gh"];
const flagsWithValues = new Set([
  "--repo",
  "--title",
  "--body",
  "--body-file",
  "--json",
  "--search",
  "--state",
  "--limit",
  "--method",
  "--jq",
  "--template",
  "--hostname",
]);

function getFlag(name) {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === name) {
      return args[index + 1];
    }
    if (value.startsWith(name + "=")) {
      return value.slice(name.length + 1);
    }
  }
  return undefined;
}

function getPositionals() {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (flagsWithValues.has(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith("--") && value.includes("=")) {
      continue;
    }
    if (value.startsWith("-")) {
      continue;
    }
    values.push(value);
  }
  return values;
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return { nextIssueNumber: 101, issues: {} };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function issueUrl(repo, number) {
  return "https://github.com/" + repo + "/issues/" + number;
}

function repoValue() {
  return getFlag("--repo") || "getsentry/junior";
}

function readBody() {
  const bodyFile = getFlag("--body-file");
  if (bodyFile) {
    try {
      return fs.readFileSync(bodyFile, "utf8");
    } catch {
      return "";
    }
  }
  return getFlag("--body") || "";
}

function defaultIssue(repo, number) {
  return {
    number,
    title: "Eval issue",
    body: "",
    state: "OPEN",
    url: issueUrl(repo, number),
    labels: [],
    assignees: [],
    author: { login: "junior-eval" },
  };
}

function pickFields(record, csv) {
  if (!csv) {
    return record;
  }
  return Object.fromEntries(
    csv
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((key) => [key, key in record ? record[key] : null]),
  );
}

function outputJson(value) {
  fs.writeFileSync(process.stdout.fd, JSON.stringify(value, null, 2) + "\\n");
}

function outputText(value) {
  fs.writeFileSync(process.stdout.fd, value);
}

const repoFiles = {
  "packages/junior/src/chat/sandbox/egress-policy.ts": \`import { resolveAuthTokenPlaceholder } from "@/chat/plugins/auth/auth-token-placeholder";
import { resolvePluginCommandEnv } from "@/chat/plugins/command-env";
import { getPluginProviders } from "@/chat/plugins/registry";

/** Build the policy that forwards provider requests back to Junior for credentials. */
export function buildSandboxEgressNetworkPolicy() {
  // Plugin credential domains are forwarded through the host so the sandbox can
  // activate requester-bound credentials for the current turn.
}

/** Resolve non-secret command environment values for registered sandbox providers. */
export async function resolveSandboxCommandEnvironment() {
  const env = {};
  for (const plugin of getPluginProviders()) {
    Object.assign(env, resolvePluginCommandEnv(plugin.manifest));
    const credentials = plugin.manifest.credentials;
    if (credentials) {
      env[credentials.authTokenEnv] = resolveAuthTokenPlaceholder(credentials);
    }
  }
  return env;
}
\`,
  "packages/junior/src/chat/plugins/registry.ts": \`import { createGitHubAppBroker } from "@/chat/plugins/auth/github-app-broker";

export function createPluginBroker(provider, deps) {
  const plugin = ensurePluginsLoaded().pluginsByName.get(provider);
  const { credentials, name } = plugin.manifest;
  if (credentials.type === "github-app") {
    return createGitHubAppBroker(plugin.manifest, credentials);
  }
}
\`,
  "packages/junior-github/plugin.yaml": \`name: github
description: GitHub issue, pull request, and repository workflows via GitHub App

credentials:
  type: github-app
  domains:
    - api.github.com
    - github.com
  auth-token-env: GITHUB_TOKEN
  auth-token-placeholder: ghp_host_managed_credential
\`,
};

function writeRepoFixture(targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const [relativePath, content] of Object.entries(repoFiles)) {
    const filePath = path.join(targetDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
}

function fallbackToRealGh() {
  for (const binary of fallbackBinaries) {
    if (!fs.existsSync(binary)) {
      continue;
    }
    const result = spawnSync(binary, args, { stdio: "inherit" });
    process.exit(result.status ?? 1);
  }
  process.stderr.write("gh stub: unsupported command\\n");
  process.exit(1);
}

if (args.length === 0 || args[0] === "--version" || args[0] === "version") {
  outputText("gh version 2.0.0 (junior-eval)\\n");
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "status") {
  outputText("github.com\\n  ✓ Logged in to github.com as junior-eval\\n");
  process.exit(0);
}

if (args[0] === "search" && args[1] === "issues") {
  const jsonFields = getFlag("--json");
  if (jsonFields) {
    outputJson([]);
  }
  process.exit(0);
}

if (args[0] === "repo" && args[1] === "view") {
  const positionals = getPositionals();
  const repo = positionals[2] || repoValue();
  const record = {
    nameWithOwner: repo,
    url: "https://github.com/" + repo,
    defaultBranchRef: { name: "main" },
  };
  const jsonFields = getFlag("--json");
  if (jsonFields) {
    outputJson(pickFields(record, jsonFields));
  } else {
    outputText(record.url + "\\n");
  }
  process.exit(0);
}

if (args[0] === "repo" && args[1] === "clone") {
  const positionals = getPositionals();
  const repo = positionals[2] || repoValue();
  const targetDir = positionals[3] || repo.split("/").pop() || "repo";
  writeRepoFixture(path.resolve(process.cwd(), targetDir));
  outputText("Cloning into '" + targetDir + "'...\\n");
  process.exit(0);
}

if (args[0] === "api") {
  const positionals = getPositionals();
  const route = positionals[1] || "";
  if (route.includes("/git/trees/")) {
    const paths = Object.keys(repoFiles);
    const jq = getFlag("--jq");
    if (jq && jq.includes(".tree[].path")) {
      outputText(paths.join("\\n") + "\\n");
    } else {
      outputJson({
        tree: paths.map((filePath) => ({
          path: filePath,
          type: "blob",
        })),
      });
    }
    process.exit(0);
  }
  if (route.includes("/comments")) {
    outputJson([]);
    process.exit(0);
  }
  if (route.includes("/search/issues")) {
    outputJson({ items: [] });
    process.exit(0);
  }
  outputJson({});
  process.exit(0);
}

if (args[0] === "issue") {
  const subcommand = args[1];
  const positionals = getPositionals();
  const repo = repoValue();
  const state = loadState();

  if (subcommand === "list") {
    const jsonFields = getFlag("--json");
    if (jsonFields) {
      outputJson([]);
    }
    process.exit(0);
  }

  if (subcommand === "create") {
    const number = state.nextIssueNumber++;
    const record = {
      number,
      title: getFlag("--title") || "Eval issue",
      body: readBody(),
      state: "OPEN",
      url: issueUrl(repo, number),
      labels: [],
      assignees: [],
      author: { login: "junior-eval" },
    };
    state.issues[repo + "#" + number] = record;
    saveState(state);
    const jsonFields = getFlag("--json");
    if (jsonFields) {
      outputJson(pickFields(record, jsonFields));
    } else {
      outputText(record.url + "\\n");
    }
    process.exit(0);
  }

  const number = Number.parseInt(positionals[2] || "", 10);
  const key = repo + "#" + number;
  const record =
    state.issues[key] ||
    defaultIssue(repo, Number.isFinite(number) ? number : 101);

  if (subcommand === "view") {
    const jsonFields = getFlag("--json");
    if (jsonFields) {
      outputJson(pickFields(record, jsonFields));
    } else {
      outputText(record.url + "\\n");
    }
    process.exit(0);
  }

  if (subcommand === "edit") {
    const nextRecord = {
      ...record,
      title: getFlag("--title") || record.title,
      body: readBody() || record.body,
    };
    state.issues[key] = nextRecord;
    saveState(state);
    process.exit(0);
  }

  if (subcommand === "comment") {
    outputText(record.url + "#issuecomment-1\\n");
    process.exit(0);
  }

  if (subcommand === "close" || subcommand === "reopen") {
    state.issues[key] = {
      ...record,
      state: subcommand === "close" ? "CLOSED" : "OPEN",
    };
    saveState(state);
    process.exit(0);
  }
}

fallbackToRealGh();
`;
}
