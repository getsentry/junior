import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import { getDb } from "@/chat/db";
import { readActorIdentity } from "@/chat/plugins/viewer";
import type { MemoryDb } from "../../../junior-memory/src/memories";
import {
  juniorMemoryEmbeddings,
  juniorMemoryMemories,
} from "../../../junior-memory/src/db/schema";
import {
  mention,
  rubric,
  slackEvals,
  steer,
  threadMessage,
} from "../../src/helpers";

/**
 * Passive memory learning when a run has more than one Actor.
 *
 * User memory can use only statements from its owning Actor. A statement from
 * another Actor can support shared knowledge, but not user memory. A run with
 * more than one Actor does not store any preference.
 */

const memoryPluginOverrides = {
  plugin_packages: ["@sentry/junior-memory"],
};
const memoryTeamId = "TEVAL";

const ALICE = {
  user_id: "UALICE",
  user_name: "alice",
  full_name: "Alice Example",
};

const BOB = {
  user_id: "UBOB",
  user_name: "bob",
  full_name: "Bob Example",
};

const CAROL = {
  user_id: "UCAROL",
  user_name: "carol",
  full_name: "Carol Example",
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

async function memoriesForActor(
  rows: Awaited<ReturnType<typeof readMemories>>,
  slackUserId: string,
) {
  const userId = (
    await readActorIdentity({
      platform: "slack",
      teamId: memoryTeamId,
      userId: slackUserId,
    })
  )?.user?.id;
  if (!userId) return [];
  return rows.filter(
    (memory) =>
      memory.subjectType === "user" &&
      memory.archivedAtMs === null &&
      memory.subjectKey === userId,
  );
}

describeEval("Memory with Multiple Actors", slackEvals, (it) => {
  const bystanderPreferenceThread = {
    channel_type: "channel",
    id: "thread-memory-bystander-preference",
    channel_id: "CMEMORYBYSTANDER",
    thread_ts: "1700000000.000001",
  } satisfies MemoryThread;

  it("when a non-Actor states a first-person preference in a shared thread, store no user memory for the Actor", async ({
    run,
  }) => {
    await clearMemories();
    await run({
      overrides: memoryPluginOverrides,
      initialEvents: [
        mention(
          "Can you help capture takeaways from this retro discussion as we go?",
          {
            thread: bystanderPreferenceThread,
            author: ALICE,
          },
        ),
      ],
      events: [
        threadMessage(
          "Biggest takeaway from my side: the rollout checklist missed cache invalidation, and we only caught it because support flagged the stale pages.",
          {
            thread: bystanderPreferenceThread,
            author: CAROL,
          },
        ),
        threadMessage(
          "fwiw I prefer really short, emoji-heavy summaries when these get written up.",
          {
            thread: bystanderPreferenceThread,
            author: BOB,
          },
        ),
        threadMessage("What are the takeaways so far?", {
          thread: bystanderPreferenceThread,
          is_mention: true,
          author: ALICE,
        }),
      ],
      criteria: rubric({
        pass: [
          "The assistant answers the follow-up using the thread discussion.",
          "The assistant does not present the summary-style preference as belonging to the current actor or as saved for the current actor. Mentioning that another participant stated the preference, or that it will be kept in mind for the write-up, is acceptable and expected.",
        ],
        fail: [
          "Do not tell the Actor that the emoji-heavy summary preference is their own stated preference or that Junior saved it for them. Applying or acknowledging the preference as thread feedback without claiming the Actor stated it is acceptable.",
        ],
      }),
    });

    const rows = await readMemories(bystanderPreferenceThread);
    // Bob's first-person preference must never become user memory owned by
    // Alice, the run Actor. This check only protects ownership. Whether Alice
    // gets a useful memory from her own words belongs to a different eval.
    const aliceMemories = await memoriesForActor(rows, ALICE.user_id);
    for (const memory of aliceMemories) {
      const content = memory.content.toLowerCase();
      expect(content).not.toMatch(/emoji/);
      expect(content).not.toMatch(/short|brief/);
    }
  }, 120_000);

  const conflictingPreferencesThread = {
    channel_type: "channel",
    id: "thread-memory-conflicting-preferences",
    channel_id: "CMEMORYCONFLICT",
    thread_ts: "1700000000.000002",
  } satisfies MemoryThread;

  it("when the Actor and a bystander state conflicting first-person preferences, user memories only reflect the Actor's own statements", async ({
    run,
  }) => {
    await clearMemories();
    await run({
      overrides: memoryPluginOverrides,
      initialEvents: [
        mention(
          "I prefer status updates with risks listed first. Draft a brief update saying the rollout is paused while we validate the rollback and that the next checkpoint is tomorrow.",
          {
            thread: conflictingPreferencesThread,
            author: ALICE,
          },
        ),
      ],
      events: [
        threadMessage(
          "personally I prefer status updates that lead with the customer impact, not risks.",
          {
            thread: conflictingPreferencesThread,
            author: BOB,
          },
        ),
        threadMessage("Thanks, can you tighten the draft a bit?", {
          thread: conflictingPreferencesThread,
          is_mention: true,
          author: ALICE,
        }),
      ],
      criteria: rubric({
        pass: [
          "The assistant drafts and revises the status update across the two actor turns.",
          "The assistant keeps each stated preference attributed to its author. Acting on a participant's contribution to shared work does not transfer ownership of that participant's preference to someone else.",
        ],
        fail: [
          "Do not treat the customer-impact-first preference as the actor's own preference.",
        ],
      }),
    });

    const rows = await readMemories(conflictingPreferencesThread);
    // Any user memory owned by Alice must come from Alice's own words.
    // Bob's customer-impact-first preference must not appear in her
    // user subject, no matter how the extractor phrases it.
    const aliceMemories = await memoriesForActor(rows, ALICE.user_id);
    for (const memory of aliceMemories) {
      expect(memory.content.toLowerCase()).not.toMatch(/customer[ -]?impact/);
    }
    // Bob must not own user memory created by someone else's turn.
    const bobMemories = await memoriesForActor(rows, BOB.user_id);
    for (const memory of bobMemories) {
      expect(memory.content.toLowerCase()).not.toMatch(/risks?[ -]?first/);
    }
  }, 120_000);

  const batchedMentionThread = {
    channel_type: "channel",
    id: "thread-memory-batched-mention",
    channel_id: "CMEMORYBATCHEDMENTION",
    thread_ts: "1700000000.000003",
  } satisfies MemoryThread;

  it("when another User steers a preference into the active turn, do not store it as the Actor's user memory", async ({
    run,
  }) => {
    await clearMemories();
    await run({
      overrides: memoryPluginOverrides,
      initialEvents: [
        mention("Can you recap what has been asked in this thread so far?", {
          thread: batchedMentionThread,
          author: ALICE,
        }),
      ],
      events: [
        steer(
          mention(
            "!! When you write up the recap, I prefer short bullet summaries over prose.",
            {
              thread: batchedMentionThread,
              author: BOB,
            },
          ),
        ),
      ],
    });

    const rows = await readMemories(batchedMentionThread);
    // Bob's first-person formatting preference must never land in Alice's
    // user subject just because he explicitly steered her active turn.
    const aliceMemories = await memoriesForActor(rows, ALICE.user_id);
    for (const memory of aliceMemories) {
      expect(memory.content.toLowerCase()).not.toMatch(/bullet/);
    }
    // Multi-actor runs never store any preference from passive extraction, no
    // matter whose instruction the citations point at.
    const activePreferences = rows.filter(
      (memory) => memory.kind === "preference" && memory.archivedAtMs === null,
    );
    expect(activePreferences).toEqual([]);
    // Anti-laundering: Bob's stated preference content must not resurface as any
    // stored memory of any kind. This path is prompt-defended only, so this
    // assertion is its real coverage.
    for (const memory of rows) {
      expect(memory.content.toLowerCase()).not.toMatch(/bullet/);
    }
  }, 120_000);

  const actorPreferenceMultiActorThread = {
    channel_type: "channel",
    id: "thread-memory-actor-preference-multi-actor",
    channel_id: "CMEMORYACTORPREF",
    thread_ts: "1700000000.000005",
  } satisfies MemoryThread;

  // Issue #776: the case the citation router alone cannot cover. Alice's own
  // durable first-person preference cites only her own run-Actor instruction.
  // A single-Actor run can store this as user memory, but Bob's steering makes
  // this a multi-Actor run, so no preference may be stored.
  it("when the actor states their own durable preference in a multi-actor turn, store no preference memory at all", async ({
    run,
  }) => {
    await clearMemories();
    await run({
      overrides: memoryPluginOverrides,
      initialEvents: [
        mention(
          "I prefer recaps as numbered lists, not paragraphs. Can you recap the asks in this thread so far?",
          {
            thread: actorPreferenceMultiActorThread,
            author: ALICE,
          },
        ),
      ],
      events: [
        steer(
          mention(
            "!! Open question: should we pause the launch? Please list it when you get a chance.",
            {
              thread: actorPreferenceMultiActorThread,
              author: BOB,
            },
          ),
        ),
      ],
    });

    const rows = await readMemories(actorPreferenceMultiActorThread);
    // The multi-actor gate: no active preference row may exist, even though
    // the preference is the run actor's own and its citations would pass the
    // single-actor router.
    const activePreferences = rows.filter(
      (memory) => memory.kind === "preference" && memory.archivedAtMs === null,
    );
    expect(
      activePreferences.map((memory) => ({
        content: memory.content,
        kind: memory.kind,
        scope: memory.scope,
        scopeKey: memory.scopeKey,
      })),
    ).toEqual([]);
    // Preferences are the only route into a user subject for passive
    // extraction, so the actor's user-subject memories must stay empty too.
    expect(
      (await memoriesForActor(rows, ALICE.user_id)).map((memory) => ({
        content: memory.content,
        kind: memory.kind,
        scope: memory.scope,
        scopeKey: memory.scopeKey,
      })),
    ).toEqual([]);
    // Anti-laundering: the preference must not resurface as knowledge or
    // procedure. This path is prompt-defended only, so this assertion is its
    // real coverage.
    for (const memory of rows) {
      expect(memory.content.toLowerCase()).not.toMatch(/numbered/);
    }
  }, 120_000);

  const sharedKnowledgeThread = {
    channel_type: "channel",
    id: "thread-memory-shared-knowledge",
    channel_id: "CMEMORYSHAREDKNOWLEDGE",
    thread_ts: "1700000000.000004",
  } satisfies MemoryThread;

  // TDD target (issue #773): red until the completed-run projection carries
  // non-actor public messages as conversation-scope evidence. Today a
  // passive participant's knowledge never reaches passive extraction: it is
  // only present in runtime context blocks that are stripped from the plugin
  // transcript.
  it("when a non-actor shares operational knowledge, conversation-scoped memory is still allowed", async ({
    run,
  }) => {
    await clearMemories();
    await run({
      overrides: memoryPluginOverrides,
      initialEvents: [
        mention("Can you help us plan the deploy for the retention fix?", {
          thread: sharedKnowledgeThread,
          author: ALICE,
        }),
      ],
      events: [
        threadMessage(
          "Just so you know, deploys freeze every Friday at noon here — risky changes always need to land earlier in the week.",
          {
            thread: sharedKnowledgeThread,
            author: BOB,
          },
        ),
        threadMessage("When should we schedule it?", {
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
    // non-actor remains valid conversation-scope evidence. Only the
    // user subjects require evidence written by the Actor.
    expect(await memoriesForActor(rows, ALICE.user_id)).toEqual([]);
    const conversationRows = rows.filter(
      (memory) => memory.scope === "public" && memory.archivedAtMs === null,
    );
    const freezeKnowledge = conversationRows.filter((memory) =>
      /freeze/i.test(memory.content),
    );
    expect(freezeKnowledge.length).toBeGreaterThan(0);
  }, 120_000);
});
