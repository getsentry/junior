/** Explicit skill references: `$name`, and `/name` as older input. */
import type { SkillMetadata } from "@/chat/skills";

function isCommonEnvironmentVariable(name: string): boolean {
  return [
    "HOME",
    "LANG",
    "PATH",
    "PWD",
    "SHELL",
    "TEMP",
    "TERM",
    "TMP",
    "TMPDIR",
    "USER",
  ].includes(name.toUpperCase());
}

// Any character but a letter, digit, or `$` can come before `$`: a tag, such
// as `<instructions>$name`, Slack code, or Slack italics (`_$name_`). `US$5`
// is not a reference. The name must end where the reference ends, so
// `$BETA_TOKEN` or `$weather-lookup-v2` does not reference `beta` or
// `weather-lookup`. A closing `_` can follow.
const DOLLAR_REFERENCE =
  /(?<![a-z0-9$])\$([a-z0-9]+(?:-[a-z0-9]+)*)(?![a-z0-9]|[-_][a-z0-9])/gi;
// A path such as `/tmp` or `/brief/notes.md` is not a skill reference.
const SLASH_REFERENCE = /(?:^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?![a-z0-9/-])/gi;

function referenceMatches(
  text: string,
  pattern: RegExp,
): { index: number; name: string }[] {
  return [...text.matchAll(pattern)].flatMap((match) =>
    match[1] ? [{ index: match.index, name: match[1].toLowerCase() }] : [],
  );
}

function dollarReferenceMatches(text: string) {
  return referenceMatches(text, DOLLAR_REFERENCE).filter(
    ({ name }) => !isCommonEnvironmentVariable(name),
  );
}

/**
 * Return the skills that a person's `text` references explicitly, once each,
 * in the order they appear. `$name` is the reference form; `/name` is
 * accepted as older input.
 */
export function skillReferences(
  text: string,
  availableSkills: SkillMetadata[],
): string[] {
  const names = [
    ...dollarReferenceMatches(text),
    ...referenceMatches(text, SLASH_REFERENCE),
  ]
    .sort((left, right) => left.index - right.index)
    .map(({ name }) => name)
    .filter((name) => availableSkills.some((skill) => skill.name === name));
  return [...new Set(names)];
}

/**
 * Return the names that a SKILL.md body references as `$name`, once each, in
 * the order they appear, whether or not a skill has that name. A body has no
 * `/name` form, so a path such as `/brief` unlocks nothing.
 */
export function skillBodyReferences(body: string): string[] {
  return [...new Set(dollarReferenceMatches(body).map(({ name }) => name))];
}
