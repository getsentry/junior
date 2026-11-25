import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { UserSearchResult } from "@sentry/junior/api/schema";

import { PeoplePicker } from "../src/client/components/PeoplePicker";
import {
  movePickerActive,
  pickerName,
  pickerOptions,
} from "../src/client/components/peoplePickerOptions";

const user = (
  userId: string,
  extra: Partial<UserSearchResult> = {},
): UserSearchResult => ({ email: `${userId}@example.com`, userId, ...extra });

describe("people picker", () => {
  it("names a person by full name, then handle, then email", () => {
    expect(
      pickerName(user("a", { fullName: "Ana", slackUserName: "ana" })),
    ).toBe("Ana");
    expect(pickerName(user("a", { slackUserName: "ana" }))).toBe("ana");
    expect(pickerName(user("a"))).toBe("a@example.com");
  });

  it("offers search results that are not chosen yet", () => {
    const [ana, ben, cy] = [user("ana"), user("ben"), user("cy")];
    expect(pickerOptions([ana, ben, cy], [ben])).toEqual([ana, cy]);
  });

  it("moves past people who already belong, and wraps at the ends", () => {
    const options = [user("ana"), user("ben", { isMember: true }), user("cy")];
    expect(movePickerActive(options, -1, 1)).toBe(0);
    expect(movePickerActive(options, -1, -1)).toBe(2);
    expect(movePickerActive(options, 0, 1)).toBe(2);
    expect(movePickerActive(options, 2, 1)).toBe(0);
    expect(movePickerActive(options, 0, -1)).toBe(2);
    expect(movePickerActive([user("ben", { isMember: true })], -1, 1)).toBe(-1);
    expect(movePickerActive([], -1, 1)).toBe(-1);
  });
});

describe("PeoplePicker", () => {
  it("renders a combobox that controls its people listbox", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <PeoplePicker
          add={async () => {}}
          label="Add members"
          memberLabel="Member"
          onCancel={() => {}}
          onDone={() => {}}
          submitLabel="Add"
          target={{ spaceId: "6f1c2a7e-3b4d-4e5f-8a6b-7c8d9e0f1a21" }}
        />
      </QueryClientProvider>,
    );
    const input = html.match(/<input[^>]*>/)?.[0] ?? "";
    expect(input).toContain('role="combobox"');
    expect(input).toContain('aria-label="Add members"');
    expect(input).toContain('aria-expanded="false"');
    expect(input).toContain('aria-autocomplete="list"');
    const controls = input.match(/aria-controls="([^"]+)"/)?.[1];
    expect(html).toContain(`id="${controls}" role="listbox"`);
    // Nothing is chosen yet, so Add waits.
    expect(html.match(/<button type="submit"[^>]*>Add</)?.[0]).toContain(
      ' disabled=""',
    );
  });
});
