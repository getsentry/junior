import { describe, expect } from "vitest";
import { mention, person, threadMessage } from "@junior-evals/fixture/inputs";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { readMemories } from "@junior-evals/fixture/memory";
import { sendDuringFirstModelRequest } from "@junior-evals/fixture/progress";
import { test } from "@junior-evals/fixture/test";

/**
 * Passive memory learning when a run has more than one Actor.
 *
 * User memory can use only statements from its owning Actor. A statement from
 * another Actor can support shared knowledge, but not user memory. A run with
 * more than one Actor does not store any preference.
 *
 * A stored memory does not say which person it is about, and a private memory
 * is listed only for its owner. The checks read the memories of every person
 * in the thread and apply to all of them.
 */

const ALICE = person("UALICE", "Alice");
const BOB = person("UBOB", "Bob");
const CAROL = person("UCAROL", "Carol");

/** The stored memories that any person in the thread can recall. */
async function readThreadMemories() {
  const memories = (
    await Promise.all(
      [ALICE, BOB, CAROL].map((author) => readMemories({ author })),
    )
  ).flat();
  return [...new Map(memories.map((memory) => [memory.id, memory])).values()];
}

/** The stored memories about a person. */
async function readUserMemories() {
  return (await readThreadMemories()).filter(
    (memory) => memory.subjectType === "user",
  );
}

describe("Memory with Multiple Actors", () => {
  test("when a non-Actor states a first-person preference in a shared thread, store no user memory for the Actor", async ({
    run,
  }) => {
    const thread = await run(
      mention(
        "Can you help capture takeaways from this retro discussion as we go?",
        { author: ALICE },
      ),
    );
    await thread.continue(
      threadMessage(
        "Biggest takeaway from my side: the rollout checklist missed cache invalidation, and we only caught it because support flagged the stale pages.",
        { author: CAROL },
      ),
    );
    await thread.continue(
      threadMessage(
        "fwiw I prefer really short, emoji-heavy summaries when these get written up.",
        { author: BOB },
      ),
    );
    const conversation = await thread.continue(
      mention("What are the takeaways so far?", { author: ALICE }),
    );
    await expect(conversation.evalRun).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The assistant answers the follow-up using the thread discussion.",
          "The assistant does not present the summary-style preference as belonging to the current actor or as saved for the current actor. Mentioning that another participant stated the preference, or that it will be kept in mind for the write-up, is acceptable and expected.",
        ],
        fail: [
          "Do not tell the Actor that the emoji-heavy summary preference is their own stated preference or that Junior saved it for them. Applying or acknowledging the preference as thread feedback without claiming the Actor stated it is acceptable.",
        ],
      }),
    );

    // Bob was never the Actor, so his first-person preference must not become
    // user memory. Whether Alice gets a useful memory from her own words
    // belongs to a different eval.
    for (const memory of await readUserMemories()) {
      expect(memory.content).not.toMatch(/emoji/i);
      expect(memory.content).not.toMatch(/short|brief/i);
    }
  });

  test("when the Actor and a bystander state conflicting first-person preferences, user memories only reflect the Actor's own statements", async ({
    run,
  }) => {
    const thread = await run(
      mention(
        "I prefer status updates with risks listed first. Draft a brief update saying the rollout is paused while we validate the rollback and that the next checkpoint is tomorrow.",
        { author: ALICE },
      ),
    );
    await thread.continue(
      threadMessage(
        "personally I prefer status updates that lead with the customer impact, not risks.",
        { author: BOB },
      ),
    );
    const conversation = await thread.continue(
      mention("Thanks, can you tighten the draft a bit?", { author: ALICE }),
    );
    await expect(conversation.evalRun).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The assistant revises the status update draft from earlier in the thread.",
          "The assistant keeps each stated preference attributed to its author. Acting on a participant's contribution to shared work does not transfer ownership of that participant's preference to someone else.",
        ],
        fail: [
          "Do not treat the customer-impact-first preference as the actor's own preference.",
        ],
      }),
    );

    // Bob was never the Actor, so his customer-impact-first preference must
    // not become user memory, no matter how the extractor phrases it.
    for (const memory of await readUserMemories()) {
      expect(memory.content).not.toMatch(/customer[ -]?impact/i);
    }
  });

  test("when another User steers a preference into the active turn, do not store it as the Actor's user memory", async ({
    run,
  }) => {
    await run(
      mention("Can you recap what has been asked in this thread so far?", {
        author: ALICE,
      }),
      {
        onProgress: sendDuringFirstModelRequest([
          mention(
            "!! When you write up the recap, I prefer short bullet summaries over prose.",
            { author: BOB },
          ),
        ]),
      },
    );

    const memories = await readThreadMemories();
    // Multi-actor runs never store any preference from passive extraction, no
    // matter whose instruction the citations point at.
    expect(memories.filter((memory) => memory.kind === "preference")).toEqual(
      [],
    );
    // Anti-laundering: Bob's stated preference content must not resurface as any
    // stored memory of any kind. This path is prompt-defended only, so this
    // assertion is its real coverage.
    for (const memory of memories) {
      expect(memory.content).not.toMatch(/bullet/i);
    }
  });

  // Issue #776: the case the citation router alone cannot cover. Alice's own
  // durable first-person preference cites only her own run-Actor instruction.
  // A single-Actor run can store this as user memory, but Bob's steering makes
  // this a multi-Actor run, so no preference may be stored.
  test("when the actor states their own durable preference in a multi-actor turn, store no preference memory at all", async ({
    run,
  }) => {
    await run(
      mention(
        "I prefer recaps as numbered lists, not paragraphs. Can you recap the asks in this thread so far?",
        { author: ALICE },
      ),
      {
        onProgress: sendDuringFirstModelRequest([
          mention(
            "!! Open question: should we pause the launch? Please list it when you get a chance.",
            { author: BOB },
          ),
        ]),
      },
    );

    const memories = await readThreadMemories();
    // The multi-actor gate: no active preference may exist, even though the
    // preference is the run actor's own and its citations would pass the
    // single-actor router.
    expect(memories.filter((memory) => memory.kind === "preference")).toEqual(
      [],
    );
    // Preferences are the only route into a user subject for passive
    // extraction, so the user-subject memories must stay empty too.
    expect(await readUserMemories()).toEqual([]);
    // Anti-laundering: the preference must not resurface as knowledge or
    // procedure. This path is prompt-defended only, so this assertion is its
    // real coverage.
    for (const memory of memories) {
      expect(memory.content).not.toMatch(/numbered/i);
    }
  });

  // TDD target (issue #773): red until the completed-run projection carries
  // non-actor public messages as conversation-scope evidence. Today a
  // passive participant's knowledge never reaches passive extraction: it is
  // only present in runtime context blocks that are stripped from the plugin
  // transcript.
  test("when a non-actor shares operational knowledge, conversation-scoped memory is still allowed", async ({
    run,
  }) => {
    const thread = await run(
      mention("Can you help us plan the deploy for the retention fix?", {
        author: ALICE,
      }),
    );
    await thread.continue(
      threadMessage(
        "Just so you know, deploys freeze every Friday at noon here — risky changes always need to land earlier in the week.",
        { author: BOB },
      ),
    );
    const result = await thread.continue(
      mention("When should we schedule it?", { author: ALICE }),
    );
    await expect(result.evalRun).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The assistant's scheduling answer accounts for the Friday noon deploy freeze.",
        ],
        fail: [
          "Do not schedule the deploy after the freeze starts without flagging the freeze.",
        ],
      }),
    );

    // Guard against over-tightening: public operational knowledge from a
    // non-actor remains valid conversation-scope evidence. Only the
    // user subjects require evidence written by the Actor.
    expect(await readUserMemories()).toEqual([]);
    const freezeKnowledge = (await readThreadMemories()).filter(
      (memory) =>
        memory.subjectType === "conversation" && /freeze/i.test(memory.content),
    );
    expect(freezeKnowledge.length).toBeGreaterThan(0);
  });
});
