# Interfaces: Access, Sandbox And Sign-In

Sketches for review, not final code. Labels follow `../design.md`.

## Delegated Access

```ts
/** What a plugin may pass. It has no binding and no signature. */
type UnboundCredentialSubject = {
  kind: "automation_creator" | "timer_creator";
  userId: string;
};

/**
 * Bound and signed by core (P17). Used only with a system actor. The HMAC
 * covers kind, scope, userId, teamId, dmChannelId and requestId.
 */
type SignedCredentialSubject = UnboundCredentialSubject & {
  scope:
    | { automationId: string }
    | { conversationId: ConversationId; watchId: string };
  teamId: string;
  /** DM-bound subjects work only in this DM. */
  dmChannelId?: string;
  /** The run this subject was bound for. Another run cannot reuse it. */
  requestId: RequestId;
  signature: string;
};

/**
 * Core only. Throws if the plugin passed a binding (as on main).
 * createRequest calls it after it mints the request id (P17).
 */
function bindSubject(
  subject: UnboundCredentialSubject,
  scope: SignedCredentialSubject["scope"],
  run: { requestId: RequestId; teamId: string; dmChannelId?: string },
): SignedCredentialSubject;
```

## Credentials For A Turn

```ts
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
 * subject, never newer input. At every turn start and resume, checks the
 * signature, the run id and that the binding still holds (P17). Throws when
 * a person actor carries a subject.
 */
function credentialsForTurn(
  turn: TurnRecord,
  conversation: Conversation,
): Promise<TurnCredentials>;
```

Title lookups do not use this. They keep today's system actor with no user
credentials (P25 retired).

## Sandbox And Sandbox Pass

The pass is in the sandbox network policy, so it applies to every process
in the VM (P36).

```ts
/** SQL, on the conversation. One sandbox per conversation (Decided). */
type SandboxRef = {
  conversationId: ConversationId;
  vmId: string;
  /** Actor and exact subject of the turn that last held a pass. */
  lastPassFor?: { actor: Actor; subject?: SignedCredentialSubject };
};

type SandboxPass = {
  passId: string;
  turnId: TurnId;
  vmId: string;
  expiresAtMs: number;
};

/**
 * At an attempt's first sandbox use. If the turn has no pass, mint one and
 * save sandboxPassId on the turn (fenced) first. If lastPassFor differs from
 * this turn's actor or subject, kill user processes. Then apply the policy
 * with the pass, expiry capped near the attempt limit. Later attempts of
 * the same turn renew the same pass.
 */
function applySandboxPass(
  lock: WorkerLock,
  turn: TurnRecord,
  sandbox: SandboxRef,
): Promise<SandboxPass>;

/**
 * finishTurn and the sign_in, post_retry and error_retry pauses call this.
 * The VM keeps its files. Requests to declared domains get no credentials.
 */
function applyNoCredentialsPolicy(sandbox: SandboxRef): Promise<void>;

/**
 * The credential proxy, before it adds credentials: the VM token matches
 * pass.vmId; the signature and expiry are good; the pass id equals the
 * sandboxPassId of the conversation's open turn in SQL, that turn is
 * running, and lockExpiresAtMs > now() (P36); a plugin declares the host.
 * Anything else fails closed. Undeclared hosts pass with no credentials
 * (Decided).
 */
function checkProxyRequest(
  request: ProxyRequest,
  pass: SandboxPass,
): Promise<ProxyDecision>;

type ProxyDecision =
  | { allow: true; credentials: "none" | { provider: string } }
  | {
      allow: false;
      status: 403;
      reason:
        | "vm_mismatch"
        | "not_current_pass"
        | "turn_not_running"
        | "lock_expired"
        | "expired"
        | "bad_signature";
    };
```

A sign-in-needed or permission-denied signal from the proxy is saved under
`pass.turnId`. Only that turn sees it.

## Sign-In

```ts
/**
 * Pause for sign-in at a safe point. Needs policy.canAskUser and a person
 * actor (P13); otherwise the turn ends blocked. Sends the private link (10
 * minutes, one use, bound to actor and turnId) and the short thread notice.
 * Applies the no-credentials policy. Its nextRunAtMs is the link expiry,
 * so the release sets wakeAtMs to it (P32).
 */
function pauseForSignIn(
  lock: WorkerLock,
  turn: TurnRecord,
  provider: string,
): Promise<TurnRecord>;

/**
 * Sign-in callback. Saves turn_authorized for (turnId, provider), raises
 * inboxSeq and sets wakeAtMs to now (P32), then notifies a worker. A
 * worker that holds the lock then sees the change before it releases.
 * Writes no history. Only work() resumes the turn.
 */
function recordSignIn(
  turnId: TurnId,
  actor: PersonActor,
  provider: string,
): Promise<void>;
```

Inside `work()`, for an open turn paused for sign-in:

| Found                                          | Action                                                               |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| the turn is under the stop (P34)               | `finishTurn(stopped: person)`                                        |
| `turn_authorized` for this turn                | resume the turn                                                      |
| new input whose actor is the same person (P13) | `finishTurn(stopped: superseded)`, then a turn for it next (Decided) |
| input from another person, or any system actor | wait (Decided)                                                       |
| `nowMs >= linkExpiresAtMs`                     | `finishTurn(stopped: sign_in_expired)` (Decided)                     |

## Examples

### E1. Same person supersedes a sign-in pause

Before: T1 for A (person), paused `sign_in` (GitHub), link expires 12:10.
Inbox `[b1 (B, 12:03)]`.

1. 12:05: A posts `a2`. `send(a2)` notifies a worker.
2. `work()` finds T1 paused and `a2` from A, a person actor equal to T1's.
   It calls `finishTurn(T1, stopped: superseded)`. The thread gets "Stopped
   waiting for GitHub sign-in."
3. T2 starts with `[a2]`, ahead of `b1` (Decided).
4. After T2: T3 for B with `[b1]`.

If A signs in after step 2, `work()` ignores the grant for T1, which is
finished. A's account stays connected.

### E2. Another person waits until the link expires

Before: T1 for A, paused `sign_in`, link expires 12:10. B posts `b1` at
12:03.

1. `send(b1)` sets `wakeAtMs` to now, so a worker runs at 12:03. Input is
   from B, so it waits. Before release, `nextRunAtMs` is the link expiry,
   so the worker sets `wakeAtMs` to 12:10 (compare-and-set on
   `inboxSeq`).
2. 12:10: a worker runs. `finishTurn(T1, stopped: sign_in_expired)`. The
   thread gets the short ending note.
3. T2 starts for B with `[b1]`.

### E3. A timer turn needs sign-in

Before: T1 runs for the system actor with A's timer subject. A tool needs
A's Linear account.

1. `pauseForSignIn` sees a system actor. No link is sent.
2. `finishTurn(T1, blocked: "needs a connected Linear account")`. The
   thread gets that reason.

### E4. Lost worker keeps the pass

Before: T1 for A, attempt 1 on W1 (v7), pass `p1` applied.

1. W1 is lost. W2 takes the lock (v8) and restarts T1.
2. `applySandboxPass` finds `sandboxPassId: p1` on T1 and the same actor.
   It renews `p1`'s expiry. No processes are killed.
3. Between W1's loss and W2's restart, T1 stayed `running`. The proxy
   allowed `p1` only while W1's lock was live (`lockExpiresAtMs > now()`),
   so W1's processes kept A's access for at most 90 s after its last
   check-in. From the expiry until W2 took the lock, the proxy refused
   `p1` (`lock_expired`).

### E5. Background process after the turn ends

Before: T1 for A left `npm run watch` running. T1 ends; `finishTurn`
applies the no-credentials policy. Later T2 for B starts.

1. Before T2: the old process calls a declared domain. The policy has no
   pass, so no credentials are added.
2. T2's first sandbox use: `lastPassFor` is A, T2 is B. The worker kills
   user processes, then applies B's pass `p2`.
3. The process is gone, so it can never send with B's pass. A's files
   stay (Decided: one sandbox per conversation). The user docs say so.

If T2 were also A's, step 2 would not kill the process. It would then run
with A's access during T2 (P36, limit).

Files stay. A git hook or `PATH` shim from T1 could run in T2 under B's
pass; B's commands run with hooks and package scripts off and a clean
`HOME` and `PATH` (P36, shared files; needs David).
