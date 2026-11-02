# Credentials And OAuth

Long-lived secrets never reach the model or the Sandbox. They stay in host
storage and host-applied headers.

## Authority

- Set the run Actor first, then call `credentialContextForActor(actor,
subject?)`. Do not build a parallel Actor or credential shape.
- The current Actor is the default subject. Another subject needs explicit
  delegation in the durable execution context: a system Actor and
  `credentialContext.subject`.
- Bind Slack DM delegation to the exact Destination, and scheduler delegation
  to the exact plugin and task id, before you save them.
- A delegated scheduled run stays system-acted and cannot start interactive
  OAuth.
- A timer Turn uses a timer Watch subject only when every batched Event has a
  valid binding for the same user. A resumed Turn verifies it again.
- Conversation membership grants no provider authority. Missing Actor or
  subject context fails closed.
- Issue credentials lazily for a verified operation and Sandbox context.
  Cache keys include every scope that applies.

## Service Accounts

- An Actor's own connection always wins over the service account.
- Each surface asks `serviceAccountAllows` before it uses the service account,
  and `serviceAccountOnly` before it falls back to Actor auth or asks an
  Actor to connect, where it sees the request.
- Everyone who can talk to Junior can use what the service account allows,
  so the provider account must see only what all of them may see.
- Every connect route, including the OAuth callback, requires an Admin. A
  pending sign-in finishes only for the Admin who started it.

## OAuth

- An authorization request is short-lived, single-use, and bound to the
  Actor, provider, Conversation, and continuation.
- Deliver the authorization URL privately. Public output has no reusable URL
  or token.
- Replayed, expired, mismatched, or consumed callbacks fail without changing
  Conversation authority.
- Pending MCP auth stores a new write-once attempt id before the private link
  goes out. A failed delivery restores the earlier pending auth.
- Before the callback changes a shared credential, it takes the thread lock
  and checks that its attempt still owns pending auth.
