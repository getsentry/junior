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
  process.stdout.write(JSON.stringify(value, null, 2) + "\\n");
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
  process.stdout.write("gh version 2.0.0 (junior-eval)\\n");
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write("github.com\\n  ✓ Logged in to github.com as junior-eval\\n");
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
    process.stdout.write(record.url + "\\n");
  }
  process.exit(0);
}

if (args[0] === "api") {
  const positionals = getPositionals();
  const route = positionals[1] || "";
  if (route.includes("/comments")) {
    outputJson([]);
    process.exit(0);
  }
  if (route.includes("/search/issues")) {
    outputJson({ items: [] });
    process.exit(0);
  }
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
      process.stdout.write(record.url + "\\n");
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
      process.stdout.write(record.url + "\\n");
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
    process.stdout.write(record.url + "#issuecomment-1\\n");
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
