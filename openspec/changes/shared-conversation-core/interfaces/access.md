# Interfaces: Access, Sandbox And Sign-In

Sketches for review, not final code. Labels follow `../design.md`.

## Credentials For A Turn

```ts
/**
 * Delegated access, signed by the runtime (HMAC over kind, scope and user).
 * A plugin never supplies the binding. Used only with a system actor.
 */
type SignedCredentialSubject = {
  kind: "automation_creator" | "timer_creator";
  userId: string;
  /** What it is bound to: Automation id, or conversation + Watch id. */
  scope:
    | { automationId: string }
    | { conversationId: ConversationId; watchId: string };
  /** DM-bound subjects work only in this DM. */
  dmChannelId?: string;
  signature: string;
};

/**
 * What a turn may use. Built once per attempt. Tools, MCP, the sandbox pass
 * and the credential proxy read only this. Real tokens stay on the host.
 */
type TurnCredentials = {
  turnId: TurnId;
  actor: Actor;
  subject?: SignedCredentialSubject;
  /** Resolves a provider credential per call. Never cached for a user. */
  forProvider(provider: string): Promise<ProviderCredential | "sign_in_needed">;
};

/**
 * The only credential builder (rule 8). Reads the turn's own actor and
 * subject, never newer input. Checks the subject signature and binding at
 * every turn start and resume (P17). Throws when a person actor carries a
 * delegated subject, or when the binding no longer holds.
 */
function credentialsForTurn(
  turn: TurnRecord,
  conversation: Conversation,
): Promise<TurnCredentials>;
```

Today 6 turn paths, the CLI, title lookups and snapshot builds each build
credentials. After step 9 in `tasks.md`, only `credentialsForTurn` builds
them for a turn. Snapshot builds keep their own system-only path (no user
credentials, credential route removed before the setup script runs).

## Sandbox And Sandbox Pass

```ts
/** SQL, on the conversation. One sandbox per conversation (Decided). */
type SandboxRef = {
  conversationId: ConversationId;
  vmId: string;
  snapshotId?: string;
};

/**
 * Lets the conversation's sandbox use one turn's access through the
 * credential proxy. Signed. Ends with its turn (Decided).
 */
type SandboxPass = {
  passId: string;
  turnId: TurnId;
  vmId: string;
  /** The worker lock version that issued it (P5). */
  lockVersion: number;
  expiresAtMs: number;
};

/**
 * Issue a pass at the first sandbox use in an attempt. Saves sandboxPassId
 * on the turn (fenced) before the sandbox sees the pass. A new attempt after
 * a lost worker revokes the old pass first.
 */
function issueSandboxPass(
  lock: WorkerLock,
  turn: TurnRecord,
  sandbox: SandboxRef,
): Promise<SandboxPass>;

/** Mark the pass revoked in Redis. finishTurn calls it. Idempotent. */
function revokeSandboxPass(passId: string): Promise<void>;

/**
 * The credential proxy runs this before it adds credentials: VM token
 * matches pass.vmId, signature is good, pass not expired or revoked, and a
 * plugin declares the host. Undeclared hosts pass through with no
 * credentials (Decided).
 */
function checkProxyRequest(
  request: ProxyRequest,
  pass: SandboxPass,
): ProxyDecision;

type ProxyDecision =
  | { allow: true; credentials: "none" | { provider: string } }
  | {
      allow: false;
      status: 403;
      reason: "vm_mismatch" | "revoked" | "expired" | "bad_signature";
    };
```

A "sign-in needed" or "permission denied" signal from the proxy is saved
under `pass.turnId`, not under the VM. Only that turn sees it.

## Sign-In Pause

```ts
/**
 * Pause the turn for sign-in at a safe point. Needs policy.canAskUser.
 * Sends the private link (10 minutes, one use, bound to actor and turnId)
 * and the short thread notice. Sets wakeAtMs to the link expiry.
 * Without canAskUser the turn ends blocked instead.
 */
function pauseForSignIn(
  lock: WorkerLock,
  turn: TurnRecord,
  provider: string,
): Promise<TurnRecord>;

/**
 * Sign-in callback. Saves turn_authorized for (turnId, provider), then
 * notifies a worker. Writes no history. Only work() resumes the turn.
 */
function recordSignIn(
  turnId: TurnId,
  actor: PersonActor,
  provider: string,
): Promise<void>;
```

Inside `work()`, for an open turn paused for sign-in:

| Found                                  | Action                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------- |
| `turn_authorized` for this turn        | resume the turn                                                         |
| new input from the turn's own person   | `finishTurn(stopped: superseded)`, then a turn for that input (Decided) |
| input from another person, or an event | wait (Decided)                                                          |
| `nowMs >= linkExpiresAtMs`             | `finishTurn(stopped: sign_in_expired)` (Decided)                        |
| stop request                           | `finishTurn(stopped: person)`                                           |

## Examples

### E1. Same person supersedes a sign-in pause

Before: T1 for A, paused `sign_in` (GitHub), link expires 12:10. Inbox
`[b1 (B, 12:03)]`.

1. 12:05: A posts `a2`. `send(a2)` notifies a worker.
2. `work()` finds T1 paused and `a2` from A. It calls `finishTurn(T1,
stopped: superseded)`. The thread gets "Stopped waiting for GitHub
   sign-in." The pass is revoked. The link no longer resumes anything.
3. T2 starts with `[a2]` (P24: the superseding message goes next).
4. After T2: T3 for B with `[b1]`.

If A signs in after step 2: `recordSignIn` saves the grant for T1, and
`work()` ignores it because T1 is finished. A's account stays connected.

### E2. Another person waits until the link expires

Before: T1 for A, paused `sign_in`, link expires 12:10. B posts `b1` at
12:03.

1. `work()` at 12:03: input from B, so it waits. `wakeAtMs` stays 12:10.
2. 12:10: the timer job notifies a worker. `work()` calls `finishTurn(T1,
stopped: sign_in_expired)`. The thread gets the short ending note.
3. T2 starts for B with `[b1]`.

### E3. Lost worker and the sandbox pass

Before: T1 for A, attempt 1 on W1 (v7), pass `p1` (v7) in use.

1. W1 is lost. W2 takes the lock (v8) and restarts T1 (`restarts: 1`).
2. W2 calls `revokeSandboxPass(p1)` before the agent loop starts.
3. A process from attempt 1 still calls GitHub. The proxy finds `p1`
   revoked: 403. No credentials are added.
4. W2's first sandbox call issues `p2` (v8).

### E4. Background process after the turn ends

Before: T1 for A left `npm run watch` running in the sandbox. T1 ends.
`finishTurn` revokes `p1`. T2 for B starts and does not use the sandbox.

1. The old process calls a declared domain with `p1`. 403 `revoked`.
2. It calls an undeclared domain. It goes through with no credentials.
3. B's files and A's files share the sandbox (Decided: one sandbox per
   conversation). The user docs must say so.
