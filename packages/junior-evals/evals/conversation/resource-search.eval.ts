import { describe, expect } from "vitest";
import { slackMention } from "@junior-evals/fixture/inputs";
import { completedToolCalls } from "@junior-evals/fixture/results";
import { test, type ToolCall } from "@junior-evals/fixture/test";

/**
 * Finding other conversations about one linked resource. A person who links
 * a pull request gets a search by that resource. Work named only in words
 * gets a search by words.
 */

function annotationFilters(conversation: { toolCalls: ToolCall[] }) {
  return completedToolCalls("searchConversations", conversation).map(
    (call) => (call.input as { annotation?: unknown } | undefined)?.annotation,
  );
}

describe("Resource Search", () => {
  test("when a person links a pull request and asks who worked on it, search conversations by that resource", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "which other threads touched https://github.com/getsentry/junior/pull/4120? i want to know who else is on it before I push",
      ),
    );

    expect(
      annotationFilters(conversation).some(
        (annotation) =>
          typeof annotation === "string" &&
          /getsentry\/junior(?:\/pull\/|#)4120/i.test(annotation),
      ),
    ).toBe(true);
  });

  test("when a person describes work only in words, search conversations by words, not by a resource", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "did anyone already look into why the billing cron jobs fail on Mondays? find the thread if there is one",
      ),
    );

    const filters = annotationFilters(conversation);
    expect(filters.length).toBeGreaterThan(0);
    expect(filters.filter((annotation) => annotation != null)).toEqual([]);
  });
});
