# Inbox kinds

Every Inbox item has a kind, such as `question` or `github:pull_request`.
This file states the contract that every kind follows.
[Inbox](./inbox.md) owns what all items share, such as who sees, answers,
and changes an item.

## Jobs

- When Junior or a plugin needs a new kind of item, its authors write
  the kind's table first, so people agree on what it asks before the code
  exists.
- When a person reads the table of a kind, they can say what each viewer
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
  state that GitHub still computes, a rule of the kind names it and gives
  the output, usually the output that the person has now.
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
- `kind-table` Each kind is a decision table in a YAML file next to the
  code of its owner: core kinds in Junior, and plugin kinds in their plugin.
  Its rules use the
  [FIRST hit policy](https://docs.camunda.io/docs/components/modeler/dmn/decision-table-hit-policy/#first)
  of [DMN](https://www.omg.org/dmn/), and each cell is a simple unary test,
  such as `clean`, `not(open)`, or `-`. Junior generates the code of the
  kind from its table.
- `table-checks` The build fails when a rule can never be the first match,
  or when an input can be unknown and no rule names `unknown`.
- `table-links` Each rule of a table names the rules in `design/` that it
  serves, and its ID is a sub-feature ID in the verification map. The build
  fails when a table names a rule that `design/` does not have, or when the
  verification map has no claim for a rule of a table.

## Gaps

- `kind-table`: no kind is a table yet, and people write the code of each
  kind.
- `open-while-asked`, `state-not-events`, `commands-not-changes`: each
  source adds, changes, and closes its own items, and plugins call `upsert`
  and `close`. Nothing checks a kind against its rules.
- `table-links`: no check compares the tables with `design/` or with the
  verification map.
