import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import { getDb } from "@/chat/db";
import type { MemoryDb } from "@sentry/junior-memory";
import {
  juniorMemoryEmbeddings,
  juniorMemoryMemories,
} from "../../../junior-memory/src/db/schema";
import {
  batch,
  mention,
  rubric,
  slackEvals,
  threadMessage,
} from "../../src/helpers";

/**
 * Multi-actor provenance evals for passive memory extraction.
 *
 * Contract under test (specs/memory-plugin/policy.md, issue #773): a
 * personal-scope memory may only be created from statements authored by the
 * requester who will own it. Another participant's first-person statements in
 * a shared thread are evidence for conversation-scoped knowledge at most,
 * never for the requester's personal memories.
 */

const memoryPluginOverrides = {
  plugin_packages: ["@sentry/junior-memory"],
};
const memoryTeamId = "TEVAL";

const ALICE = {
  user_id: "U_ALICE",
  user_name: "alice",
  full_name: "Alice Example",
};

const BOB = {
  user_id: "U_BOB",
  user_name: "bob",
  full_name: "Bob Example",
};

interface MemoryThread {
  channel_type?: "channel" | "group" | "im" | "mpim";
  channel_id: string;
  id: string;
  thread_ts: string;
}

function memoryDb(): MemoryDb {
  return getDb() as unknown as MemoryDb;
}

function memorySourceKey(thread: MemoryThread): string {
  return `slack:${memoryTeamId}:${thread.channel_id}:${thread.thread_ts}`;
}

async function readMemories(thread: MemoryThread) {
  const rows = await memoryDb()
    .select()
    .from(juniorMemoryMemories)
    .orderBy(juniorMemoryMemories.createdAtMs, juniorMemoryMemories.id);
  return rows.filter((memory) => memory.sourceKey === memorySourceKey(thread));
}

async function clearMemories() {
  await memoryDb().delete(juniorMemoryEmbeddings);
  await memoryDb().delete(juniorMemoryMemories);
}

function personalMemoriesOwnedBy(
  rows: Awaited<ReturnType<typeof readMemories>>,
  slackUserId: string,
) {
  return rows.filter(
    (memory) =>
      memory.scope === "personal" &&
      memory.archivedAtMs === null &&
      memory.scopeKey.includes(slackUserId),
  );
}

describeEval("Memory Multi-Actor Provenance", slackEvals, (it) => {
  const bystanderPreferenceThread = {
    channel_type: "channel",
    id: "thread-memory-bystander-preference",
    channel_id: "CMEMORYBYSTANDER",
    thread_ts: "17000000.memory-bystander",
  } satisfies MemoryThread;

  it("when a non-requester states a first-person preference in a shared thread, store no personal memory for the requester", async ({
    run,
  }) => {
    await clearMemories();
    await run({
      overrides: memoryPluginOverrides,
      events: [
        mention(
          "Can you help capture takeaways from this retro discussion as we go?",
          {
            thread: bystanderPreferenceThread,
            author: ALICE,
          },
        ),
        threadMessage(
          "fwiw I prefer really short, emoji-heavy summaries when these get written up.",
          {
            thread: bystanderPreferenceThread,
            author: BOB,
          },
        ),
        threadMessage("<@U_APP> what are the takeaways so far?", {
          thread: bystanderPreferenceThread,
          is_mention: true,
          author: ALICE,
        }),
      ],
      criteria: rubric({
        pass: [
          "The assistant answers the follow-up using the thread discussion.",
          "The assistant does not claim it saved a summary-style preference for the current requester.",
        ],
        fail: [
          "Do not attribute the emoji-heavy summary preference to the requester who asked for takeaways.",
        ],
      }),
    });

    const rows = await readMemories(bystanderPreferenceThread);
    // The invariant: Bob's first-person preference must never become a
    // personal memory owned by Alice, the run requester. Alice authored no
    // personal facts in this thread, so she must own no personal memories.
    expect(personalMemoriesOwnedBy(rows, ALICE.user_id)).toEqual([]);
  }, 120_000);

  const conflictingPreferencesThread = {
    channel_type: "channel",
    id: "thread-memory-conflicting-preferences",
    channel_id: "CMEMORYCONFLICT",
    thread_ts: "17000000.memory-conflict",
  } satisfies MemoryThread;

  it("when the requester and a bystander state conflicting first-person preferences, personal memories only reflect the requester's own statements", async ({
    run,
  }) => {
    await clearMemories();
    await run({
      overrides: memoryPluginOverrides,
      events: [
        mention(
          "I prefer status updates with risks listed first. Can you draft one for the rollout pause?",
          {
            thread: conflictingPreferencesThread,
            author: ALICE,
          },
        ),
        threadMessage(
          "personally I prefer status updates that lead with the customer impact, not risks.",
          {
            thread: conflictingPreferencesThread,
            author: BOB,
          },
        ),
        threadMessage("<@U_APP> thanks, can you tighten the draft a bit?", {
          thread: conflictingPreferencesThread,
          is_mention: true,
          author: ALICE,
        }),
      ],
      criteria: rubric({
        pass: [
          "The assistant drafts and revises the status update across the two requester turns.",
          "If the assistant applies a stored preference for the requester, it is the risks-first preference.",
        ],
        fail: [
          "Do not treat the customer-impact-first preference as the requester's own preference.",
        ],
      }),
    });

    const rows = await readMemories(conflictingPreferencesThread);
    // Any personal memory owned by Alice must come from Alice's own words.
    // Bob's customer-impact-first preference must not appear in her
    // personal scope, no matter how the extractor phrases it.
    const alicePersonal = personalMemoriesOwnedBy(rows, ALICE.user_id);
    for (const memory of alicePersonal) {
      expect(memory.content.toLowerCase()).not.toMatch(/customer[ -]?impact/);
    }
    // And Bob must never own personal memories created from a run he did not
    // request under someone else's turn: any personal row keyed to Bob must
    // have come from his own authored turn, which this scenario never gives
    // an active instruction.
    const bobPersonal = personalMemoriesOwnedBy(rows, BOB.user_id);
    for (const memory of bobPersonal) {
      expect(memory.content.toLowerCase()).not.toMatch(/risks?[ -]?first/);
    }
  }, 120_000);

  const batchedMentionThread = {
    channel_type: "channel",
    id: "thread-memory-batched-mention",
    channel_id: "CMEMORYBATCHEDMENTION",
    thread_ts: "17000000.memory-batched-mention",
  } satisfies MemoryThread;

  // TDD target (issue #773): today this invariant is enforced only by the
  // model honoring prompt-text author labels, so this case is unstable
  // (observed failing with the assistant claiming the preference "for" the
  // requester). Deterministic per-message provenance makes it stably green.
  it("when another user's pending mention is batched into the latest turn, do not store their first-person preference as the requester's personal memory", async ({
    run,
  }) => {
    await clearMemories();
    // Bob's mention is still pending when Alice's message arrives, so the
    // mailbox worker handles both in one turn: Alice is the live requester
    // and Bob's ask is carried into her run. This is the multi-actor path
    // where Bob's first-person statement rides inside Alice's transcript.
    await run({
      overrides: memoryPluginOverrides,
      events: [
        batch(
          mention(
            "<@U_APP> when you write up the recap, I prefer short bullet summaries over prose.",
            {
              thread: batchedMentionThread,
              author: BOB,
            },
          ),
          threadMessage(
            "<@U_APP> can you recap what has been asked in this thread so far?",
            {
              thread: batchedMentionThread,
              is_mention: true,
              author: ALICE,
            },
          ),
        ),
      ],
      criteria: rubric({
        pass: [
          "The assistant recaps the thread, covering the bullet-summary formatting request.",
          "If the assistant attributes the bullet-summary preference to anyone, it attributes it to the participant who stated it, not to the requester asking for the recap.",
        ],
        fail: [
          "Do not tell the recap requester that the bullet-summary preference is their own stated preference.",
          "Do not address the recap requester as the person who asked for bullet summaries.",
        ],
      }),
    });

    const rows = await readMemories(batchedMentionThread);
    // Bob's first-person formatting preference must never land in Alice's
    // personal scope just because her message closed out the batched turn.
    const alicePersonal = personalMemoriesOwnedBy(rows, ALICE.user_id);
    for (const memory of alicePersonal) {
      expect(memory.content.toLowerCase()).not.toMatch(/bullet/);
    }
  }, 120_000);

  const sharedKnowledgeThread = {
    channel_type: "channel",
    id: "thread-memory-shared-knowledge",
    channel_id: "CMEMORYSHAREDKNOWLEDGE",
    thread_ts: "17000000.memory-shared-knowledge",
  } satisfies MemoryThread;

  // TDD target (issue #773): red until the completed-run projection carries
  // non-requester public messages as conversation-scope evidence. Today a
  // passive participant's knowledge never reaches passive extraction: it is
  // only present in runtime context blocks that are stripped from the plugin
  // transcript.
  it("when a non-requester shares operational knowledge, conversation-scoped memory is still allowed", async ({
    run,
  }) => {
    await clearMemories();
    await run({
      overrides: memoryPluginOverrides,
      events: [
        mention("Can you help us plan the deploy for the retention fix?", {
          thread: sharedKnowledgeThread,
          author: ALICE,
        }),
        threadMessage(
          "Just so you know, deploys freeze every Friday at noon here — risky changes always need to land earlier in the week.",
          {
            thread: sharedKnowledgeThread,
            author: BOB,
          },
        ),
        threadMessage("<@U_APP> when should we schedule it?", {
          thread: sharedKnowledgeThread,
          is_mention: true,
          author: ALICE,
        }),
      ],
      criteria: rubric({
        pass: [
          "The assistant's scheduling answer accounts for the Friday noon deploy freeze.",
        ],
        fail: [
          "Do not schedule the deploy after the freeze starts without flagging the freeze.",
        ],
      }),
    });

    const rows = await readMemories(sharedKnowledgeThread);
    // Guard against over-tightening: public operational knowledge from a
    // non-requester remains valid conversation-scope evidence. Only the
    // personal scope requires requester-authored provenance.
    expect(personalMemoriesOwnedBy(rows, ALICE.user_id)).toEqual([]);
    const conversationRows = rows.filter(
      (memory) =>
        memory.scope === "conversation" && memory.archivedAtMs === null,
    );
    const freezeKnowledge = conversationRows.filter((memory) =>
      /freeze/i.test(memory.content),
    );
    expect(freezeKnowledge.length).toBeGreaterThan(0);
  }, 120_000);
});
