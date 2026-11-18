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
    "XDG_CONFIG_HOME",
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
  const isSkill = (name: string) =>
    availableSkills.some((skill) => skill.name === name);
  // Any non-word character can come before `$`, so `$name` also matches
  // after a tag, such as `<instructions>$name` in an Automation run, or in
  // Slack code. A word before it, such as `US$5`, is not a reference.
  const dollarPattern = /(?<![\w$])\$([a-z0-9]+(?:-[a-z0-9]+)*)/gi;
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
    .map(({ name }) => name)
    .filter(isSkill);
  return [...new Set(names)];
}
