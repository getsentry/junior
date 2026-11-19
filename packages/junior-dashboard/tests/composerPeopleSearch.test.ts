import { describe, expect, it } from "vitest";

import type { MentionablePerson } from "@sentry/junior/api/schema";
import { rankPeople } from "../src/client/conversations/composerPeopleSearch";

function person(slackUserId: string, fullName: string, slackUserName?: string) {
  return {
    slackUserId,
    fullName,
    ...(slackUserName ? { slackUserName } : undefined),
  } satisfies MentionablePerson;
}

describe("rankPeople", () => {
  it("ranks a word-start match above a scattered one", () => {
    const people = [person("U1", "Marcus Ngata"), person("U2", "Casey Nguyen")];
    expect(
      rankPeople(people, "ngu").map((row) => row.person.slackUserId),
    ).toEqual(["U2", "U1"]);
  });

  it("marks the matched letters of the shown name", () => {
    const [row] = rankPeople([person("U2", "Casey Nguyen")], "cn");
    expect(row?.nameMatches).toEqual([0, 6]);
  });

  it("keeps a person the API found by handle, after the name matches", () => {
    const people = [
      person("U3", "Sam Ortiz", "casey-backup"),
      person("U2", "Casey Nguyen"),
    ];
    const rows = rankPeople(people, "casey");
    expect(rows.map((row) => row.person.slackUserId)).toEqual(["U2", "U3"]);
    expect(rows[1]?.nameMatches).toBeUndefined();
  });
});
