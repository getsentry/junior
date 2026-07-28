import fs from "node:fs";
import { spawnSync } from "node:child_process";

const [profilePath] = process.argv.slice(2);
if (!profilePath) {
  throw new Error("Usage: install-runtime-profile.mjs <profile.json>");
}

const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
if (profile.version !== 1 || profile.runtime !== "node22") {
  throw new Error("Unsupported sandbox image profile");
}

function run(cmd, args = [], options = {}) {
  const command = options.sudo ? "sudo" : cmd;
  const commandArgs = options.sudo ? [cmd, ...args] : args;
  const result = spawnSync(command, commandArgs, {
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${[command, ...commandArgs].join(" ")} failed`);
  }
}

function tryRun(cmd, args = [], options = {}) {
  const command = options.sudo ? "sudo" : cmd;
  const commandArgs = options.sudo ? [cmd, ...args] : args;
  const result = spawnSync(command, commandArgs, {
    env: process.env,
    stdio: "inherit",
  });
  return !result.error && result.status === 0;
}

function installGh() {
  if (tryRun("dnf", ["install", "-y", "gh"], { sudo: true })) {
    return;
  }

  const repoUrl = "https://cli.github.com/packages/rpm/gh-cli.repo";
  if (
    !tryRun(
      "dnf",
      ["config-manager", "addrepo", `--from-repofile=${repoUrl}`],
      { sudo: true },
    )
  ) {
    run("dnf", ["install", "-y", "dnf-command(config-manager)"], {
      sudo: true,
    });
    run("dnf", ["config-manager", "--add-repo", repoUrl], { sudo: true });
  }

  run("dnf", ["install", "-y", "gh", "--repo", "gh-cli"], { sudo: true });
}

function installUrlDependency(dependency) {
  const rpmPath = `/tmp/junior-runtime-${dependency.sha256.slice(0, 12)}.rpm`;
  run("curl", ["-fsSL", dependency.url, "-o", rpmPath]);
  run("bash", [
    "-lc",
    `printf '%s  %s\\n' "$1" "$2" | sha256sum -c -`,
    "verify-runtime-rpm",
    dependency.sha256,
    rpmPath,
  ]);
  run("dnf", ["install", "-y", rpmPath], { sudo: true });
  run("rm", [rpmPath]);
}

const npmPackages = [];
for (const dependency of profile.dependencies) {
  if (dependency.type === "npm") {
    npmPackages.push(`${dependency.package}@${dependency.version}`);
    continue;
  }
  if ("url" in dependency) {
    installUrlDependency(dependency);
    continue;
  }
  if (dependency.package === "gh") {
    installGh();
    continue;
  }
  if (dependency.package === "ripgrep" && tryRun("rg", ["--version"])) {
    continue;
  }
  run("dnf", ["install", "-y", dependency.package], { sudo: true });
}

if (npmPackages.length > 0) {
  run("npm", [
    "install",
    "--global",
    "--prefix",
    "/vercel/sandbox/.junior",
    ...npmPackages,
  ]);
}

for (const command of profile.postinstall) {
  run(command.cmd, command.args ?? [], { sudo: command.sudo });
}

const dependencyChecks = new Map([
  ["agent-browser", ["agent-browser", "--version"]],
  ["docker", ["docker", "--version"]],
  ["gh", ["gh", "--version"]],
  ["jq", ["jq", "--version"]],
  ["ripgrep", ["rg", "--version"]],
  ["sentry", ["sentry", "--version"]],
  ["vercel", ["vercel", "--version"]],
]);
for (const dependency of profile.dependencies) {
  const [cmd, ...args] = dependencyChecks.get(dependency.package) ?? [];
  if (cmd) {
    run(cmd, args);
  }
}

run("bash", [
  "-lc",
  [
    'test "$(id -un)" = vercel-sandbox',
    'test "$PWD" = /vercel/sandbox',
    "node --version",
    "npm --version",
    "dnf --version",
  ].join(" && "),
]);
