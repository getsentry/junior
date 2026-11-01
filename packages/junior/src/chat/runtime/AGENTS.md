# Runtime

This module owns native Turn orchestration, recovery, and provider-neutral
delivery ports. `../agent/` owns the model and tool loop. Callers save input,
deliver replies, and save their results. This module must not import a
provider layer.

## Invariants

- `turn-execution.ts` advances a started Turn by one Run. The Turn finishes
  only after the caller's result save succeeds. A paused Run leaves the Turn
  open.
- Only a completed assistant message with no tool calls is a reply. Thinking,
  tool calls, and text attached to tool calls stay internal.
- Progress uses the status surface, never an assistant reply.
- Save an assistant message only after delivery succeeds.
- `no_reply` needs an intentional no-reply. Missing text is not intentional
  silence.
- Recovery keeps the same Conversation id and Turn id. The first saved result
  wins.
- Do not repeat work that is already in saved agent history.
- Timeouts and delivery retries share the normal execution limit of the Turn.
- An explicit provider rejection fails the Turn. A transient or unknown
  delivery result resumes and generates the reply again. This can send a
  duplicate. Do not claim exactly-once delivery.
- Compaction and handoff change agent history only. They never create a new
  Conversation or change visible Messages. They keep open work, key facts,
  files, completed tool results, and the active Actor and Destination.
- Plugins and skills may add prompt text. They do not own runtime state or
  credentials.
