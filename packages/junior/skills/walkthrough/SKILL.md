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

## Writing

- `intent` says what kind of change this is first: "This PR fixes a bug
  where…", "This stack adds…".
- Each chapter `body` is two or three short sentences of prose for a reader
  with no context. Cite each evidence item by its 1-based index, such as
  `[2]`, and cite every item.
- For a bug fix, the cause chapter must cite code or a check that shows the
  cause. Show evidence. Do not claim that the cause is proven.
- `side_effects` names what else the fix touches and whether that is safe.
- Add a decision only for something the reader must judge: an assumption that
  nobody confirmed, a behavior change, a missing signal, or a question that
  nobody asked.
- `asks` are questions a reader is likely to ask at that chapter.
- If one code change mixes types, such as a feature and a refactor, add a
  `splits` entry for it.

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
