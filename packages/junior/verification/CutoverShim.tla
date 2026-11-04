---------------------------- MODULE CutoverShim ----------------------------
(***************************************************************************)
(* Model 5: the P45 shim (plan 5356776). One conversation.                 *)
(*                                                                         *)
(* Safety comes only from the stale lease fence and the pin.               *)
(* - Time. Each today's lease take gets the next epoch: its acquiredAtMs.  *)
(*   `fence` is the last epoch k for which acquiredAt(k) + maxDuration +   *)
(*   60 s has passed. An invocation records `born`, the last epoch taken   *)
(*   before it started. Vercel ends it at maxDuration, so once the fence   *)
(*   passes epoch born + 1 it has ended (Tick). Its own take, if any, has  *)
(*   an epoch after born.                                                  *)
(* - Mixed maxDuration. Workers in LONG run on a deployment with a longer  *)
(*   maxDuration, up to the 1,800 s ceiling; `fenceL` is the fence for     *)
(*   that value (TickL). D(lease) (FenceCls): the running max `mdMax`,     *)
(*   which a deployment raises before its first take; the ceiling for a    *)
(*   lease from before step 3 (no deploymentId). MDFENCE "current" uses    *)
(*   the current deployment's value, "noCeiling" the running max for both. *)
(* - Tombstone. From step 3, the heartbeat clear of an expired lease and a *)
(*   take over an expired lease first save staleLeaseAcquiredAtMs (`tomb`) *)
(*   and staleLeaseMaxDurationSeconds (`tombCls`), each the larger value.  *)
(*   A worker from before step 3 (LEGACY) saves nothing. With GAP it takes *)
(*   over expired leases (the plan's give-up); without GAP it takes only   *)
(*   an absent lease.                                                      *)
(* - The fence. The move pins an expired lease only when its fence and the *)
(*   tombstone's have passed, and with no lease when the tombstone's and,  *)
(*   after a cron gap, freshSinceAtMs + 1,860 s (`freshEp`) have passed.   *)
(*   It reads the lease, then the tombstone, and writes the pin in one     *)
(*   conversation mutation (EARLYTOMB: tombstone first, C11). No version   *)
(*   takes a pinned lease.                                                 *)
(* - Today's workers have no cursor-write lease check (no C3). Step 3 on   *)
(*   they refuse core = new (the reader); LEGACY has no reader. They can   *)
(*   start at any time: a deployment keeps its own queue deliveries until  *)
(*   they expire, and a busy-defer chain extends them. A worker can        *)
(*   release with work left (a continuation).                              *)
(* - Per-turn lock. The move holds withTurnCursorMutation for each turn it *)
(*   moves. abandonTurnRecord (worker a, no lease) takes that lock, writes *)
(*   only the end status and does nothing when the cursor is gone. ENDROW: *)
(*   a repeated move gives the open row of an ended cursor the same end.   *)
(* - Stop. Today's stop() saves the stop key in Redis with the inputs it   *)
(*   covers; the new core judges inputs by stopAtMs (`stopAt`: the inputs  *)
(*   received before it). STOPMOVE: the move carries the key into stopAt.  *)
(* - Agent invocation row (`inv`, I15). The move moves a row only when it  *)
(*   has the creating parent turn and record and its actor matches them    *)
(*   (kind ok); it closes every other row `failed`. MOVEACTOR "copy": it   *)
(*   trusts the actor the row stored (bug 12). The parent's actor is A.    *)
(* - Production `cur`: new (has new_core), rev (a revert to a release from *)
(*   step 3) or pre (an Instant Rollback to a release from before step 3). *)
(*   The cron of new and rev upserts the current row `curRow`; pre's cron  *)
(*   does not, and its heartbeat clear saves no tombstone. `rowAge` counts *)
(*   pre's cron runs. STALEROW: a row 3 runs (3 min) old is current for no *)
(*   deployment. FRESH: when new's cron upserts again, it sets             *)
(*   freshSinceAtMs if the row was stale ("stale", the plan) or missed any *)
(*   run ("any"). While pre is current, its ingress adds the LATE inputs   *)
(*   to today's waiting input; today's ingress does so while core = old.   *)
(* - n is the new core's work() on deployment `dep`. Not current: it takes *)
(*   no lock. A take on new moves when it finds today's state or no pin    *)
(*   (each take pins). On rev it runs work() on a core = new               *)
(*   conversation, then moves it back. FINISHBACK (C10): the move back     *)
(*   deletes what a crashed move left in Redis before it sets core old;    *)
(*   CLEANFIRST (C12): before work() too. REVFENCE (C14): a take on rev    *)
(*   with no pin first passes the fence and pins, as on new.               *)
(* - Pin expiry. The pin is a field of today's conversation record, which  *)
(*   expires after 7 idle days. REFRESH: while new is current, the sweep   *)
(*   refreshes it daily. 7 days are more than 3 cron runs.                 *)
(*                                                                         *)
(* Input i1 has an open cursor at start (its worker died). Input i2 waits  *)
(* in pendingMessages.                                                     *)
(* INGRESS: Slack delivers a3 (new input i3) and the retries r1, r2, r3 of *)
(* i1, i2, i3. Today's path reads core, then writes Redis; the new core's  *)
(* is one SQL insert that checks core. CLAIM (C5, C6): from step 3 every   *)
(* path first adds the id to inboundMessageIds in one mutation, before it  *)
(* reads core, and only the add that wins goes on. The move copies each    *)
(* claimed id that is not in pendingMessages as a duplicate. The sweep is  *)
(* in Cutover.tla.                                                         *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    OLD,        \* today's workers
    LEGACY,     \* the ones from before step 3 (a subset of OLD)
    GAP,        \* a LEGACY worker takes over an expired lease
    FENCE,      \* the stale lease fence (FALSE: take an expired lease at once)
    EARLYTOMB,  \* the move reads the tombstone before the lease step
    TAKES,      \* today's lease takes per run
    CRASHES,    \* invocation crashes per run
    STALLS,     \* lease or lock expiries of live invocations per run
    DEPS,       \* what a flip makes current: "rev", "pre"
    FLIPS,      \* production changes per run (a flip from new and back)
    STALEROW,   \* a row 3 cron runs old is current for no deployment
    FRESH,      \* when the cron sets freshSinceAtMs: "none", "stale", "any"
    LONG,       \* workers on a deployment with the longer maxDuration
    MDFENCE,    \* D(lease): "max", "current", "noCeiling"
    ABANDONS,   \* lease-less abandonTurnRecord calls per run
    ENDROW,     \* a repeated move ends the open row of an ended cursor
    CLEANFIRST, \* the move back runs the C10 delete before work()
    REVFENCE,   \* a take on rev passes the fence and pins before work() (C14)
    STOPS,      \* stop() calls per run
    STOPMOVE,   \* the move carries today's stop key into stopAtMs
    INVKINDS,   \* the Agent invocation row's kinds: "ok", "bad", "gone", "none"
    MOVEACTOR,  \* the actor of a moved row: "verify" or "copy"
    PINEXPIRE,  \* pin expiries per run
    REFRESH,    \* the sweep refreshes the pin TTL while new is current
    LATE,       \* inputs that today's or pre's ingress adds
    INGRESS,    \* Slack deliveries: a3 (i3) and the retries r1, r2, r3
    CLAIM,      \* every ingress path first adds the id to inboundMessageIds (C5, C6)
    FINISHBACK, \* the move back first ends a crashed move's Redis part (C10)
    RECORD      \* the ghost flags to keep (fewer flags: fewer states)

Msgs == {"i1", "i2"} \cup LATE \cup (IF INGRESS \cap {"a3", "r3"} # {} THEN {"i3"} ELSE {})
DMsg == [a3 |-> "i3", r1 |-> "i1", r2 |-> "i2", r3 |-> "i3"]
Workers == OLD \cup {"a", "n"}
MovePcs == {"nlease", "mlock", "minsert", "mdelete", "mclear", "mfinish"}
Ended == {"abandoned", "done", "stopped"}
Max(x, y) == IF x > y THEN x ELSE y
\* The class of the 1,800 s ceiling.
Ceil == IF LONG = {} THEN "S" ELSE "L"

VARIABLE s
vars == s

NoLease == [who |-> "", ep |-> 0, live |-> FALSE]
Pin == [who |-> "pin", ep |-> 0, live |-> TRUE]

Stored(k) == CASE k = "ok" -> {"A"} [] k = "gone" -> {"A"} [] k = "bad" -> {"B"} [] k = "none" -> {"A", "B"}
InvInit == IF INVKINDS = {} THEN {[kind |-> "", stored |-> "", st |-> ""]}
           ELSE UNION {{[kind |-> k, stored |-> a, st |-> "active"] : a \in Stored(k)} : k \in INVKINDS}

Init ==
    \E inv \in InvInit :
    s = [cur |-> "new", curRow |-> "new", rowAge |-> 0, everRev |-> FALSE, flips |-> FLIPS,
         core |-> "old", mdMax |-> "S",
         lease |-> NoLease, tomb |-> 0, tombCls |-> "S", freshEp |-> 0,
         ep |-> 0, takes |-> 0, fence |-> 0, fenceL |-> 0,
         born |-> [w \in Workers |-> 0], took |-> [w \in Workers |-> 0],
         sqlHolder |-> FALSE, sqlLive |-> FALSE, nFresh |-> FALSE,
         nTomb |-> 0,                          \* EARLYTOMB: the tombstone n read
         pc |-> [w \in Workers |-> "idle"], turn |-> [w \in Workers |-> ""],
         dep |-> "new",
         nWin |-> FALSE,                       \* ghost: n read a row less than 3 runs old
         mlock |-> [m \in Msgs |-> ""],        \* withTurnCursorMutation holder
         cursor |-> [m \in Msgs |-> IF m = "i1" THEN "open" ELSE "none"],
         pending |-> {"i2"}, arrived |-> {},
         row |-> [m \in Msgs |-> "none"], rec |-> [m \in Msgs |-> FALSE],
         inbox |-> {},
         stopKey |-> {}, stopAt |-> {},
         ids |-> {"i1", "i2"},                 \* today's inboundMessageIds (state.ts:159)
         seen |-> {},                          \* ids the move copied as duplicates
         dlv |-> [d \in INGRESS |-> "wait"],
         inv |-> inv, reqActor |-> "", invMoves |-> 0, invFails |-> 0,
         \* ghosts
         moved |-> FALSE,                      \* a move finished; no move back, pin expiry or late append since
         movedOnce |-> FALSE,                  \* a move finished once
         staleOld |-> {},                      \* inputs today's path wrote stale (today's bug)
         superseded |-> {},                    \* inputs whose cursor abandonTurnRecord ended
         stopped |-> {},                       \* inputs a stop covers
         late |-> [d \in INGRESS |-> FALSE],   \* the delivery came after a move
         accepted |-> [m \in Msgs |-> IF m \in {"i1", "i2"} THEN 1 ELSE 0],
         starts |-> [m \in Msgs |-> IF m = "i1" THEN 1 ELSE 0],
         oldFin |-> [m \in Msgs |-> 0], newFin |-> [m \in Msgs |-> 0],
         inserts |-> [m \in Msgs |-> 0], entries |-> [m \in Msgs |-> 0],
         crashes |-> CRASHES, stalls |-> STALLS, abandons |-> ABANDONS, stops |-> STOPS,
         expiries |-> PINEXPIRE, ex |-> {}]

Bump(k) == IF k < 2 THEN k + 1 ELSE k
Go(st, w, p) == [st EXCEPT !.pc[w] = p]
Flag(st, f) == IF f \in RECORD THEN [st EXCEPT !.ex = @ \cup {f}] ELSE st
\* A ghost flag that an invariant reads: always kept.
Mark(st, f) == [st EXCEPT !.ex = @ \cup {f}]

\* The invocations in g end with no further writes. Their locks expire.
StopSet(st, g) ==
    [st EXCEPT !.pc = [w \in Workers |-> IF w \in g THEN "idle" ELSE @[w]],
               !.turn = [w \in Workers |-> IF w \in g THEN "" ELSE @[w]],
               !.born = [w \in Workers |-> IF w \in g THEN 0 ELSE @[w]],
               !.took = [w \in Workers |-> IF w \in g THEN 0 ELSE @[w]],
               !.mlock = [m \in Msgs |-> IF @[m] \in g THEN "" ELSE @[m]]]

Stop(st, w) == StopSet(st, {w})

\* w holds today's lease: its own take, not expired.
Owns(st, w) == st.lease.who = w /\ st.lease.live /\ st.lease.ep = st.took[w] /\ st.pc[w] # "idle"

(***************************************************************************)
(* The fence                                                               *)
(***************************************************************************)
\* D(lease) for a lease that w took, now: "L" for the longer value.
FenceCls(w) ==
    IF LONG = {} THEN "S"
    ELSE IF w \in LEGACY THEN (IF MDFENCE = "noCeiling" THEN s.mdMax ELSE "L")
    ELSE IF MDFENCE = "current" THEN "S" ELSE s.mdMax

Passed(st, e, c) == IF c = "L" THEN e <= st.fenceL ELSE e <= st.fence

\* Save the tombstone of the lease l (step 3 code).
SaveTomb(st, l) ==
    [st EXCEPT !.tomb = Max(@, l.ep), !.tombCls = IF FenceCls(l.who) = "L" THEN "L" ELSE @]

(***************************************************************************)
(* Environment                                                             *)
(***************************************************************************)
\* Production changes: from new to a deployment in DEPS, and back. The cron
\* of new and rev upserts the row within a run (taken as at once); pre's
\* cron does not. Back on new after pre, the upsert may set freshSinceAtMs:
\* a new time point, so it takes an epoch.
Flip ==
    /\ s.flips > 0
    /\ \E d \in IF s.cur = "new" THEN DEPS ELSE {"new"} :
        LET gap == s.cur = "pre" /\ \/ FRESH = "stale" /\ s.rowAge = 3
                                    \/ FRESH = "any" /\ s.rowAge > 0
        IN s' = [s EXCEPT !.cur = d, !.flips = @ - 1, !.everRev = @ \/ d = "rev",
                          !.curRow = IF d = "pre" THEN @ ELSE d,
                          !.rowAge = IF d = "pre" THEN @ ELSE 0,
                          !.freshEp = IF gap THEN s.ep + 1 ELSE @,
                          !.ep = IF gap THEN @ + 1 ELSE @]

\* A cron run on pre: the row gets one run older.
CronAge == s.cur = "pre" /\ s.rowAge < 3 /\ s' = [s EXCEPT !.rowAge = @ + 1]

Crash(w) == s.pc[w] # "idle" /\ s.crashes > 0 /\ s' = [Stop(s, w) EXCEPT !.crashes = @ - 1]

\* A live invocation misses its check-ins: its lease or lock expires. It
\* keeps running until the fence (Tick) or a crash ends it.
Stall(w) ==
    /\ s.pc[w] # "idle" /\ s.stalls > 0
    /\ \/ /\ w \in OLD /\ Owns(s, w)
          /\ s' = [s EXCEPT !.lease.live = FALSE, !.stalls = @ - 1]
       \/ /\ w = "n" /\ s.sqlHolder /\ s.sqlLive
          /\ s' = [s EXCEPT !.sqlLive = FALSE, !.stalls = @ - 1]

\* acquiredAt(fence + 1) + maxDuration + 60 s passes. Every invocation with
\* the shorter maxDuration that started before that take has ended.
Tick ==
    /\ s.fence < s.ep
    /\ s' = StopSet([s EXCEPT !.fence = @ + 1],
                    {w \in (OLD \cup {"a"}) \ LONG : s.pc[w] # "idle" /\ s.born[w] <= s.fence})

\* The same for the longer maxDuration. It passes after the shorter one.
TickL ==
    /\ LONG # {} /\ s.fenceL < s.fence
    /\ s' = StopSet([s EXCEPT !.fenceL = @ + 1],
                    {w \in LONG : s.pc[w] # "idle" /\ s.born[w] <= s.fenceL})

\* The lease of a dead holder expires.
ExpireDead ==
    \/ /\ s.lease.who \in OLD /\ s.lease.live
       /\ (s.pc[s.lease.who] = "idle" \/ s.took[s.lease.who] # s.lease.ep)
       /\ s' = [s EXCEPT !.lease.live = FALSE]
    \/ /\ s.sqlHolder /\ s.sqlLive /\ s.pc["n"] = "idle"
       /\ s' = [s EXCEPT !.sqlLive = FALSE]

\* The heartbeat clear, a cron run on the production deployment: save the
\* tombstone, then erase the expired lease. On pre: no tombstone.
HeartbeatClear ==
    /\ s.lease.who \in OLD /\ ~s.lease.live
    /\ LET st == IF s.cur = "pre" THEN [s EXCEPT !.rowAge = IF @ < 3 THEN @ + 1 ELSE @]
                 ELSE SaveTomb(s, s.lease)
       IN s' = Flag([st EXCEPT !.lease = NoLease], "heartbeatCleared")

\* Today's conversation record is idle for 7 days and expires with the pin.
\* With REFRESH, not while new is current; on pre, 7 days make the row stale.
PinExpire ==
    /\ s.expiries > 0 /\ s.lease.who = "pin" /\ s.pc["n"] = "idle"
    /\ (\A m \in Msgs : s.cursor[m] # "open") /\ s.pending = {}
    /\ REFRESH => s.cur = "rev" \/ (s.cur = "pre" /\ s.rowAge = 3)
    /\ s' = Flag([s EXCEPT !.lease = NoLease, !.moved = FALSE, !.expiries = @ - 1], "pinExpired")

\* Today's ingress (core = old) or pre's adds a LATE input to today's
\* waiting input. A conversation has today's state again: the next take
\* moves it.
OIngress ==
    /\ s.cur = "pre" \/ s.core = "old"
    /\ \E m \in LATE \ s.arrived :
        s' = [s EXCEPT !.pending = @ \cup {m}, !.arrived = @ \cup {m}, !.moved = FALSE]

\* stop() in the conversation mutation. Today's (core = old, or on pre)
\* saves the stop key with the inputs it covers; the new core's sets
\* stopAtMs. A stop covers the input that waits or runs.
UserStop ==
    LET onOld == s.core = "old" \/ s.cur = "pre"
        live == {m \in Msgs : s.cursor[m] = "open" \/ s.row[m] = "open"} \cup s.pending \cup s.inbox
    IN /\ s.stops > 0 /\ live # {}
       /\ s' = [s EXCEPT !.stops = @ - 1, !.stopped = @ \cup live,
                         !.stopKey = IF onOld THEN @ \cup live ELSE @,
                         !.stopAt = IF onOld THEN @ ELSE @ \cup live]

\* Slack ingress. Ghost Accept counts the acceptance; a retry that came
\* after a move and is accepted again breaks retryAfterMoveIsDuplicate.
Accept(st, d) ==
    LET m == DMsg[d]
    IN [st EXCEPT !.accepted[m] = @ + 1,
                  !.ex = IF st.late[d] /\ st.accepted[m] > 0 THEN @ \cup {"retryAcceptedAfterMove"} ELSE @]

DeliverOk(d) == d = "r3" /\ "a3" \in INGRESS => s.dlv["a3"] # "wait"
Claimed == IF CLAIM THEN "claimed" ELSE "wait"

\* CLAIM: one conversation mutation adds the id before any read of core;
\* only the add that wins goes on.
DeliverClaim(d) ==
    LET m == DMsg[d]
    IN /\ CLAIM /\ s.dlv[d] = "wait" /\ DeliverOk(d)
       /\ s' = IF m \in s.ids THEN Flag([s EXCEPT !.dlv[d] = "done"], "retryRefused")
               ELSE [s EXCEPT !.dlv[d] = "claimed", !.ids = @ \cup {m}, !.late[d] = s.movedOnce]

\* The new core: one SQL insert, unique on the inbound message id, that
\* checks core in the same transaction.
DeliverNew(d) ==
    LET m == DMsg[d]
    IN /\ s.dlv[d] = Claimed /\ DeliverOk(d) /\ s.core = "new"
       /\ s' = IF s.rec[m] \/ m \in s.seen THEN Flag([s EXCEPT !.dlv[d] = "done"], "retryRefused")
               ELSE Accept([s EXCEPT !.dlv[d] = "done", !.rec[m] = TRUE, !.inbox = @ \cup {m},
                                     !.late[d] = IF CLAIM THEN @ ELSE s.movedOnce], d)

\* Today's path: read core (old), then one Redis write (without CLAIM the
\* dedupe check and the append). An append after a move waits in
\* pendingMessages for the next take's move.
DeliverOldRead(d) ==
    /\ s.dlv[d] = Claimed /\ DeliverOk(d) /\ s.core = "old"
    /\ s' = [s EXCEPT !.dlv[d] = "oldRead", !.late[d] = IF CLAIM THEN @ ELSE s.movedOnce]

DeliverOldWrite(d) ==
    LET m == DMsg[d]
    IN /\ s.dlv[d] = "oldRead"
       /\ s' = IF ~CLAIM /\ m \in s.ids THEN Flag([s EXCEPT !.dlv[d] = "done"], "retryRefused")
               ELSE LET st == [s EXCEPT !.dlv[d] = "done", !.ids = @ \cup {m}, !.pending = @ \cup {m},
                                        !.moved = FALSE]
                    IN Accept(IF s.core = "new" THEN Flag(st, "oldWriteAfterMove") ELSE st, d)

Ingress == \E d \in INGRESS : DeliverClaim(d) \/ DeliverNew(d) \/ DeliverOldRead(d) \/ DeliverOldWrite(d)

(***************************************************************************)
(* Today's workers                                                         *)
(***************************************************************************)
OldRunnable(st) == {m \in Msgs : st.cursor[m] = "open"} \cup st.pending

\* Ghost for a cursor write by w on input m. A write after the pin is the
\* cutover's bug. A write without the lease before the pin is today's bug
\* (no C3): today's workers run that turn twice too, so the duplicate
\* checks skip m.
OldWrite(st, w, m) ==
    IF Owns(s, w) THEN st
    ELSE IF s.lease.who = "pin" THEN Flag(st, "oldWriteAfterPin")
    ELSE [st EXCEPT !.staleOld = @ \cup {m}]

\* An old write that leaves a cursor open after a move.
Opened(st) == IF st.moved /\ \E m \in Msgs : st.cursor[m] = "open"
              THEN Flag(st, "turnOpenedAfterMove") ELSE st

\* A delivery or a busy-defer redelivery starts an invocation, which runs
\* startConversationWork in the conversation mutation. Step 3 on: refuse
\* core = new; raise the running max (the deployment row upsert); save the
\* tombstone before a take over an expired lease. The take mints a fresh
\* token and acquiredAt (the next epoch).
OTake(w) ==
    LET legacy == w \in LEGACY
        over == s.lease.who \in OLD
    IN
    /\ s.pc[w] = "idle"
    /\ IF ~legacy /\ s.core = "new" THEN s' = Flag(s, "refused")
       ELSE IF s.lease.who = "pin" THEN s' = Flag(s, "busyDeferOnPin")
       ELSE /\ ~s.lease.live /\ OldRunnable(s) # {} /\ s.takes < TAKES
            /\ ~(over /\ legacy /\ ~GAP)
            /\ LET st0 == IF w \in LONG /\ ~legacy THEN [s EXCEPT !.mdMax = "L"] ELSE s
                   st == IF over /\ ~legacy THEN SaveTomb(st0, s.lease) ELSE st0
               IN s' = Go([st EXCEPT !.ep = @ + 1, !.takes = @ + 1, !.born[w] = s.ep, !.took[w] = s.ep + 1,
                                     !.lease = [who |-> w, ep |-> s.ep + 1, live |-> TRUE]],
                          w, "oready")

\* Run an open turn (resume) or the next waiting input (a cursor write), or
\* release. A worker releases with work left when it hands off to a
\* continuation (worker.ts:418-423); the continuation is a new delivery.
\* With the stop key it ends the inputs the key covers.
OReady(w) ==
    /\ s.pc[w] = "oready"
    /\ \/ s' = Go(s, w, "orel")   \* nothing left, or a continuation
       \/ /\ s.stopKey # {} /\ Owns(s, w)
          /\ s' = Go([s EXCEPT !.cursor = [m \in Msgs |-> IF @[m] = "open" /\ m \in s.stopKey THEN "stopped" ELSE @[m]],
                               !.pending = @ \ s.stopKey, !.stopKey = {}], w, "orel")
       \/ \E m \in OldRunnable(s) :
            IF s.cursor[m] = "open" THEN s' = Go([s EXCEPT !.turn[w] = m], w, "orun")
            ELSE /\ s.mlock[m] = ""
                 /\ s' = Go(Opened(OldWrite([s EXCEPT !.cursor[m] = "open", !.pending = @ \ {m},
                                                      !.starts[m] = Bump(@), !.turn[w] = m], w, m)),
                            w, "orun")

\* A checkpoint save rewrites the cursor as open (upsertTurnRecord), over an
\* end status too: today's core then runs the turn on.
OSave(w) ==
    LET m == s.turn[w] IN
    /\ s.pc[w] = "orun" /\ s.mlock[m] = ""
    /\ s' = Opened(OldWrite([s EXCEPT !.cursor[m] = "open", !.superseded = @ \ {m}], w, m))

OFinish(w) ==
    LET m == s.turn[w] IN
    /\ s.pc[w] = "orun" /\ s.mlock[m] = ""
    /\ s' = Go(OldWrite([s EXCEPT !.cursor[m] = "done", !.oldFin[m] = Bump(@), !.turn[w] = ""], w, m),
               w, "oready")

\* Release: only the token holder erases the lease. No tombstone.
ORel(w) ==
    /\ s.pc[w] = "orel"
    /\ s' = Stop([s EXCEPT !.lease = IF Owns(s, w) THEN NoLease ELSE @], w)

\* abandonTurnRecord, with no lease, in withTurnCursorMutation: take the
\* lock; then write only the end status, or nothing when the cursor is gone.
ALock ==
    /\ s.pc["a"] = "idle" /\ s.abandons > 0
    /\ \E m \in Msgs :
        /\ s.mlock[m] = ""
        /\ s' = Go([s EXCEPT !.mlock[m] = "a", !.turn["a"] = m, !.born["a"] = s.ep,
                             !.abandons = @ - 1], "a", "awrite")

AWrite ==
    LET m == s.turn["a"]
        ends == s.cursor[m] = "open"
        st0 == IF ends /\ s.row[m] = "open" THEN Flag(s, "abandonedHalfMoved")
               ELSE IF s.cursor[m] = "none" /\ s.moved THEN Flag(s, "abandonFoundNoCursor")
               ELSE s
        \* The new core already runs the turn that this write supersedes.
        st == IF ends /\ s.pc["n"] = "nrun" /\ s.turn["n"] = m THEN Mark(st0, "supersededRun") ELSE st0
    IN /\ s.pc["a"] = "awrite"
       /\ s' = Stop(Opened([st EXCEPT !.cursor[m] = IF ends THEN "abandoned" ELSE @,
                                      !.superseded = IF ends THEN @ \cup {m} ELSE @]), "a")

(***************************************************************************)
(* The new core's work() (n), on the deployment `dep`                      *)
(***************************************************************************)
NOk(st) == st.sqlHolder /\ st.sqlLive /\ st.nFresh

\* A cursor of a crashed move: it has a turn row. ENDROW counts an ended one.
HalfMoved(st, m) == st.row[m] # "none" /\ (st.cursor[m] = "open" \/ (ENDROW /\ st.cursor[m] # "none"))

\* Today's state: the move moves it. A missing pin counts: each take on new
\* pins and refreshes the TTL.
Leftover(st) ==
    \/ \E m \in Msgs : st.cursor[m] = "open" \/ HalfMoved(st, m)
    \/ st.pending # {} \/ st.inv.st = "active" \/ st.lease.who # "pin"

\* What a crashed move left in Redis (C10).
Crashed(st) == (\E m \in Msgs : st.cursor[m] # "none" /\ st.row[m] # "none") \/ \E m \in st.pending : st.rec[m]

IdleOnNew(st) == (\A m \in Msgs : st.row[m] # "open") /\ st.inbox = {}

\* The row names d and, with STALEROW, is less than 3 cron runs old.
Current(d) == s.curRow = d /\ (STALEROW => s.rowAge < 3)

\* Where a take on rev goes once the pin holds: the C10 delete first
\* (CLEANFIRST), the move back, or work().
RevNext(st) == IF CLEANFIRST /\ Crashed(st) THEN "mfinish" ELSE IF IdleOnNew(st) THEN "mback" ELSE "nready"

\* A delivery starts an invocation on the new-core deployment, or after a
\* revert also on the reverted one. It reads the current row. Not current:
\* it takes no lock and acks.
NStart ==
    /\ s.pc["n"] = "idle"
    /\ \E d \in IF s.everRev THEN {"new", "rev"} ELSE {"new"} :
        s' = IF Current(d) THEN Go([s EXCEPT !.dep = d, !.nWin = s.rowAge < 3], "n", "ntake")
             ELSE Flag(s, "nonCurrentNoLock")

\* The SQL lock take (one compare-and-set, P5).
NTake ==
    /\ s.pc["n"] = "ntake" /\ (~s.sqlHolder \/ ~s.sqlLive)
    /\ LET st == [s EXCEPT !.sqlHolder = TRUE, !.sqlLive = TRUE, !.nFresh = TRUE]
       IN s' = IF s.dep = "new"
               THEN Go([st EXCEPT !.core = "new"], "n",
                       IF ~Leftover(st) THEN "nready" ELSE IF EARLYTOMB THEN "ntomb" ELSE "nlease")
               ELSE IF s.core = "new" /\ REVFENCE /\ s.lease.who # "pin"
               THEN Go(st, "n", IF EARLYTOMB THEN "ntomb" ELSE "nlease")
               ELSE IF s.core = "new" THEN Go(st, "n", RevNext(s))
               ELSE IF s.lease.who = "pin" THEN Go(st, "n", "munpin")  \* a move back that crashed
               ELSE Go(st, "n", "nrel")

\* EARLYTOMB only: read the tombstone from SQL before the lease step.
NTomb == s.pc["n"] = "ntomb" /\ s' = Go([s EXCEPT !.nTomb = s.tomb], "n", "nlease")

\* The stale lease fence and the pin, in the conversation mutation. A live
\* lease, or a fence not yet passed: set wakeAtMs and end. On rev
\* (REVFENCE) there is no move: the pin keeps today's state for the move
\* back to give back.
NLease ==
    LET tomb == IF EARLYTOMB THEN s.nTomb ELSE s.tomb
        l == s.lease
        leaseOk == l.who \in OLD => Passed(s, l.ep, FenceCls(l.who))
        freshOk == l.who = "" => Passed(s, s.freshEp, Ceil)
        clear == ~FENCE \/ (Passed(s, tomb, s.tombCls) /\ leaseOk /\ freshOk)
        free == l.who = "" \/ (l.who \in OLD /\ ~l.live)
        wait == IF l.who = "" THEN "moveWaitsForTombstone" ELSE "moveWaits"
        \* A new pin while pre is current, by an n that read the row before it
        \* was 3 runs old: the window. pinAfterStale: stale by now.
        pinned(st) == IF l.who # "pin" /\ s.cur = "pre" /\ s.nWin
                      THEN Mark(IF s.rowAge = 3 THEN Mark(st, "pinAfterStale") ELSE st, "pinInWindow")
                      ELSE st
    IN /\ s.pc["n"] = "nlease"
       /\ s' = IF ~NOk(s) THEN Stop(s, "n")
               ELSE IF l.who = "pin" \/ (free /\ clear)
               THEN Go(pinned([s EXCEPT !.lease = Pin]), "n", IF s.dep = "rev" THEN RevNext(s) ELSE "mlock")
               ELSE Flag(Stop([s EXCEPT !.sqlHolder = FALSE, !.sqlLive = FALSE], "n"), wait)

\* The turns that the move moves: open cursors and, with ENDROW, the ended
\* cursors of a crashed move.
MoveSet(st) == {m \in Msgs : st.cursor[m] = "open" \/ HalfMoved(st, m)}

\* withTurnCursorMutation for each moved turn. Busy: the run fails and a
\* later take repeats the move.
NMoveLock ==
    LET set == MoveSet(s)
    IN /\ s.pc["n"] = "mlock"
       /\ s' = IF \A m \in set : s.mlock[m] = ""
               THEN Go([s EXCEPT !.mlock = [m \in Msgs |-> IF m \in set THEN "n" ELSE @[m]]],
                       "n", "minsert")
               ELSE Flag(Stop(s, "n"), "moveLockBusy")

\* The move, part 1 (SQL, fenced): a turn row per open cursor (keyed by turn
\* id), an inbox entry with a request record per waiting input (unique),
\* the stop key into stopAtMs (STOPMOVE), and the Agent invocation row
\* moved or closed. ENDROW: the open row of an ended cursor gets its end.
NMoveInsert ==
    LET rows == {m \in Msgs : s.cursor[m] = "open" /\ s.row[m] = "none"}
        entries == {m \in s.pending : ~s.rec[m]}
        ends == {m \in Msgs : ENDROW /\ s.cursor[m] \in Ended /\ s.row[m] = "open"}
        trust == IF MOVEACTOR = "verify" THEN s.inv.kind = "ok" ELSE TRUE
        actor == IF MOVEACTOR = "verify" THEN "A" ELSE s.inv.stored
        active == s.inv.st = "active"
        st == [s EXCEPT
                 !.row = [m \in Msgs |-> IF m \in rows THEN "open" ELSE IF m \in ends THEN "ended" ELSE @[m]],
                 !.inserts = [m \in Msgs |-> IF m \in rows THEN @[m] + 1 ELSE @[m]],
                 !.rec = [m \in Msgs |-> IF m \in entries THEN TRUE ELSE @[m]],
                 !.inbox = @ \cup entries,
                 !.seen = @ \cup {m \in s.ids \ s.pending : ~s.rec[m]},
                 !.entries = [m \in Msgs |-> IF m \in entries THEN @[m] + 1 ELSE @[m]],
                 !.stopAt = IF STOPMOVE THEN @ \cup s.stopKey ELSE @,
                 !.inv.st = IF ~active THEN @ ELSE IF trust THEN "moved" ELSE "closed",
                 !.reqActor = IF active /\ trust THEN actor ELSE @,
                 !.invMoves = IF active /\ trust THEN @ + 1 ELSE @,
                 !.invFails = IF active /\ ~trust THEN @ + 1 ELSE @]
    IN /\ s.pc["n"] = "minsert"
       /\ s' = IF ~NOk(s) THEN Stop(s, "n")
               ELSE Go(IF ends # {} THEN Flag(st, "rowEnded") ELSE st, "n", "mdelete")

\* Part 2 (Redis): delete each cursor that has a row, then the turn locks.
NMoveDelete ==
    /\ s.pc["n"] = "mdelete"
    /\ s' = Go([s EXCEPT !.cursor = [m \in Msgs |-> IF s.row[m] # "none" THEN "none" ELSE @[m]],
                         !.mlock = [m \in Msgs |-> IF @[m] = "n" THEN "" ELSE @[m]]], "n", "mclear")

\* Part 3 (Redis): clear each waiting input that has a request record. An
\* input appended after part 1 stays for the next take's move.
NMoveClear ==
    /\ s.pc["n"] = "mclear"
    /\ s' = Go([s EXCEPT !.pending = {m \in @ : ~s.rec[m]},
                         !.moved = \A m \in s.pending : s.rec[m], !.movedOnce = TRUE], "n", "nready")

\* Run an open row or the next inbox entry. An input under stopAtMs ends
\* without a run.
NReady ==
    LET open == {m \in Msgs : s.row[m] = "open"}
        under == (open \cup s.inbox) \cap s.stopAt
        Run(st, m) == Go(IF m \in s.superseded THEN Mark(st, "supersededRun") ELSE st, "n", "nrun")
        Started(st, m) == IF m \in s.stopped THEN Mark(st, "stoppedRun") ELSE st
    IN
    /\ s.pc["n"] = "nready"
    /\ s' = IF ~NOk(s) THEN Stop(s, "n")
            ELSE IF under # {}
            THEN LET st == [s EXCEPT !.row = [m \in Msgs |-> IF m \in under /\ @[m] = "open" THEN "stopped" ELSE @[m]],
                                     !.inbox = @ \ under]
                 IN IF under \subseteq s.stopped THEN st ELSE Mark(st, "stopTooWide")
            ELSE IF open # {}
            THEN LET m == CHOOSE x \in open : TRUE
                 IN Run(Started([s EXCEPT !.turn["n"] = m], m), m)
            ELSE IF s.inbox # {}
            THEN LET m == CHOOSE x \in s.inbox : TRUE
                 IN Run(Started([s EXCEPT !.row[m] = "open", !.inbox = @ \ {m},
                                          !.starts[m] = Bump(@), !.turn["n"] = m], m), m)
            ELSE IF s.dep = "rev" THEN Go(s, "n", "mback")
            ELSE Go(s, "n", "nrel")

NFinish ==
    /\ s.pc["n"] = "nrun"
    /\ s' = IF NOk(s)
            THEN Go([s EXCEPT !.row[s.turn["n"]] = "done", !.newFin[s.turn["n"]] = Bump(@)], "n", "nready")
            ELSE Stop(s, "n")

\* The move back (current deployment lacks new_core), idle on the new core:
\* part 1 (SQL, fenced) sets core old; part 2 (Redis) clears the pin. With
\* FINISHBACK, a Redis step first deletes what a crashed move left: each
\* cursor with a turn row and each waiting input with a request record.
NMoveBack ==
    /\ s.pc["n"] = "mback"
    /\ s' = IF ~(NOk(s) /\ IdleOnNew(s)) THEN Go(s, "n", "nrel")
            ELSE IF FINISHBACK /\ Crashed(s) THEN Go(s, "n", "mfinish")
            ELSE Go(Flag([s EXCEPT !.core = "old", !.moved = FALSE], "movedBack"), "n", "munpin")

\* The C10 delete. ENDROW: an open row of an ended cursor gets its end.
NMoveFinish ==
    /\ s.pc["n"] = "mfinish"
    /\ s' = Go([s EXCEPT !.row = [m \in Msgs |-> IF ENDROW /\ s.cursor[m] \in Ended /\ @[m] = "open"
                                                THEN "ended" ELSE @[m]],
                         !.cursor = [m \in Msgs |-> IF s.row[m] # "none" THEN "none" ELSE @[m]],
                         !.pending = {m \in @ : ~s.rec[m]}], "n", "nready")

NUnpin ==
    /\ s.pc["n"] = "munpin"
    /\ s' = Go([s EXCEPT !.lease = IF @.who = "pin" THEN NoLease ELSE @], "n", "nrel")

NRel ==
    /\ s.pc["n"] = "nrel"
    /\ s' = Stop([s EXCEPT !.sqlHolder = IF NOk(s) THEN FALSE ELSE @,
                           !.sqlLive = IF NOk(s) THEN FALSE ELSE @], "n")

(***************************************************************************)
OldStep(w) == OTake(w) \/ OReady(w) \/ OSave(w) \/ OFinish(w) \/ ORel(w)
NewStep == NStart \/ NTake \/ NTomb \/ NLease \/ NMoveLock \/ NMoveInsert
           \/ NMoveDelete \/ NMoveClear \/ NReady \/ NFinish \/ NMoveBack \/ NMoveFinish \/ NUnpin \/ NRel

Next ==
    \/ \E w \in OLD : OldStep(w)
    \/ ALock \/ AWrite
    \/ NewStep
    \/ Flip \/ CronAge \/ Tick \/ TickL \/ ExpireDead \/ HeartbeatClear
    \/ PinExpire \/ OIngress \/ UserStop \/ Ingress
    \/ \E w \in Workers : Crash(w) \/ Stall(w)

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Safety                                                                  *)
(***************************************************************************)
OldRuns(w) == s.pc[w] = "orun"
NewRuns == s.pc["n"] = "nrun"

\* No conversation runs on both cores at once, stalled invocations included.
oneCore == ~((\E w \in OLD : OldRuns(w)) /\ NewRuns)

\* The same, counting only invocations whose lease or lock is live.
oneCoreLive == ~((\E w \in OLD : OldRuns(w) /\ Owns(s, w)) /\ NewRuns /\ NOk(s))

\* No input starts twice, and no turn finishes on both cores or twice on the
\* new core. Not counted: inputs that today's path wrote stale before any
\* pin, and a turn that two of today's workers finish (both today's bug,
\* no C3; after the pin, noOldWriteAfterPin catches the second write).
noDuplicateTurn ==
    \A m \in Msgs \ s.staleOld :
        s.starts[m] <= 1 /\ s.newFin[m] <= 1 /\ ~(s.oldFin[m] > 0 /\ s.newFin[m] > 0)

\* After a move finishes and while the pin holds, no today's turn is open,
\* no today's input waits and no invocation row is active.
noStrandedCursor ==
    (s.moved /\ s.lease.who = "pin" /\ s.pc["n"] \notin MovePcs)
        => (\A m \in Msgs : s.cursor[m] # "open") /\ s.pending = {} /\ s.inv.st # "active"

\* The move is idempotent: each turn row and inbox entry is inserted once.
moveIdempotent == \A m \in Msgs : s.inserts[m] <= 1 /\ s.entries[m] <= 1

\* No old-core write (with the lease or without it) opens a turn after a move.
noTurnOpenedAfterMove == "turnOpenedAfterMove" \notin s.ex

\* No today's cursor write after the pin.
noOldWriteAfterPin == "oldWriteAfterPin" \notin s.ex

\* The new core never runs a turn that abandonTurnRecord ended.
noSupersededRun == "supersededRun" \notin s.ex

\* A stop covers the same inputs after the move: the new core runs none of
\* them and ends no other.
stopHonored == "stoppedRun" \notin s.ex /\ "stopTooWide" \notin s.ex

\* I15: a moved invocation row acts for its creating parent's actor, and
\* each row is moved or closed once.
movedActorVerified ==
    /\ s.inv.st = "moved" => s.reqActor = "A"
    /\ s.invMoves + s.invFails <= 1

safety ==
    /\ oneCoreLive /\ noDuplicateTurn /\ noStrandedCursor /\ moveIdempotent
    /\ noTurnOpenedAfterMove /\ noOldWriteAfterPin /\ noSupersededRun /\ stopHonored
    /\ movedActorVerified

\* Ingress (Cutover.tla): no input is accepted twice; a retry after a move
\* is a duplicate; accepted input that no turn took waits in an inbox.
acceptedOnce == \A m \in Msgs : s.accepted[m] <= 1
retryAfterMoveIsDuplicate == "retryAcceptedAfterMove" \notin s.ex
noLostInput ==
    \A m \in Msgs \ s.stopped : (s.accepted[m] > 0 /\ s.starts[m] = 0) => m \in s.pending \cup s.inbox

\* Every safety failure and two-core run comes from a pin in the window
\* after a rollback below step 3 (the plan's accepted gap).
onlyWindowGap == (safety /\ oneCore) \/ "pinInWindow" \in s.ex

\* Worked examples: each must be reachable.
ex_moveWaitsForFence == "moveWaits" \notin s.ex
ex_moveWaitsForTombstone == "moveWaitsForTombstone" \notin s.ex
ex_heartbeatCleared == "heartbeatCleared" \notin s.ex
ex_refused == "refused" \notin s.ex
ex_busyDeferOnPin == "busyDeferOnPin" \notin s.ex
ex_nonCurrentNoLock == "nonCurrentNoLock" \notin s.ex
ex_movedBack == "movedBack" \notin s.ex
ex_moveLockBusy == "moveLockBusy" \notin s.ex
ex_abandonFoundNoCursor == "abandonFoundNoCursor" \notin s.ex
ex_abandonedHalfMoved == "abandonedHalfMoved" \notin s.ex
ex_movedThenFinishedOnNew == ~(s.newFin["i1"] = 1 /\ s.cursor["i1"] = "none")
ex_takeoverTombstone == ~(s.tomb > 0 /\ s.lease.who \in OLD /\ s.lease.ep > s.tomb)
ex_rowEnded == "rowEnded" \notin s.ex
ex_pinExpired == "pinExpired" \notin s.ex
ex_pinAfterStale == "pinAfterStale" \notin s.ex
ex_staleRowNoLock == ~(s.cur = "pre" /\ s.rowAge = 3 /\ "nonCurrentNoLock" \in s.ex)
ex_freshWait == ~(s.freshEp > s.fence /\ s.cur = "new" /\ "moveWaitsForTombstone" \in s.ex)
ex_stopMoved == ~(s.stopKey # {} /\ \E m \in Msgs : s.row[m] = "stopped")
ex_longFence == ~(s.fenceL > 0 /\ s.lease.who = "pin")
ex_invMoved == s.inv.st # "moved"
ex_invClosed == s.inv.st # "closed"
ex_inboxMovedThenRunOnNew == ~(s.newFin["i2"] = 1 /\ s.pending = {})
ex_retryRefused == "retryRefused" \notin s.ex
ex_oldWriteAfterMove == "oldWriteAfterMove" \notin s.ex

=============================================================================
