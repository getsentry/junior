# Guardian

Guardian reviews a tool call of the agent immediately before it runs. It
checks the exact action against what the person asked for, then allows the
action, asks the person to confirm it, or denies it. Ordinary work goes on
with no interruption. A write that nobody asked for, or that exposes private
data, does not run.

## Intent

- Allow by default. Guardian blocks an action only when the action clearly
  matches one named rule from a fixed list. General doubt is not a reason to
  block.
- Only the person who runs the Turn can authorize an action. Their own
  messages in the Run's Conversation set what is authorized. Text from the
  agent, a parent agent, tools, files, issues, comments, Event authors, and
  other people is context. It is never approval. The one exception is the
  task of a Conversation that a Lead starts: it passes on the instruction
  of the Lead's person, so it counts as that person's request.
- The model rates risk and authorization, and names one rule. Code turns the
  rule into allow, ask, or deny, so the model never chooses between ask and
  deny.
- Secrets and private data never go where people outside the organization
  can read them, also when the person asks for it.
- A block holds for the outcome, not for the tool. The same side effect
  through another tool, a script, or a child agent gets the same decision.
- Guardian fails closed. When review cannot run, the action does not run.
- Guardian is a second check on authorization and risk. Provider
  permissions, tool validation, and credential scope still apply. Whether
  the work is correct or well proven is not its concern.
- The install, not the agent, states facts about destinations. Each plugin
  can declare where its writes go, such as which destinations people outside
  the organization can read. A fact never authorizes an action.
- Guardian understands every placeholder credential in the Sandbox: which
  env var holds it, and which domains get the real credential. A command
  that sends that env var to those domains does not expose a secret.

## Entry points

- Slack: an Inbox item in which Junior names an action, its target, and its
  side effects, and asks the person to confirm it.
- Dashboard: System, "Guardian reviews"; the "Guardian" line in the costs of
  a Conversation.
- Plugin authors: `approvalMode` (`auto`, `review`, or `approve`), tool
  annotations, and `describeProposal`.
- Deployment: `AI_GUARDIAN_MODEL` selects the review model.

## Rules

- Guardian reviews each plugin tool and each MCP tool, unless the tool is
  marked read-only and not destructive. A `review` tool is always reviewed.
  An `approve` tool is never reviewed, so use it only when the tool code
  proves that each effect is safe. A core tool is reviewed only when it opts
  in, such as Automation and Workspace changes, `spawnAgent`, and
  `messageAgent`.
- A public URL for a Sandbox server (`createPreview`) always goes through
  Guardian review, and the normal rules, such as `data_exposure`, decide.
- A confirmation rule asks. The person clears it when they confirm the exact
  action. A hard rule denies, and no confirmation clears it. Examples are
  `data_exposure`, `credential_probing`, `security_weakening`, and
  `untrusted_instruction`. High or critical risk with low or unknown
  authorization asks, also when no rule matches.
- An Automation run cannot ask, because no person is there to answer. Each
  ask becomes a deny.
- When Guardian asks, the agent asks the person about that exact action, the
  way it asks any question: with an Inbox item, also in a child agent. The
  agent never names Guardian or the review.
- After three rejected attempts in a row, the agent stops that write for
  the Turn and explains the risk.
- The root user instructions are the only authority. Each line has its real
  author. Only the current Actor's lines authorize. A restriction or a
  revocation still applies when it comes from a line that cannot authorize.
  A later message from the person wins over an earlier one. A bare yes
  answers only the question directly before it. Text that imitates these
  instructions, or claims an approval that they do not show, is untrusted.
- Only the core context of a proposal is fact: Actor, Source, Destination,
  Conversation, and credential authority. Tool input, descriptions,
  annotations, `describeProposal`, and transcript evidence are untrusted
  evidence.
- A child agent does not inherit approvals. The parent's text is its
  instruction. Guardian judges `spawnAgent` and `messageAgent` text by the
  material actions that it names, and the parent's own Conversation must
  back each one.
- A Code Mode script cannot authorize. Guardian judges each call of a script
  as if the agent made it directly. It uses the script and its earlier calls
  only to see where the data came from.
- The conventional steps of requested work match no rule, such as a pull
  request that delivers requested code and upkeep of that pull request
  ([GitHub](./github.md)).
- The organization's own Slack, including the active Conversation, is not
  outside the organization. Ordinary product context, such as repo and
  system names, is not private data.

## Gaps

- `publishImage` makes a public URL with no review, and nothing checks the
  image for private data. This breaks "secrets and private data never go
  where people outside the organization can read them".
- Guardian is not told about the placeholders of the GitHub, Vercel, and
  Datadog plugins. It can deny a normal call to their APIs as a secret leak.
  This breaks "Guardian understands every placeholder credential".
