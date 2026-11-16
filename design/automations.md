# Automations

A user saves an instruction or a skill, and Junior runs it later: on a
Schedule, on a matching Event, or on a new message in a Slack channel. Each
Automation run posts its result to the conversation where the user created
the Automation.

## Intent

- A run works with no person present, and acts as Junior, not as its
  creator. When access is missing, the run blocks. It never asks anyone to
  sign in.
- A run posts nothing unless it chooses to. Each run starts its own
  Conversation, posts at most one message to each Destination, and puts
  later replies in that message's thread, where people continue it.
- Junior records every failure and block, and shows it to the creator as a
  Review item or another notice. It never posts a failure to the
  Destination.

## Entry points

- Slack: ask Junior in the conversation that should get the results.
- Dashboard: Automations, and its Runs view.
- MCP server: read-only search and fetch with the `automations:read` scope.

## Rules

- The agent creates or manages an Automation only in a Turn that a person
  started. An Automation run or an Event cannot.
- Anyone in the workspace can see and manage an Automation that posts to a
  public channel. Other Automations are visible only to their creator or
  from their Destination.
- An event filter limits noise. It is not access control.
- A Watch is not an Automation. An Automation run is not a Run.

## Gaps

- A creator can ask for runs to use their own credentials, because some
  providers have no Junior access yet. This breaks "acts as Junior": a run
  can fail when the creator is not connected, and an edit by someone else
  switches it back to Junior's credentials. The goal is to remove creator
  credentials.
- A failed run is not recorded where a person sees it, and repeated
  failures tell nobody. This breaks "Junior records every failure and block".
