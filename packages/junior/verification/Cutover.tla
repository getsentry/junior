------------------------------ MODULE Cutover ------------------------------
(***************************************************************************)
(* Model 3: the cutover under a rolling deploy (P45).                      *)
(*                                                                         *)
(* One conversation. Three workers:                                        *)
(* - o1: today's worker without the reader release (tasks.md step 14). It  *)
(*   takes today's Redis lease, never reads `core` and its cursor writes   *)
(*   check nothing.                                                        *)
(* - o2: today's worker with the reader release. After it takes the lease  *)
(*   it reads `core` and refuses a new-core conversation, or moves an idle *)
(*   one back when the cutover switch is off (the rollback path).          *)
(* - n: the new core. Its SQL lock take sets `core` in the same            *)
(*   compare-and-set (P5). A take that finds today's state takes today's   *)
(*   Redis lease, waits for it, and moves the state: one SQL transaction   *)
(*   inserts the turn rows (keyed by turn id) and the inbox entries with   *)
(*   request records (unique on conversation and inbound message id) and   *)
(*   copies `inboundMessageIds`; then Redis deletes the cursors and clears *)
(*   moved `pendingMessages`.                                              *)
(*                                                                         *)
(* Input i1 has an open Redis turn cursor at start. Input i2 waits in      *)
(* `pendingMessages` at start. Input i3 is new. DELIVERIES are the Slack   *)
(* deliveries: a3 (i3) and the retries r1, r2, r3. Slack ingress with      *)
(* `core` new is one SQL insert that checks `core` in the same             *)
(* transaction. With `core` old it reads `core`, then writes Redis (the    *)
(* `inboundMessageIds` check and the append are one Redis step).          *)
(*                                                                         *)
(* A worker can crash at any step (its lease or lock stays until expiry),  *)
(* or stall so that its lease or lock expires while it still runs.        *)
(*                                                                         *)
(* DEPLOY_GATE (P45, decided): no operator switch. The gate is on while a  *)
(* new-core deployment is live and the deploy marker (every live           *)
(* deployment has the reader release) is 6.5 minutes old. A rollback is a  *)
(* revert deploy: the gate turns off, n takes no new attempt, and only     *)
(* reader-release workers (o2) take new work. The repair job sweeps        *)
(* conversations with today's state by starting n (sweepMoves). The delete *)
(* release ships only when no today's state is left (DELETE_RELEASE).      *)
(* Without DEPLOY_GATE (the drafts) an operator switch flips both ways.    *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    WITH_O1,      \* a worker without the reader release is still running
    MOVE_CHECK,   \* "first": move only on the take that sets core new;
                  \* "always": every new-core take moves leftover Redis state
    PIN_LEASE,    \* the move leaves today's lease key held for the new core
    OLD_FENCED,   \* the reader release's cursor writes check the lease token
    DEPLOY_GATE,  \* the gate: on only when o1 is gone and new-core is live
    DELETE_RELEASE, \* the delete release can ship (with DEPLOY_GATE)
    GATE,         \* when o1 counts as gone: "seen" (01e2234: no check-in for
                  \* 6.5 minutes) or "retention" (its last publish plus the
                  \* queue's maximum retention: no delivery of it is left)
    O1_QUEUED,    \* queue messages o1 published that can still come back to it
    SEEN_CHECK,   \* Slack ingress dedupe on the new core: "records" (the
                  \* request records), "both" (also reads today's Redis
                  \* inboundMessageIds) or "shared" (every path adds to it first)
    DELIVERIES,   \* subset of {"a3", "r1", "r2", "r3"}
    CRASHES,      \* worker crashes per run
    EXPIRIES,     \* lease or lock expiries of live workers per run
    FLIPS         \* per run: deploys and reverts (DEPLOY_GATE) or switch flips

Msgs == {"i1", "i2", "i3"}
DMsg == [a3 |-> "i3", r1 |-> "i1", r2 |-> "i2", r3 |-> "i3"]
OldWorkers == IF WITH_O1 THEN {"o1", "o2"} ELSE {"o2"}
Workers == OldWorkers \cup {"n"}
MovePcs == {"nlease", "minsert", "mdelete", "mclear"}

VARIABLE s
vars == s

Init ==
    s = [core |-> "old", switch |-> FALSE,  \* the operator switch (no DEPLOY_GATE)
         newLive |-> ~DEPLOY_GATE,  \* a new-core deployment is live
         deleted |-> FALSE,         \* the delete release shipped
         dropped |-> FALSE,         \* the drop release shipped (C8)
         marker |-> IF WITH_O1 THEN "none" ELSE "aged",  \* the deploy marker (DEPLOY_GATE)
         o1Queue |-> 0,             \* o1's own pending queue deliveries
         nDeployed |-> ~DEPLOY_GATE, \* a new-core deployment ever went live
         lease |-> "",          \* today's Redis lease: "", a worker, or "pin"
         sqlHolder |-> "", sqlLive |-> FALSE,
         nFresh |-> FALSE,      \* n's lock version is the current one (P5)
         pc |-> [w \in Workers |-> "idle"], turn |-> [w \in Workers |-> ""],
         cursor |-> [m \in Msgs |-> IF m = "i1" THEN "open" ELSE "none"],
         row |-> [m \in Msgs |-> "none"],
         pendingMessages |-> {"i2"},           \* pendingMessages
         inboundMessageIds |-> {"i1", "i2"},      \* today's dedupe list (state.ts:159)
         rec |-> [m \in Msgs |-> "none"],  \* request record: "none", "req", "seen"
         newInbox |-> {},
         dlv |-> [d \in DELIVERIES |-> "wait"],
         \* ghosts
         moved |-> FALSE,                 \* a move finished once
         o1Stale |-> {},                  \* inputs o1 wrote stale (see Stale)
         late |-> [d \in DELIVERIES |-> FALSE],  \* the delivery came after a move
         starts |-> [m \in Msgs |-> IF m = "i1" THEN 1 ELSE 0],
         accepted |-> [m \in Msgs |-> IF m = "i3" THEN 0 ELSE 1],
         oldFin |-> [m \in Msgs |-> 0], newFin |-> [m \in Msgs |-> 0],
         inserts |-> [m \in Msgs |-> 0], entries |-> [m \in Msgs |-> 0],
         crashes |-> CRASHES, expiries |-> EXPIRIES, flips |-> FLIPS, ex |-> {}]

\* Ghost counts stop at 2: the checks only ask "at most 1", and a stale
\* o1 can reopen a finished cursor again and again.
Bump(n) == IF n < 2 THEN n + 1 ELSE n

Go(st, w, p) == [st EXCEPT !.pc[w] = p]
Stop(st, w) == [st EXCEPT !.pc[w] = "idle", !.turn[w] = ""]
Flag(st, f) == [st EXCEPT !.ex = @ \cup {f}]

(***************************************************************************)
(* Environment                                                             *)
(***************************************************************************)
\* The cutover is on. DEPLOY_GATE: no operator, only deploys move it.
SwitchOn == IF DEPLOY_GATE THEN s.marker = "aged" /\ s.newLive ELSE s.switch

\* The drafts: an operator flips the switch.
Flip == ~DEPLOY_GATE /\ s.flips > 0 /\ s' = [s EXCEPT !.switch = ~@, !.flips = @ - 1]

\* CI/CD deploys the new core, or a revert deploy rolls it back. After a
\* revert, n takes no new attempt; an attempt in flight goes on. After the
\* delete release there is no rollback (fix forward only).
Deploy ==
    /\ DEPLOY_GATE /\ s.flips > 0 /\ ~s.deleted
    /\ s' = [s EXCEPT !.newLive = ~@, !.nDeployed = TRUE, !.flips = @ - 1]

\* Vercel push mode partitions a queue topic by deployment id: a message
\* goes back to the deployment that published it, also after a promotion
\* or a rollback, until it is acked or expires (24 h by default, up to 7
\* days). o1 publishes while it is current or has an attempt in flight
\* (a notify after release, the busy defer). Each pending delivery can
\* start an o1 attempt at any later time, after any quiet gap.
O1Publish ==
    /\ WITH_O1 /\ s.o1Queue < O1_QUEUED
    /\ s.marker = "none" \/ s.pc["o1"] # "idle"
    /\ s' = [s EXCEPT !.o1Queue = @ + 1]

\* A pending o1 delivery expires (its retention ends).
O1Expire == s.o1Queue > 0 /\ s' = [s EXCEPT !.o1Queue = @ - 1]



\* The deploy job promotes the reader release: o1's deployment takes no new
\* requests, and the job writes the marker. o1 attempts in flight go on.
Mark == WITH_O1 /\ s.marker = "none" /\ s' = [s EXCEPT !.marker = "set"]

\* The 5-minute attempt limit ends an o1 attempt in flight.
AttemptLimit == s.marker = "set" /\ s.pc["o1"] # "idle" /\ s' = Stop(s, "o1")

\* o1 counts as gone. "seen": 6.5 minutes with no check-in (the attempt
\* limit plus the 90 s lease): no attempt and no lease left, but its
\* pending deliveries stay. "retention": also its last publish is older
\* than the queue's maximum retention, so every delivery of it expired.
MarkerAges ==
    /\ s.marker = "set" /\ s.pc["o1"] = "idle"
    /\ s' = [s EXCEPT !.marker = "aged", !.lease = IF @ = "o1" THEN "" ELSE @,
                      !.o1Queue = IF GATE = "retention" THEN 0 ELSE @]

Crash(w) ==
    /\ s.pc[w] # "idle" /\ s.crashes > 0
    /\ s' = [Stop(s, w) EXCEPT !.crashes = @ - 1]

\* A dead holder's lease or lock expires.
ExpireDead ==
    \/ /\ s.lease \in Workers /\ s.pc[s.lease] = "idle" /\ s' = [s EXCEPT !.lease = ""]
    \/ /\ s.sqlHolder = "n" /\ s.sqlLive /\ s.pc["n"] = "idle" /\ s' = [s EXCEPT !.sqlLive = FALSE]

\* A live worker stalls past the TTL. It keeps running.
Stall(w) ==
    /\ s.pc[w] # "idle" /\ s.expiries > 0
    /\ \/ s.lease = w /\ s' = [s EXCEPT !.lease = "", !.expiries = @ - 1]
       \/ /\ w = "n" /\ s.sqlHolder = "n" /\ s.sqlLive
          /\ s' = [s EXCEPT !.sqlLive = FALSE, !.expiries = @ - 1]

\* Ghost: count the acceptance. A Slack retry that came after a move and
\* is accepted again is the duplicate that retryAfterMoveIsDuplicate forbids.
Accept(st, d) ==
    LET m == DMsg[d]
    IN [st EXCEPT !.accepted[m] = @ + 1,
                  !.ex = IF st.late[d] /\ st.accepted[m] > 0 THEN @ \cup {"retryAcceptedAfterMove"} ELSE @]

\* Slack ingress. SEEN_CHECK "shared": every path first adds the id to
\* today's `inboundMessageIds` (one atomic add); only the add that wins goes on.
Claimed == IF SEEN_CHECK = "shared" THEN "claimed" ELSE "wait"
DeliverOk(d) == d = "r3" => s.dlv["a3"] # "wait"

DeliverClaim(d) ==
    LET m == DMsg[d]
    IN /\ SEEN_CHECK = "shared" /\ s.dlv[d] = "wait" /\ DeliverOk(d)
       /\ s' = IF m \in s.inboundMessageIds
               THEN Flag([s EXCEPT !.dlv[d] = "done"], "retryRefused")
               ELSE [s EXCEPT !.dlv[d] = "claimed", !.inboundMessageIds = @ \cup {m}, !.late[d] = s.moved]

\* New core: one SQL insert, unique on the inbound message id, that checks
\* `core` in the same transaction. "both": it also reads inboundMessageIds.
DeliverNew(d) ==
    LET m == DMsg[d]
        dup == s.rec[m] # "none" \/ (SEEN_CHECK = "both" /\ m \in s.inboundMessageIds)
    IN /\ s.dlv[d] = Claimed /\ DeliverOk(d) /\ s.core = "new"
       /\ s' = IF dup
               THEN Flag([s EXCEPT !.dlv[d] = "done"], "retryRefused")
               ELSE Accept([s EXCEPT !.dlv[d] = "done", !.rec[m] = "req", !.newInbox = @ \cup {m},
                                     !.late[d] = IF SEEN_CHECK = "shared" THEN @ ELSE s.moved], d)

\* Today's path: read `core` (old), then write Redis (dedupe check and
\* append in one step; with "shared" the add came first).
DeliverOldRead(d) ==
    /\ ~s.deleted /\ s.dlv[d] = Claimed /\ DeliverOk(d) /\ s.core = "old"
    /\ s' = [s EXCEPT !.dlv[d] = "oldRead",
                      !.late[d] = IF SEEN_CHECK = "shared" THEN @ ELSE s.moved]

DeliverOldWrite(d) ==
    LET m == DMsg[d]
    IN /\ s.dlv[d] = "oldRead"
       /\ s' = IF SEEN_CHECK # "shared" /\ m \in s.inboundMessageIds
               THEN Flag([s EXCEPT !.dlv[d] = "done"], "retryRefused")
               ELSE Accept([s EXCEPT !.dlv[d] = "done", !.inboundMessageIds = @ \cup {m},
                                     !.pendingMessages = @ \cup {m},
                                     !.ex = IF s.core = "new" THEN @ \cup {"oldWriteAfterMove"} ELSE @], d)

(***************************************************************************)
(* Today's workers (o1, o2)                                                *)
(***************************************************************************)
\* No open turn and no inbox entry on the new core (P45 rollback).
IdleOnNew(st) == (\A m \in Msgs : st.row[m] # "open") /\ st.newInbox = {}

\* A move back is a SQL lock take: it needs a free lock, raises the version
\* and sets core old.
MoveBack(st) ==
    [st EXCEPT !.core = "old", !.nFresh = FALSE, !.sqlHolder = "", !.sqlLive = FALSE,
               !.ex = @ \cup {"movedBack"}]
CanMoveBack == ~SwitchOn /\ IdleOnNew(s) /\ ~(s.sqlHolder = "n" /\ s.sqlLive)

\* o1's deployment takes no new request once the marker is written, but it
\* still gets its own pending deliveries. No today's worker takes new work
\* after the delete release.
OStarts(w) == (w = "o1" => s.marker = "none" \/ s.o1Queue > 0) /\ ~s.deleted

\* An o1 attempt from a pending delivery uses it up and checks in, so o1
\* is live again ("seen" counts from here).
OTake(w) ==
    /\ OStarts(w) /\ s.pc[w] = "idle" /\ s.lease = ""
    /\ s' = Go([s EXCEPT !.lease = w,
                         !.o1Queue = IF w = "o1" /\ s.marker # "none" THEN @ - 1 ELSE @,
                         !.marker = IF w = "o1" /\ @ = "aged" THEN "set" ELSE @], w, "leased")

\* o1 does not read core. o2 reads it with the lease held.
OCheck(w) ==
    /\ s.pc[w] = "leased"
    /\ s' = IF w = "o1" \/ s.core = "old" THEN Go(s, w, "oready")
            ELSE IF CanMoveBack THEN Go(MoveBack(s), w, "oready")
            ELSE Flag(Go([s EXCEPT !.lease = IF @ = w THEN "" ELSE @], w, "idle"), "refused")

\* PIN_LEASE: o2 finds the pin and reads core without taking the lease. A
\* pin on an old-core conversation is left by a move back that crashed
\* before it cleared the pin. Moving back replaces the pin with o2's lease.
OPin(w) ==
    /\ PIN_LEASE /\ w = "o2" /\ OStarts(w) /\ s.pc[w] = "idle" /\ s.lease = "pin"
    /\ s' = IF s.core = "old" THEN Go([s EXCEPT !.lease = w], w, "oready")
            ELSE IF CanMoveBack THEN Go([MoveBack(s) EXCEPT !.lease = w], w, "oready")
            ELSE Flag(s, "refused")

\* A cursor write. The reader release with OLD_FENCED checks the lease
\* token first. o1 has no reader release, so it checks nothing.
OldOk(w) == w = "o1" \/ ~OLD_FENCED \/ s.lease = w

\* Ghost: o1 wrote the cursor of input m after its lease expired, on an
\* old-core conversation. That is today's behavior (o1 has no fence), not
\* the cutover's: today's path runs that turn twice too. The duplicate
\* checks skip m (only m).
Stale(st, w, m) ==
    IF w = "o1" /\ s.lease # w /\ s.core = "old" THEN [st EXCEPT !.o1Stale = @ \cup {m}] ELSE st

OReady(w) ==
    /\ s.pc[w] = "oready"
    /\ s' = IF \E m \in Msgs : s.cursor[m] = "open"
            THEN LET m == CHOOSE x \in Msgs : s.cursor[x] = "open"
                 IN Go([s EXCEPT !.turn[w] = m], w, "orun")
            ELSE IF s.pendingMessages # {}
            THEN LET m == CHOOSE x \in s.pendingMessages : TRUE
                 IN IF OldOk(w)
                    THEN Go(Stale([s EXCEPT !.cursor[m] = "open", !.pendingMessages = @ \ {m},
                                            !.starts[m] = Bump(@), !.turn[w] = m], w, m), w, "orun")
                    ELSE Stop(s, w)
            ELSE Go(s, w, "orel")

\* A checkpoint save: rewrites the cursor as open.
OSave(w) ==
    /\ s.pc[w] = "orun"
    /\ s' = IF OldOk(w)
            THEN LET m == s.turn[w]
                 IN Stale([s EXCEPT !.cursor[m] = "open"], w, m)
            ELSE Stop(s, w)

OFinish(w) ==
    /\ s.pc[w] = "orun"
    /\ s' = IF OldOk(w)
            THEN Go(Stale([s EXCEPT !.cursor[s.turn[w]] = "done", !.oldFin[s.turn[w]] = Bump(@)], w, s.turn[w]),
                    w, "oready")
            ELSE Stop(s, w)

ORel(w) ==
    /\ s.pc[w] = "orel"
    /\ s' = Stop([s EXCEPT !.lease = IF @ = w THEN "" ELSE @], w)

(***************************************************************************)
(* The new core (n)                                                        *)
(***************************************************************************)
\* Today's state to move. With PIN_LEASE a missing pin counts: a take that
\* set core and crashed before the pin left today's lease to an old worker.
LeftoverRedis(st) ==
    \/ \E m \in Msgs : st.cursor[m] = "open"
    \/ st.pendingMessages # {}
    \/ PIN_LEASE /\ st.lease # "pin"

\* Today's state of the conversation: an old-core owner or state the move
\* would move (with PIN_LEASE a missing pin counts: a today's worker may
\* still hold the lease). inboundMessageIds is only the dedupe list.
OldState(st) == st.core = "old" \/ LeftoverRedis(st)

\* The delete release ships only when no conversation has today's state.
\* From then on no worker takes today's lease and no ingress reads core;
\* requests in flight on earlier deployments go on. The move and the
\* repair job sweep stay in it.
DeleteRelease ==
    /\ DEPLOY_GATE /\ DELETE_RELEASE /\ ~s.deleted /\ SwitchOn /\ ~OldState(s)
    /\ s' = [s EXCEPT !.deleted = TRUE]

\* Proposed fix (FINDINGS.md C8): the release that drops the move and
\* today's Redis state ships only when the delete release's marker is 6.5
\* minutes old (no request of an earlier deployment is in flight: no
\* ingress between its core read and its Redis write, no o2 attempt) and
\* again no conversation has today's state.
DropRelease ==
    /\ s.deleted /\ ~s.dropped /\ ~OldState(s)
    /\ \A d \in DELIVERIES : s.dlv[d] # "oldRead"
    /\ \A w \in OldWorkers : s.pc[w] = "idle"
    /\ s' = [s EXCEPT !.dropped = TRUE]

\* acquireWorkerLock: one SQL compare-and-set takes the lock, raises the
\* version and sets core. With the switch off it does not take an old-core
\* conversation (today's path runs it).
NTake ==
    /\ s.pc["n"] = "idle" /\ (s.sqlHolder = "" \/ ~s.sqlLive)
    /\ s.nDeployed  \* after a revert, its own pending deliveries still come
    /\ s.core = "new" \/ SwitchOn
    /\ s' = Go([s EXCEPT !.sqlHolder = "n", !.sqlLive = TRUE, !.nFresh = TRUE, !.core = "new"],
               "n", IF s.core = "old" \/ (MOVE_CHECK = "always" /\ LeftoverRedis(s))
                    THEN "nlease" ELSE "nready")

\* Take today's lease: wait while an old worker holds it. With PIN_LEASE
\* the take writes the pin (no expiry) at once.
NLease ==
    /\ s.pc["n"] = "nlease"
    /\ s.lease = "" \/ (PIN_LEASE /\ s.lease = "pin")
    /\ s' = Go([s EXCEPT !.lease = IF PIN_LEASE THEN "pin" ELSE "n"], "n", "minsert")

NOk(st) == st.nFresh /\ st.sqlHolder = "n" /\ st.sqlLive

\* The move, part 1: one SQL transaction (fenced). A turn row per open
\* cursor (keyed by turn id), an inbox entry and request record per
\* `pendingMessages` input (unique on the inbound message id), and a
\* "seen" record per other id in inboundMessageIds.
NMoveInsert ==
    LET newRows == {m \in Msgs : s.cursor[m] = "open" /\ s.row[m] = "none"}
        newEntries == {m \in s.pendingMessages : s.rec[m] \in {"none", "seen"}}
        newSeen == {m \in s.inboundMessageIds \ s.pendingMessages : s.rec[m] = "none"}
        repeat == (\E m \in Msgs : s.cursor[m] = "open" /\ s.row[m] # "none")
                  \/ (\E m \in s.pendingMessages : s.rec[m] = "req")
    IN /\ s.pc["n"] = "minsert"
       /\ s' = IF NOk(s)
               THEN Go([s EXCEPT
                   !.row = [m \in Msgs |-> IF m \in newRows THEN "open" ELSE @[m]],
                   !.inserts = [m \in Msgs |-> IF m \in newRows THEN @[m] + 1 ELSE @[m]],
                   !.rec = [m \in Msgs |-> IF m \in newEntries THEN "req"
                                            ELSE IF m \in newSeen THEN "seen" ELSE @[m]],
                   !.newInbox = @ \cup newEntries,
                   !.entries = [m \in Msgs |-> IF m \in newEntries THEN @[m] + 1 ELSE @[m]],
                   !.ex = IF repeat THEN @ \cup {"moveRepeated"} ELSE @], "n", "mdelete")
               ELSE Stop(s, "n")

\* The move, part 2 (Redis): delete each cursor that has a row.
NMoveDelete ==
    /\ s.pc["n"] = "mdelete"
    /\ s' = Go([s EXCEPT !.cursor = [m \in Msgs |-> IF @[m] = "open" /\ s.row[m] # "none"
                                                  THEN "none" ELSE @[m]]], "n", "mclear")

\* The move, part 3 (Redis): remove each `pendingMessages` input that has a
\* request record. Then give the lease back (with PIN_LEASE the pin stays).
NMoveClear ==
    /\ s.pc["n"] = "mclear"
    /\ s' = Go([s EXCEPT !.pendingMessages = {m \in @ : s.rec[m] # "req"}, !.moved = TRUE,
                         !.lease = IF @ = "n" THEN "" ELSE @], "n", "nready")

NReady ==
    /\ s.pc["n"] = "nready"
    /\ s' = IF \E m \in Msgs : s.row[m] = "open"
            THEN LET m == CHOOSE x \in Msgs : s.row[x] = "open"
                 IN Go([s EXCEPT !.turn["n"] = m], "n", "nrun")
            ELSE IF s.newInbox # {}
            THEN LET m == CHOOSE x \in s.newInbox : TRUE
                 IN IF NOk(s)
                    THEN Go([s EXCEPT !.row[m] = "open", !.newInbox = @ \ {m},
                                      !.starts[m] = Bump(@), !.turn["n"] = m], "n", "nrun")
                    ELSE Stop(s, "n")
            ELSE Go(s, "n", "nrel")

NFinish ==
    /\ s.pc["n"] = "nrun"
    /\ s' = IF NOk(s)
            THEN Go([s EXCEPT !.row[s.turn["n"]] = "done", !.newFin[s.turn["n"]] = Bump(@)], "n", "nready")
            ELSE Stop(s, "n")

NRel ==
    /\ s.pc["n"] = "nrel"
    /\ s' = Stop([s EXCEPT !.sqlHolder = IF NOk(s) THEN "" ELSE @], "n")

(***************************************************************************)
Old(w) == OTake(w) \/ OPin(w) \/ OCheck(w) \/ OReady(w) \/ OSave(w) \/ OFinish(w) \/ ORel(w)
New == NTake \/ NLease \/ NMoveInsert \/ NMoveDelete \/ NMoveClear \/ NReady \/ NFinish \/ NRel
Ingress == \E d \in DELIVERIES : DeliverClaim(d) \/ DeliverNew(d) \/ DeliverOldRead(d) \/ DeliverOldWrite(d)

Next ==
    \/ \E w \in OldWorkers : Old(w)
    \/ New \/ Ingress
    \/ Flip \/ Deploy \/ DeleteRelease \/ DropRelease \/ ExpireDead \/ Mark \/ O1Publish \/ O1Expire \/ (WITH_O1 /\ (AttemptLimit \/ MarkerAges))
    \/ \E w \in Workers : Crash(w) \/ Stall(w)

Spec == Init /\ [][Next]_vars

\* For sweepMoves: fairness for the repair job only, and for time. The
\* repair job starts n on a conversation with today's state: weak fairness
\* for n's steps, strong for its wait on today's lease (o2 can take the
\* lease back again and again). Time: a dead holder's lease expires, and
\* o2's attempt ends (the 5-minute attempt limit). None for Slack, deploys
\* or o2 taking new work.
SpecFairSweep ==
    Spec /\ WF_vars(New) /\ SF_vars(NLease) /\ WF_vars(ExpireDead)
         /\ WF_vars(OCheck("o2") \/ OReady("o2") \/ OSave("o2") \/ OFinish("o2") \/ ORel("o2"))

(***************************************************************************)
(* Safety                                                                  *)
(***************************************************************************)
OldRuns(w) == s.pc[w] = "orun"
NewRuns == s.pc["n"] = "nrun"

\* No conversation runs on both cores at once (stalled workers included).
oneCore == ~((\E w \in OldWorkers : OldRuns(w)) /\ NewRuns)

\* The same, counting only workers whose lease or lock is still live and
\* current. A stalled worker's window is P5 "Limit".
oneCoreLive == ~((\E w \in OldWorkers : OldRuns(w) /\ s.lease = w) /\ NewRuns /\ NOk(s))

\* No input runs in two turns, and no turn finishes on both cores. An
\* input that o1 wrote stale is not counted (see Stale).
noCrossCoreDuplicate ==
    \A m \in Msgs \ s.o1Stale : s.starts[m] <= 1 /\ ~(s.oldFin[m] > 0 /\ s.newFin[m] > 0)

\* A turn finishes at most once. Two of today's workers can break this
\* without the cutover (a stalled worker, no fence), so it is not in safety.
\* An input that o1 wrote stale is not counted.
noDuplicateTurn ==
    \A m \in Msgs \ s.o1Stale : s.starts[m] <= 1 /\ s.oldFin[m] + s.newFin[m] <= 1

\* An open turn is never lost: until it finishes, its cursor or its row is
\* open, or a worker runs it.
noLostTurn ==
    \A m \in Msgs :
        (s.starts[m] > 0 /\ s.oldFin[m] + s.newFin[m] = 0)
            => (s.cursor[m] = "open" \/ s.row[m] = "open" \/ \E w \in Workers : s.turn[w] = m)

\* Accepted input that no turn took is in one of the two inboxes.
noLostInput ==
    \A m \in Msgs : (s.accepted[m] > 0 /\ s.starts[m] = 0) => m \in s.pendingMessages \cup s.newInbox

\* A Slack retry that comes after a move is a duplicate.
retryAfterMoveIsDuplicate == "retryAcceptedAfterMove" \notin s.ex

\* Stronger: no input is accepted twice, also when a retry races the move.
\* A second acceptance is harmless when the move dedupes it.
acceptedOnce == \A m \in Msgs : s.accepted[m] <= 1

\* Today's state that the new core owns is moved later: o2 refuses it,
\* and with "first" no later take moves it.
noStrandedCursor ==
    \A m \in Msgs :
        (s.cursor[m] = "open" /\ s.core = "new" /\ s.row[m] = "none")
            => (MOVE_CHECK = "always" \/ s.pc["n"] \in MovePcs)

\* The move is idempotent: each turn row and each inbox entry is inserted
\* at most once.
moveIdempotent == \A m \in Msgs : s.inserts[m] <= 1 /\ s.entries[m] <= 1

\* DEPLOY_GATE: while the switch is on, o1 is gone, so it cannot take the
\* lease or keep running.
gateHolds == DEPLOY_GATE => (SwitchOn => s.pc["o1"] = "idle")

\* DELETE_RELEASE: after the delete release, no conversation has today's
\* state (nothing is left for a path that no longer exists).
noOldStateAfterDelete == s.deleted => ~OldState(s)

\* C8: after the drop release, no conversation has today's state.
noOldStateAfterDrop == s.dropped => ~OldState(s)

safety ==
    /\ oneCoreLive /\ noCrossCoreDuplicate /\ noLostTurn /\ noLostInput /\ retryAfterMoveIsDuplicate
    /\ noStrandedCursor /\ moveIdempotent /\ noOldStateAfterDrop /\ (WITH_O1 => gateHolds)

\* The repair job sweep: while the gate is on, each conversation with
\* today's state is eventually moved. Run with SpecFairSweep.
sweepMoves == [](SwitchOn /\ OldState(s) => <>(~SwitchOn \/ ~OldState(s)))

\* Worked examples: each must be reachable.
ex_dropped == ~s.dropped
ex_revertedAfterMove == ~(s.moved /\ ~s.newLive /\ s.marker = "aged")
ex_movedBack == "movedBack" \notin s.ex
ex_moveRepeatedAfterCrash == "moveRepeated" \notin s.ex
ex_movedThenFinishedOnNew == ~(s.row["i1"] = "done" /\ s.cursor["i1"] = "none")
ex_refusedByReader == "refused" \notin s.ex
ex_inboxMovedThenRunOnNew == ~(s.newFin["i2"] = 1 /\ s.pendingMessages = {})
ex_retryRefused == "retryRefused" \notin s.ex
ex_oldWriteAfterMove == "oldWriteAfterMove" \notin s.ex

=============================================================================
