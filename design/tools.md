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

## Rules

- A tool description says what the tool does and what it returns. The
  meaning of an argument goes on that argument.
- An argument description says what the value is, what happens when it is
  left out, and its limits. A fixed set of values is a list of choices, not
  prose.
- A description promises only what the tool enforces. When it says that a
  call fails, that call fails.
- Arguments that contradict each other fail the call. The tool does not
  pick one of them.
- A tool takes a target as an ID, a mention, or a link. It matches a plain
  name only against what Junior already stores. It never pages through a
  provider's whole list to find a name.
- The model never chooses who acts, where a result goes, or which
  credentials a call uses. The runtime sets them from the request.
- One value has one name in tool arguments, tool results, and prompt text.
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

- A tool that cannot work in a Turn stays in the tool list. The model
  learns only from a separate note, or from a failed call, that it cannot
  use it. This breaks "the model sees only the tools and arguments that can
  work in the current Turn".
- Some results cut long text and add only "…", such as Conversation
  summaries in search results and the task of a child agent in its list.
  The model does not learn how much is missing or how to get it. This
  breaks "no part of a result is lost without notice".
- Some arguments have no description, such as arguments of the Automation,
  Inbox item, and Google Calendar tools. This breaks "an argument
  description says what the value is".
- `userLookup` finds a person by a plain name through pages of the Slack
  member list. In a large workspace it can miss the person. This breaks "it
  never pages through a provider's whole list to find a name".
