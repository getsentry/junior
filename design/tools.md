# Tools

The model acts through tools: core tools, plugin tools, and MCP tools. Each
tool states what it does, takes arguments that each mean one thing, and
returns a result that shows the model its next step.

## Intent

- A tool works the same way for every model and provider. Its name, its
  arguments, and its result hold the contract, not prompt text that a model
  can skip.
- The model sees only the tools and arguments that can work in the current
  Turn. Each direct tool costs context in every Turn, so a tool that few
  Conversations use waits behind tool search.
- A result tells the model what happened and what to do next. The model
  never needs a second call to check that a call worked, or to guess why it
  failed.
- No part of a result is lost without notice. When a result is cut, the
  model learns that it was cut, how much there is, and how to get the rest.

## Entry points

- The model: direct tools in every Turn, and deferred tools through
  `searchTools`.
- Plugins: the tools that a plugin adds, and MCP tools from an MCP provider.
- Dashboard: tool calls and results in a Conversation transcript.

## Rules

- A tool description says what the tool does and what it returns. The
  meaning of an argument goes on that argument.
- An argument description says what the value is, what happens when it is
  left out, and its limits. A fixed set of values is a list of choices, not
  prose.
- A description promises only what the tool enforces. When it says that a
  call fails, that call fails.
- A call that changes state returns the saved state, not only "done". An
  empty list is a success, not an error.
- An error that the model can fix says what was wrong and how to fix it:
  the argument and the form that it takes, the tool that finds the right
  value, or that no change to the call can work in this Turn.
- An error that the model cannot fix is a system failure. It goes to
  Sentry.
- MCP tools keep the names and results of their provider. Junior's own
  wrappers around them follow these rules.

## Gaps

- Most tool errors say what went wrong, but not how to fix it. This breaks
  "an error that the model can fix says what was wrong and how to fix it".
