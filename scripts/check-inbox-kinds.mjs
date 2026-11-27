import fs from "node:fs";
import path from "node:path";
import {
  FEATURES_DIR,
  designRuleIds,
  linkProblems,
  subFeatureIds,
} from "./inbox-kinds/links.mjs";
import {
  CODE_HEADER_START,
  UPDATE_COMMAND,
  renderKindCode,
} from "./inbox-kinds/render.mjs";
import { analyzeTable, parseTable } from "./inbox-kinds/table.mjs";

/**
 * Inbox kind check (`design/inbox-kinds.md`): generate the code of each
 * table that names a code file and fail when it drifts, and fail on the
 * `table-checks` and `table-links` problems. `--update` writes the code.
 */

const TABLE = /^packages\/[^/]+\/src\/.+-kind\.yaml$/;
const DESIGN = /^design\/[^/]+\.md$/;
const GENERATED = /\.generated\.ts$/;
const FIX = `Edit the table, then run \`${UPDATE_COMMAND}\`.`;

/** Check every table, or write its generated files with `--update`. */
export async function run({ root, files, args }) {
  const update = args.includes("--update");
  const problems = [];
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
  const designIds = new Set(
    files
      .filter((file) => DESIGN.test(file))
      .flatMap((file) => designRuleIds(read(file))),
  );
  const featureIds = (feature) => {
    const file = `${FEATURES_DIR}/${feature}.md`;
    return files.includes(file)
      ? new Set(subFeatureIds(read(file)))
      : undefined;
  };
  const codeFiles = new Set();
  const parsed = new Set();
  for (const tablePath of files.filter((file) => TABLE.test(file))) {
    let table;
    try {
      table = parseTable(read(tablePath));
    } catch (error) {
      problems.push(`${tablePath}: ${error.message}`);
      continue;
    }
    parsed.add(tablePath);
    problems.push(
      ...[
        ...analyzeTable(table),
        ...linkProblems(table, designIds, featureIds(table.feature)),
      ].map((problem) => `${tablePath}: ${problem}`),
    );
    if (table.code === undefined) continue;
    codeFiles.add(table.code);
    const code = await renderKindCode(table, tablePath);
    const current = fs.existsSync(path.join(root, table.code))
      ? read(table.code)
      : undefined;
    if (current === code) continue;
    if (update) fs.writeFileSync(path.join(root, table.code), code);
    else problems.push(`${table.code}: differs from ${tablePath}. ${FIX}`);
  }
  // A generated file outlives its table when the table moves or goes. Its
  // header names the table, so a table that fails to parse keeps its file.
  for (const file of files.filter((item) => GENERATED.test(item))) {
    const header = read(file).split("\n", 1)[0];
    if (codeFiles.has(file) || !header.startsWith(CODE_HEADER_START)) continue;
    const tablePath = path.posix.join(
      path.posix.dirname(file),
      header.slice(CODE_HEADER_START.length, -1),
    );
    if (files.includes(tablePath) && !parsed.has(tablePath)) continue;
    problems.push(`${file}: no table generates it. Delete it.`);
  }
  return problems;
}
