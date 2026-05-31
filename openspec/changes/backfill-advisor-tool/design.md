# Design: `advisor-tool`

## Goals

- Define `advisor` as a consultant tool for hard reasoning, not a delegated worker that implements changes.
- Keep parent and advisor contexts separated unless the executor explicitly supplies evidence.
- Permit advisor inspection through a host-filtered read-only tool subset.
- Persist advisor-private history by parent conversation so follow-up advisor calls can build on prior advice.
- Keep advisor failures non-fatal to the main executor.

## Non-Goals

- Build a general multi-agent orchestration framework.
- Fork the main Pi transcript into the advisor.
- Allow advisor-side file mutation, Slack posting, user questions, recursive advisor calls, or MCP tool invocation.
- Specify exact advisor prose beyond structural behavioral constraints.
- Specify OpenTelemetry implementation details beyond semantic span ownership.

## Prior Art Summary

Claude Code subagents use specialized agents with their own context windows, custom prompts, model/tool settings, and separate tool permissions. They are useful when exploration would flood the main context, when a task benefits from a focused expert prompt, or when a subagent should be limited to read-only tools. Claude Agent SDK subagents make the parent-to-subagent boundary explicit: a subagent starts fresh and does not receive the parent conversation or tool results unless the parent includes needed evidence in the prompt. Amp Oracle is closer to Junior's advisor shape: a stronger read-only model exposed as a tool for review, debugging, analysis, and deciding what to do next, with explicit prompting rather than routine automatic use.

Sources:

- Claude Code subagents: https://code.claude.com/docs/en/sub-agents
- Claude Agent SDK subagents: https://code.claude.com/docs/en/agent-sdk/subagents
- Amp Oracle: https://ampcode.com/news/oracle

## Decisions

### Advisor Is A Consultant, Not An Implementer

The main executor remains responsible for edits, Slack side effects, verification, and user-visible replies. The advisor returns guidance only.

### Context Transfer Is Explicit

The advisor does not receive the parent transcript. The executor must pass a focused `question` and curated `context` packet. Follow-up calls can rely on advisor-private history, but any new evidence or changed constraint must still be included explicitly.

### Tool Access Is Host-Filtered Read-Only

The advisor receives only tools annotated `readOnlyHint: true` and not `destructiveHint: true`. Recursive advisor tools and MCP bridge tools are excluded until a nested-agent auth/resume contract exists.

### Advisor History Is Conversation-Scoped

Junior intentionally differs from fresh-only subagent prior art by persisting the advisor's own Pi message history at `junior:<conversationId>:advisor_session`. This keeps hard technical review coherent across multiple advisor calls without polluting the main transcript.

### Failures Are Non-Fatal

Invalid input, missing conversation identity, store failures, and advisor inference failures return structured `ok:false` tool results. The executor may continue only when verified evidence makes the next action clear.

## Open Design Questions

- Whether advisor failures should eventually be thrown expected tool errors instead of `ok:false` results.
- Whether advisor history needs compaction or token-budget enforcement before long conversations.
- Whether the advisor should have a max-turn or timeout contract distinct from the parent turn.
- Whether the advisor should ever receive specific MCP providers after nested auth/resume behavior is specified.
- Whether final-answer evals should assert advisor use on hard tasks or only assert behavior quality after advisor use.
