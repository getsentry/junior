import { beforeEach, describe, expect, test, vi } from "vitest";
import { readPeopleProfile } from "@sentry/junior/api/people/profile";
import { createDashboardApp } from "../../../src/app";
import { dashboardReporting, profileReport } from "./fixture";

vi.mock("@sentry/junior/api/people/profile", () => ({
  readPeopleProfile: vi.fn(),
}));

describe("people profile route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readPeopleProfile).mockImplementation(profileReport);
  });

  test("decodes the person email before loading the profile", async () => {
    const app = createDashboardApp({
      authRequired: false,
      reporting: dashboardReporting(),
    });

    const response = await app.fetch(
      new Request("http://localhost/api/people/Person%2BAlerts%40Example.com"),
    );

    expect(response.status).toBe(200);
    expect(readPeopleProfile).toHaveBeenCalledWith("Person+Alerts@Example.com");
    expect(await response.json()).toMatchObject({
      actor: {
        email: "Person+Alerts@Example.com",
      },
      totals: {
        conversations: 1,
      },
    });
  });

  test("rejects blank person emails", async () => {
    const app = createDashboardApp({
      authRequired: false,
      reporting: dashboardReporting(),
    });

    const response = await app.fetch(
      new Request("http://localhost/api/people/%20%20"),
    );

    expect(response.status).toBe(400);
    expect(readPeopleProfile).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ error: "Email is required" });
  });
});
