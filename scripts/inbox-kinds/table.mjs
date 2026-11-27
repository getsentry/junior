import { parse } from "yaml";
import * as z from "zod";

/**
 * Inbox kind decision tables (`design/inbox-kinds.md`). The first row whose
 * cells all match gives its output (DMN's FIRST hit policy). A cell is an
 * S-FEEL unary test: `-` or none, `v`, `v1, v2`, or `not(v1, v2)`. The key
 * is `output`, not `then`, so no parsed row is a thenable.
 */

/** The most input combinations that the check enumerates for one table. */
export const MAX_COMBINATIONS = 1_000_000;

const NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)?$/;
const VALUE = /^[a-z][a-z0-9_-]*$/;
const COMMAND = /^[a-z][a-z0-9-]*$/;
const RULE_ID = /^[a-z][a-z0-9-]*$/;
const ruleId = z.string().regex(RULE_ID);

const value = z.string().regex(VALUE);
const command = z.string().regex(COMMAND);
const cell = z.union([z.boolean(), z.string()]);
const domainSchema = z.union([z.literal("bool"), z.array(value).min(2)]);

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
        // What the ask tells the person to do, such as "to mark it ready".
        step: z.string().min(1).optional(),
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
  // The verification map file, in `.agents/skills/verify-junior/features/`,
  // whose sub-features are the rules of the table.
  feature: z.string().regex(/^[a-z][a-z0-9-]*$/),
  // Only a kind whose code Junior generates names its code file.
  code: z
    .string()
    .regex(/^packages\/[^/]+\/src\/.+\.generated\.ts$/)
    .optional(),
  inputs: z.record(
    z.string().regex(NAME),
    z.strictObject({
      values: domainSchema,
      // What the input means, when its name does not say it, such as a
      // fact that the source derives. The generated code keeps it.
      description: z.string().min(1).optional(),
    }),
  ),
  rules: z
    .array(
      z.strictObject({
        id: ruleId,
        // The IDs of the `design/` rules that the rule serves.
        serves: z.array(ruleId).min(1),
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
function cellTerms(raw) {
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
    const input = { name, bool: spec.values === "bool", domain };
    if (spec.description !== undefined) input.description = spec.description;
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
      rows.push({ id: rule.id, index, cells, output: row.output });
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
