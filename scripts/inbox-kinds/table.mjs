import { parse } from "yaml";
import * as z from "zod";

/**
 * Inbox kind decision tables (`design/inbox-kinds/*.yaml`).
 *
 * A table lists the inputs of a kind with their domains and the phrase of
 * each value, and its rules in order. Each rule has an ID and one or more
 * rows, and its text comes from the phrases of its cells. A row matches
 * when each of its cells matches, and the first row that matches gives its
 * output (the FIRST hit policy of DMN). The key is `output`, not `then`, so
 * no parsed row is a thenable. Each cell is a unary test from DMN's
 * S-FEEL: `-` or no cell matches any value, `v` matches one value, `v1, v2`
 * matches any of them, and `not(v1, v2)` matches every other value.
 */

/** The most input combinations that the check enumerates for one table. */
export const MAX_COMBINATIONS = 1_000_000;

const NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)?$/;
const VALUE = /^[a-z][a-z0-9_-]*$/;
const COMMAND = /^[a-z][a-z0-9-]*$/;
const RULE_ID = /^[a-z][a-z0-9-]*$/;

const value = z.string().regex(VALUE);
const command = z.string().regex(COMMAND);
const cell = z.union([z.boolean(), z.string()]);
const domainSchema = z.union([z.literal("bool"), z.array(value).min(2)]);
// The phrase of a value is a clause, such as "it is open". `not` is the
// clause for `not(v)`, and `who` names the viewer that has the value, such
// as "the requester".
const phraseSchema = z.union([
  z.string().min(1),
  z
    .strictObject({
      is: z.string().min(1).optional(),
      not: z.string().min(1).optional(),
      who: z.string().min(1).optional(),
    })
    .refine((phrase) => Object.keys(phrase).length > 0, "It needs a phrase."),
]);

const outputSchema = z.union([
  z.literal("keep"),
  z.strictObject({ close: z.enum(["done", "dismissed"]) }),
  z.strictObject({ notice: z.strictObject({ step: z.string().min(1) }) }),
  z.strictObject({
    // `label` is the text of the ask. `content` says what a person gets
    // when the text comes from the subject, such as a question.
    ask: z
      .strictObject({
        label: z.string().min(1).optional(),
        content: z.string().min(1).optional(),
        choices: z
          .array(z.strictObject({ label: z.string().min(1), command }))
          .min(1)
          .optional(),
        dismiss: command.optional(),
      })
      .refine(
        (ask) => (ask.label === undefined) !== (ask.content === undefined),
        "An ask needs a `label` or a `content`.",
      ),
  }),
]);

const tableSchema = z.strictObject({
  kind: z.string().regex(/^[a-z][a-z0-9_]*(?::[a-z][a-z0-9_]*)?$/),
  source: z.string().min(1),
  hit: z.literal("first"),
  doc: z.string().regex(/^design\/[a-z0-9-]+\.md$/),
  // Only a kind whose code Junior generates names its code file.
  code: z
    .string()
    .regex(/^packages\/[^/]+\/src\/.+\.generated\.ts$/)
    .optional(),
  inputs: z.record(
    z.string().regex(NAME),
    z.strictObject({
      values: domainSchema,
      phrases: z.record(z.string(), phraseSchema),
      // An input whose meaning its phrases do not show in full, such as a
      // fact that the source derives, says it in `text`.
      text: z.string().min(1).optional(),
    }),
  ),
  // The phrase of each command, such as "removes them from the reviewers".
  commands: z.record(command, z.string().min(1)).default({}),
  rules: z
    .array(
      z.strictObject({
        id: z.string().regex(RULE_ID),
        rows: z
          .array(
            z.strictObject({
              when: z.record(z.string(), cell).default({}),
              output: outputSchema,
            }),
          )
          .min(1),
      }),
    )
    .min(1),
});

/**
 * Split a unary test cell that is not `-` into the values that it names,
 * and whether `not(...)` negates them.
 */
export function cellTerms(raw) {
  const text = String(raw).trim();
  const negated = /^not\((.*)\)$/.exec(text);
  const values = (negated ? negated[1] : text)
    .split(",")
    .map((part) => part.trim());
  return { negated: negated !== null, values };
}

/**
 * Parse one unary test cell against its input domain. Return the set of
 * values that it matches, or throw when it is not valid.
 */
export function parseCell(raw, domain) {
  const text = String(raw).trim();
  if (text === "-") return new Set(domain);
  const { negated, values } = cellTerms(text);
  for (const item of values) {
    if (!domain.includes(item)) {
      throw new Error(
        `\`${text}\` names \`${item}\`, which is not one of ${domain.join(", ")}`,
      );
    }
  }
  if (new Set(values).size !== values.length) {
    throw new Error(`\`${text}\` names a value twice`);
  }
  return new Set(
    negated ? domain.filter((item) => !values.includes(item)) : values,
  );
}

/**
 * Parse and validate a table from its YAML text. Throw an error that names
 * the problem when the table is not valid.
 */
export function parseTable(text) {
  // YAML 1.2 core schema, so `no`, `on`, and `off` stay strings.
  const table = tableSchema.parse(parse(text, { version: "1.2" }));
  const inputs = Object.entries(table.inputs).map(([name, spec]) => {
    const domain = spec.values === "bool" ? ["true", "false"] : spec.values;
    for (const item of Object.keys(spec.phrases)) {
      if (!domain.includes(item)) {
        throw new Error(
          `\`${name}\` has a phrase for \`${item}\`, which is not one of ${domain.join(", ")}.`,
        );
      }
    }
    const input = {
      name,
      bool: spec.values === "bool",
      domain,
      phrases: spec.phrases,
    };
    if (spec.text !== undefined) input.text = spec.text;
    return input;
  });
  for (const input of inputs) {
    const [head, tail] = input.name.split(".");
    if (tail !== undefined && head in table.inputs) {
      throw new Error(`\`${head}\` is an input and a group of inputs.`);
    }
  }
  const ids = new Set();
  const rows = [];
  for (const rule of table.rules) {
    if (ids.has(rule.id)) throw new Error(`Rule \`${rule.id}\` is twice.`);
    ids.add(rule.id);
    for (const [index, row] of rule.rows.entries()) {
      const where = `Rule \`${rule.id}\` row ${index + 1}`;
      for (const name of Object.keys(row.when)) {
        if (!(name in table.inputs)) {
          throw new Error(`${where} tests \`${name}\`, which is no input.`);
        }
      }
      const cells = inputs.map((input) => {
        const raw = row.when[input.name];
        if (raw === undefined)
          return { raw: "-", match: new Set(input.domain) };
        try {
          return { raw: String(raw), match: parseCell(raw, input.domain) };
        } catch (error) {
          throw new Error(`${where}, \`${input.name}\`: ${error.message}`, {
            cause: error,
          });
        }
      });
      // `when` keeps the order of the cells in the table, which is the
      // order that the rule text names them in.
      rows.push({
        id: rule.id,
        index,
        cells,
        when: row.when,
        output: row.output,
      });
    }
  }
  return { ...table, inputs, rows };
}

/** Return the index of the first row that matches one combination, or -1. */
function firstMatch(rows, combination) {
  return rows.findIndex((row) =>
    row.cells.every((cell, position) => cell.match.has(combination[position])),
  );
}

/**
 * Check a parsed table: each row must be the first match for at least one
 * combination of input values, and each input that can be `unknown` must
 * have a row that matches `unknown`. Return the problems.
 */
export function analyzeTable(table) {
  const problems = [];
  for (const [position, input] of table.inputs.entries()) {
    if (!input.domain.includes("unknown")) continue;
    // `not(clean)` matches `unknown` too, but only a cell that names it
    // shows that the author decided what an unknown fact gives.
    const named = table.rows.some((row) => {
      const { raw } = row.cells[position];
      return (
        !raw.startsWith("not(") &&
        raw.split(",").some((part) => part.trim() === "unknown")
      );
    });
    if (!named) {
      problems.push(
        `\`${input.name}\` can be unknown, and no rule names \`unknown\`.`,
      );
    }
  }
  const total = table.inputs.reduce(
    (product, input) => product * input.domain.length,
    1,
  );
  if (total > MAX_COMBINATIONS) {
    problems.push(
      `The inputs have ${total} combinations, more than the ${MAX_COMBINATIONS} that the check can enumerate. Split the kind or make its domains smaller.`,
    );
    return problems;
  }
  const hit = new Set();
  const combination = table.inputs.map((input) => input.domain[0]);
  const visit = (position) => {
    if (position === table.inputs.length) {
      hit.add(firstMatch(table.rows, combination));
      return;
    }
    for (const item of table.inputs[position].domain) {
      combination[position] = item;
      visit(position + 1);
    }
  };
  visit(0);
  for (const [index, row] of table.rows.entries()) {
    if (!hit.has(index)) {
      problems.push(
        `Rule \`${row.id}\` row ${row.index + 1} can never be the first match.`,
      );
    }
  }
  return problems;
}
