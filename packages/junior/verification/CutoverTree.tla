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
(*                                                                         *)
(* MOVE_RULE "shim" (plan 5356776, C7 in the shim's terms): no gate, and   *)
(* the child's lease has the stale lease fence of CutoverShim.tla: epochs, *)
(* `cfence`, the tombstone `ctomb`; an expired lease stays until the       *)
(* heartbeat clear (with the tombstone) or a take over it. The row moves   *)
(* only after the child passes the fence (lease, then tombstone, in one    *)
(* step: C11) and is pinned. cp is a child worker from before step 3: no   *)
(* core read, no tombstone, takes only an absent lease. No result write    *)
(* checks a token. "shimNoFence": the same with the child's fence off;     *)
(* "shimNoPin": the move does not pin the child; "shimEarlyTomb": the move *)
(* reads the child's tombstone before the root's lease step (C11).         *)
(* The root keeps the lease check: it stands for the root's own fence,     *)
(* which CutoverShim.tla checks.                                           *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    MOVE_RULE,      \* "plan": move when the child is new-core or its lease
                    \* is free; "pin": the move also pins the child's lease;
                    \* "shim", "shimNoFence", "shimNoPin", "shimEarlyTomb": see above
    RESULT_FENCED,  \* co's result write checks its child lease token
    TAKES,          \* "shim": child lease takes per run
    CRASHES, EXPIRIES

Shim == MOVE_RULE \in {"shim", "shimNoFence", "shimNoPin", "shimEarlyTomb"}
ChildWorkers == IF Shim THEN {"co", "cp"} ELSE {"co"}
Workers == {"ro", "n", "cn"} \cup ChildWorkers
Max(x, y) == IF x > y THEN x ELSE y

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
         \* "shim": the child lease's epoch and expiry, the fence, the tombstone
         childEp |-> 0, childLive |-> FALSE, cep |-> 0, cfence |-> 0, ctomb |-> 0,
         nTomb |-> 0,            \* "shimEarlyTomb": the tombstone that n read
         born |-> [w \in ChildWorkers |-> 0],
         crashes |-> CRASHES, expiries |-> EXPIRIES, ex |-> {}]

Go(st, w, p) == [st EXCEPT !.pc[w] = p]
Flag(st, f) == [st EXCEPT !.ex = @ \cup {f}]

(***************************************************************************)
(* Environment                                                             *)
(***************************************************************************)
\* The deploy gate turns on (P45: no operator switch).
SwitchOn == ~s.switch /\ s' = [s EXCEPT !.switch = TRUE]

Crash(w) == s.pc[w] # "idle" /\ s.crashes > 0 /\ s' = [Go(s, w, "idle") EXCEPT !.crashes = @ - 1]

\* A dead holder's lease or lock expires. "shim": the child lease stays,
\* expired, until the heartbeat clear.
ExpireDead ==
    \/ s.rootLease = "ro" /\ s.pc["ro"] = "idle" /\ s' = [s EXCEPT !.rootLease = ""]
    \/ /\ ~Shim /\ s.childLease = "co" /\ s.pc["co"] = "idle" /\ s' = [s EXCEPT !.childLease = ""]
    \/ /\ Shim /\ s.childLease \in ChildWorkers /\ s.childLive /\ s.pc[s.childLease] = "idle"
       /\ s' = [s EXCEPT !.childLive = FALSE]
    \/ s.nLock /\ s.pc["n"] = "idle" /\ s' = [s EXCEPT !.nLock = FALSE]
    \/ s.cnLock /\ s.pc["cn"] = "idle" /\ s' = [s EXCEPT !.cnLock = FALSE]

\* A live worker stalls past the TTL and keeps running.
Stall(w) ==
    /\ s.pc[w] # "idle" /\ s.expiries > 0
    /\ \/ w = "ro" /\ s.rootLease = "ro" /\ s' = [s EXCEPT !.rootLease = "", !.expiries = @ - 1]
       \/ /\ ~Shim /\ w = "co" /\ s.childLease = "co"
          /\ s' = [s EXCEPT !.childLease = "", !.expiries = @ - 1]
       \/ /\ Shim /\ w \in ChildWorkers /\ s.childLease = w /\ s.childLive
          /\ s' = [s EXCEPT !.childLive = FALSE, !.expiries = @ - 1]
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
    /\ ~Shim /\ s.pc["co"] = "idle" /\ s.childLease = "" /\ s.child = "running"
    /\ s' = Go([s EXCEPT !.childLease = "co"], "co", "check")

\* "shim": a take mints the next epoch. co (step 3) also takes over an
\* expired lease and saves its tombstone first; cp (before step 3) takes
\* only an absent lease and reads no core.
ShimTake(w) ==
    LET over == s.childLease \in ChildWorkers /\ ~s.childLive
    IN /\ Shim /\ s.pc[w] = "idle" /\ s.child = "running" /\ s.cep < TAKES
       /\ s.childLease = "" \/ (w = "co" /\ over)
       /\ s' = Go([s EXCEPT !.childLease = w, !.childLive = TRUE, !.childEp = s.cep + 1,
                             !.cep = @ + 1, !.born[w] = s.cep,
                             !.ctomb = IF over THEN Max(@, s.childEp) ELSE @],
                  w, IF w = "co" THEN "check" ELSE "run")
CoCheck ==
    /\ s.pc["co"] = "check"
    /\ s' = IF s.core = "old" /\ s.childCore = "old" THEN Go(s, "co", "run")
            ELSE Flag(Go([s EXCEPT !.childLease = IF @ = "co" THEN "" ELSE @], "co", "idle"), "refused")
\* The result write. A row that the move already moved is gone: the
\* result is lost.
CoFinish(w) ==
    /\ w \in ChildWorkers /\ s.pc[w] = "run"
    /\ s' = IF RESULT_FENCED /\ s.childLease # w THEN Go(s, w, "idle")
            ELSE LET st == Go([s EXCEPT !.child = "done",
                                        !.childLease = IF @ = w THEN "" ELSE @], w, "idle")
                 IN IF s.invRow = "active" THEN [st EXCEPT !.invRow = "result"]
                    ELSE IF s.invRow = "moved" THEN Flag(st, "resultLost")
                    ELSE st   \* a second child turn: today's bug (no C3)

\* "shim": the heartbeat clear of an expired child lease saves the
\* tombstone (current code), then erases the lease.
ChildHeartbeatClear ==
    /\ Shim /\ s.childLease \in ChildWorkers /\ ~s.childLive
    /\ s' = [s EXCEPT !.ctomb = Max(@, s.childEp), !.childLease = ""]

\* "shim": acquiredAt(cfence + 1) + maxDuration + 60 s passes; every child
\* invocation that started before that take has ended.
ChildTick ==
    /\ Shim /\ s.cfence < s.cep
    /\ s' = [s EXCEPT !.cfence = @ + 1,
                      !.pc = [w \in Workers |-> IF w \in ChildWorkers /\ @[w] # "idle" /\ s.born[w] <= s.cfence
                                               THEN "idle" ELSE @[w]]]

\* "shim": the child passes the stale lease fence (lease, then tombstone, in
\* one step: C11), or is pinned already. tomb: the tombstone it reads.
FenceOk(tomb) ==
    \/ s.childLease = "pin"
    \/ s.childLease = "" /\ (MOVE_RULE = "shimNoFence" \/ tomb <= s.cfence)
    \/ /\ s.childLease \in ChildWorkers /\ ~s.childLive
       /\ MOVE_RULE = "shimNoFence" \/ Max(s.childEp, tomb) <= s.cfence
ChildFenceOk == FenceOk(s.ctomb)

(***************************************************************************)
(* New core on the root (n)                                                *)
(***************************************************************************)
NTake ==
    /\ s.pc["n"] = "idle" /\ ~s.nLock /\ (s.core = "new" \/ s.switch \/ Shim)
    /\ s' = Go([s EXCEPT !.nLock = TRUE, !.core = "new"], "n", "lease")

\* Take or keep the pin on R's lease (Cutover.tla), waiting for ro.
NLease ==
    /\ s.pc["n"] = "lease" /\ s.rootLease \in {"", "pin"}
    /\ s' = Go([s EXCEPT !.rootLease = "pin"], "n", IF MOVE_RULE = "shimEarlyTomb" THEN "ctomb" ELSE "move")

\* "shimEarlyTomb" only: n reads the child's tombstone in its own step.
NTomb == s.pc["n"] = "ctomb" /\ s' = Go([s EXCEPT !.nTomb = s.ctomb], "n", "move")

ChildFree ==
    IF MOVE_RULE = "shimEarlyTomb" THEN FenceOk(s.nTomb)
    ELSE IF Shim THEN ChildFenceOk
    ELSE IF MOVE_RULE = "pin" THEN s.childLease \in {"", "pin"}
    ELSE s.childCore = "new" \/ s.childLease = ""

\* The invocation row moves into a request record (fenced by n's lock).
NMove ==
    /\ s.pc["n"] = "move"
    /\ s' = IF ~s.nLock THEN Go(s, "n", "idle")
            ELSE IF s.invRow \in {"active", "result"} /\ ChildFree
            THEN Go([s EXCEPT !.record = IF s.invRow = "result" THEN "answered" ELSE "open",
                              !.invRow = "moved",
                              !.childLease = IF MOVE_RULE \in {"plan", "shimNoPin"} THEN @ ELSE "pin"], "n", "run")
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
    /\ IF Shim THEN ChildFenceOk ELSE s.childLease \in {"", "pin"}
    /\ s' = Go([s EXCEPT !.cnLock = TRUE, !.childCore = "new", !.childLease = "pin"], "cn", "run")
CnFinish ==
    /\ s.pc["cn"] = "run" /\ s.record = "open"
    /\ s' = IF s.cnLock THEN Go([s EXCEPT !.record = "answered", !.child = "done", !.cnLock = FALSE], "cn", "idle")
            ELSE Go(s, "cn", "idle")
CnRel == s.pc["cn"] = "run" /\ s' = Go([s EXCEPT !.cnLock = FALSE], "cn", "idle")

(***************************************************************************)
Next ==
    \/ RoTake \/ RoCheck \/ RoDeliver \/ RoRel
    \/ CoTake \/ CoCheck \/ \E w \in ChildWorkers : CoFinish(w) \/ ShimTake(w)
    \/ ChildHeartbeatClear \/ ChildTick
    \/ NTake \/ NLease \/ NTomb \/ NMove \/ NDeliver \/ NRel
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
