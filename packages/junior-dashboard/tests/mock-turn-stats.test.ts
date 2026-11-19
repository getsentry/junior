import { describe, expect, it } from "vitest";

import {
  readMockLocationDirectory,
  readMockPeopleProfile,
} from "../src/mock-reporting/fixtures";

// Like the server: a running Turn is active, a failed latest Turn is failed.
describe("mock Conversation stats", () => {
  it("counts a failed latest Turn on the profile", () => {
    const profile = readMockPeopleProfile("riley@sentry.io");
    expect(profile?.totals.failed).toBeGreaterThan(0);
  });

  it("counts running Turns as active", () => {
    const directory = readMockLocationDirectory();
    const active = [...directory.locations, directory.privateActivity].reduce(
      (sum, item) => sum + item.active,
      0,
    );
    expect(active).toBeGreaterThan(0);
  });
});
