----------------------------- MODULE DropGuard -----------------------------
(***************************************************************************)
(* Model 6: the P45 column-drop guard (plan 170f513, step 17).             *)
(*                                                                         *)
(* Step 15 reads the `core` column, staleLeaseAcquiredAtMs and the current *)
(* row. Step 17's migration drops them. It runs only when the current row  *)
(* has old_core_deleted (step 16) and currentSinceAtMs is at least WAIT    *)
(* old. Time is in units of 15 s, kept as ages so the state space stays    *)
(* small. Each bound is checked through the unit it ends in, so the model  *)
(* is up to one unit per bound more pessimistic than the host.             *)
(* - Step 16 was just promoted. Ingress and the cron go only to it. The    *)
(*   cron runs at least every CRON units; its first run sets the current   *)
(*   row (`row`) to step 16 and currentSinceAtMs (`since` is its age).     *)
(* - A step 15 invocation reads the current row when it starts. If the row *)
(*   names step 15 it works and can send queue messages to its own         *)
(*   deployment; else it acks and sends nothing. Vercel ends it at MD.     *)
(* - A message can be delivered (again) until RET after its send: the      *)
(*   retention and the signature age both count from the send.             *)
(* - App and database clocks differ by up to SKEW: the migration can run   *)
(*   SKEW early.                                                           *)
(* Not modeled: an Instant Rollback to step 15 and a promote again.        *)
(***************************************************************************)
EXTENDS Integers

CONSTANTS MD, RET, SKEW, WAIT, CRON, INVS, SENDS, STARTS

Slots == 1..INVS
MSlots == 1..SENDS

VARIABLES row, lag, since, inv, msg, sends, starts, dropped
vars == <<row, lag, since, inv, msg, sends, starts, dropped>>

\* inv[i]: a step 15 invocation. msg[j]: -1 when free, else its age. In
\* flight at the promote: working invocations and messages of age 0.
Off == [on |-> FALSE, age |-> 0, works |-> FALSE]
Init ==
    /\ row = 15 /\ lag = 0 /\ since = 0
    /\ inv \in [Slots -> {Off, [on |-> TRUE, age |-> 0, works |-> TRUE]}]
    /\ msg \in [MSlots -> {-1, 0}]
    /\ sends = SENDS /\ starts = STARTS /\ dropped = FALSE

Free(i) == ~inv[i].on

\* A delivery of a step 15 message starts a step 15 invocation.
Deliver(i) ==
    /\ \E j \in MSlots : msg[j] # -1
    /\ Free(i) /\ starts > 0
    /\ inv' = [inv EXCEPT ![i] = [on |-> TRUE, age |-> 0, works |-> row = 15]]
    /\ starts' = starts - 1
    /\ UNCHANGED <<row, lag, since, msg, sends, dropped>>

\* A working step 15 invocation sends a message to its own deployment.
Send(i) ==
    /\ ~Free(i) /\ inv[i].works /\ sends > 0
    /\ \E j \in MSlots : msg[j] = -1 /\ msg' = [msg EXCEPT ![j] = 0]
    /\ sends' = sends - 1
    /\ UNCHANGED <<row, lag, since, inv, starts, dropped>>

End(i) == ~Free(i) /\ inv' = [inv EXCEPT ![i] = Off]
          /\ UNCHANGED <<row, lag, since, msg, sends, starts, dropped>>
Ack(j) == msg[j] # -1 /\ msg' = [msg EXCEPT ![j] = -1]
          /\ UNCHANGED <<row, lag, since, inv, sends, starts, dropped>>

Cron ==
    /\ row = 15
    /\ row' = 16 /\ since' = 0
    /\ UNCHANGED <<lag, inv, msg, sends, starts, dropped>>

Cap(x, k) == IF x > k THEN k ELSE x

\* One unit passes. An invocation past MD ends; a message past RET expires.
Tick ==
    /\ row = 16 \/ lag < CRON
    /\ inv' = [i \in Slots |-> IF Free(i) \/ inv[i].age >= MD THEN Off
                               ELSE [inv[i] EXCEPT !.age = @ + 1]]
    /\ msg' = [j \in MSlots |-> IF msg[j] = -1 \/ msg[j] >= RET THEN -1 ELSE msg[j] + 1]
    /\ since' = IF row = 16 THEN Cap(since + 1, WAIT) ELSE since
    /\ lag' = IF row = 16 THEN 0 ELSE lag + 1
    /\ UNCHANGED <<row, sends, starts, dropped>>

\* Step 17's migration.
Drop ==
    /\ ~dropped /\ row = 16 /\ since + SKEW >= WAIT
    /\ dropped' = TRUE
    /\ UNCHANGED <<row, lag, since, inv, msg, sends, starts>>

Next ==
    \/ \E i \in Slots : Deliver(i) \/ Send(i) \/ End(i)
    \/ \E j \in MSlots : Ack(j)
    \/ Cron \/ Tick \/ Drop

Spec == Init /\ [][Next]_vars

\* No step 15 invocation runs after the drop.
noReadAfterDrop == dropped => \A i \in Slots : Free(i)

\* Worked example: the drop runs.
ex_dropped == ~dropped

=============================================================================
