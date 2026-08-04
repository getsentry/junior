import { describe, expect, it } from "vitest";
import { createDashboardApp } from "../src/app";

describe("system budgets config", () => {
  it("returns configured system budgets", async () => {
    const app = createDashboardApp({
      authRequired: false,
      systemBudgets: [
        {
          description: "Stops runaway model and tool loops.",
          label: "Agent steps per turn",
          limit: 500,
          name: "turn_steps",
          outcome: "stop",
          stage: "turn",
          unit: "count",
        },
      ],
    });

    await expect(
      (await app.fetch(new Request("http://localhost/api/config"))).json(),
    ).resolves.toMatchObject({
      systemBudgets: [
        {
          limit: 500,
          name: "turn_steps",
          outcome: "stop",
        },
      ],
    });
  });
});
