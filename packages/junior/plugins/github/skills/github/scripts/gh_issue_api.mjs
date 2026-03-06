#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

function usage() {
  console.error(`Usage:
  gh_issue_api.mjs create --repo owner/repo --title "..." --body-file /path/body.md
  gh_issue_api.mjs update --repo owner/repo --number 123 [--title "..."] [--body-file /path/body.md] [--state open|closed]
  gh_issue_api.mjs comment --repo owner/repo --number 123 --body-file /path/comment.md
  gh_issue_api.mjs add-labels --repo owner/repo --number 123 --labels bug,regression
  gh_issue_api.mjs remove-labels --repo owner/repo --number 123 --labels triage
  gh_issue_api.mjs get --repo owner/repo --number 123
  gh_issue_api.mjs list-comments --repo owner/repo --number 123
`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command) return { command: null, options: {} };

  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected token: ${token}`);
    }

    const key = token.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }

    options[key] = next;
    i += 1;
  }

  return { command, options };
}

function splitRepo(repo) {
  const [owner, name] = (repo ?? "").split("/");
  if (!owner || !name) {
    throw new Error(`Invalid repo '${repo}'. Expected owner/repo.`);
  }
  return { owner, repo: name };
}

function assertRequired(options, ...keys) {
  for (const key of keys) {
    if (!options[key]) {
      throw new Error(`Missing required option --${key}`);
    }
  }
}

async function maybeReadBody(options) {
  if (options["body-file"]) {
    return await readFile(options["body-file"], "utf8");
  }
  if (options.body) {
    return options.body;
  }
  return undefined;
}

async function runGh(args, input) {
  return await new Promise((resolve, reject) => {
    const child = spawn("gh", args, {
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(stderr.trim() || `gh exited with code ${code}`);
      error.code = code;
      error.stderr = stderr;
      error.stdout = stdout;
      reject(error);
    });

    if (input) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

async function ghApi(path, { method = "GET", body } = {}) {
  const args = [
    "api",
    path,
    "--method",
    method,
    "--header",
    "Accept: application/vnd.github+json"
  ];

  if (body) {
    args.push("--input", "-");
  }

  const response = await runGh(args, body ? JSON.stringify(body) : undefined);
  if (!response.stdout.trim()) {
    return {};
  }

  try {
    return JSON.parse(response.stdout);
  } catch {
    return { raw: response.stdout.trim() };
  }
}

async function run() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command) {
    usage();
    process.exit(1);
  }

  assertRequired(options, "repo");
  const { owner, repo } = splitRepo(options.repo);
  let result;

  if (command === "create") {
    assertRequired(options, "title");
    const body = await maybeReadBody(options);
    result = await ghApi(`/repos/${owner}/${repo}/issues`, {
      method: "POST",
      body: {
        title: options.title,
        ...(body ? { body } : {})
      }
    });
  } else if (command === "update") {
    assertRequired(options, "number");
    const body = await maybeReadBody(options);
    const patch = {
      ...(options.title ? { title: options.title } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(options.state ? { state: options.state } : {})
    };

    if (Object.keys(patch).length === 0) {
      throw new Error("Update requires at least one of --title, --body-file/--body, or --state");
    }

    result = await ghApi(`/repos/${owner}/${repo}/issues/${options.number}`, {
      method: "PATCH",
      body: patch
    });
  } else if (command === "comment") {
    assertRequired(options, "number");
    const body = await maybeReadBody(options);
    if (!body) throw new Error("Comment requires --body-file or --body");

    result = await ghApi(`/repos/${owner}/${repo}/issues/${options.number}/comments`, {
      method: "POST",
      body: { body }
    });
  } else if (command === "add-labels") {
    assertRequired(options, "number", "labels");
    const labels = options.labels
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (labels.length === 0) throw new Error("--labels must include at least one label");

    result = await ghApi(`/repos/${owner}/${repo}/issues/${options.number}/labels`, {
      method: "POST",
      body: { labels }
    });
  } else if (command === "remove-labels") {
    assertRequired(options, "number", "labels");
    const labels = options.labels
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (labels.length === 0) throw new Error("--labels must include at least one label");

    const removed = [];
    for (const label of labels) {
      await ghApi(`/repos/${owner}/${repo}/issues/${options.number}/labels/${encodeURIComponent(label)}`, {
        method: "DELETE"
      });
      removed.push(label);
    }
    result = { removed };
  } else if (command === "get") {
    assertRequired(options, "number");

    result = await ghApi(`/repos/${owner}/${repo}/issues/${options.number}`, {
      method: "GET"
    });
  } else if (command === "list-comments") {
    assertRequired(options, "number");

    result = await ghApi(`/repos/${owner}/${repo}/issues/${options.number}/comments`, {
      method: "GET"
    });
  } else {
    throw new Error(`Unknown command '${command}'`);
  }

  process.stdout.write(`${JSON.stringify({ ok: true, command, repo: `${owner}/${repo}`, result }, null, 2)}\n`);
}

run().catch((error) => {
  process.stderr.write(
    `${JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ...(typeof error?.code === "number" ? { exit_code: error.code } : {}),
        ...(typeof error?.stderr === "string" && error.stderr.trim().length > 0
          ? { stderr: error.stderr.trim() }
          : {})
      },
      null,
      2
    )}\n`
  );
  process.exit(1);
});
