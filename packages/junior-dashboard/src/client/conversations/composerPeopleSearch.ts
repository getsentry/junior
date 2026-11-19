import type { MentionablePerson } from "@sentry/junior/api/schema";
import { quickOpenMatch } from "../components/quickOpenMatch";
import { mentionName } from "./composerMentionToken";

type PeopleSearchRow = {
  person: MentionablePerson;
  /** UTF-16 indices in the shown name that the query matched. */
  nameMatches?: number[];
};

/**
 * Rank people from the search API the way the command palette ranks
 * Conversations: by a quick-open match on the shown name. The API also
 * finds a person by Slack handle, which the menu does not show, so those
 * rows follow, in the API's order.
 */
export function rankPeople(
  people: readonly MentionablePerson[],
  query: string,
): PeopleSearchRow[] {
  const named: { row: PeopleSearchRow; score: number }[] = [];
  const others: PeopleSearchRow[] = [];
  for (const person of people) {
    const match = quickOpenMatch(mentionName(person), query);
    if (match) {
      named.push({
        row: { person, nameMatches: match.indices },
        score: match.score,
      });
    } else {
      others.push({ person });
    }
  }
  // Sort is stable, so equal scores keep the API's order.
  named.sort((left, right) => right.score - left.score);
  return [...named.map((ranked) => ranked.row), ...others];
}
