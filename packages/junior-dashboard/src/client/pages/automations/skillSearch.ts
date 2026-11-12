import type { SkillReport } from "@sentry/junior/api/schema";
import { quickOpenMatch } from "../../components/quickOpenMatch";

export type SkillSearchRow = {
  skill: SkillReport;
  /** UTF-16 indices in the name that the query matched. */
  nameMatches?: number[];
  /** UTF-16 indices in the description that the query matched. */
  descriptionMatches?: number[];
};

/**
 * Rank skills for the picker search. A name match ranks above any
 * description match, so `self` puts `self-update` at the top. Descriptions
 * match only on whole terms: a scatter across a long sentence matches
 * almost any query.
 */
export function searchSkills(
  skills: readonly SkillReport[],
  query: string,
): SkillSearchRow[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const named: { row: SkillSearchRow; score: number }[] = [];
  const described: { row: SkillSearchRow; score: number }[] = [];
  for (const skill of skills) {
    const name = quickOpenMatch(skill.name, query);
    if (name) {
      named.push({
        row: { skill, nameMatches: name.indices },
        score: name.score,
      });
      continue;
    }
    const description = skill.description.toLowerCase();
    if (!terms.every((term) => description.includes(term))) continue;
    const match = quickOpenMatch(skill.description, query);
    if (match) {
      described.push({
        row: { skill, descriptionMatches: match.indices },
        score: match.score,
      });
    }
  }
  // Sort is stable, so equal scores keep the skill list's order.
  const byScore = (left: { score: number }, right: { score: number }) =>
    right.score - left.score;
  return [...named.sort(byScore), ...described.sort(byScore)].map(
    (ranked) => ranked.row,
  );
}
