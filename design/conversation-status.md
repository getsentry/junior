# Conversation status

Each Conversation has one status that says what its own work needs. Every
viewer sees the same status. A list, a Space, or a parent shows the roll-up
of its tree: the status of the Conversation that needs the most attention
in it. People use statuses to find the work that is blocked on a person,
failed, or still runs, without opening each Conversation.

## Jobs

- When a person scans a list of Conversations or Spaces, they see which
  trees are blocked on a person, failed, or still run, so they open only
  the work that needs them.
- When work cannot go on without a person, it shows `needs_input` until a
  person acts, so blocked work never looks finished and finished work never
  looks blocked.
- When an agent finished the work that it was given, its Conversation shows
  `done`, so people and auto-archive can retire it.
- When a list or a Space loads, it reads stored statuses, so its load time
  does not grow with the history of its Conversations.

## Rules

**Statuses**

- `one-status` Each Conversation stores one status: `working`,
  `needs_input`, `failed`, `stopped`, `idle`, or `done`. It describes the
  Conversation's own work, not the work of its child agents. A status never
  comes from what the model says.
- `working` While a Turn is queued or running, the status is `working`. New
  input that starts work makes it `working`.
- `needs-input` The status is `needs_input` only while the work is blocked
  on a person: an open action Inbox item that this Conversation added, or a
  Turn that waits for a sign-in. An unread reply, a failed Turn, a notice,
  a To-do, and an item that another Conversation added do not make it
  `needs_input`.
- `turn-limit` When automated input reaches the automated-turn limit, the
  Conversation adds an action Inbox item that asks a person whether to
  continue. Until a person answers it or sends input, or the parent gives
  new work, automated input starts no Turn. The limit never stops a
  Conversation.
- `failed` When the latest Turn failed and no later Turn started, the status
  is `failed`. A reply that says the agent could not do the task is not a
  failure.
- `stopped` When a person or the parent stops a Conversation, the status is
  `stopped`. It does not resume by itself: only a person's input or new work
  from its parent ends the stop.
- `idle` When the latest Turn ended and a Watch or a Timer on this
  Conversation is live, the status is `idle`. A new, cancelled, or expired
  Watch or Timer changes the status.
- `done` When the latest Turn ended and nothing on this Conversation is
  pending, the status is `done`. This is the same for every kind of
  Conversation, so a root is done when it answered the person and nothing
  waits. A Turn that ended blocked is `done`: the parent has the result.
- `own-order` When more than one status applies, the first of these wins:
  `stopped`, `working`, `needs_input`, `failed`, `idle`, `done`. So an agent
  that keeps working while its question is open shows `working`.

**Roll-ups**

- `roll-up` The roll-up of a tree is the first of these that applies to the
  top Conversation or any descendant: `needs_input`, `failed`, `working`,
  `idle`. Otherwise it is `stopped` when the top Conversation is stopped,
  and `done` when it is not.
- `shared` Statuses and roll-ups are the same for every viewer. What waits
  on one person comes from their Inbox, not from a status.
- `archived-out` An archived Conversation keeps its status. It and its
  descendants do not count in the roll-up of an ancestor.
- `space-roll-up` The roll-up of a Space is the roll-up of its Lead's tree.
- `where-shown` Lists of Conversations, the Space sidebar, and the Threads
  panel show roll-ups. A Conversation's own page shows its own status.

**Freshness**

- `current` A status changes in the same write as the facts that set it, so
  a reader never derives it.
- `self-heals` If a status misses a change that no write makes, such as a
  sign-in wait or a Watch that expires, or a worker that is lost, Junior
  corrects it within 5 minutes, with no action from a person.

## Non-goals

- Unread is not a status. Whether a person read a reply is their own state.

## Gaps

- `current`: Junior derives each status on every read, so a list of
  Conversations or Spaces can take more than 10 seconds to load.
- `one-status`, `own-order`: a status is only `needs_input`, `working`, or
  `done`. A failed Turn shows `needs_input`, or `done` in a Task, and a
  stop or a live Watch shows `done`.
- `needs-input`: an unread reply shows `needs_input`.
- `turn-limit`: the automated-turn limit stops the Conversation tree and
  posts a notice, so the tree shows `done`, and only a person's message
  continues it.
- `shared`, `roll-up`: a roll-up differs for each viewer. A tree shows
  "Needs you" only to the person that it waits on, and it has no `failed`
  or `idle`.
