# Automations

A user saves an instruction or a skill, and Junior runs it later without a
person in the loop: on a Schedule, on a matching Event, or on a new message
in a Slack channel. Each Automation run posts its result to the
conversation where the user created the Automation.

## Behaviors

- `create-scheduled` A user asks for a reminder or a recurring task. Junior
  saves it without a confirmation step and posts there when it is due.
- `create-event` A user asks Junior to act when a resource changes. Each
  matching Event starts one Automation run that posts to the Destination.
- `channel-message` A user asks Junior to act on new posts in a channel.
  Junior replies in the thread of each new top-level message in that channel.
- `manage` A user asks to list, reschedule, pause, resume, or delete.
  Junior changes the existing Automation and does not create a new one.
- `move` A user asks, in a different conversation, to move an Automation
  there. Junior changes its Destination to that conversation.
- `run-now` A user asks to run a Scheduled automation now. It runs soon,
  and its Schedule does not change.
- `no-action` When the instruction's condition is not met, the run posts
  nothing.
- `blocked` When a run cannot work, Junior blocks the Automation and sends
  a DM to its creator only.
- `dashboard` A user opens an Automation to see its runs and versions, edit
  it, pause or resume it, delete it, or make an earlier version active.

## Entry points

- Slack: ask Junior in the conversation that should get the results.
- Dashboard: Automations, and its Runs view.
- MCP server: read-only search and fetch with the `automations:read` scope.

## Rules

- The agent creates or manages an Automation only in a Turn that a person
  started. An Automation run or an Event cannot.
- Runs use Junior's credentials, so they work with no person present.
- Gap: a creator can ask for runs to use their own credentials. A run can
  then fail when the creator is not connected, and an edit by someone else
  switches it back to Junior's credentials. The goal is to remove creator
  credentials.
- Each Automation run starts its own Conversation and posts at most one
  message, to its Destination or to the creator's DM. People can continue
  the Conversation from that message.
- Anyone in the workspace can see and manage an Automation that posts to a
  public channel. Other Automations are visible only to their creator or
  from their Destination.
- An event filter limits noise. It is not access control.
- A Watch is not an Automation. An Automation run is not a Run.
