import { format } from "oxfmt";

/** The command that writes the generated files from the tables. */
export const UPDATE_COMMAND = "pnpm inbox-kinds:check --update";

/** The start of the first line of every generated file. */
export const CODE_HEADER_START = "// Generated from the Inbox kind table ";

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
    const field = { description: input.description, type };
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
        const doc = field.description
          ? `/**\n${wrap(field.description.split(/\s+/), 70, "")
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
    `${CODE_HEADER_START}${tablePath}.`,
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
