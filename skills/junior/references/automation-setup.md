# Automation Setup in a Skill

Use this when a skill tells Junior how to create or update the automations that run it.

## Shape

- Set `skill` to the skill name. Put only what the run needs beyond the skill in `context`: repo, mode, team keys, who to tag.
- Do not write an instruction that says "Use the X skill". That is the old shape.
- Keep thresholds, report format, and workflow in the skill, so a skill change reaches every automation.
- Keep a `Read scope:` and allowed side effects in `context` when runs need them. Action review checks run actions against the stored context, not against the skill body. Posting the result to the automation's own outcomes needs no listing.

## Delivery

The runtime owns delivery. The automation's destination and outcomes set where results go.

- Say what to post and when to post nothing. Do not say where to post: no "post in <#CHANNEL>", no "this channel".
- A run ends with one result: one message, no action, or misconfigured. It cannot post a second message, post into a thread, or post to another channel. A Slack channel-message run posts in the message's thread without being told.
- `createAutomation` rejects "this channel", "this conversation", "this thread", and `[[NO_REPLY]]`. Write a channel mention only where the run reads or acts on that channel, such as its history.
- Tell the requester to set up the automation from a top-level message in the channel where results go.

## Tools

Use `searchAutomations` to find an existing automation before you create one, then `updateAutomation` or `createAutomation`. Do not name other tools.

## Platform limits

Do not copy runtime rules into the skill. List a limit only when it changes the skill's design, such as "one automation per digest group, because a run posts one message".

## Example

```markdown
## Automation

Create or update one automation per repo from a top-level message in the target channel.

- Skill: `release-train`. Schedule: weekly, Thursday 09:00, the creator's timezone.
- Outcome: `send_message` to the current conversation.
- Context (fill every `<...>`): `Repo <owner/repo>, bump=<bump>. Read scope: <owner/repo> releases, tags, commits, and workflow runs. Allowed side effects: dispatch <owner/repo>'s release workflow. When nothing is pending since the last release, post nothing.`
```
