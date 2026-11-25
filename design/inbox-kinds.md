# Inbox kinds

Every Inbox item has a kind, such as `question` or `github:pull_request`.
This file states the contract that every kind follows, and the rules of
each kind. [Inbox](./inbox.md) owns what all items share, such as who sees,
answers, and changes an item.

## Jobs

- When Junior or a plugin needs a new kind of item, its authors write the
  kind's rules here first, so people agree on what it asks before the code
  exists.
- When a person reads the rules of a kind, they can say what each viewer
  sees for any state of its subject.
- When a webhook is lost or late, the item still shows the correct ask
  after Junior reads the subject again.

## Rules

**The contract**

- `kind-declares` Each kind names its subject, the one source that gives
  the subject's state, the Inbox events that it reads, its rules in order,
  and the command that each choice and Dismiss sends.
- `first-rule-wins` For each viewer, the first rule that matches the state
  gives the output: nothing, a notice with its step, or an ask with its
  label and choices. When no rule matches, the output is nothing.
- `unknown-keeps` When the source cannot give a fact yet, such as a merge
  state that GitHub still computes, each output stays as it is.
- `open-while-asked` The item of a `{kind, id}` is open while one or more
  people get an output. When nobody does, it closes with the reason of the
  rule that matched.
- `state-not-events` Junior gets each output from the current state and the
  Inbox events, never from one webhook. A lost or late webhook only delays
  the correct output until the next read.
- `inbox-log` What a person did on an item, such as a dismiss or a Resume,
  comes only from its Inbox events. Each event records the rule that gave
  the person's output. A kind keeps no other record of what people did.
- `dismiss-holds` A dismiss holds while the person's output comes from the
  same rule. When a different rule gives them an output, they get it. A
  kind can state a longer hold as a rule.
- `commands-not-changes` A choice or a Dismiss sends a command, such as
  "remove this reviewer on GitHub", and adds an Inbox event. It does not
  change the item. Junior then gets the outputs again. When the command
  fails, the person stays on the item.
- `push-on-new-ask` A person gets a push when their output changes from
  nothing to an ask, or to an ask from a different rule. Other changes push
  nobody.
- `rules-in-owner-doc` The rules of a core kind are in this file. The rules
  of a plugin kind are in the design file of its plugin, such as
  [GitHub](./github.md).

**`question`** (an agent asks). Source: the question.

- `question-closed` When a person answered or dismissed it, nobody gets it.
- `question-ask` Its assignees get the question, with its form.

**`notice`** (an agent tells). Source: the notice.

- `notice-closed` When a person dismissed it, nobody gets it.
- `notice-show` Its assignees get the notice, with its step.

**`todo`**. Source: the To-do and the Conversation's access.

- `todo-closed` When the To-do is done or dropped, or a person does not own
  it, nobody gets it.
- `todo-access` When the assignee cannot see the Conversation's private
  content, nobody gets it.
- `todo-ask` The assignee gets "To do for you". Done marks the To-do done,
  and Dismiss drops it.

**`reply`**. Source: the latest reply and the starter's read position.

- `reply-slack` When the Conversation has a Slack thread, nobody gets it.
- `reply-read` When the starter read the latest reply, nobody gets it.
- `reply-notice` The starter gets a notice with the latest reply.

**`automation`**. Source: the Automation, its last run, and the enabled
triggers.

- `alert-dismissed` When a person dismissed an alert of the Automation
  after it last recovered, nobody gets one. A pause is no recovery.
- `alert-blocked` When the Automation is blocked, the creator gets a notice
  to fix the problem and resume it.
- `alert-trigger` When its trigger is not available, the creator gets a
  notice that names the problem.
- `alert-run-failed` When its last run failed or blocked, the creator gets
  an ask with the steps that fit, such as Run again and Pause.

## Gaps

- `open-while-asked`, `state-not-events`, `commands-not-changes`: each
  source adds, changes, and closes its own items, and plugins call `upsert`
  and `close`. Nothing checks a kind against its rules.
- `alert-blocked`, `alert-trigger`: these alerts are actions that ask no
  question, not notices.
