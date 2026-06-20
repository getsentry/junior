# Memory Plugin Security

## Metadata

- Created: 2026-06-13
- Last Edited: 2026-06-20

## Purpose

Define the memory plugin's security boundaries for storage, retrieval, tools,
model calls, embeddings, logging, and multi-user visibility.

## Security Invariants

1. Runtime context, not model text, determines memory visibility.
2. Install-level policy determines which public/shareable categories, scopes,
   subjects, and model providers are allowed.
3. Secrets are rejected, not stored with a special classification.
4. Memory content may be model-visible only inside the stored scope and current
   policy.
5. Retrieval ranking is not an authorization boundary.
6. Embeddings and lexical indexes are derived data and cannot grant visibility.
7. Provider credentials never enter plugin storage, prompt contributions, tool
   schemas, task payloads, logs, or model-visible content.
8. Observation/task payloads use stable references and bounded safe metadata,
   not raw private transcript text.
9. Every write path uses the same policy, validation, and secret rejection
   layer.

## Authority Boundaries

The store must derive authority-bearing fields from Junior runtime context:

- requester identity
- source platform
- tenant/workspace/org boundary when available
- destination or conversation identity
- source actor
- source event or observation id

The model may request memory operations, but it cannot choose authority fields.
Tool arguments can express content, query text, limit, or expiration. They
cannot express actor ids, workspace ids, channel ids, thread ids, arbitrary
owner ids, arbitrary conversation ids, requested scope classes, or arbitrary
scope overrides for `searchMemories`.

Subject type is stored so the plugin can distinguish user, conversation, and
general knowledge. Subject keys are runtime-derived when present. Display names,
aliases, and model-extracted subject text are metadata. They are useful for
rendering and future graph work, but they are not authorization principals.

Admin CLI selectors also are not authorization by themselves. They identify the
records an operator wants to inspect or repair; deployment/operator
authorization is a separate host boundary.

## Multi-User Visibility

Personal memory is visible only to the same requester in a compatible runtime
context.

Conversation memory is visible only in the same conversation identity. V1 does
not recall conversation memory across related channels, Slack workspaces,
threads, projects, or rooms.

V1 passive extraction is limited to conversations classified as `public` by
Junior's existing conversation privacy/destination visibility contracts, and it
stores conversation-scoped workplace knowledge by default. Direct, private,
unknown, local CLI, and unsupported sources may still use explicit memory tools
when policy allows them, but they must not feed passive extraction. Visibility
classification must fail closed.

Personal-scoped `user` subject memories may be created only by the current
author/requester and must contain public/shareable first-person content. An
explicit tool request to store private, sensitive, or third-party personal
profile content must fail with a model-visible input error.

For workplace installs, passive third-party personal facts should be rejected.
Third-party operational facts from public conversations may be stored only when
they are clean workplace knowledge under [`./policy.md`](./policy.md).

## Model Boundaries

Extraction, retrieval, and tool-calling models are helpers, not security
boundaries.

The plugin must validate structured extraction output after model generation and
before storage. It must reject malformed, low-confidence, out-of-scope,
secret-like, or incoherent candidates even if the model marks them as valid.
If a second policy-adjudication model is used, its output is also guidance, not
the final security boundary.

The embedding provider receives only memory text or retrieval query text needed
for the operation. It must not receive raw provider credentials, raw Slack
payloads, raw OAuth data, or unrestricted transcripts through the plugin API.
Install policy may disable extraction or embedding providers for private
conversation text.

Embedding vectors inherit the same scope, subject, lifecycle, policy, and
provider restrictions as their source memories. They must not be logged,
reported, exported, retained, or exposed under weaker rules than memory content.

## Task Payloads

Plugin background task payloads must contain stable references and bounded safe
metadata only.

They must not contain:

- raw private user text
- raw assistant text
- raw tool payloads
- provider credentials
- authorization URLs
- OAuth tokens
- Slack tokens
- memory content unless the task exists specifically to repair a memory id that
  can be reloaded from storage

Observation-backed tasks should reload bounded observation payloads through the
core-provided observation helper.

## Logging And Reporting

Logs, spans, dashboards, and plugin operational reports may include:

- plugin name
- hook or task name
- memory operation name
- memory id or bounded id prefix
- scope type
- subject type
- memory type
- embedding provider/model/dimensions
- extraction candidate counts
- rejection reason codes
- duration
- outcome

They must not include:

- raw memory content
- raw private conversation text
- extraction prompt text
- raw model extraction output
- SQL parameter values containing user data
- provider credentials
- authorization URLs
- Slack tokens
- raw private tool arguments or results

## Related Specs

- `./index.md`
- `./policy.md`
- `./storage.md`
- `./retrieval.md`
- `./extraction.md`
- `./tools.md`
- `./admin.md`
- `../identity.md`
- `../credential-injection.md`
- `../data-redaction-policy.md`
