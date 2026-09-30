# Spaces

This module owns the Space tree, Conversation assignment, the Space
classifier, the Space agent tools, the per-Turn Space prompt context, and the
`junior spaces backfill` command.

A Space is a nested forum category of Conversations. Spaces mirror how the
organization is built and run: products, product areas, platforms, teams,
internal tools, processes, and recurring kinds of work. Each root Conversation
has at most one primary Space.

Spaces are a core feature, beside Briefs. The classifier reads the latest
Brief, and the dashboard, privacy gate, and Turn tasks are core-owned. Spaces
use the plugin registration contract through `coreRegistrations()`, but they
are not an installed plugin.

## Enablement

Spaces are off by default. Apps enable them with
`createApp({ briefs: { enabled: true }, spaces: { enabled: true } })`.
Spaces need Briefs. When Briefs are off, no Space task or prompt context runs.
The example app and the `junior init` scaffold enable both.

## Data model

- `junior_spaces` stores the current tree. A Space points only at its parent
  with `parent_space_id`. Moving a Space moves its subtree and every assigned
  Conversation with one update.
- Active sibling names are unique without case differences. The tree has at
  most `MAX_SPACE_DEPTH` levels.
- A merged or archived Space keeps its row. A merged Space records
  `merged_into_space_id`. `resolveSpaceId` follows merges, so an old id still
  resolves to the surviving Space.
- `junior_conversation_spaces` stores the current Space of one root
  Conversation. A pinned assignment came from a request. The classifier never
  replaces a pinned assignment. The row also stores the kind of work:
  `question`, `investigation`, `bug`, `feature`, or `task`. Rows cascade when
  their Conversation is deleted.
- `junior_space_changes` is the append-only log. It records each create,
  update, move, merge, archive, and assignment with the actor, the
  Conversation where the change was requested, and before and after values.
  The current rows are mutable. The log is the history.

## Classification

`briefs.updateBrief` calls `assignSpaceFromBrief` after it stores a Brief.
The classifier runs only while the root Conversation has no Space, or has a
pinned Space with no kind yet. A pinned Space stays, and only the kind is
stored. So each Conversation costs at most one classifier call. The call uses the default
model with the `junior.space_assign` prompt name. The task emits a
`spaces/space_assigned` event with the path, confidence, model id, and cost.

The classifier sees the Brief, the Conversation title and channel, and an
outline of at most 400 Spaces. The outline keeps shallow Spaces first, so a
listed Space always has its parent listed. The model either picks an existing
Space or proposes a new Space under an existing parent. A proposed Space that
already exists under that parent is reused.

The prompt groups by repository or product first. GitHub repositories come
from the Brief links. Incidents are the exception: they always go in one
top-level Incidents Space. Child Spaces are features or components, never
kinds of work, because the kind is a separate label.
The prompt never makes a Space for the whole organization or its main
product, because every Conversation is about them.

The app can add its own rules with `spaces.guidance`. They come after the core
rules and win when the two conflict. Keep organization-specific steering, such
as SDK Spaces, there and keep the core prompt general. The `junior spaces
backfill` CLI does not load app settings, so it runs without guidance; the
`runSpaceBackfill` tool uses it. Space descriptions are short keyword lists.
`normalizeSpaceDescription` removes lead-ins such as "Conversations about".

## Privacy

- The classifier never names a Space from private content. A non-public
  Conversation can join an existing Space, but the classifier cannot create a
  Space for it.
- A person can ask Junior to create or rename a Space from any Conversation.
  The `createSpace` and `updateSpace` descriptions say that names are public,
  so Junior uses the name the person asked for and no private details.
- The change log keeps a reason only when the requesting Conversation is
  public. It keeps Conversation ids for every assignment.
- Browsing shows public Conversations with their title and kind. It only
  counts private Conversations. Tree counts include
  private Conversations.
- Space facts (people and kinds) come only from the
  listed public Conversations.
- A Conversation detail includes its Space path only when the viewer can see
  the Conversation content.

## Tools and prompt context

The deferred `spaces` tool source has `listSpaces`, `getSpace`,
`findSpaceConversations`, `createSpace`, `updateSpace`, `moveSpace`,
`mergeSpace`, `archiveSpace`, and `assignConversationSpace`.
`findSpaceConversations` searches public Conversation titles and Briefs, so
Junior can find Conversations to move, such as every incident. A tool assignment is pinned. A Conversation that a
person starts from a Space in the dashboard is also pinned to that Space.

When the current Conversation has a Space, the `userPrompt` hook adds the
Space path and the descriptions of the Space and its ancestors.

## Backfill

`junior spaces backfill` replays the classifier over unassigned root
Conversations that have a Brief, oldest first. The tree grows as it would
have grown at runtime.

- Without `--apply`, the run writes nothing. It grows an in-memory copy of the
  tree and prints a Markdown outline with counts and up to three public titles
  per Space.
- With `--apply`, each Space and assignment goes through the store with the
  `backfill` actor, so every step is in the change log.
- `--limit`, `--since`, `--model`, and `--out` narrow the run, pick the
  model, and write the outline to a file.

Apps that enable the `operator-tools` experimental feature also get the
`runSpaceBackfill` operator tool in non-public Conversations. It runs the same
backfill inside the deployment, with the default model, at most 200
Conversations per call. It stops before each next Conversation when it has
used 60% of the Turn timeout, and reports how many it handled. Use it on a Preview to try the backfill against the
Preview's copy of the database. `backfill-tool.ts` owns it.

## Layout

`types.ts` owns the shared types. `tree.ts` builds the tree and owns name,
depth, and path rules. `store.ts` reads and writes Spaces, assignments, and
the change log. `classify.ts` owns the classifier prompt and output checks.
`assign.ts` applies a classification. `registration.ts` owns enablement and
the prompt context. `events.ts` owns the Conversation event. `tools.ts` owns
the agent tools. `backfill.ts` owns the backfill. The read-only dashboard API
is in `src/api/spaces`.
