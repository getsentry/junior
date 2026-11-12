# Walkthroughs scratch

This is the single scratch branch for the Walkthroughs work. It is not for
review or merge. It holds the old draft stack (#3087–#3174), the journal, and
the prototypes.

## What is where

- **Code:** the branch starts at `walkthrough/15-source-lookup` (895657404).
  That is the whole stack, slices 1–15, with the lower PRs as its ancestors.
- **`walkthrough-prototype` history:** merged with `-s ours` in the commit
  "Keep walkthrough-prototype history". The commits are in the history, and
  the files did not change. Tip: 87148d706.
- **`walkthrough-journal` history:** merged the same way. Tip: e5209102c.
  - `notes/` is a copy of that branch: DECISIONS.md, JOURNAL.md, cost runs and
    eval runs.
  - `runs/real-transcript/` is not copied, because its generated documents
    use a real source Conversation. It is still in the merged history.
- **`prototypes/`:** static design prototypes. Open `index.html` in a browser.
  - `3153.html`, `3071.html`, `3131.html`: hand-made storyboards.
  - `present.html?pr=3153|3071`: narrated presentation. The audio is not
    committed. `narration.json` has the text.
  - `stories.html?pr=3153`: a phone stories version. Rejected as too gimmicky.
  - `case.html`: assurance case for each PR. This is the direction that
    worked best.

## What we learned, newest first

1. **Organize a Walkthrough around "why"**:
   - why this change;
   - why this cause, for bug fixes;
   - why this fix, for bug fixes;
   - why this design;
   - why it is safe.

   Each why has an answer, evidence, the alternatives that were ruled out,
   and an evidence tag.

2. **Questions grounded in the source Conversation work.** In 6 real questions,
   Junior quoted the author's real reasons. It said "the author didn't say"
   when the source had no reason, and it found a real `break` vs `return`
   inconsistency in #3153.
3. **The remaining failures are in generation, not answers:**
   - it adds a tradeoff that nobody stated;
   - it gives a tag that is too strong for its sentence;
   - an answer worked out from the code sometimes starts with "Because"
     instead of "From the code".
4. **Use two tags, not one:**
   - where the reason comes from: author stated, discussed, or not discussed;
   - how well it is proven: proven, supported, code shows, or asserted.

   With one tag, almost every item counts as weak and shows up front.

5. **Show up front only what needs the reader.** Fold strong evidence. Keep
   open every element that has a question on it. Put gaps first.
6. **Visuals only where they are evidence.** Do not use json-render
   (it was more code and twice the cost). Do not use slides or stories.

The `scratch/walkthrough-why` work (the why format, slice 16) is added on top
of this branch as its own commit.
