import { describe, expect } from "vitest";
import { mockDatabaseDocs } from "@junior-evals/fixture/database-docs";
import { reply, slackMention } from "@junior-evals/fixture/inputs";
import {
  completedToolCalls,
  type ToolCall,
} from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

type SpawnInput = { agent_type?: string | null; kind?: string | null };

function spawnInput(call: ToolCall): SpawnInput {
  return (call.input as SpawnInput | undefined) ?? {};
}

// The user never names spawnAgent here. These cases measure whether Junior
// decides on its own when delegation pays for itself and which agent type
// fits.
describe("Implicit Delegation", () => {
  test("when a request splits into independent research tracks, start a child agent for each track", async ({
    agent,
  }) => {
    // A small budget keeps each child short. The case measures the parent's
    // choice to delegate, not the quality of the children's research.
    const { run } = await agent({ limits: { maxToolCallsPerTurn: 6 } });
    mockDatabaseDocs();
    const conversation = await run(
      slackMention(
        "I need to pick a database for a new service. Research how PostgreSQL, MySQL, and SQLite each handle adding a NOT NULL column with a default to a very large table: locking, rewrite cost, and replication impact. Go to each project's own docs, then give me the tradeoffs.",
      ),
    );

    const spawned = completedToolCalls("spawnAgent", conversation);
    expect(spawned.length).toBeGreaterThanOrEqual(2);
    // Research that only the parent reads is background work: a Task.
    expect(spawned.map((call) => spawnInput(call).kind)).not.toContain(
      "thread",
    );
    // A brief can carry each track, so no child needs this conversation.
    expect(spawned.map((call) => spawnInput(call).agent_type)).not.toContain(
      "fork",
    );
  });

  test("when a background job needs most of the thread's discussion, fork it", async ({
    agent,
  }) => {
    const { run } = await agent({ limits: { maxToolCallsPerTurn: 4 } });
    const conversation = await run(
      slackMention(
        "ok, kick off a background agent to write the design doc for this from everything we hashed out above: what we picked, what we threw out and why, and what's still open. I'll keep going with you on the migration in the meantime.",
      ),
      {
        history: [
          slackMention(
            "We need a retry policy for outbound webhooks. Today we retry 3 times, 10s apart, and big customers get hammered when they come back from an outage.",
          ),
          reply(
            "Options: fixed interval with more attempts, exponential backoff, or a per-endpoint token bucket. Exponential backoff with jitter spreads load best for the least work.",
          ),
          slackMention(
            "Token bucket is too much state per endpoint for v1, drop it. Go with backoff. Start at 30s and cap at 6h?",
          ),
          reply(
            "That works. With a 6h cap, 12 attempts covers about 24 hours. Full jitter keeps endpoints that failed together from retrying together.",
          ),
          slackMention(
            "Yes to full jitter. After 24h move it to a dead-letter queue. Customers can replay dead letters from the dashboard for 7 days, not 30, because storage costs.",
          ),
          reply(
            "Noted. Should a 410 Gone stop retries at once? Today we retry it like a 500.",
          ),
          slackMention(
            "Yes, a 410 disables the endpoint and emails the owner. A 429 respects Retry-After but never past the 6h cap. Every attempt keeps the same X-Delivery-Id so receivers can dedupe.",
          ),
          reply(
            "Got it. Open items: whether 5xx from one region counts against the global failure rate, and who owns the alert when an endpoint passes 5% failures.",
          ),
          slackMention(
            "Leave both open, Marta's team will weigh in. Let's start on how to migrate the in-flight deliveries.",
          ),
          reply(
            "For in-flight deliveries, the safest path is to let the old schedule finish and put only new deliveries on the new policy.",
          ),
        ],
      },
    );

    const spawned = completedToolCalls("spawnAgent", conversation);
    expect(spawned.map((call) => spawnInput(call).agent_type)).toContain(
      "fork",
    );
  });

  test("when a request needs only a few direct tool calls, do the work without a child agent", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention("what time is it right now in UTC and in Tokyo?"),
    );

    expect(completedToolCalls("spawnAgent", conversation)).toEqual([]);
    expect(conversation.replies).toHaveLength(1);
  });
});
