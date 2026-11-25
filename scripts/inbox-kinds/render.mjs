import { format } from "oxfmt";

/** The width that the design files wrap their rule lists at. */
const DOC_WIDTH = 76;

/** The command that writes the generated files from the tables. */
export const UPDATE_COMMAND = "pnpm inbox-kinds:check --update";

// Design files and tables are both in `design/`.
function docRelative(tablePath) {
  return tablePath.replace(/^design\//, "");
}

/** The line that starts a generated rule list in a design file. */
function docStartMarker(tablePath) {
  return `<!-- Generated from ${docRelative(tablePath)}. -->`;
}

/** The line that ends a generated rule list in a design file. */
function docEndMarker(tablePath) {
  return `<!-- End of ${docRelative(tablePath)}. -->`;
}

function wrap(words, width, indent) {
  const lines = [];
  let line = "";
  for (const word of words) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = `${indent}${word}`;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  lines.push(line);
  return lines;
}

/** Render the rule list of a table, as the design file shows it. */
export function renderRuleList(table) {
  return table.rules
    .flatMap((rule) =>
      wrap(["-", `\`${rule.id}\``, ...rule.text.split(/\s+/)], DOC_WIDTH, "  "),
    )
    .join("\n");
}

/**
 * Replace the generated rule list between the markers of one table in a
 * design file. Throw when the file does not have the markers once.
 */
export function embedRuleList(doc, tablePath, list) {
  const start = docStartMarker(tablePath);
  const end = docEndMarker(tablePath);
  const lines = doc.split("\n");
  const from = lines.indexOf(start);
  const to = lines.indexOf(end);
  if (
    from === -1 ||
    to < from ||
    lines.lastIndexOf(start) !== from ||
    lines.lastIndexOf(end) !== to
  ) {
    throw new Error(
      `It needs the lines \`${start}\` and \`${end}\` once, in this order, around the rule list.`,
    );
  }
  return [...lines.slice(0, from + 1), list, ...lines.slice(to)].join("\n");
}

function outcomeOf(row) {
  const { output } = row;
  if (output === "keep") return { kind: "keep", rule: row.id };
  if ("close" in output) {
    return { kind: "close", rule: row.id, status: output.close };
  }
  if ("notice" in output) {
    return { kind: "notice", rule: row.id, step: output.notice.step };
  }
  return { kind: "ask", rule: row.id, ...output.ask };
}

function condition(input, cell) {
  if (cell.match.size === input.domain.length) return undefined;
  const target = `inputs.${input.name}`;
  if (input.bool) return cell.match.has("true") ? target : `!${target}`;
  const values = [...cell.match];
  const others = input.domain.filter((item) => !cell.match.has(item));
  if (values.length === 1) return `${target} === "${values[0]}"`;
  if (others.length === 1) return `${target} !== "${others[0]}"`;
  return `(${values.map((item) => `${target} === "${item}"`).join(" || ")})`;
}

function inputsType(table) {
  // `viewer.requester` becomes the field `requester` of the object `viewer`.
  const fields = new Map();
  for (const input of table.inputs) {
    const type = input.bool
      ? "boolean"
      : input.domain.map((item) => `"${item}"`).join(" | ");
    const field = { text: input.text, type };
    const [head, tail] = input.name.split(".");
    if (tail === undefined) {
      fields.set(head, field);
    } else {
      if (!fields.has(head)) fields.set(head, new Map());
      fields.get(head).set(tail, field);
    }
  }
  const render = (map) =>
    [...map]
      .map(([name, field]) => {
        if (field instanceof Map) return `${name}: { ${render(field)} };`;
        const doc = field.text
          ? `/**\n${wrap(field.text.split(/\s+/), 70, "")
              .map((line) => ` * ${line}`)
              .join("\n")}\n */\n`
          : "";
        return `${doc}${name}: ${field.type};`;
      })
      .join("\n");
  return render(fields);
}

/**
 * Render the code of a kind from its table: the `Inputs` type, the
 * `Outcome` union, the `Commands` that its choices and Dismiss send, and
 * `decide()`. The code is formatted like every other file.
 */
export async function renderKindCode(table, tablePath) {
  const outcomes = new Set([JSON.stringify({ kind: "nothing" })]);
  const branches = [];
  for (const row of table.rows) {
    const outcome = JSON.stringify(outcomeOf(row));
    outcomes.add(outcome);
    const tests = row.cells
      .map((cell, position) => condition(table.inputs[position], cell))
      .filter((test) => test !== undefined);
    const body = `return ${outcome};`;
    branches.push(
      `// \`${row.id}\` row ${row.index + 1}\n${tests.length > 0 ? `if (${tests.join(" && ")}) { ${body} }` : body}`,
    );
  }
  const commands = [
    ...new Set(
      table.rows.flatMap((row) =>
        typeof row.output === "object" && "ask" in row.output
          ? [
              ...(row.output.ask.choices ?? []).map((choice) => choice.command),
              ...(row.output.ask.dismiss ? [row.output.ask.dismiss] : []),
            ]
          : [],
      ),
    ),
  ];
  const source = [
    `// Generated from ${tablePath}.`,
    `// Edit the table, then run \`${UPDATE_COMMAND}\`.`,
    "",
    `/** The facts that the \`${table.source}\` source gives about one viewer of a \`${table.kind}\` item. */`,
    `export interface Inputs { ${inputsType(table)} }`,
    "",
    "/** A command that a choice or Dismiss sends. */",
    `export type Command = ${commands.length > 0 ? commands.map((item) => `"${item}"`).join(" | ") : "never"};`,
    "",
    "/** The handler that runs each command. */",
    "export type Commands = Record<Command, () => Promise<void>>;",
    "",
    "/** The output for one viewer, with the ID of the rule that gave it. */",
    `export type Outcome = ${[...outcomes].join(" | ")};`,
    "",
    "/** Return the output of the first rule that matches the inputs. */",
    "export function decide(inputs: Inputs): Outcome {",
    ...branches,
    `return { kind: "nothing" };`,
    "}",
    "",
  ].join("\n");
  const result = await format(table.code, source, { printWidth: 80 });
  if (result.errors.length > 0) {
    throw new Error(
      `The code of ${tablePath} does not format: ${result.errors[0].message}`,
    );
  }
  return result.code;
}
