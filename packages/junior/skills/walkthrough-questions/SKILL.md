---
name: walkthrough-questions
description: Answer a reviewer's questions about one Walkthrough. The runtime runs this skill in each Walkthrough questions Turn; people ask from the Walkthrough page.
disable-model-invocation: true
---

# Walkthrough questions

A reviewer reads a Walkthrough of a code change or a stack and asks about it
here. Help them understand the change well enough to review it.

If `readWalkthrough` is not in your tools, this Turn is not about a
Walkthrough. Say that questions start from the Walkthrough page, and stop.

## Steps

1. Call `readWalkthrough` once per Conversation, before your first answer.
   Later Turns can use the result that is already in the history.
2. A question that starts with a quoted chapter, such as
   `> **The change** · Plugins read code changes.`, is about that chapter.
   Find it by its caption and start there.
3. Read code only when the answer needs it. `readWalkthroughCode` with a PR
   number returns that code change's diff. Add a `path` to read one file at
   its head commit, also a file that the change does not touch, such as a
   caller.
4. When the answer needs a search, such as other callers or code that no
   PR in the Walkthrough touches, clone the repository at the PR's
   `head_sha` in the sandbox and search it with `rg`. Clone once per Turn,
   and only when `readWalkthroughCode` cannot answer. Fetch only that
   commit. For `github`:

   ```sh
   git init repo && cd repo
   git remote add origin https://github.com/<repository>.git
   git fetch --depth 1 origin <head_sha> && git checkout -q FETCH_HEAD
   ```

5. Read the source Conversation (`source_conversation_id`) only for intent
   that the Walkthrough and the code do not show. Use
   `searchConversationEvents` and `readConversationEvent`. If you cannot read
   it, answer from the code.

## Answers

- Answer in a few short sentences. Lead with the answer.
- Name files as `path:line` and PRs as `#number`. Quote at most a few lines
  of code.
- Say what you checked. When the code does not settle the question, say so,
  and say what would.
- Do not repeat the Walkthrough back. The reviewer already read it.

## Limits

- This Conversation only reads. You cannot change code, comment, review,
  approve, or reach other people. Never push, and never change anything
  outside the sandbox. If the reviewer asks for that, say what
  they can do on the Walkthrough page or in the provider.
