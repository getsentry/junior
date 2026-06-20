# Memory Plugin Policy

## Metadata

- Created: 2026-06-13
- Last Edited: 2026-06-20

## Purpose

Define install-level memory policy controls, with specific attention to
workplace deployments where passive memory can create privacy, trust, and
compliance risks.

## Scope

- What must be tunable by the installing app or workspace.
- V1 passive extraction toggle and default extraction guidance.
- Default workplace extraction guidance.
- Public-memory eligibility and workplace-sensitive rejection categories.
- How policy affects tools, passive extraction, retrieval, retention, models,
  and admin output.

## Non-Goals

- Supporting install-provided extraction guidelines in V1.
- Defining legal retention, eDiscovery, or data subject export workflows.
- Creating per-jurisdiction legal compliance advice.
- Replacing the global data redaction policy.

## Policy Model

The memory plugin must evaluate an install-level policy before writing,
recalling, embedding, or displaying memory.

Policy should be resolved from explicit plugin configuration and runtime
context. The model may not change policy through prompt text or tool arguments.

V1 needs only a small required policy surface:

- passive extraction toggle
- automatic memory injection toggle

The V1 config shape is:

```ts
interface MemoryPolicy {
  passiveExtraction: boolean;
  autoInjectMemories: boolean;
}
```

Plugin enablement is controlled by the normal plugin registration path. If an
install does not want memory at all, it should not enable the memory plugin.

V1 uses the default workplace guidance in this spec. Configurable extraction
guidelines are a future extension. The deterministic validator enforces hard
rules:

- no secrets
- runtime-derived scope only
- source visibility checks
- public/shareable memory content only
- `public` conversation visibility for passive capture only in V1
- policy toggle checks
- provider allowlist checks
- no raw transcript storage
- redaction and logging restrictions

Memory policy must be loaded before hooks run and must be available to
extraction, tools, retrieval, storage, and admin code.

## Conservative Defaults

Workplace-safe defaults should be conservative:

1. `passiveExtraction` defaults to `false`.
2. If passive extraction is enabled in V1, it learns only allowed workplace
   knowledge from conversations classified as `public`.
3. `autoInjectMemories` defaults to `true` when the memory plugin is enabled.
4. Installs that do not want automatic memory injection can set
   `autoInjectMemories` to `false`, requiring the model to use
   `searchMemories` for recall.
5. Passive extraction from conversations classified as `direct`, `private`,
   `unknown`, or unsupported is out of scope for V1.
6. V1 does not store private or sensitive memory content, even in personal
   scope.
7. Third-party personal facts about coworkers should not be passively stored by
   default.
8. Retention should prefer shorter TTLs for `context`, `event`, `task`, and
   `observation` memories.
9. Default admin output should be redacted.

An install can choose whether to enable passive extraction and whether to enable
automatic memory injection, but V1 does not expose broader extraction behaviors.

## Default Workplace Guidelines

When `passiveExtraction` is `true`, the extractor should look for clean
workplace knowledge from conversations classified as `public`.

Aim to extract:

- durable project, product, repository, or operational facts
- team workflow preferences and conventions
- ownership and responsibility facts, such as who owns a project or migration
- explicit decisions, status changes, deadlines, launch windows, or deploy
  windows
- channel-level norms, such as how a public channel tracks work or incidents
- explicit "remember this" requests that are appropriate for the requested
  scope

Avoid extracting:

- casual conversation, jokes, venting, or social commentary
- summaries of a discussion that are not useful without hidden context
- temporary troubleshooting details that will not matter later
- facts whose usefulness depends on remembering the whole transcript
- personal details about coworkers
- speculative claims about people
- sensitive workplace categories listed below

The memory text should be the minimum useful assertion, not a transcript quote.
It should strip incidental names, Slack handles, timestamps, and context unless
they are needed for the memory to be correct.

Future configurable extraction guidelines may narrow or redirect what the model
looks for, such as "only remember repository conventions and product
decisions." They are not part of V1, and when added they must not override hard
validators or allow passive extraction from non-public or otherwise disallowed
sources.

## Third-Party Facts

Third-party facts are allowed in V1 only when they are operational knowledge
from a conversation classified as `public`, rather than personal claims.

Useful third-party memories include:

- `Priya owns the billing migration.`
- `Alex said the deploy freeze starts Friday, 2026-06-19.`
- `The infra team uses Linear for incident follow-up.`
- `The #frontend channel prefers PRs under 400 lines.`

Unsafe third-party memories include:

- `Bob is unreliable.`
- `David is on the billing team.` when written as personal memory by someone
  other than David
- `Sam is interviewing elsewhere.`
- `Alice is dealing with a medical issue.`
- `Dana dislikes working with Chris.`

When a memory is materially a person's claim rather than a direct public
conversation fact, preserve provenance in the content. Prefer
`Alex said the deploy freeze starts Friday` over laundering the claim into
`The deploy freeze starts Friday` unless the conversation context makes it an
accepted team fact.

### Personal Scope Authorship

Personal-scoped memories may store public/shareable first-person facts only for
the current author/requester. The author can explicitly ask Junior to remember
`I prefer terse code reviews` or `I am the release captain for Project Atlas`.
Another participant cannot create a personal memory such as `David prefers
terse code reviews` or `David is the release captain` on David's behalf.

Personal-scoped memories can also store public/shareable `general` subject
knowledge for the requester when explicitly requested, but they cannot target
another user as the subject. Third-person facts belong only in conversation
scope when they are clean operational knowledge for the current public
conversation and pass the normal third-party policy. They are not personal
memories for the named person.

## Non-Public And Sensitive Categories

V1 stores only public/shareable memory content. The extractor and explicit tool
path must reject information that requires private, sensitive, legal,
compliance, or secret handling.

The default workplace policy should reject storage of:

- health, disability, medical, or family-care details
- legal issues, immigration status, or government identifiers
- compensation, performance review, promotion, discipline, or termination
  details
- protected class, religion, politics, union activity, or similar affiliation
- financial hardship, personal relationships, or private life details
- passwords, credentials, tokens, keys, recovery codes, or secrets
- speculative claims about a coworker's intent, ability, mood, reliability, or
  character
- jokes, venting, gossip, conflict, or interpersonal commentary
- raw conversation summaries whose future usefulness depends on hidden context

Explicit user requests to remember private or sensitive personal details are
rejected in V1. Personal scope controls who can see an allowed public/shareable
memory; it does not authorize storage of non-public content.

## Passive Extraction Policy

Passive extraction must use policy as an input before model prompting and again
after structured extraction output.

The extraction prompt may describe allowed categories for quality. Policy
enforcement should happen in a separate policy adjudication step after
extraction proposes candidate facts. The deterministic validator remains the
final enforcement point for hard safety rules.

`passiveExtraction` is a boolean:

| Value   | Meaning                                                                 |
| ------- | ----------------------------------------------------------------------- |
| `false` | Do not enqueue passive extraction tasks.                                |
| `true`  | Learn allowed workplace knowledge from public conversations only in V1. |

Explicit-only memory creation is not a passive extraction setting. It is the
normal tool path: when `passiveExtraction` is `false`, the only way to write
memory is through explicit tools such as `createMemory`.

When `passiveExtraction` is `true`, policy allows passive extraction of:

- explicitly requested durable user preferences about Junior's behavior
- durable project or repository facts
- operational workflow facts
- explicit dates or deployment windows
- explicit "remember this" requests

Policy still disallows passive extraction by category, including:

- personal facts about third parties
- identity or relationship facts about third parties
- non-operational conversation summaries
- non-public or sensitive facts
- low-confidence inferences
- facts without explicit durability

For V1, passive extraction should store conversation-scoped operational
knowledge by default. Passive personal memory from public conversations requires
explicit remember language from the source user and must still be visible only
to that requester.

## Automatic Injection Policy

`autoInjectMemories` controls automatic memory reads. It is independent from
passive extraction:

| Value   | Meaning                                                                    |
| ------- | -------------------------------------------------------------------------- |
| `true`  | `userPrompt` injects relevant visible memories into model-visible prompts. |
| `false` | `userPrompt` does not inject memories; recall requires `searchMemories`.   |

When `autoInjectMemories` is `false`, the plugin may still expose memory tools
and may still perform passive extraction if `passiveExtraction` is `true`. The
model-visible recall path is explicit: the model must call `searchMemories`,
which applies the same visibility, policy, ranking, and redaction rules as
automatic memory injection.

## Explicit Tools And Policy

Explicit `createMemory` requests are still subject to install policy.

For example, passive extraction is limited to public-conversation workplace
knowledge in V1, but users may still explicitly store public/shareable personal
preferences about themselves when the requested memory passes policy.

The explicit tool path must run the same deterministic policy filter as passive
extraction. Explicit user intent can make a fact eligible for storage under
install policy, but it cannot override secret rejection, source/scope rules,
workplace-sensitive category rejection, public-content restrictions, provider
and embedding policy, or retention and lifecycle policy.

Tool errors should explain policy rejection at a high level without revealing
hidden policy internals or sensitive content.

Explicit `createMemory` may use the same policy adjudicator as passive
extraction when the policy decision is not deterministic. If adjudication fails
for an explicit tool request, the tool should return a retryable input error
rather than storing the memory.

## Retrieval And Policy

Retrieval must apply current policy as well as stored scope and lifecycle.

If policy changes after a memory was created, the stricter current policy wins
for automatic memory injection and list/search results. The memory may remain
stored but hidden until an admin repair workflow decides whether to archive it.

Policy changes must not make hidden memories visible merely because the model
asks for them.

## Model And Provider Policy

Some installs may restrict which providers can receive memory-related text.

Host provider configuration must support disabling:

- passive extraction model calls
- embedding model calls
- sending memory text to non-approved providers
- sending private conversation text to extraction models

When embeddings are disabled by policy, lexical recall remains the fallback.

## Admin Policy

Admin commands must respect policy defaults:

- redacted output by default
- explicit flags for content display
- no secret disclosure
- scope selectors required for user-visible records
- repair commands should report counts and ids before content

Policy should also let installs disable full-content admin output if they need a
stricter workplace posture.

## Related Specs

- `./index.md`
- `./security.md`
- `./extraction.md`
- `./tools.md`
- `./retrieval.md`
- `./admin.md`
- `../data-redaction-policy.md`
