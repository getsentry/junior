import { beforeEach, describe, expect, test, vi } from "vitest";
import { readPeopleList } from "@sentry/junior/api/people/list";
import { createDashboardApp } from "../../../src/app";
import { dashboardReporting, directoryReport } from "./fixture";

vi.mock("@sentry/junior/api/people/list", () => ({
  readPeopleList: vi.fn(),
}));

describe("people list route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readPeopleList).mockResolvedValue(directoryReport());
  });

  test("serves the people list from the People API", async () => {
    const app = createDashboardApp({
      authRequired: false,
      reporting: dashboardReporting(),
    });

    const response = await app.fetch(
      new Request("http://localhost/api/people"),
    );

    expect(response.status).toBe(200);
    expect(readPeopleList).toHaveBeenCalledWith();
    expect(await response.json()).toMatchObject({
      people: [
        {
          conversations: 2,
          actor: {
            email: "person@example.com",
            fullName: "Person Example",
          },
        },
      ],
      source: "conversation_index",
    });
  });
});
