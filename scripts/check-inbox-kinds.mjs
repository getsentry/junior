import fs from "node:fs";
import path from "node:path";
import {
  UPDATE_COMMAND,
  embedRuleList,
  renderKindCode,
  renderRuleList,
} from "./inbox-kinds/render.mjs";
import { analyzeTable, parseTable } from "./inbox-kinds/table.mjs";

/**
 * Inbox kind check. Each `design/inbox-kinds/*.yaml` decision table states
 * the rules of one Inbox kind (`design/inbox-kinds.md`). From each table,
 * this check generates the kind's code and the rule list in its design file,
 * and fails when either differs from the files. It also fails when a row of
 * a table can never be the first match, or when an input can be unknown and
 * no rule names `unknown`.
 *
 * Run `pnpm inbox-kinds:check --update` to write the generated files.
 */

const TABLE = /^design\/inbox-kinds\/[^/]+\.yaml$/;
const GENERATED = /\.generated\.ts$/;
// The start of the header that `renderKindCode` writes.
const CODE_HEADER_START = "// Generated from design/inbox-kinds/";
const FIX = `Edit the table, then run \`${UPDATE_COMMAND}\`.`;

/** Check every table, or write its generated files with `--update`. */
export async function run({ root, files, args }) {
  const update = args.includes("--update");
  const problems = [];
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
  const write = (file, contents) =>
    fs.writeFileSync(path.join(root, file), contents);
  const codeFiles = new Set();
  for (const tablePath of files.filter((file) => TABLE.test(file))) {
    let table;
    try {
      table = parseTable(read(tablePath));
    } catch (error) {
      problems.push(`${tablePath}: ${error.message}`);
      continue;
    }
    codeFiles.add(table.code);
    problems.push(
      ...analyzeTable(table).map((problem) => `${tablePath}: ${problem}`),
    );
    const code = await renderKindCode(table, tablePath);
    const current = fs.existsSync(path.join(root, table.code))
      ? read(table.code)
      : undefined;
    if (current !== code) {
      if (update) write(table.code, code);
      else problems.push(`${table.code}: differs from ${tablePath}. ${FIX}`);
    }
    let doc;
    try {
      doc = embedRuleList(read(table.doc), tablePath, renderRuleList(table));
    } catch (error) {
      problems.push(`${table.doc}: ${error.message}`);
      continue;
    }
    if (doc !== read(table.doc)) {
      if (update) write(table.doc, doc);
      else {
        problems.push(
          `${table.doc}: its rule list differs from ${tablePath}. ${FIX}`,
        );
      }
    }
  }
  // A generated file outlives its table when the table moves or goes.
  for (const file of files.filter((item) => GENERATED.test(item))) {
    if (!codeFiles.has(file) && read(file).startsWith(CODE_HEADER_START)) {
      problems.push(`${file}: no table generates it. Delete it.`);
    }
  }
  return problems;
}
