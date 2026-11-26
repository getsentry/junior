import { cellTerms } from "./table.mjs";

/**
 * The text of each rule, generated from its rows and the phrases of the
 * values that their cells name.
 *
 * A rule's rows that give the same output make one sentence: "When <the
 * cells that every row has>, and either <the other cells of each row>,
 * <output>." A cell whose value names the viewer, such as "the requester",
 * becomes the subject when every row of the sentence has it.
 */

/** Join clauses with "and": "a", "a and b", or "a, b, and c". */
function joinAll(items) {
  if (items.length < 3) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

/**
 * Join clauses with "or". Words that start or end every clause are said
 * once, so "it merged" and "it closed" become "it merged or closed".
 */
function joinAny(items) {
  if (items.length === 1) return items[0];
  const words = items.map((item) => item.split(" "));
  const shortest = Math.min(...words.map((item) => item.length));
  let head = 0;
  while (
    head < shortest - 1 &&
    words.every((item) => item[head] === words[0][head])
  ) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < shortest - head - 1 &&
    words.every((item) => item.at(-1 - tail) === words[0].at(-1 - tail))
  ) {
    tail += 1;
  }
  const middles = words.map((item) =>
    item.slice(head, item.length - tail).join(" "),
  );
  const joined =
    middles.length > 2
      ? `${middles.slice(0, -1).join(", ")}, or ${middles.at(-1)}`
      : middles.some((item) => / (?:and|or) |,/.test(item))
        ? middles.join(", or ")
        : middles.join(" or ");
  return [
    ...words[0].slice(0, head),
    joined,
    ...words[0].slice(words[0].length - tail),
  ].join(" ");
}

/** The clause of one value, such as "it merged". */
function phraseOf(input, value, where) {
  const phrase = input.phrases[value];
  const text = typeof phrase === "string" ? phrase : phrase?.is;
  if (text === undefined) {
    throw new Error(
      `${where}: \`${input.name}\` value \`${value}\` has no phrase.`,
    );
  }
  return text;
}

/** The clause of one cell, such as "it merged or closed". */
function cellClause(input, raw, where) {
  const { negated, values } = cellTerms(raw);
  if (!negated) {
    return joinAny(values.map((item) => phraseOf(input, item, where)));
  }
  const phrase = input.phrases[values[0]];
  if (values.length === 1 && typeof phrase === "object" && phrase.not) {
    return phrase.not;
  }
  return joinAny(
    input.domain
      .filter((item) => !values.includes(item))
      .map((item) => phraseOf(input, item, where)),
  );
}

/** The cells of a row in table order, without `-`. */
function rowCells(row) {
  return Object.entries(row.when)
    .map(([name, raw]) => ({ name, raw: String(raw).trim() }))
    .filter((cell) => cell.raw !== "-");
}

/** What a viewer gets from an output, after its subject. */
function outputPhrase(output) {
  if (output === "keep") return { text: "their output stays as it is" };
  if ("close" in output) return { text: "nobody gets it" };
  if ("notice" in output) {
    return { gets: `a notice ${output.notice.step}`, extra: [] };
  }
  const { ask } = output;
  return {
    gets: ask.label === undefined ? ask.content : `"${ask.label}"`,
    extra: [
      ...(ask.choices ?? []).map((choice) => [choice.label, choice.command]),
      ...(ask.dismiss ? [["Dismiss", ask.dismiss]] : []),
    ],
  };
}

function sentence(table, rows, where) {
  const inputs = new Map(table.inputs.map((input) => [input.name, input]));
  const cells = rows.map(rowCells);
  let common = cells[0].filter((cell) =>
    cells.every((other) =>
      other.some((item) => item.name === cell.name && item.raw === cell.raw),
    ),
  );
  const rest = cells.map((row) =>
    row.filter((cell) => !common.some((item) => item.name === cell.name)),
  );
  const output = outputPhrase(rows[0].output);
  let main = output.text;
  if (main === undefined) {
    // The subject is a viewer cell that every row has, or "they".
    const subject = common.find((cell) => {
      const phrase = inputs.get(cell.name).phrases[cell.raw];
      return typeof phrase === "object" && phrase.who !== undefined;
    });
    common = common.filter((cell) => cell !== subject);
    main = subject
      ? `${inputs.get(subject.name).phrases[subject.raw].who} gets ${output.gets}`
      : `they get ${output.gets}`;
  }
  const clause = (cell) => cellClause(inputs.get(cell.name), cell.raw, where);
  const conditions = common.map(clause);
  // A row with only the common cells matches whenever the others do.
  if (rest.every((row) => row.length > 0) && rest.length > 1) {
    const either = joinAny(rest.map((row) => joinAll(row.map(clause))));
    conditions.push(conditions.length > 0 ? `either ${either}` : either);
  }
  const text =
    conditions.length > 0
      ? `When ${joinAll(conditions)}, ${main}.`
      : `${main}.`;
  const extra = (output.extra ?? []).map(([label, item]) => {
    const phrase = table.commands[item];
    if (phrase === undefined) {
      throw new Error(`${where}: command \`${item}\` has no phrase.`);
    }
    return `${label} ${phrase}.`;
  });
  return [text.charAt(0).toUpperCase() + text.slice(1), ...extra].join(" ");
}

// Both close statuses read "nobody gets it", so their rows share a sentence.
function outputKey(output) {
  if (output === "keep") return "keep";
  return "close" in output ? "close" : JSON.stringify(output);
}

/**
 * Generate the text of one rule. Throw an error that names the row and the
 * value when a cell names a value that has no phrase.
 */
export function ruleText(table, rule) {
  const rows = table.rows.filter((row) => row.id === rule.id);
  const groups = [];
  for (const row of rows) {
    const last = groups.at(-1);
    if (last && outputKey(last[0].output) === outputKey(row.output)) {
      last.push(row);
    } else {
      groups.push([row]);
    }
  }
  return groups
    .map((group) =>
      sentence(table, group, `Rule \`${rule.id}\` row ${group[0].index + 1}`),
    )
    .join(" ");
}
