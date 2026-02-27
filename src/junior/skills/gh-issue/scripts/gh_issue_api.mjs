#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const API_BASE = "https://api.github.com";

function usage() {
  console.error(`Usage:
  gh_issue_api.mjs create --repo owner/repo --title "..." --body-file /path/body.md
  gh_issue_api.mjs update --repo owner/repo --number 123 [--title "..."] [--body-file /path/body.md] [--state open|closed]
  gh_issue_api.mjs comment --repo owner/repo --number 123 --body-file /path/comment.md
  gh_issue_api.mjs add-labels --repo owner/repo --number 123 --labels bug,regression
  gh_issue_api.mjs remove-labels --repo owner/repo --number 123 --labels triage

Environment:
  Optional GITHUB_TOKEN=<installation token>
  (sandbox network policy may inject Authorization headers automatically)
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

async function ghRequest(path, { method = "GET", token, body } = {}) {
  const authHeader = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      ...authHeader,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }

  if (!response.ok) {
    const message = parsed?.message ?? `GitHub API error ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.payload = parsed;
    throw error;
  }

  return parsed;
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

function assertRequired(options, ...keys) {
  for (const key of keys) {
    if (!options[key]) {
      throw new Error(`Missing required option --${key}`);
    }
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

  const installationToken = process.env.GITHUB_TOKEN?.trim();

  let result;

  if (command === "create") {
    assertRequired(options, "title");
    const body = await maybeReadBody(options);
    result = await ghRequest(`/repos/${owner}/${repo}/issues`, {
      method: "POST",
      token: installationToken,
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

    result = await ghRequest(`/repos/${owner}/${repo}/issues/${options.number}`, {
      method: "PATCH",
      token: installationToken,
      body: patch
    });
  } else if (command === "comment") {
    assertRequired(options, "number");
    const body = await maybeReadBody(options);
    if (!body) throw new Error("Comment requires --body-file or --body");

    result = await ghRequest(`/repos/${owner}/${repo}/issues/${options.number}/comments`, {
      method: "POST",
      token: installationToken,
      body: { body }
    });
  } else if (command === "add-labels") {
    assertRequired(options, "number", "labels");
    const labels = options.labels
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (labels.length === 0) throw new Error("--labels must include at least one label");

    result = await ghRequest(`/repos/${owner}/${repo}/issues/${options.number}/labels`, {
      method: "POST",
      token: installationToken,
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
      await ghRequest(`/repos/${owner}/${repo}/issues/${options.number}/labels/${encodeURIComponent(label)}`, {
        method: "DELETE",
        token: installationToken
      });
      removed.push(label);
    }
    result = { removed };
  } else {
    throw new Error(`Unknown command '${command}'`);
  }

  process.stdout.write(`${JSON.stringify({ ok: true, command, repo: `${owner}/${repo}`, result }, null, 2)}\n`);
}

run().catch((error) => {
  const status = error?.status;
  const payload = error?.payload;
  process.stderr.write(
    `${JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ...(status ? { status } : {}),
        ...(payload ? { payload } : {})
      },
      null,
      2
    )}\n`
  );
  process.exit(1);
});
