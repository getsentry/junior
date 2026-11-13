import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createToolSourceIndex,
  readRepoToolSources,
} from "./tool-schema-ast.mjs";

// Model-facing tool inputs and results use snake_case keys, so each value
// has one name in both directions. See policies/tool-design.md.
const SCHEMA_PROPERTIES = ["inputSchema", "outputSchema"];
const SNAKE_CASE_KEY = /^[a-z0-9_]+$/;
// Card fields that tool results carry for the dashboard and Slack cards.
const ALLOWED_KEYS = new Set([
  "objectAnnotations",
  "objectCards",
  "removedCards",
]);

/** Check tool input and output schemas in a set of source files. */
export function checkToolKeyCasingSources(files, packageSrcRoots = {}) {
  const index = createToolSourceIndex(files, packageSrcRoots);
  const errors = new Set();
  const onKey = (filePath, property, key) => {
    if (SNAKE_CASE_KEY.test(key) || ALLOWED_KEYS.has(key)) return;
    errors.add(
      `${filePath}:${index.lineOf(filePath, property)}: tool schema key "${key}" must be snake_case`,
    );
  };
  for (const { filePath, properties } of index.toolDefinitions()) {
    for (const name of SCHEMA_PROPERTIES) {
      const schema = properties.get(name);
      if (schema) index.walkSchema(filePath, schema, { onKey });
    }
  }
  return [...errors].sort();
}

/** Check that every repo tool schema uses snake_case keys. */
export async function checkRepoToolKeyCasing(repoRoot) {
  const { files, packageSrcRoots } = await readRepoToolSources(repoRoot);
  return checkToolKeyCasingSources(files, packageSrcRoots);
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const repoRoot = path.resolve(
    process.argv[2] ?? path.join(path.dirname(scriptPath), "../../.."),
  );
  const errors = await checkRepoToolKeyCasing(repoRoot);
  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  }
}
