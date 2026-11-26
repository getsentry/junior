/**
 * The `table-links` rule of `design/inbox-kinds.md`: each rule of a table
 * names the `design/` rules that it serves, and its ID is a sub-feature ID
 * in the verification map.
 */

/** The directory of the verification map. */
export const FEATURES_DIR = ".agents/skills/verify-junior/features";

// A rule line in `design/`, or a sub-feature line in the verification map,
// starts with its ID: "- `dismiss-holds` A dismiss holds ...". A Gap line
// has a colon after its ID, so it does not match.
const ID_LINE = /^- `([a-z][a-z0-9-]*)` /;

/** Return the rule IDs of a `design/*.md` file. */
export function designRuleIds(markdown) {
  return markdown
    .split("\n")
    .map((line) => ID_LINE.exec(line)?.[1])
    .filter((id) => id !== undefined);
}

/** Return the sub-feature IDs of a verification map file. */
export function subFeatureIds(markdown) {
  const ids = [];
  let inSection = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("## ")) inSection = line === "## Sub-features";
    const id = inSection ? ID_LINE.exec(line)?.[1] : undefined;
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

/**
 * Return the problems with the links of a parsed table. `designIds` holds
 * every rule ID in `design/`, and `featureIds` the sub-feature IDs of the
 * table's verification map file, or undefined when it has no such file.
 */
export function linkProblems(table, designIds, featureIds) {
  const featureFile = `${FEATURES_DIR}/${table.feature}.md`;
  if (featureIds === undefined) {
    return [`\`feature: ${table.feature}\` names no file ${featureFile}.`];
  }
  const problems = [];
  for (const rule of table.rules) {
    for (const id of rule.serves) {
      if (!designIds.has(id)) {
        problems.push(
          `Rule \`${rule.id}\` serves \`${id}\`, which no design/*.md rule has.`,
        );
      }
    }
    if (!featureIds.has(rule.id)) {
      problems.push(
        `Rule \`${rule.id}\` has no line in the Sub-features of ${featureFile}.`,
      );
    }
  }
  return problems;
}
