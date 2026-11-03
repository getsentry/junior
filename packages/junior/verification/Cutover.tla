------------------------------ MODULE Cutover ------------------------------
(***************************************************************************)
(* Model 3: the cutover under a rolling deploy (P45).                      *)
(*                                                                         *)
(* One conversation. Three workers:                                        *)
(* - o1: today's worker without the reader release (tasks.md step 14). It  *)
(*   takes today's Redis lease and never reads `core`.                     *)
(* - o2: today's worker with the reader release. After it takes the lease  *)
(*   it reads `core` and refuses a new-core conversation, or moves an idle *)
(*   one back when the cutover switch is off (the rollback path).          *)
(* - n: the new core. Its SQL lock take sets `core` in the same            *)
(*   compare-and-set (P5). On the take that sets `core` to new, it takes   *)
(*   today's Redis lease, waits for it, and moves the state: insert the    *)
(*   turn row (keyed by turn id, once), then delete the Redis cursor.      *)
(*                                                                         *)
(* Input i1 has an open Redis turn cursor at start. Input i2 may arrive at *)
(* any time. The inbox is one logical inbox that both paths read: the move *)
(* of today's mailbox input is not modeled.                                *)
(*                                                                         *)
(* A worker can crash at any step (its lease or lock stays until expiry),  *)
(* or stall so that its lease or lock expires while it still runs. The     *)
(* cutover switch can flip both ways.                                      *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    WITH_O1,     \* a worker without the reader release is still running
    MOVE_CHECK,  \* "first": move only on the take that sets core new;
                 \* "always": every new-core take moves leftover Redis state
    PIN_LEASE,   \* the move leaves today's lease key held for the new core
    OLD_FENCED,  \* today's cursor writes check the conversation lease token
    CRASHES,     \* worker crashes per run
    EXPIRIES,    \* lease or lock expiries of live workers per run
    FLIPS        \* cutover switch flips per run

Msgs == {"i1", "i2"}
OldWorkers == IF WITH_O1 THEN {"o1", "o2"} ELSE {"o2"}
Workers == OldWorkers \cup {"n"}
MovePcs == {"nlease", "minsert", "mdelete"}

VARIABLES
    core,       \* conversation row owner: "old" or "new"
    switch,     \* the cutover switch
    lease,      \* today's Redis lease: "", a worker, or "pin" (PIN_LEASE)
    sqlHolder,  \* the SQL lock: "" or "n"
    sqlLive,    \* the SQL lock has not expired
    nFresh,     \* n's lock version is the current one (P5 fence)
    pc, turn,   \* worker step and the turn (input) it runs
    cursor,     \* Redis turn cursor per turn: "none", "open", "done"
    row,        \* SQL turn row per turn: "none", "open", "done"
    pending,    \* input not yet taken into a turn
    arrived,
    starts, oldFin, newFin, inserts,  \* ghost counts per turn
    crashes, expiries, flips, ex

vars == <<core, switch, lease, sqlHolder, sqlLive, nFresh, pc, turn, cursor, row,
          pending, arrived, starts, oldFin, newFin, inserts, crashes, expiries, flips, ex>>

Init ==
    /\ core = "old" /\ switch = FALSE /\ lease = ""
    /\ sqlHolder = "" /\ sqlLive = FALSE /\ nFresh = FALSE
    /\ pc = [w \in Workers |-> "idle"] /\ turn = [w \in Workers |-> ""]
    /\ cursor = [m \in Msgs |-> IF m = "i1" THEN "open" ELSE "none"]
    /\ row = [m \in Msgs |-> "none"]
    /\ pending = {} /\ arrived = {"i1"}
    /\ starts = [m \in Msgs |-> IF m = "i1" THEN 1 ELSE 0]
    /\ oldFin = [m \in Msgs |-> 0] /\ newFin = [m \in Msgs |-> 0]
    /\ inserts = [m \in Msgs |-> 0]
    /\ crashes = CRASHES /\ expiries = EXPIRIES /\ flips = FLIPS /\ ex = {}

Stop(w) == /\ pc' = [pc EXCEPT ![w] = "idle"] /\ turn' = [turn EXCEPT ![w] = ""]

(***************************************************************************)
(* Environment                                                             *)
(***************************************************************************)
Arrive == "i2" \notin arrived /\ arrived' = arrived \cup {"i2"} /\ pending' = pending \cup {"i2"}
          /\ UNCHANGED <<core, switch, lease, sqlHolder, sqlLive, nFresh, pc, turn, cursor, row,
                         starts, oldFin, newFin, inserts, crashes, expiries, flips, ex>>

Flip == flips > 0 /\ switch' = ~switch /\ flips' = flips - 1
        /\ UNCHANGED <<core, lease, sqlHolder, sqlLive, nFresh, pc, turn, cursor, row, pending,
                       arrived, starts, oldFin, newFin, inserts, crashes, expiries, ex>>

Crash(w) ==
    /\ pc[w] # "idle" /\ crashes > 0 /\ crashes' = crashes - 1 /\ Stop(w)
    /\ UNCHANGED <<core, switch, lease, sqlHolder, sqlLive, nFresh, cursor, row, pending,
                   arrived, starts, oldFin, newFin, inserts, expiries, flips, ex>>

\* A dead holder's lease or lock expires.
ExpireDead ==
    \/ /\ lease \in Workers /\ pc[lease] = "idle" /\ lease' = ""
       /\ UNCHANGED <<sqlHolder, sqlLive>>
    \/ /\ sqlHolder = "n" /\ sqlLive /\ pc["n"] = "idle" /\ sqlLive' = FALSE
       /\ UNCHANGED <<lease, sqlHolder>>
ExpireDeadStep ==
    ExpireDead /\ UNCHANGED <<core, switch, nFresh, pc, turn, cursor, row, pending, arrived,
                              starts, oldFin, newFin, inserts, crashes, expiries, flips, ex>>

\* A live worker stalls past the TTL. It keeps running.
Stall(w) ==
    /\ pc[w] # "idle" /\ expiries > 0 /\ expiries' = expiries - 1
    /\ \/ lease = w /\ lease' = "" /\ UNCHANGED <<sqlHolder, sqlLive>>
       \/ w = "n" /\ sqlHolder = "n" /\ sqlLive /\ sqlLive' = FALSE /\ UNCHANGED <<lease, sqlHolder>>
    /\ UNCHANGED <<core, switch, nFresh, pc, turn, cursor, row, pending, arrived,
                   starts, oldFin, newFin, inserts, crashes, flips, ex>>

(***************************************************************************)
(* Today's workers (o1, o2)                                                *)
(***************************************************************************)
Go(w, p) == pc' = [pc EXCEPT ![w] = p]

\* No open turn and no open record on the new core (P45 rollback).
IdleOnNew == (\A m \in Msgs : row[m] # "open") /\ pending = {}

OTake(w) ==
    /\ w \in OldWorkers /\ pc[w] = "idle"
    /\ lease = "" /\ lease' = w /\ Go(w, "leased")
    /\ UNCHANGED <<core, switch, sqlHolder, sqlLive, nFresh, turn, cursor, row, pending,
                   arrived, starts, oldFin, newFin, inserts, crashes, expiries, flips, ex>>

\* o1 does not read core. o2 reads it with the lease held. Moving back is a
\* SQL lock take: it needs a free lock and raises the lock version.
OCheck(w) ==
    /\ pc[w] = "leased"
    /\ IF w = "o1" \/ core = "old"
       THEN Go(w, "oready") /\ UNCHANGED <<core, sqlHolder, sqlLive, nFresh, lease, ex>>
       ELSE IF ~switch /\ IdleOnNew /\ ~(sqlHolder = "n" /\ sqlLive)
       THEN /\ core' = "old" /\ nFresh' = FALSE /\ sqlHolder' = "" /\ sqlLive' = FALSE
            /\ ex' = ex \cup {"movedBack"} /\ Go(w, "oready") /\ UNCHANGED lease
       ELSE /\ lease' = IF lease = w THEN "" ELSE lease
            /\ Go(w, "idle")
            /\ ex' = ex \cup {"refused"}
            /\ UNCHANGED <<core, sqlHolder, sqlLive, nFresh>>
    /\ UNCHANGED <<switch, turn, cursor, row, pending, arrived, starts, oldFin, newFin, inserts,
                   crashes, expiries, flips>>

\* PIN_LEASE: o2 finds the pin. It reads core without taking the lease. A
\* pin on an old-core conversation is left by a move back that crashed
\* before it cleared the pin. Moving back replaces the pin with o2's lease.
OPin(w) ==
    /\ PIN_LEASE /\ w = "o2" /\ pc[w] = "idle" /\ lease = "pin"
    /\ IF core = "old"
       THEN lease' = w /\ Go(w, "oready") /\ UNCHANGED <<core, sqlHolder, sqlLive, nFresh, ex>>
       ELSE IF ~switch /\ IdleOnNew /\ ~(sqlHolder = "n" /\ sqlLive)
       THEN /\ core' = "old" /\ nFresh' = FALSE /\ sqlHolder' = "" /\ sqlLive' = FALSE
            /\ lease' = w /\ ex' = ex \cup {"movedBack"} /\ Go(w, "oready")
       ELSE /\ ex' = ex \cup {"refused"}
            /\ UNCHANGED <<core, sqlHolder, sqlLive, nFresh, lease, pc>>
    /\ UNCHANGED <<switch, turn, cursor, row, pending, arrived, starts, oldFin, newFin, inserts,
                   crashes, expiries, flips>>

\* A cursor write. With OLD_FENCED it checks the lease token first.
OldOk(w) == ~OLD_FENCED \/ lease = w

OReady(w) ==
    /\ pc[w] = "oready"
    /\ IF \E m \in Msgs : cursor[m] = "open"
       THEN LET m == CHOOSE x \in Msgs : cursor[x] = "open"
            IN /\ turn' = [turn EXCEPT ![w] = m] /\ Go(w, "orun")
               /\ UNCHANGED <<cursor, pending, starts, ex>>
       ELSE IF pending # {}
       THEN LET m == CHOOSE x \in pending : TRUE
            IN IF OldOk(w)
               THEN /\ cursor' = [cursor EXCEPT ![m] = "open"] /\ pending' = pending \ {m}
                    /\ starts' = [starts EXCEPT ![m] = @ + 1]
                    /\ turn' = [turn EXCEPT ![w] = m] /\ Go(w, "orun") /\ UNCHANGED ex
               ELSE Stop(w) /\ UNCHANGED <<cursor, pending, starts, ex>>
       ELSE Go(w, "orel") /\ UNCHANGED <<turn, cursor, pending, starts, ex>>
    /\ UNCHANGED <<core, switch, lease, sqlHolder, sqlLive, nFresh, row, arrived, oldFin,
                   newFin, inserts, crashes, expiries, flips>>

\* A checkpoint save: rewrites the cursor as open.
OSave(w) ==
    /\ pc[w] = "orun"
    /\ IF OldOk(w)
       THEN /\ cursor' = [cursor EXCEPT ![turn[w]] = "open"]
            /\ ex' = IF cursor[turn[w]] = "none" THEN ex \cup {"cursorRecreated"} ELSE ex
            /\ UNCHANGED <<pc, turn>>
       ELSE Stop(w) /\ UNCHANGED <<cursor, ex>>
    /\ UNCHANGED <<core, switch, lease, sqlHolder, sqlLive, nFresh, row, pending, arrived,
                   starts, oldFin, newFin, inserts, crashes, expiries, flips>>

OFinish(w) ==
    /\ pc[w] = "orun"
    /\ IF OldOk(w)
       THEN /\ cursor' = [cursor EXCEPT ![turn[w]] = "done"]
            /\ oldFin' = [oldFin EXCEPT ![turn[w]] = @ + 1] /\ Go(w, "oready")
            /\ UNCHANGED turn
       ELSE Stop(w) /\ UNCHANGED <<cursor, oldFin>>
    /\ UNCHANGED <<core, switch, lease, sqlHolder, sqlLive, nFresh, row, pending, arrived,
                   starts, newFin, inserts, crashes, expiries, flips, ex>>

ORel(w) ==
    /\ pc[w] = "orel"
    /\ lease' = (IF lease = w THEN "" ELSE lease) /\ Stop(w)
    /\ UNCHANGED <<core, switch, sqlHolder, sqlLive, nFresh, cursor, row, pending, arrived,
                   starts, oldFin, newFin, inserts, crashes, expiries, flips, ex>>

(***************************************************************************)
(* The new core (n)                                                        *)
(***************************************************************************)
LeftoverRedis == \E m \in Msgs : cursor[m] = "open"

\* acquireWorkerLock: one SQL compare-and-set takes the lock, raises the
\* version and sets core. With the switch off it does not take an old-core
\* conversation (today's path runs it).
NTake ==
    /\ pc["n"] = "idle" /\ (sqlHolder = "" \/ ~sqlLive)
    /\ core = "new" \/ switch
    /\ sqlHolder' = "n" /\ sqlLive' = TRUE /\ nFresh' = TRUE /\ core' = "new"
    /\ Go("n", IF core = "old" \/ (MOVE_CHECK = "always" /\ LeftoverRedis) THEN "nlease" ELSE "nready")
    /\ UNCHANGED <<switch, lease, turn, cursor, row, pending, arrived, starts, oldFin, newFin, inserts,
                   crashes, expiries, flips, ex>>

\* Take today's lease: wait while an old worker holds it. With PIN_LEASE
\* the take writes the pin (no expiry) at once.
NLease ==
    /\ pc["n"] = "nlease"
    /\ lease = "" \/ (PIN_LEASE /\ lease = "pin")
    /\ lease' = (IF PIN_LEASE THEN "pin" ELSE "n") /\ Go("n", "minsert")
    /\ UNCHANGED <<core, switch, sqlHolder, sqlLive, nFresh, turn, cursor, row, pending, arrived,
                   starts, oldFin, newFin, inserts, crashes, expiries, flips, ex>>

NOk == nFresh /\ sqlHolder = "n" /\ sqlLive

\* The move, part 1 (SQL, fenced): insert a turn row for each open cursor,
\* once (keyed by turn id).
NMoveInsert ==
    /\ pc["n"] = "minsert"
    /\ IF NOk
       THEN LET new == {m \in Msgs : cursor[m] = "open" /\ row[m] = "none"}
            IN /\ row' = [m \in Msgs |-> IF m \in new THEN "open" ELSE row[m]]
               /\ inserts' = [m \in Msgs |-> IF m \in new THEN inserts[m] + 1 ELSE inserts[m]]
               /\ Go("n", "mdelete") /\ UNCHANGED turn
       ELSE Stop("n") /\ UNCHANGED <<row, inserts>>
    /\ ex' = IF \E m \in Msgs : cursor[m] = "open" /\ row[m] # "none" THEN ex \cup {"moveRepeated"} ELSE ex
    /\ UNCHANGED <<core, switch, lease, sqlHolder, sqlLive, nFresh, cursor, pending, arrived,
                   starts, oldFin, newFin, crashes, expiries, flips>>

\* The move, part 2 (Redis): delete each cursor that now has a row. Then
\* give the lease back (with PIN_LEASE the pin stays).
NMoveDelete ==
    /\ pc["n"] = "mdelete"
    /\ cursor' = [m \in Msgs |-> IF cursor[m] = "open" /\ row[m] # "none" THEN "none" ELSE cursor[m]]
    /\ lease' = IF lease = "n" THEN "" ELSE lease
    /\ Go("n", "nready")
    /\ UNCHANGED <<core, switch, sqlHolder, sqlLive, nFresh, turn, row, pending, arrived,
                   starts, oldFin, newFin, inserts, crashes, expiries, flips, ex>>

NReady ==
    /\ pc["n"] = "nready"
    /\ IF \E m \in Msgs : row[m] = "open"
       THEN LET m == CHOOSE x \in Msgs : row[x] = "open"
            IN turn' = [turn EXCEPT !["n"] = m] /\ Go("n", "nrun")
               /\ UNCHANGED <<row, pending, starts>>
       ELSE IF pending # {}
       THEN LET m == CHOOSE x \in pending : TRUE
            IN IF NOk
               THEN /\ row' = [row EXCEPT ![m] = "open"] /\ pending' = pending \ {m}
                    /\ starts' = [starts EXCEPT ![m] = @ + 1]
                    /\ turn' = [turn EXCEPT !["n"] = m] /\ Go("n", "nrun")
               ELSE Stop("n") /\ UNCHANGED <<row, pending, starts>>
       ELSE Go("n", "nrel") /\ UNCHANGED <<turn, row, pending, starts>>
    /\ UNCHANGED <<core, switch, lease, sqlHolder, sqlLive, nFresh, cursor, arrived, oldFin,
                   newFin, inserts, crashes, expiries, flips, ex>>

NFinish ==
    /\ pc["n"] = "nrun"
    /\ IF NOk
       THEN /\ row' = [row EXCEPT ![turn["n"]] = "done"]
            /\ newFin' = [newFin EXCEPT ![turn["n"]] = @ + 1] /\ Go("n", "nready")
            /\ UNCHANGED turn
       ELSE Stop("n") /\ UNCHANGED <<row, newFin>>
    /\ UNCHANGED <<core, switch, lease, sqlHolder, sqlLive, nFresh, cursor, pending, arrived,
                   starts, oldFin, inserts, crashes, expiries, flips, ex>>

NRel ==
    /\ pc["n"] = "nrel"
    /\ sqlHolder' = (IF NOk THEN "" ELSE sqlHolder) /\ Stop("n")
    /\ UNCHANGED <<core, switch, lease, sqlLive, nFresh, cursor, row, pending, arrived,
                   starts, oldFin, newFin, inserts, crashes, expiries, flips, ex>>

(***************************************************************************)
Old(w) == OTake(w) \/ OPin(w) \/ OCheck(w) \/ OReady(w) \/ OSave(w) \/ OFinish(w) \/ ORel(w)
New == NTake \/ NLease \/ NMoveInsert \/ NMoveDelete \/ NReady \/ NFinish \/ NRel

Next ==
    \/ \E w \in OldWorkers : Old(w)
    \/ New
    \/ Arrive \/ Flip \/ ExpireDeadStep
    \/ \E w \in Workers : Crash(w) \/ Stall(w)

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Safety                                                                  *)
(***************************************************************************)
OldRuns(w) == pc[w] = "orun"
NewRuns == pc["n"] = "nrun"

\* No conversation runs on both cores at once (stalled workers included).
oneCore == ~((\E w \in OldWorkers : OldRuns(w)) /\ NewRuns)

\* The same, counting only workers whose lease or lock is still live and
\* current. A stalled worker's window is P5 "Limit".
oneCoreLive ==
    ~((\E w \in OldWorkers : OldRuns(w) /\ lease = w) /\ NewRuns /\ NOk)

\* A turn starts at most once and is not finished on both cores.
noCrossCoreDuplicate == \A m \in Msgs : starts[m] <= 1 /\ ~(oldFin[m] > 0 /\ newFin[m] > 0)

\* A turn finishes at most once. Two of today's workers can break this
\* without the cutover (a stalled worker, no fence), so it is not in safety.
noDuplicateTurn == \A m \in Msgs : starts[m] <= 1 /\ oldFin[m] + newFin[m] <= 1

\* An open turn is never lost: until it finishes, its cursor or its row is
\* open, or a worker runs it.
noLostTurn ==
    \A m \in Msgs :
        (starts[m] > 0 /\ oldFin[m] + newFin[m] = 0)
            => (cursor[m] = "open" \/ row[m] = "open" \/ \E w \in Workers : turn[w] = m)

\* A cursor that the new core owns is moved later: o2 refuses it, and with
\* "first" no later take moves it.
noStrandedCursor ==
    \A m \in Msgs :
        (cursor[m] = "open" /\ core = "new" /\ row[m] = "none")
            => (MOVE_CHECK = "always" \/ pc["n"] \in MovePcs)

\* The move is idempotent: each turn row is inserted at most once, and a
\* repeat never reopens a finished turn.
moveIdempotent == \A m \in Msgs : inserts[m] <= 1

safety ==
    /\ oneCoreLive /\ noCrossCoreDuplicate /\ noLostTurn /\ noStrandedCursor
    /\ moveIdempotent

\* Worked examples: each must be reachable.
ex_movedBack == "movedBack" \notin ex
ex_moveRepeatedAfterCrash == "moveRepeated" \notin ex
ex_movedThenFinishedOnNew == ~(row["i1"] = "done" /\ cursor["i1"] = "none")
ex_refusedByReader == "refused" \notin ex

=============================================================================
