import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SystemBudgets } from "../src/client/pages/system/SystemBudgets";

describe("system budgets", () => {
  it("shows configured queue and stop budgets", () => {
    const html = renderToStaticMarkup(
      <SystemBudgets
        budgets={[
          {
            description: "Queues additional conversations.",
            label: "Active globally",
            limit: 100,
            name: "active_conversations_global",
            outcome: "queue",
            stage: "conversation_admission",
            unit: "count",
          },
          {
            description: "Stops runaway model and tool loops.",
            label: "Agent steps per turn",
            limit: 500,
            name: "turn_steps",
            outcome: "stop",
            stage: "turn",
            unit: "count",
          },
          {
            description: "Stops work after the daily budget.",
            label: "Daily spend",
            limit: 250,
            name: "daily_spend",
            outcome: "stop",
            stage: "turn",
            unit: "usd",
          },
          {
            description: "Cumulative active time across resumes.",
            label: "Runtime per turn",
            limit: 21_600_000,
            name: "turn_runtime",
            outcome: "stop",
            stage: "turn",
            unit: "milliseconds",
          },
        ]}
      />,
    );

    expect(html).toContain("System budgets");
    expect(html).toContain("Active globally");
    expect(html).toContain("Agent steps per turn");
    expect(html).toContain("Runtime per turn");
    expect(html).toContain("Daily spend");
    expect(html).toContain("$250");
    expect(html).toContain("6 hours");
    expect(html.match(/>Queue</g)).toHaveLength(1);
    expect(html.match(/>Stop</g)).toHaveLength(3);
  });
});
