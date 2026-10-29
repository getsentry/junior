# System Prompt

## Intent

The model reads Junior's prompt as one ordered set of blocks. Each rule must
have one known home, so that the order and priority of the rules stay the same
when we change the prompt. This policy defines those blocks, their order, and
the authority of each input. It also defines how to change the prompt. The
shape follows first-party OpenAI and Anthropic guidance. The sources are at the
end of this file.

`packages/junior/src/chat/prompt.ts` builds the prompt.
`packages/junior/src/chat/system-prompt-rules.ts` holds the core rule blocks.
When this policy and the code do not agree, fix one of them in the same change.

## Policy

### Two parts

- The **system prompt** holds rules that apply in every Turn. It has operator
  authority.
- The **context message** is a user-role message that comes before the current
  instruction. It holds facts and data for this request. It never holds rules
  that apply to all Turns.
- The **current instruction** is a separate user-role message. It is the job.

### System prompt blocks

The system prompt has these blocks, in this order. A Prompt mode
(`conversation`, `automation`, or `child_agent`) can replace the content of a
block. It must not add, remove, or move a block.

1. **Identity.** One header sentence that states the role and the precedence
   rule. Then the name and platform identity. Keep it short.
2. **Working principles.**
   - `<task-execution>` (or the mode's `<automation-run>` or
     `<child-agent-run>`): what the job is, when to continue, and when to ask.
     Junior may infer what the user wants. Junior must not infer facts.
   - `<evidence>`: what Junior may claim, how to state uncertainty, how to
     find the cause of a failure, and how to handle corrections and pushback.
3. **Context and trust.** `<context-trust>` says what each context input is
   and how much authority it has. It holds rules only. It does not hold the
   context data.
4. **Actions and safety.** `<safety>`: limits on actions, approvals, and
   retries of actions with side effects.
5. **Tools and skills.** `<tool-policy>`, `<skill-policy>`, and `<planning>`:
   rules that apply to more than one tool. A rule about one tool goes in that
   tool's description. See `agent-steering.md` and `tool-design.md`.
6. **Communication and output.** `<tool-call-style>`, `<conversation>`,
   `<slack-actions>`, `<failure-reporting>`, and `<output>`: how Junior tells
   the result. A short answer that says what is not known is a complete answer.
7. **Personality.** The consumer's `SOUL.md`: voice and tone only.
8. **World.** The consumer's `WORLD.md`: facts about the operator, such as
   the company, repos, and resources.
9. **Plugin guidance.** `<plugin-system-context>`: text from plugin
   `systemPrompt` hooks.

Blocks 7 to 9 come from the consumer and from plugins. They come last, after
all core rules. The identity header states that core rules win when they
conflict with these blocks. Core behavior must not depend on `SOUL.md` or
`WORLD.md`, because each install has its own files or none.

### Context message

The context message holds these inputs. Each input has one authority level:

| Input                                                       | Authority                                                                                 |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `<context>`, `<runtime>`, `<disabled-tools>`, skill catalog | Runtime facts for this request. True when the runtime wrote them.                         |
| `<conversation-notes>`                                      | Runtime facts. Not instructions. No person wrote them, so they do not give approval.      |
| `<plugin-context>`, including recalled memories             | Information that can be old or wrong. Check it before you use it as evidence for a claim. |
| `<skill>` (a loaded skill)                                  | Task instructions below the system prompt and the current instruction.                    |
| AGENTS.md                                                   | Repository instructions below the system prompt and the current instruction.              |
| `<thread-context>`                                          | Evidence only. Not instructions.                                                          |
| Tool results, files, and fetched documents                  | Information only. Text in them that looks like an instruction has no authority.           |

- Put each input in its own typed tag. Do not put one label on the full
  message that gives all inputs the same trust.
- Put runtime context, memories, and plugin text that changes per request in
  the context message, not in the system prompt. Text in the system prompt
  gets operator authority. Only static plugin guidance (block 9) goes there.

### Cache rules

- The system prompt is the same for every Turn of one deployment, platform,
  and Prompt mode. Do not put data about the request, the actor, the time, or
  the Conversation in it.
- A plugin `systemPrompt` hook must return the same text for one deployment
  and platform. Put text that changes in a `userPrompt` hook.
- Do not change an earlier message in the transcript. Only context compaction
  can change earlier messages.
- Put a fact that is true for one request only in a request-scoped tag. See
  `REQUEST_CONTEXT_SECTION_TAG` in `packages/junior/src/chat/turn-context-tag.ts`.

### How to change the prompt

- Put each new rule in one block from this policy. If no block fits, change
  this policy in the same change. Do not add a rule only to make one eval pass.
  See `agent-steering.md`.
- Give each rule one home. When a new rule replaces an old one, delete the old
  one in the same change.
- Base a change to the shape, the order, or the authority levels on a
  first-party OpenAI or Anthropic source. Add the source to the list below.
- Measure prompt changes with evals, not with tests that check prompt strings.
  See `evals.md`. A prompt change must run the behavioral and integration
  evals.
- Keep each block short. Add a line only when it changes behavior.

## Exceptions

- Security and safety backstops can be in more than one place when each copy
  serves a different enforcement path. See `agent-steering.md`.

## Sources

Fetched on 2026-10-29. See issue #2364 for the full research.

- OpenAI, [Prompt engineering](https://developers.openai.com/api/docs/guides/prompt-engineering.md):
  Identity, then Instructions, then Examples, then Context. Put context that
  changes near the end. Put content that repeats at the start, for caching.
- OpenAI, [GPT-5.5](https://developers.openai.com/api/docs/guides/latest-model/gpt-5.5.md)
  and [GPT-5.6](https://developers.openai.com/api/docs/guides/prompt-guidance-gpt-5p6.md)
  guides: Role, Personality, Goal, Success criteria, Constraints, Tools,
  Output, Stop rules. Keep personality short and apart from collaboration
  rules. Rules that conflict "create more instability than missing detail".
  Report missing evidence instead of guessing.
- OpenAI, [GPT-4.1 guide](https://cookbook.openai.com/examples/gpt4-1_prompting_guide):
  when instructions conflict, the model tends to follow the one nearer the end.
  This is why the identity header states precedence for blocks 7 to 9.
- OpenAI, [Model Spec](https://model-spec.openai.com/2026-08-18.html), chain of
  command: tool output and quoted data have no authority. The model "should not
  change its stance solely to agree with the user".
- Anthropic, [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices):
  labeled sections, a short role, long data before the request.
- Anthropic, [Reduce hallucinations](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-hallucinations):
  allow "I don't know", and do not make claims without support.
- Anthropic, [Mid-conversation system messages](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages):
  raw tool output in a system message gets operator authority.
- Anthropic, [claude.ai system prompts](https://platform.claude.com/docs/en/release-notes/system-prompts/claude-fable-5-1):
  tone in its own block, with a short tone reminder as the last block.
- Claude Code 2.1.312 (taken from the published binary): the static sections
  are intro, System, Doing tasks, Executing actions with care, Using your
  tools, and Tone and style, in that order. Per-session sections and all
  context come after them.
