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

The type sets the structure. Use its opening and its checks, then skip,
merge, reorder, or add chapters when the change needs it. A mixed change
draws on each of its types.

| Type        | Opening                                               | What a reviewer must check                             |
| ----------- | ----------------------------------------------------- | ------------------------------------------------------ |
| Bug fix     | What broke, and the root cause                        | Is it really the root cause; what else the fix affects |
| Feature     | The problem, and what changes for the user            | The gap it fills; how it is tested                     |
| Refactor    | What stays the same, and why the refactor is worth it | Proof that behavior does not change; the exceptions    |
| Migration   | Why it is needed                                      | Safe to run; rollback                                  |
| Performance | The hot path, and the numbers                         | Are the numbers real                                   |
| Dependency  | What changed upstream                                 | Blast radius                                           |
| UI          | Before and after                                      | States and edge cases                                  |

Every Walkthrough has two chapters:

- **The opening** comes first, with `role: "opening"`. Write the type's
  opening in the reader's terms: what was wrong, missing, or hard before
  this change, then what changes. Do not open on mechanics. For a stack or
  a mixed change, add a short map that names each part by what it does,
  and show the diagram. Say where the review risk is. For a small PR, this
  can be a short paragraph.
- **How we know it works**, with `role: "proof"`: the tests, checks, or
  runs that show the change does what it says.

Give every other chapter `role: "other"`. Spend chapters on the checks in
the table: risky or decision-heavy parts get room. A part that is
boilerplate gets one line in another chapter, or goes in `also_changed`.
Never write a chapter that only lists files or tests.

When the change has runtime effects, end with what to watch after it ships.
Name the concrete signal, such as a log, a metric, or a row status, and the
value that means trouble.

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

Write for a reader who knows the repository and the words in
TERMINOLOGY.md, but not this change.

- `intent` says what kind of change this is first, then the problem it
  solves: "This PR fixes a bug where…", "This stack adds… so that…".
- Define each new term where it first appears, such as a new kind of row or
  a feature name that a reader outside that feature would not know. Say what
  a thing does before you name it, then give the identifier in code format:
  "a second click joins the running version (`claimWalkthroughVersion`)".
  Never start a sentence with an identifier. Name one only when the reader
  needs it; the citation already points at the code.
- One idea per chapter. Each `label` is its title, a few words, such as
  "Root cause". The `caption` is one sentence that says what the chapter
  shows. Make each label and each caption unique.
- Each `body` is one short paragraph. The prose explains; citations support
  it. Cite evidence by its 1-based index, such as `[2]`, where it backs a
  point, not on every sentence. Cite every item you add. Use one to three
  items, and at most four. An opening can cite little or nothing.
- Show evidence for a root cause, such as code or a check. Do not claim that
  the cause is proven.
- Add a decision only for something a reviewer must decide, and state the
  tradeoff: an assumption that nobody confirmed, a behavior change, a missing
  signal, or a question that nobody asked. Never for trivia such as a rename.
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
