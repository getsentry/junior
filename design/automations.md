# Automations

A user saves an instruction or a skill, and Junior runs it later: on a
Schedule, on a matching Event, or on a new message in a Slack channel. Each
Automation run posts its result to the Automation's Destination.

## Intent

- A run works with no person present, and acts as Junior, not as its
  creator. When access is missing, the run blocks. It never asks anyone to
  sign in.
- A Schedule means "at this time, do this work". Each run can reason and
  use tools. A fixed message that skips the work is not a goal.
- A run posts nothing unless it chooses to. Each run starts its own
  Conversation, posts at most one message to each Destination, and puts
  later replies in that message's thread, where people continue it.
- Junior records every failure and block, and shows it to the creator as a
  Review item or another notice. It never posts a failure to the
  Destination.

## Entry points

- Slack: ask Junior in the conversation that should get the results.
- Dashboard: ask Junior in a Conversation, and name a public Slack channel
  as the Destination.
- Dashboard: Automations, and its Runs view.
- MCP server: read-only search and fetch with the `automations:read` scope.

## Rules

- The agent creates or manages an Automation only in a Turn that a person
  started. An Automation run or an Event cannot.
- Anyone in the workspace can see and manage an Automation whose
  Destination is a public channel. Other Automations can be seen and managed
  only by their creator or from their Destination.
- A block pauses the Automation until someone resumes it.
- An event filter limits noise. It is not access control.

## Gaps

- A creator can ask for runs to use their own credentials, because some
  providers have no Junior access yet. This breaks "acts as Junior": a run
  can fail when the creator is not connected, and an edit by someone else
  switches it back to Junior's credentials.
- A failed run shows only on the dashboard. It tells its creator nothing,
  and repeated failures alert nobody. This breaks "shows it to the creator".
- When an Automation reaches the limit of automated Turns in a row, Junior
  posts a pause notice to the Destination. This breaks "posts nothing unless
  it chooses to" and "never posts a failure to the Destination".
