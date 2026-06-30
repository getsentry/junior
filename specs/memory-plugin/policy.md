# Memory Plugin Policy

## Metadata

- Created: 2026-06-13
- Last Edited: 2026-06-28

## Purpose

Define V1 memory policy guidance, with specific attention to workplace
deployments where passive memory can create privacy, trust, and compliance
risks.

## Scope

- Current V1 default extraction guidance.
- Future install-level policy controls for the installing app or workspace.
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

Plugin enablement is controlled by the normal plugin registration path. If an
install does not want memory at all, it should not enable the memory plugin.

V1 uses the default workplace guidance in this spec. Configurable install-level
policy and extraction guidelines are future extensions. The memory agent owns
semantic memory decisions, including public/shareable eligibility and
workplace-sensitive rejection. Deterministic code enforces structural hard
rules:

- runtime-derived scope only
- no raw transcript storage
- redaction and logging restrictions

The model may not change memory policy through prompt text or tool arguments.

## Conservative Defaults

Workplace-safe defaults should be conservative:

1. Automatic memory injection is enabled when the memory plugin is enabled.
2. Passive extraction is enabled when the memory plugin is enabled.
3. V1 does not store private or sensitive memory content, even in personal
   scope.
4. Third-party personal facts about coworkers should not be passively stored by
   default.
5. Retention should use explicit expiration timestamps for memories that should
   decay; V1 does not infer default TTLs from kind.
6. Default admin output should be redacted.

An install chooses whether to enable memory through plugin registration. V1 does
not expose broader extraction behaviors.

## Default Workplace Guidelines

When the memory plugin is enabled, the passive extractor should look for clean
public/shareable knowledge from supported runtime contexts.

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
It should strip incidental names, Slack handles, timestamps, perspective, and
source context unless they are needed for the memory to be correct. For
personal memories, the tool or extractor may receive first-person candidate
text such as `I prefer terse code reviews`, but the stored content should be
canonical text such as `Prefers terse code reviews`.

Future configurable extraction guidelines may narrow or redirect what the model
looks for, such as "only remember repository conventions and product
decisions." They are not part of V1, and when added they must not override hard
validators or public/shareable-content rules.

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

Stored personal content must not include the author's display name, `the
requester`, `the user`, `I`, or `my`. Ownership lives in the personal scope and
user subject fields. Content should be rendered with user-relative perspective
only when recalled.

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

Passive extraction must use this policy guidance in the memory agent prompt and
again when validating structured extraction output.

The extraction prompt may describe allowed categories for quality. Policy
enforcement should happen through memory agent review after extraction proposes
candidate facts. Deterministic validation remains the final
enforcement point for structural rules such as runtime-derived authority,
strict schemas, source visibility, provider allowlists, and lifecycle bounds.

Policy allows passive extraction of:

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
clear first-person source evidence from the user and must still be visible only
to that requester. Explicit memory-management tool calls suppress passive
extraction for the same completed session so the tool path owns its effect.

## Automatic Injection Policy

Automatic memory injection is enabled when the memory plugin is enabled.

`memory_searchMemories` remains the explicit model-visible recall path. It
applies the same visibility, policy, ranking, and redaction rules as automatic
memory injection.

## Explicit Tools And Policy

Explicit memory creation requests are still subject to memory policy guidance.

Users may explicitly store public/shareable personal preferences about
themselves when the requested memory passes policy. This includes ordinary
technical and workplace preferences or opinions, such as language, tool,
repository, product, communication, and workflow preferences, when they are
authored by the current requester and do not include private or sensitive
content.

The explicit tool path must use the same agentic policy guidance as passive
extraction. Explicit user intent can make a fact eligible for storage under
memory policy, but it cannot override secret rejection, source/scope rules,
workplace-sensitive category rejection, public-content restrictions, provider
and embedding policy, or retention and lifecycle policy.

Tool errors should explain policy rejection at a high level without revealing
hidden policy internals or sensitive content.

Explicit memory creation must use the memory agent's explicit-create review
when the policy decision is not deterministic. If review fails for an explicit
tool request, the tool should return a retryable input error rather than
storing the memory.

## Retrieval And Policy

Retrieval must apply default V1 policy guidance as well as stored scope and
lifecycle.

If policy changes after a memory was created, the stricter current policy wins
for automatic memory injection and list/search results. The memory may remain
stored but hidden until an admin repair workflow decides whether to archive it.

Policy changes must not make hidden memories visible merely because the model
asks for them.

## Model And Provider Policy

Future install policy may restrict which providers can receive memory-related
text.

Host provider configuration should support disabling or narrowing:

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
