# Tool Results

## Intent

The model reads a tool result to choose its next step. A result that says
what happened, what was cut, and how to fix a failure prevents repeat calls,
checks, and guesses. `tool-design.md` owns the schema and descriptions.

## Policy

### Success

- Return the state that the next step needs, such as IDs, the stored value,
  and counts. The model must not need a second call to check that the first
  one worked.
- When a call changes state, return the stored state, not only an
  acknowledgement such as "done".
- An empty list or search result is a success. Return the empty value, not
  an error.

### Size

- Bound every result, and never cut one without saying so. Set
  `truncated: true` and give the full size, such as `total_lines`.
- When the model can get the rest, set `continuation` with the arguments for
  the next call.

### Errors

- Model-repairable failures use the Pi tool-error channel: `ToolInputError`
  (host) or `PluginToolInputError` (plugins). This covers invalid arguments,
  missing active context, unsupported values, absent targets, ownership
  denials, and provider lookup misses.
- The message says what was wrong and how to fix it: the field and the form
  that it accepts, the tool that finds the right value, or that no change to
  the call can work in this Turn. Include the failed value when it is short
  and not private.
- A plain `Error` is a system failure and goes to Sentry.
- `tool-error-classification:check` keeps a baseline of plain `Error` throws in
  tool sources. Extend it only for true system, config, or integrity failures.
- Do not return `{ ok: false, error }` from a model-facing tool. Result unions
  are fine in private helpers and non-agent HTTP handlers.

## Exceptions

- Provider-owned MCP tools return provider results as-is. Junior wrappers
  around them follow this policy.

## Sources

Checked 2026-11-22. Research canvases: "Claude Code: tool design and prompt
design" and "Codex: tool design and prompt design".

- Claude Code 2.1.330 (requests captured from the binary): errors name the
  fix ("To replace all occurrences, set replace_all to true. To replace only
  one occurrence, please provide more context") and echo the input. Success
  results stop checks ("file state is current in your context — no need to
  Read it back"). Large output is saved, with a preview and a path.
- Codex `openai/codex@ba1c17f9`: errors name the field and the fix ("TTY
  execution is disabled by config; omit `tty` or set it to false"). Cut
  output keeps the head and tail and reports "Original token count". Its
  `update_plan` returns only "Plan updated", which gives the model no state.
