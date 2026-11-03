---------------------------- MODULE CutoverShim ----------------------------
(***************************************************************************)
(* Model 5: the P45 shim (plan 170f513). One conversation.                 *)
(*                                                                         *)
(* Safety comes only from the stale lease fence and the pin.               *)
(* - Time. Each today's lease take gets the next epoch: its acquiredAtMs.  *)
(*   `fence` is the last epoch k for which acquiredAt(k) + maxDuration +   *)
(*   60 s has passed. An invocation records `born`, the last epoch taken   *)
(*   before it started. Vercel ends it at maxDuration, so once the fence   *)
(*   passes epoch born + 1 it has ended (Tick). Its own take, if any, has  *)
(*   an epoch after born.                                                  *)
(* - Tombstone. From step 3, the heartbeat clear of an expired lease and a *)
(*   take over an expired lease first save staleLeaseAcquiredAtMs =        *)
(*   max(old, acquiredAtMs) (`tomb`) on the SQL row. A worker from before  *)
(*   step 3 (LEGACY) saves nothing. With GAP it takes over expired leases  *)
(*   (the plan's give-up); without GAP it takes only an absent lease.      *)
(* - The fence. The move pins an expired lease only when                   *)
(*   max(acquiredAt, tomb) + maxDuration + 60 s has passed, and with no    *)
(*   lease only when tomb + maxDuration + 60 s has passed. It reads the    *)
(*   lease, then the tombstone, and writes the pin in one conversation     *)
(*   mutation (EARLYTOMB: it reads the tombstone first, C11). No version   *)
(*   takes a pinned lease.                                                 *)
(* - Today's workers have no cursor-write lease check (no C3). Step 3 on   *)
(*   they refuse core = new (the reader); LEGACY has no reader. They can   *)
(*   start at any time: a deployment keeps its own queue deliveries until  *)
(*   they expire, and a busy-defer chain extends them. A worker can        *)
(*   release with work left (a continuation).                              *)
(* - Per-turn lock. The move holds withTurnCursorMutation for each turn it *)
(*   moves. abandonTurnRecord (worker a, no lease) takes that lock, writes *)
(*   only the end status and does nothing when the cursor is gone.         *)
(* - Current-deployment row, set by the cron: new (has new_core) or rev    *)
(*   (a revert). n is the new core's work() on deployment `dep`. Not       *)
(*   current: it takes no lock. On rev it runs work() on a core = new      *)
(*   conversation, then moves it back. FINISHBACK (C10): the move back     *)
(*   first deletes what a crashed move left in Redis.                      *)
(*                                                                         *)
(* Input i1 has an open cursor at start (its worker died). Input i2 waits  *)
(* in pendingMessages. Slack ingress and the sweep are in Cutover.tla.     *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    OLD,        \* today's workers
    LEGACY,     \* the ones from before step 3 (a subset of OLD)
    GAP,        \* a LEGACY worker takes over an expired lease
    FENCE,      \* the stale lease fence (FALSE: take an expired lease at once)
    EARLYTOMB,  \* the move reads the tombstone before the lease step
    TAKES,      \* today's lease takes per run (the epoch bound)
    CRASHES,    \* invocation crashes per run
    STALLS,     \* lease or lock expiries of live invocations per run
    FLIPS,      \* current-deployment changes per run (1: a revert)
    ABANDONS,   \* lease-less abandonTurnRecord calls per run
    FINISHBACK, \* the move back first ends a crashed move's Redis part (C10)
    RECORD      \* the ghost flags to keep (fewer flags: fewer states)

Msgs == {"i1", "i2"}
Workers == OLD \cup {"a", "n"}
MovePcs == {"nlease", "mlock", "minsert", "mdelete", "mclear", "mfinish"}
Max(x, y) == IF x > y THEN x ELSE y

VARIABLE s
vars == s

NoLease == [who |-> "", ep |-> 0, live |-> FALSE]
Pin == [who |-> "pin", ep |-> 0, live |-> TRUE]

Init ==
    s = [cur |-> "new", everRev |-> FALSE, flips |-> FLIPS,
         core |-> "old",
         lease |-> NoLease, tomb |-> 0, ep |-> 0, fence |-> 0,
         born |-> [w \in Workers |-> 0], took |-> [w \in Workers |-> 0],
         sqlHolder |-> FALSE, sqlLive |-> FALSE, nFresh |-> FALSE,
         nTomb |-> 0,                          \* EARLYTOMB: the tombstone n read
         pc |-> [w \in Workers |-> "idle"], turn |-> [w \in Workers |-> ""],
         dep |-> "new",
         mlock |-> [m \in Msgs |-> ""],        \* withTurnCursorMutation holder
         cursor |-> [m \in Msgs |-> IF m = "i1" THEN "open" ELSE "none"],
         pending |-> {"i2"},
         row |-> [m \in Msgs |-> "none"], rec |-> [m \in Msgs |-> FALSE], inbox |-> {},
         \* ghosts
         moved |-> FALSE,                      \* a move finished; no move back since
         staleOld |-> {},                      \* inputs today's path wrote stale (today's bug)
         starts |-> [m \in Msgs |-> IF m = "i1" THEN 1 ELSE 0],
         oldFin |-> [m \in Msgs |-> 0], newFin |-> [m \in Msgs |-> 0],
         inserts |-> [m \in Msgs |-> 0], entries |-> [m \in Msgs |-> 0],
         crashes |-> CRASHES, stalls |-> STALLS, abandons |-> ABANDONS, ex |-> {}]

Bump(k) == IF k < 2 THEN k + 1 ELSE k
Go(st, w, p) == [st EXCEPT !.pc[w] = p]
Flag(st, f) == IF f \in RECORD THEN [st EXCEPT !.ex = @ \cup {f}] ELSE st

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
(* Environment                                                             *)
(***************************************************************************)
\* The cron sets the current-deployment row: a revert, or a deploy again.
Flip ==
    /\ s.flips > 0
    /\ s' = [s EXCEPT !.cur = IF @ = "new" THEN "rev" ELSE "new",
                      !.everRev = TRUE, !.flips = @ - 1]

Crash(w) == s.pc[w] # "idle" /\ s.crashes > 0 /\ s' = [Stop(s, w) EXCEPT !.crashes = @ - 1]

\* A live invocation misses its check-ins: its lease or lock expires. It
\* keeps running until the fence (Tick) or a crash ends it.
Stall(w) ==
    /\ s.pc[w] # "idle" /\ s.stalls > 0
    /\ \/ /\ w \in OLD /\ Owns(s, w)
          /\ s' = [s EXCEPT !.lease.live = FALSE, !.stalls = @ - 1]
       \/ /\ w = "n" /\ s.sqlHolder /\ s.sqlLive
          /\ s' = [s EXCEPT !.sqlLive = FALSE, !.stalls = @ - 1]

\* acquiredAt(fence + 1) + maxDuration + 60 s passes. Every invocation that
\* started before that take has ended.
Tick ==
    /\ s.fence < s.ep
    /\ s' = StopSet([s EXCEPT !.fence = @ + 1],
                    {w \in OLD \cup {"a"} : s.pc[w] # "idle" /\ s.born[w] <= s.fence})

\* The lease of a dead holder expires.
ExpireDead ==
    \/ /\ s.lease.who \in OLD /\ s.lease.live
       /\ (s.pc[s.lease.who] = "idle" \/ s.took[s.lease.who] # s.lease.ep)
       /\ s' = [s EXCEPT !.lease.live = FALSE]
    \/ /\ s.sqlHolder /\ s.sqlLive /\ s.pc["n"] = "idle"
       /\ s' = [s EXCEPT !.sqlLive = FALSE]

\* The heartbeat clear (current deployment, so step 3 code): save the
\* tombstone, then erase the expired lease.
HeartbeatClear ==
    /\ s.lease.who \in OLD /\ ~s.lease.live
    /\ s' = Flag([s EXCEPT !.tomb = Max(@, s.lease.ep), !.lease = NoLease], "heartbeatCleared")

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
\* core = new, and save the tombstone before a take over an expired lease.
\* The take mints a fresh token and acquiredAt (the next epoch).
OTake(w) ==
    LET legacy == w \in LEGACY
        over == s.lease.who \in OLD
    IN
    /\ s.pc[w] = "idle"
    /\ IF ~legacy /\ s.core = "new" THEN s' = Flag(s, "refused")
       ELSE IF s.lease.who = "pin" THEN s' = Flag(s, "busyDeferOnPin")
       ELSE /\ ~s.lease.live /\ OldRunnable(s) # {} /\ s.ep < TAKES
            /\ ~(over /\ legacy /\ ~GAP)
            /\ s' = Go([s EXCEPT !.ep = @ + 1, !.born[w] = s.ep, !.took[w] = s.ep + 1,
                                 !.lease = [who |-> w, ep |-> s.ep + 1, live |-> TRUE],
                                 !.tomb = IF over /\ ~legacy THEN Max(@, s.lease.ep) ELSE @],
                       w, "oready")

\* Run an open turn (resume) or the next waiting input (a cursor write), or
\* release. A worker releases with work left when it hands off to a
\* continuation (worker.ts:418-423); the continuation is a new delivery.
OReady(w) ==
    /\ s.pc[w] = "oready"
    /\ \/ s' = Go(s, w, "orel")   \* nothing left, or a continuation
       \/ \E m \in OldRunnable(s) :
            IF s.cursor[m] = "open" THEN s' = Go([s EXCEPT !.turn[w] = m], w, "orun")
            ELSE /\ s.mlock[m] = ""
                 /\ s' = Go(Opened(OldWrite([s EXCEPT !.cursor[m] = "open", !.pending = @ \ {m},
                                                      !.starts[m] = Bump(@), !.turn[w] = m], w, m)),
                            w, "orun")

\* A checkpoint save rewrites the cursor as open (upsertTurnRecord).
OSave(w) ==
    LET m == s.turn[w] IN
    /\ s.pc[w] = "orun" /\ s.mlock[m] = ""
    /\ s' = Opened(OldWrite([s EXCEPT !.cursor[m] = "open"], w, m))

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
        st == IF s.cursor[m] = "open" /\ s.row[m] = "open" THEN Flag(s, "abandonedHalfMoved")
              ELSE IF s.cursor[m] = "none" /\ s.moved THEN Flag(s, "abandonFoundNoCursor")
              ELSE s
    IN /\ s.pc["a"] = "awrite"
       /\ s' = Stop(Opened([st EXCEPT !.cursor[m] = IF @ = "open" THEN "abandoned" ELSE @]), "a")

(***************************************************************************)
(* The new core's work() (n), on the deployment `dep`                      *)
(***************************************************************************)
NOk(st) == st.sqlHolder /\ st.sqlLive /\ st.nFresh

\* Today's state the move moves. A missing pin counts.
Leftover(st) == (\E m \in Msgs : st.cursor[m] = "open") \/ st.pending # {} \/ st.lease.who # "pin"

IdleOnNew(st) == (\A m \in Msgs : st.row[m] # "open") /\ st.inbox = {}

\* A delivery starts an invocation on the new-core deployment, or after a
\* revert also on the reverted one. It reads the current-deployment row.
\* Not current: it takes no lock and acks.
NStart ==
    /\ s.pc["n"] = "idle"
    /\ \E d \in IF s.everRev THEN {"new", "rev"} ELSE {"new"} :
        s' = IF s.cur = d THEN Go([s EXCEPT !.dep = d], "n", "ntake")
             ELSE Flag(s, "nonCurrentNoLock")

\* The SQL lock take (one compare-and-set, P5).
NTake ==
    /\ s.pc["n"] = "ntake" /\ (~s.sqlHolder \/ ~s.sqlLive)
    /\ LET st == [s EXCEPT !.sqlHolder = TRUE, !.sqlLive = TRUE, !.nFresh = TRUE]
       IN s' = IF s.dep = "new"
               THEN Go([st EXCEPT !.core = "new"], "n",
                       IF ~Leftover(st) THEN "nready" ELSE IF EARLYTOMB THEN "ntomb" ELSE "nlease")
               ELSE IF s.core = "new" /\ IdleOnNew(s) THEN Go(st, "n", "mback")
               ELSE IF s.core = "new" THEN Go(st, "n", "nready")
               ELSE IF s.lease.who = "pin" THEN Go(st, "n", "munpin")  \* a move back that crashed
               ELSE Go(st, "n", "nrel")

\* EARLYTOMB only: read the tombstone from SQL before the lease step.
NTomb == s.pc["n"] = "ntomb" /\ s' = Go([s EXCEPT !.nTomb = s.tomb], "n", "nlease")

\* The stale lease fence and the pin, in the conversation mutation. A live
\* lease, or a fence not yet passed: set wakeAtMs and end.
NLease ==
    LET tomb == IF EARLYTOMB THEN s.nTomb ELSE s.tomb
        clear == ~FENCE \/ Max(s.lease.ep, tomb) <= s.fence
        go == \/ s.lease.who = "pin"
              \/ s.lease.who = "" /\ clear
              \/ s.lease.who \in OLD /\ ~s.lease.live /\ clear
        wait == IF s.lease.who = "" THEN "moveWaitsForTombstone" ELSE "moveWaits"
    IN /\ s.pc["n"] = "nlease"
       /\ s' = IF ~NOk(s) THEN Stop(s, "n")
               ELSE IF go THEN Go([s EXCEPT !.lease = Pin], "n", "mlock")
               ELSE Flag(Stop([s EXCEPT !.sqlHolder = FALSE, !.sqlLive = FALSE], "n"), wait)

\* withTurnCursorMutation for each open cursor. Busy: the run fails and a
\* later take repeats the move.
NMoveLock ==
    LET open == {m \in Msgs : s.cursor[m] = "open"}
    IN /\ s.pc["n"] = "mlock"
       /\ s' = IF \A m \in open : s.mlock[m] = ""
               THEN Go([s EXCEPT !.mlock = [m \in Msgs |-> IF m \in open THEN "n" ELSE @[m]]],
                       "n", "minsert")
               ELSE Flag(Stop(s, "n"), "moveLockBusy")

\* The move, part 1 (SQL, fenced): a turn row per open cursor (keyed by turn
\* id), an inbox entry with a request record per waiting input (unique).
NMoveInsert ==
    LET rows == {m \in Msgs : s.cursor[m] = "open" /\ s.row[m] = "none"}
        entries == {m \in s.pending : ~s.rec[m]}
    IN /\ s.pc["n"] = "minsert"
       /\ s' = IF NOk(s)
               THEN Go([s EXCEPT
                   !.row = [m \in Msgs |-> IF m \in rows THEN "open" ELSE @[m]],
                   !.inserts = [m \in Msgs |-> IF m \in rows THEN @[m] + 1 ELSE @[m]],
                   !.rec = [m \in Msgs |-> IF m \in entries THEN TRUE ELSE @[m]],
                   !.inbox = @ \cup entries,
                   !.entries = [m \in Msgs |-> IF m \in entries THEN @[m] + 1 ELSE @[m]]],
                   "n", "mdelete")
               ELSE Stop(s, "n")

\* Part 2 (Redis): delete each cursor that has a row, then the turn locks.
NMoveDelete ==
    /\ s.pc["n"] = "mdelete"
    /\ s' = Go([s EXCEPT !.cursor = [m \in Msgs |-> IF s.row[m] # "none" THEN "none" ELSE @[m]],
                         !.mlock = [m \in Msgs |-> IF @[m] = "n" THEN "" ELSE @[m]]], "n", "mclear")

\* Part 3 (Redis): clear each waiting input that has a request record.
NMoveClear ==
    /\ s.pc["n"] = "mclear"
    /\ s' = Go([s EXCEPT !.pending = {m \in @ : ~s.rec[m]}, !.moved = TRUE], "n", "nready")

NReady ==
    /\ s.pc["n"] = "nready"
    /\ s' = IF ~NOk(s) THEN Stop(s, "n")
            ELSE IF \E m \in Msgs : s.row[m] = "open"
            THEN LET m == CHOOSE x \in Msgs : s.row[x] = "open"
                 IN Go([s EXCEPT !.turn["n"] = m], "n", "nrun")
            ELSE IF s.inbox # {}
            THEN LET m == CHOOSE x \in s.inbox : TRUE
                 IN Go([s EXCEPT !.row[m] = "open", !.inbox = @ \ {m},
                                 !.starts[m] = Bump(@), !.turn["n"] = m], "n", "nrun")
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
            ELSE IF FINISHBACK /\ ((\E m \in Msgs : s.cursor[m] # "none" /\ s.row[m] # "none")
                                  \/ \E m \in s.pending : s.rec[m])
            THEN Go(s, "n", "mfinish")
            ELSE Go(Flag([s EXCEPT !.core = "old", !.moved = FALSE], "movedBack"), "n", "munpin")

NMoveFinish ==
    /\ s.pc["n"] = "mfinish"
    /\ s' = Go([s EXCEPT !.cursor = [m \in Msgs |-> IF s.row[m] # "none" THEN "none" ELSE @[m]],
                         !.pending = {m \in @ : ~s.rec[m]}], "n", "mback")

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
    \/ Flip \/ Tick \/ ExpireDead \/ HeartbeatClear
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

\* After a move finishes and while the pin holds, no today's turn is open
\* and no today's input waits: nothing is left that no worker will run.
noStrandedCursor ==
    (s.moved /\ s.lease.who = "pin" /\ s.pc["n"] \notin MovePcs)
        => (\A m \in Msgs : s.cursor[m] # "open") /\ s.pending = {}

\* The move is idempotent: each turn row and inbox entry is inserted once.
moveIdempotent == \A m \in Msgs : s.inserts[m] <= 1 /\ s.entries[m] <= 1

\* No old-core write (with the lease or without it) opens a turn after a move.
noTurnOpenedAfterMove == "turnOpenedAfterMove" \notin s.ex

\* No today's cursor write after the pin.
noOldWriteAfterPin == "oldWriteAfterPin" \notin s.ex

safety ==
    /\ oneCoreLive /\ noDuplicateTurn /\ noStrandedCursor /\ moveIdempotent
    /\ noTurnOpenedAfterMove /\ noOldWriteAfterPin

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

=============================================================================
