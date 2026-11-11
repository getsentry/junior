---
name: walkthrough
description: Generate a Walkthrough for one code change or a stack. The Walkthrough worker runs this skill; people start it from the dashboard.
disable-model-invocation: true
---

# Walkthrough

A Walkthrough turns a code change or a whole stack, 1 PR or 10, into one
guided story. The prose and its citations alone must walk a reviewer with no
context through the work. Commits, diffs, and checks are evidence, not
structure: never write one chapter per PR or per commit.

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
2. A readable source Conversation tells the intent. Read it as you need.
3. Decide what kind of change the whole Walkthrough is, and set `types`. A
   mixed change has more than one.
4. Plan the story, then call `submitWalkthrough`. If it reports problems,
   fix all of them and call it again. When it succeeds, reply with one short
   sentence and stop.

## Chapters

Each type suggests chapters. Skip, merge, reorder, or add chapters when the
change needs it, and draw on more than one type for a mixed change.

- Bug fix: root cause, and proof that it is the root cause; the fix; proof
  that the fix works; side effects; what to watch after it ships.
- Feature: the problem; how it works; what it touches; how it is tested;
  what to watch after it ships.
- Migration: why; what changes in the data; safe to run; rollback.
- Refactor: what stays the same; proof that behavior does not change;
  exceptions.
- Performance: the hot path; the change; the numbers.
- Dependency: what changed upstream; blast radius; rollback.
- UI: before and after; states and edge cases.

Use 8 chapters or fewer for one PR, and 10 or fewer for a stack.

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
     file in `also_changed`.
   - Use new ids. Do not reuse a chapter, decision, or item id.
4. If nothing that the story cites changed, submit no items.

## Writing

- `intent` says what kind of change this is first: "This PR fixes a bug
  where…", "This stack adds…".
- Each chapter `label` is its title: a few words, such as "Root cause".
  The `caption` is one sentence that says what the chapter shows. Make each
  label and each caption unique.
- Each chapter `body` is one short paragraph for a reader with no context.
  Cite each evidence item by its 1-based index, such as `[2]`, and cite
  every item. A chapter can cite code from several PRs.
- Show evidence for a root cause, such as code or a check. Do not claim that
  the cause is proven.
- Add a decision only for something the reader must judge: an assumption that
  nobody confirmed, a behavior change, a missing signal, or a question that
  nobody asked.
- A decision `claim` is a statement that the reader agrees with or asks to
  change, such as "Three retries are enough to recover a lost lock." Never
  write it as a question. Put what could make the claim wrong in `concern`.
- `asks` are questions a reader is likely to ask at that chapter.

## Diagrams

- Draw one diagram for each code change that has a flow worth showing. Set
  its `pr`. Use 10 nodes or fewer: the parts that the code change touches
  and how they connect. Junior lays the diagram out.
- A chapter `view` names the `pr` of the diagram that it shows and the node
  and edge ids to show. The other parts fade.
- Most chapters have no view. Add one only when the story reaches a part of
  the flow that the reader has not seen yet, or marks a broken part. Junior
  rejects a view that shows only parts an earlier chapter showed.

## Evidence

- `code`: a line range at a commit. Cite `head` lines for code that exists in
  the head commit, including unchanged callers. Cite `base` lines for removed
  code; a `base` range must fall inside one diff hunk. Never copy code into
  prose; the runtime shows the cited lines.
- `message`: the seq of a message in the source Conversation.
- `link`: only a URL that appears in a PR body or a cited message.
- Every changed file that is not mechanical must be cited by a chapter or
  listed in `also_changed`. Group listed files under a short reason, such
  as "Tests of the validator". Never add a chapter only to cite a file.

## Limits

- Do not change code, push, comment, review, or approve. This Turn only reads
  and submits.
- Keep prose short. A long Walkthrough defeats its purpose.
