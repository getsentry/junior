import fs from "node:fs";
import path from "node:path";

function readJson(root, file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

/** List the workspace package directories, as pnpm-workspace.yaml lists them. */
export function workspaceDirectories(root) {
  return ["apps", "packages"].flatMap((group) =>
    fs
      .readdirSync(path.join(root, group))
      .map((name) => `${group}/${name}`)
      .filter((directory) =>
        fs.existsSync(path.join(root, directory, "package.json")),
      ),
  );
}

/**
 * List the project directories that the root `pnpm typecheck` script runs
 * with `tsc --noEmit`. A command or package script in an unknown shape is
 * an error, so no project is skipped without notice.
 */
export function typecheckProjects(root) {
  const projects = [];
  const errors = [];
  const rootScript = readJson(root, "package.json").scripts?.typecheck ?? "";
  const [first, ...rest] = rootScript.split(" && ");
  if (first !== "pnpm -r run typecheck") {
    errors.push(`Unknown root typecheck script: ${rootScript}`);
  }
  for (const directory of workspaceDirectories(root)) {
    const manifest = `${directory}/package.json`;
    const typecheck = readJson(root, manifest).scripts?.typecheck;
    if (typecheck === "tsc --noEmit") projects.push(directory);
    else if (typecheck !== undefined) {
      errors.push(`Unknown typecheck script in ${manifest}`);
    }
  }
  for (const command of rest) {
    const project = /^tsc --noEmit -p (\S+)$/.exec(command)?.[1];
    if (project) projects.push(project);
    else errors.push(`Unknown root typecheck command: ${command}`);
  }
  return { projects, errors };
}
