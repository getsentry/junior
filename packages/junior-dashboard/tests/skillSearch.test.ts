import { expect, it } from "vitest";

import { searchSkills } from "../src/client/pages/automations/skillSearch";

const skill = (name: string, description: string) => ({ name, description });

// No describe block: CI parses the JUnit report, and each " > " in a test
// name adds an XML entity toward the parser's limit.
it("ranks name matches above description matches", () => {
  const rows = searchSkills(
    [
      skill("diff-quality", "Run a quality pass on a local diff itself."),
      skill("brief", "Grade engineering candidates from public evidence."),
      skill("self-update", "Update this app to the latest release."),
    ],
    "self",
  );
  expect(rows.map((row) => row.skill.name)).toEqual([
    "self-update",
    "diff-quality",
  ]);
  expect(rows[0]!.nameMatches).toEqual([0, 1, 2, 3]);
  expect(rows[1]!.descriptionMatches).toEqual([37, 38, 39, 40]);
});

it("matches a description only on whole terms", () => {
  expect(
    searchSkills(
      [skill("brief", "Screen a candidate and list evidence for hiring.")],
      "self",
    ),
  ).toEqual([]);
});
