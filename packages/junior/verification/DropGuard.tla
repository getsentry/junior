----------------------------- MODULE DropGuard -----------------------------
(***************************************************************************)
(* Model 6: the P45 column-drop guard (plan 5356776, step 17).             *)
(*                                                                         *)
(* Step 15 reads the `core` column, staleLeaseAcquiredAtMs and the current *)
(* row. Step 17's migration drops them. It runs only when the current row  *)
(* has old_core_deleted (step 16) and step 15's deployment row has         *)
(* lastSeenAtMs at least WAIT old. Time is in units of 15 s, kept as ages  *)
(* so the state space stays small. Each bound is checked through the unit  *)
(* it ends in, so the model is up to one unit per bound more pessimistic   *)
(* than the host.                                                          *)
(* - Step 16 was just promoted. Production `prod` gets ingress and the     *)
(*   cron. The cron runs at least every CRON units and sets the current    *)
(*   row (`row`) to `prod`. FLIPS: a revert to step 15 and a promote       *)
(*   again before the drop; both can fall within one cron interval, so no  *)
(*   cron sees them.                                                       *)
(* - A step 15 invocation starts from Slack ingress while step 15 is       *)
(*   production, or from a delivery of its own queue message at any time.  *)
(*   Ingress always works: it reads `core`. A delivery reads the current   *)
(*   row and works only if the row names step 15; else it acks and sends   *)
(*   nothing. Only an invocation that works first upserts its deployment   *)
(*   row: lastSeenAtMs (`seen` is its age), and only when it is more than  *)
(*   THROTTLE old. One that works can send queue messages to its own       *)
(*   deployment. Vercel ends each invocation at MD.                        *)
(* - A message can be delivered (again) until RET after its send: the      *)
(*   retention and the signature age both count from the send.             *)
(* - App and database clocks differ by up to SKEW: the migration can run   *)
(*   SKEW early.                                                           *)
(***************************************************************************)
EXTENDS Integers

CONSTANTS MD, RET, SKEW, WAIT, CRON, THROTTLE, FLIPS, INVS, SENDS, STARTS

Slots == 1..INVS
MSlots == 1..SENDS

VARIABLES prod, row, lag, seen, inv, msg, flips, sends, starts, dropped
vars == <<prod, row, lag, seen, inv, msg, flips, sends, starts, dropped>>

\* inv[i]: a step 15 invocation. msg[j]: -1 when free, else its age. In
\* flight at the promote: working invocations and messages of age 0; the
\* last lastSeenAtMs write is up to THROTTLE old.
Off == [on |-> FALSE, age |-> 0, works |-> FALSE]
Init ==
    /\ prod = 16 /\ row = 15 /\ lag = 0 /\ seen \in 0..THROTTLE
    /\ inv \in [Slots -> {Off, [on |-> TRUE, age |-> 0, works |-> TRUE]}]
    /\ msg \in [MSlots -> {-1, 0}]
    /\ flips = FLIPS /\ sends = SENDS /\ starts = STARTS /\ dropped = FALSE

Free(i) == ~inv[i].on
Cap(x, k) == IF x > k THEN k ELSE x

\* A step 15 invocation starts. If it works, the deployment row upsert
\* comes first.
Start(i, works) ==
    /\ Free(i) /\ starts > 0
    /\ inv' = [inv EXCEPT ![i] = [on |-> TRUE, age |-> 0, works |-> works]]
    /\ seen' = IF works /\ seen > THROTTLE THEN 0 ELSE seen
    /\ starts' = starts - 1
    /\ UNCHANGED <<prod, row, lag, msg, flips, sends, dropped>>

Ingress(i) == prod = 15 /\ Start(i, TRUE)
Deliver(i) == (\E j \in MSlots : msg[j] # -1) /\ Start(i, row = 15)

\* A working step 15 invocation sends a message to its own deployment.
Send(i) ==
    /\ ~Free(i) /\ inv[i].works /\ sends > 0
    /\ \E j \in MSlots : msg[j] = -1 /\ msg' = [msg EXCEPT ![j] = 0]
    /\ sends' = sends - 1
    /\ UNCHANGED <<prod, row, lag, seen, inv, flips, starts, dropped>>

End(i) == ~Free(i) /\ inv' = [inv EXCEPT ![i] = Off]
          /\ UNCHANGED <<prod, row, lag, seen, msg, flips, sends, starts, dropped>>
Ack(j) == msg[j] # -1 /\ msg' = [msg EXCEPT ![j] = -1]
          /\ UNCHANGED <<prod, row, lag, seen, inv, flips, sends, starts, dropped>>

\* A revert to step 15, or a promote of step 16 again. Not after the drop:
\* an Instant Rollback below step 16 after step 17 fails (the plan: only
\* roll forward).
Flip ==
    /\ flips > 0 /\ ~dropped
    /\ prod' = (IF prod = 16 THEN 15 ELSE 16) /\ flips' = flips - 1
    /\ UNCHANGED <<row, lag, seen, inv, msg, sends, starts, dropped>>

Cron ==
    /\ row' = prod /\ lag' = 0
    /\ UNCHANGED <<prod, seen, inv, msg, flips, sends, starts, dropped>>

\* One unit passes. An invocation past MD ends; a message past RET expires.
Tick ==
    /\ lag < CRON
    /\ inv' = [i \in Slots |-> IF Free(i) \/ inv[i].age >= MD THEN Off
                               ELSE [inv[i] EXCEPT !.age = @ + 1]]
    /\ msg' = [j \in MSlots |-> IF msg[j] = -1 \/ msg[j] >= RET THEN -1 ELSE msg[j] + 1]
    /\ seen' = Cap(seen + 1, WAIT)
    /\ lag' = IF row = prod THEN 0 ELSE lag + 1
    /\ UNCHANGED <<prod, row, flips, sends, starts, dropped>>

\* Step 17's migration, while step 16 is production. A revert in progress
\* that no invocation has reached yet is invisible to any guard: it is the
\* Instant Rollback after step 17 that the plan rules out.
Drop ==
    /\ ~dropped /\ prod = 16 /\ row = 16 /\ seen + SKEW >= WAIT
    /\ dropped' = TRUE
    /\ UNCHANGED <<prod, row, lag, seen, inv, msg, flips, sends, starts>>

Next ==
    \/ \E i \in Slots : Ingress(i) \/ Deliver(i) \/ Send(i) \/ End(i)
    \/ \E j \in MSlots : Ack(j)
    \/ Flip \/ Cron \/ Tick \/ Drop

Spec == Init /\ [][Next]_vars

\* No step 15 invocation runs after the drop.
noReadAfterDrop == dropped => \A i \in Slots : Free(i)

\* Worked example: the drop runs after a revert and a promote again.
ex_droppedAfterFlips == ~(dropped /\ flips = 0)

=============================================================================
