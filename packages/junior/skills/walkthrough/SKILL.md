---
name: walkthrough
description: Generate a Walkthrough for one code change or a stack. The Walkthrough worker runs this skill; people start it from the dashboard.
disable-model-invocation: true
---

# Walkthrough

A Walkthrough helps a reviewer who has no context understand a code change
without reading all of its code. The story leads. Code is the evidence.

## Input

The instruction gives the repository, the code changes (bottom first, with
base and head commits), and sometimes a source Conversation ID: the
Conversation that opened the code change.

If `submitWalkthrough` is not in your tools, this Turn is not a Walkthrough
generation. Say that Walkthroughs start from the dashboard, and stop.

## Steps

1. Read the diff of each code change at the given commits. Use `gh pr diff`
   or a shallow clone and `git diff BASE...HEAD`. Read callers or other
   unchanged code when the change affects them.
2. If there is a source Conversation ID, read it to learn the intent. Start
   with the most recent messages and go back only as far as you need. If you
   cannot read it, continue with the code changes alone.
3. Pick the change type of each part. Each type has fixed slots, in this
   reading order. Fill the slots that apply; do not invent structure.
   - `feature`: `how_it_works`, `gap`, `change`
   - `bug_fix`: `broken`, `cause`, `fix`, `side_effects`, `proof`
   - `refactor`: `claim`, `proof`, `exceptions`
   - `migration`: `why`, `change`, `safe_to_run`, `rollback`
   - `dependency`: `what_changed`, `blast_radius`, `rollback`
   - `performance`: `hot_path`, `change`, `numbers`
   - `ui`: `before_after`
   - `ship_check`: `after_ship` (what telemetry shows whether it worked)
4. Call `submitWalkthrough`. If it reports problems, fix all of them and call
   it again. When it succeeds, reply with one short sentence and stop.

## Update

When the instruction says that this Turn updates the previous version, the
reviewer already read that version. Tell them only what changed. Do not
write the story again.

1. Call `readPreviousWalkthrough`. It returns the previous story, the files
   whose diff changed, the chapters that cite them, layers that joined or
   left the stack, and decisions that a reviewer asked to change.
2. Read the diff of each changed file at the new commits. Compare it with
   the previous head commit when that helps you say what changed.
3. Call `submitWalkthrough` with update items:
   - Add one item for each changed chapter. `touches` is the chapter id. The
     `caption` says what changed, and the `body` says why and cites the new
     code.
   - If an item addresses a decision that a reviewer asked to change, set
     `answers` to that decision id. Say how the change answers it. Do not
     claim that it does if the code does not show it.
   - Put a new concern that fits no old chapter in `added_chapters`.
   - Cite every changed hunk in an item or an added chapter, or list its
     file in `not_covered`.
   - Use new ids. Do not reuse a chapter, decision, or item id.
4. If nothing that the story cites changed, submit no items.

## Writing

- `intent` says what kind of change this is first: "This PR fixes a bug
  where…", "This stack adds…".
- Each chapter `caption` is its title in the chapter list. Make each one
  unique: a stack has many chapters in the same slot, and only the caption
  tells them apart.
- Each chapter `body` is two or three short sentences of prose for a reader
  with no context. Cite each evidence item by its 1-based index, such as
  `[2]`, and cite every item.
- For a bug fix, the cause chapter must cite code or a check that shows the
  cause. Show evidence. Do not claim that the cause is proven.
- `side_effects` names what else the fix touches and whether that is safe.
- Add a decision only for something the reader must judge: an assumption that
  nobody confirmed, a behavior change, a missing signal, or a question that
  nobody asked.
- A decision `claim` is a statement that the reader agrees with or asks to
  change, such as "Three retries are enough to recover a lost lock." Never
  write it as a question. Put what could make the claim wrong in `concern`.
- `asks` are questions a reader is likely to ask at that chapter.
- If one code change mixes types, such as a feature and a refactor, add a
  `splits` entry for it.

## Diagrams

- Draw one diagram for each code change that has a flow worth showing. Set
  its `pr`. Use 10 nodes or fewer: the parts that the code change touches
  and how they connect. Junior lays the diagram out.
- A chapter `view` names the `pr` of the diagram that it shows and the node
  and edge ids to show. The other parts fade.
- Most chapters have no view. Add one where a code change comes in, and
  again only when a chapter shows a part of the flow that the reader has not
  seen yet, or marks a broken part. Junior rejects a view that shows only
  parts an earlier chapter showed.

## Evidence

- `code`: a line range at a commit. Cite `head` lines for code that exists in
  the head commit, including unchanged callers. Cite `base` lines for removed
  code; a `base` range must fall inside one diff hunk. Never copy code into
  prose; the runtime shows the cited lines.
- `message`: the seq of a message in the source Conversation.
- `link`: only a URL that appears in a PR body or a cited message.
- Every changed file that is not mechanical must be cited by a chapter or
  listed in `not_covered` with the reason it does not matter.

## Limits

- Do not change code, push, comment, review, or approve. This Turn only reads
  and submits.
- Keep prose short. A long Walkthrough defeats its purpose.
