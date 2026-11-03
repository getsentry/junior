---------------------------- MODULE CutoverTree ----------------------------
(***************************************************************************)
(* Model 4: the cutover of a parent and a child (P45, "Parent and child"). *)
(*                                                                         *)
(* A root conversation R invoked a child conversation C. Today the link is *)
(* an active Agent invocation row: the child writes its result there and   *)
(* the root's worker gives it to the root. The root's SQL lock take        *)
(* decides `core`; the child inherits the root's `core`. A new-core root   *)
(* take moves the invocation row into a request record only when the child *)
(* is new-core or idle; otherwise that part waits for a later take.        *)
(*                                                                         *)
(* Workers, all with the reader release (Cutover.tla checks the deploy     *)
(* gate): ro (today's root worker), co (today's child worker), n (new core *)
(* on R), cn (new core on C). Each can crash, or stall so that its lease   *)
(* or lock expires while it runs. The deploy gate turns on once (no       *)
(* revert here; Cutover.tla has it). The root's own turn state and inbox  *)
(* are left out (Cutover.tla).                                             *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    MOVE_RULE,      \* "plan": move when the child is new-core or its lease
                    \* is free; "pin": the move also pins the child's lease
    RESULT_FENCED,  \* co's result write checks its child lease token
    CRASHES, EXPIRIES

Workers == {"ro", "co", "n", "cn"}

VARIABLE s
vars == s

Init ==
    s = [switch |-> FALSE, core |-> "old", childCore |-> "old",
         rootLease |-> "",       \* today's lease on R: "", "ro" or "pin"
         childLease |-> "",      \* today's lease on C: "", "co" or "pin"
         nLock |-> FALSE, cnLock |-> FALSE,   \* SQL locks live
         pc |-> [w \in Workers |-> "idle"],
         child |-> "running",    \* the child's turn: "running" or "done"
         invRow |-> "active",    \* "active", "result", "delivered", "moved"
         record |-> "none",      \* request record: "none", "open", "answered", "delivered"
         delivered |-> 0,        \* ghost: results given to the root
         crashes |-> CRASHES, expiries |-> EXPIRIES, ex |-> {}]

Go(st, w, p) == [st EXCEPT !.pc[w] = p]
Flag(st, f) == [st EXCEPT !.ex = @ \cup {f}]

(***************************************************************************)
(* Environment                                                             *)
(***************************************************************************)
\* The deploy gate turns on (P45: no operator switch).
SwitchOn == ~s.switch /\ s' = [s EXCEPT !.switch = TRUE]

Crash(w) == s.pc[w] # "idle" /\ s.crashes > 0 /\ s' = [Go(s, w, "idle") EXCEPT !.crashes = @ - 1]

\* A dead holder's lease or lock expires.
ExpireDead ==
    \/ s.rootLease = "ro" /\ s.pc["ro"] = "idle" /\ s' = [s EXCEPT !.rootLease = ""]
    \/ s.childLease = "co" /\ s.pc["co"] = "idle" /\ s' = [s EXCEPT !.childLease = ""]
    \/ s.nLock /\ s.pc["n"] = "idle" /\ s' = [s EXCEPT !.nLock = FALSE]
    \/ s.cnLock /\ s.pc["cn"] = "idle" /\ s' = [s EXCEPT !.cnLock = FALSE]

\* A live worker stalls past the TTL and keeps running.
Stall(w) ==
    /\ s.pc[w] # "idle" /\ s.expiries > 0
    /\ \/ w = "ro" /\ s.rootLease = "ro" /\ s' = [s EXCEPT !.rootLease = "", !.expiries = @ - 1]
       \/ w = "co" /\ s.childLease = "co" /\ s' = [s EXCEPT !.childLease = "", !.expiries = @ - 1]
       \/ w = "n" /\ s.nLock /\ s' = [s EXCEPT !.nLock = FALSE, !.expiries = @ - 1]
       \/ w = "cn" /\ s.cnLock /\ s' = [s EXCEPT !.cnLock = FALSE, !.expiries = @ - 1]

(***************************************************************************)
(* Today's root worker (ro): takes R's lease, reads core, gives a written  *)
(* result to the root (a cursor write, fenced by the lease, C3).           *)
(***************************************************************************)
RoTake == s.pc["ro"] = "idle" /\ s.rootLease = "" /\ s' = Go([s EXCEPT !.rootLease = "ro"], "ro", "check")
RoCheck ==
    /\ s.pc["ro"] = "check"
    /\ s' = IF s.core = "old" THEN Go(s, "ro", "run")
            ELSE Flag(Go([s EXCEPT !.rootLease = ""], "ro", "idle"), "refused")
RoDeliver ==
    /\ s.pc["ro"] = "run" /\ s.invRow = "result"
    /\ s' = IF s.rootLease = "ro"
            THEN [s EXCEPT !.invRow = "delivered", !.delivered = @ + 1]
            ELSE Go(s, "ro", "idle")
RoRel == s.pc["ro"] = "run" /\ s' = Go([s EXCEPT !.rootLease = IF @ = "ro" THEN "" ELSE @], "ro", "idle")

(***************************************************************************)
(* Today's child worker (co): takes C's lease, reads the inherited core,   *)
(* runs the child turn and writes the result to the invocation row.        *)
(***************************************************************************)
CoTake ==
    /\ s.pc["co"] = "idle" /\ s.childLease = "" /\ s.child = "running"
    /\ s' = Go([s EXCEPT !.childLease = "co"], "co", "check")
CoCheck ==
    /\ s.pc["co"] = "check"
    /\ s' = IF s.core = "old" /\ s.childCore = "old" THEN Go(s, "co", "run")
            ELSE Flag(Go([s EXCEPT !.childLease = ""], "co", "idle"), "refused")
\* The result write. A row that the move already moved is gone: the
\* result is lost.
CoFinish ==
    /\ s.pc["co"] = "run"
    /\ s' = IF RESULT_FENCED /\ s.childLease # "co" THEN Go(s, "co", "idle")
            ELSE LET st == Go([s EXCEPT !.child = "done",
                                        !.childLease = IF @ = "co" THEN "" ELSE @], "co", "idle")
                 IN IF s.invRow = "active" THEN [st EXCEPT !.invRow = "result"]
                    ELSE Flag(st, "resultLost")

(***************************************************************************)
(* New core on the root (n)                                                *)
(***************************************************************************)
NTake ==
    /\ s.pc["n"] = "idle" /\ ~s.nLock /\ (s.core = "new" \/ s.switch)
    /\ s' = Go([s EXCEPT !.nLock = TRUE, !.core = "new"], "n", "lease")

\* Take or keep the pin on R's lease (Cutover.tla), waiting for ro.
NLease ==
    /\ s.pc["n"] = "lease" /\ s.rootLease \in {"", "pin"}
    /\ s' = Go([s EXCEPT !.rootLease = "pin"], "n", "move")

ChildFree ==
    IF MOVE_RULE = "pin" THEN s.childLease \in {"", "pin"}
    ELSE s.childCore = "new" \/ s.childLease = ""

\* The invocation row moves into a request record (fenced by n's lock).
NMove ==
    /\ s.pc["n"] = "move"
    /\ s' = IF ~s.nLock THEN Go(s, "n", "idle")
            ELSE IF s.invRow \in {"active", "result"} /\ ChildFree
            THEN Go([s EXCEPT !.record = IF s.invRow = "result" THEN "answered" ELSE "open",
                              !.invRow = "moved",
                              !.childLease = IF MOVE_RULE = "pin" THEN "pin" ELSE @], "n", "run")
            ELSE Go(IF s.invRow \in {"active", "result"} THEN Flag(s, "moveWaits") ELSE s, "n", "run")

NDeliver ==
    /\ s.pc["n"] = "run" /\ s.record = "answered"
    /\ s' = IF s.nLock THEN [s EXCEPT !.record = "delivered", !.delivered = @ + 1]
            ELSE Go(s, "n", "idle")
NRel == s.pc["n"] = "run" /\ s' = Go([s EXCEPT !.nLock = FALSE], "n", "idle")

(***************************************************************************)
(* New core on the child (cn): its take inherits the root's core and, as   *)
(* for any conversation, pins today's lease. The result goes to the        *)
(* request record; with no record yet it waits.                            *)
(***************************************************************************)
CnTake ==
    /\ s.pc["cn"] = "idle" /\ ~s.cnLock /\ s.core = "new" /\ s.child = "running"
    /\ s.childLease \in {"", "pin"}
    /\ s' = Go([s EXCEPT !.cnLock = TRUE, !.childCore = "new", !.childLease = "pin"], "cn", "run")
CnFinish ==
    /\ s.pc["cn"] = "run" /\ s.record = "open"
    /\ s' = IF s.cnLock THEN Go([s EXCEPT !.record = "answered", !.child = "done", !.cnLock = FALSE], "cn", "idle")
            ELSE Go(s, "cn", "idle")
CnRel == s.pc["cn"] = "run" /\ s' = Go([s EXCEPT !.cnLock = FALSE], "cn", "idle")

(***************************************************************************)
Next ==
    \/ RoTake \/ RoCheck \/ RoDeliver \/ RoRel
    \/ CoTake \/ CoCheck \/ CoFinish
    \/ NTake \/ NLease \/ NMove \/ NDeliver \/ NRel
    \/ CnTake \/ CnFinish \/ CnRel
    \/ SwitchOn \/ ExpireDead
    \/ \E w \in Workers : Crash(w) \/ Stall(w)

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Safety                                                                  *)
(***************************************************************************)
\* A finished child's result is never lost: it waits in the row or the
\* record, or the root has it.
resultNotLost ==
    /\ "resultLost" \notin s.ex
    /\ s.child = "done" => (s.invRow \in {"result", "delivered"} \/ s.record \in {"answered", "delivered"})

\* The result never has two owners: it is in one place and the root gets
\* it at most once.
resultOneOwner ==
    /\ s.delivered <= 1
    /\ ~(s.invRow \in {"result", "delivered"} /\ s.record \in {"answered", "delivered"})

safety == resultNotLost /\ resultOneOwner

\* Worked examples: each must be reachable.
ex_childMovedThenAnsweredOnNew == ~(s.record = "delivered" /\ s.childCore = "new")
ex_resultMovedAnswered == ~(s.record = "delivered" /\ s.childCore = "old")
ex_moveWaitsForBusyChild == "moveWaits" \notin s.ex

=============================================================================
