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

/**
 * Return the skills that `text` references explicitly, once each, in the
 * order they appear. `$name` is the reference form; `/name` is accepted as
 * older input.
 */
export function skillReferences(
  text: string,
  availableSkills: SkillMetadata[],
): string[] {
  return referencedSkillNames(text).filter((name) =>
    availableSkills.some((skill) => skill.name === name),
  );
}

/**
 * Return every name that `text` writes as a skill reference, once each, in
 * the order they appear, whether or not a skill has that name.
 */
export function referencedSkillNames(text: string): string[] {
  // Any character but a letter, digit, or `$` can come before `$`: a tag,
  // such as `<instructions>$name`, Slack code, or Slack italics
  // (`_$name_`). `US$5` is not a reference. The name must end where the
  // reference ends, so `$BETA_TOKEN` or `$weather-lookup-v2` does not
  // reference `beta` or `weather-lookup`. A closing `_` can follow.
  const dollarPattern =
    /(?<![a-z0-9$])\$([a-z0-9]+(?:-[a-z0-9]+)*)(?![a-z0-9]|[-_][a-z0-9])/gi;
  // A path such as `/tmp` or `/brief/notes.md` is not a skill reference.
  const slashPattern = /(?:^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?![a-z0-9/-])/gi;
  const matches = (pattern: RegExp) =>
    [...text.matchAll(pattern)].flatMap((match) =>
      match[1] ? [{ index: match.index, name: match[1].toLowerCase() }] : [],
    );
  const names = [
    ...matches(dollarPattern).filter(
      ({ name }) => !isCommonEnvironmentVariable(name),
    ),
    ...matches(slashPattern),
  ]
    .sort((left, right) => left.index - right.index)
    .map(({ name }) => name);
  return [...new Set(names)];
}
