----------------------------- MODULE WorkerLock -----------------------------
(***************************************************************************)
(* Model 1: worker lock, lock version, turn row, checkpoint saves,         *)
(* deliveries, finishTurn, sign-in pause and wake-ups.                     *)
(*                                                                         *)
(* One conversation. Two workers. Two inbox messages: m1 (person A, in the *)
(* inbox at start) and m2 (person B, may arrive at any time). Each message *)
(* starts its own turn. Each turn has two deliveries: index 0 is the       *)
(* assistant response, index 1 is the error message or ending note that    *)
(* finishTurn sends.                                                       *)
(*                                                                         *)
(* A worker can crash after any durable write (the named Crash_* actions,  *)
(* one per crash point, P42), or stall so that its lock expires while it   *)
(* still runs (LockExpires). A crashed worker's "notify a worker" message  *)
(* comes back from the queue. A worker that stops on LockLostError acks    *)
(* its message.                                                            *)
(*                                                                         *)
(* Lock versions and acquisition numbers are kept relative (Norm), so the  *)
(* state space is finite. Only "equal" and "older" comparisons read them.  *)
(*                                                                         *)
(* The constants select a plan revision. See the *.cfg files and README.md.*)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    LOCK_CAS,          \* P5: take the lock and raise the version in one SQL CAS
    ERROR_PAUSE,       \* P31: an error saves `paused: error_retry`
    DELIVERY_LIMIT,    \* P11, P33: each delivery has an attempt limit
    WAKE_RULE,         \* "prior" (ab76f5d), "p32" (5122bb7), "seq" (5ed29c2 on)
    SIGN_IN_WAKES,     \* recordSignIn raises inboxSeq and sets wakeAtMs (P32)
    DELAYED_NOTIFY,    \* the pre-release wake time also queues a delayed notify
    SEND_STEPS,        \* send() runs as its P32 steps, each with a crash point;
                       \* FALSE: one atomic step (a smaller bound)
    RESTART_IS_ERROR,  \* P4 (decided): a restart uses one of the turn's errors
    ERROR_LIMIT,       \* abstracts the limit of 5 turn errors
    WITH_M2,           \* person B may send m2
    WITH_SIGNIN,       \* turns may pause for sign-in
    WITH_ERRORS,       \* attempts may fail with an error
    WITH_SOFT,         \* attempts may pause at the soft time limit
    WITH_BROKEN,       \* the reply target may refuse every post
    LOSSES,            \* crashes plus lock expiries of live workers, per run
    POST_FAILS         \* posts that fail once and then work

Workers == {"w1", "w2"}
TurnIds == {1, 2}
Msgs == {"m1", "m2"}
DeliveryIds == TurnIds \X {0, 1}
POST_LIMIT == 2          \* abstracts the limit of 5 post attempts
RESTART_LIMIT == 1
Open == {"running", "paused", "finishing"}
Final == {"completed", "failed", "stopped"}

VARIABLE s

IdleWorker == [pc |-> "idle", seq |-> 0, ver |-> 0, turn |-> 0, workLeft |-> FALSE]

NoTurn == [status |-> "none", msg |-> "", errors |-> 0, restarts |-> 0,
           pause |-> "", resumedFrom |-> "", outcome |-> "",
           softUsed |-> FALSE, signUsed |-> FALSE, granted |-> FALSE,
           linkExpired |-> FALSE,
           handedOff |-> FALSE,   \* ghost: a live worker released a running turn
           charged |-> FALSE,     \* ghost: this attempt already used an error
           failures |-> 0]        \* ghost: errors seen plus lost-worker restarts

(***************************************************************************)
(* Helpers. Each takes a state record and returns a value or a new state.  *)
(***************************************************************************)
Max(a, b) == IF a > b THEN a ELSE b
\* The queue is a count of notify messages (they carry no payload, so it is
\* a multiset of one kind). Inc never drops one and has no cap. The count
\* stays finite with no state constraint: a release's notify follows a
\* take that used one, and every other send is a bounded event (send(), a
\* sign-in, a link expiry, a loss, the repair job).
Inc(q) == q + 1

\* wakeAtMs and the wake-time index (P7) change together, except inside
\* send() (P32 steps).
Wake(st, v) == [st EXCEPT !.wake = v, !.idx = v]

\* Replace each value >= 1 by its rank among the values in use. 0 keeps
\* meaning "none". Ranking keeps "equal" and "older", so this is exact.
Rank(used, v) == IF v > 0 THEN Cardinality({u \in used : u > 0 /\ u <= v}) ELSE 0

Norm(st) ==
    LET vers == {st.workers[w].ver : w \in Workers} \cup {st.sqlVer}
        seqs == {st.workers[w].seq : w \in Workers} \cup {st.holder, st.lastSeq, st.maxRaisedSeq}
    IN [st EXCEPT !.sqlVer = Rank(vers, @),
                  !.holder = Rank(seqs, @),
                  !.lastSeq = Rank(seqs, @),
                  !.maxRaisedSeq = Rank(seqs, @),
                  !.workers = [w \in Workers |->
                      [st.workers[w] EXCEPT !.ver = Rank(vers, @), !.seq = Rank(seqs, @)]]]

SetW(st, w, x) == [st EXCEPT !.workers[w] = x]
SetPc(st, w, pc) == [st EXCEPT !.workers[w].pc = pc]
SetTurn(st, t, x) == [st EXCEPT !.turns[t] = x]
Flag(st, f) == [st EXCEPT !.ex = @ \cup {f}]

OpenTurnOf(st) ==
    LET open == {t \in TurnIds : st.turns[t].status \in Open}
    IN IF open = {} THEN 0 ELSE CHOOSE t \in open : \A u \in open : u <= t

TakenMsgs(st) == {st.turns[t].msg : t \in {u \in TurnIds : st.turns[u].status # "none"}}
IsStale(st, w) == st.workers[w].seq < st.maxRaisedSeq
TokenOk(st, w) == st.holder = st.workers[w].seq /\ st.holderLive

\* The worker stops at once: LockLostError or a failed check-in.
StopWorker(st, w, why) == Flag(SetW(st, w, IdleWorker), why)

\* One SQL transaction that first checks token and lock version (P5).
Fenced(st, w, after) ==
    IF st.sqlVer = st.workers[w].ver /\ (LOCK_CAS => TokenOk(st, w))
    THEN [after EXCEPT !.staleWrite = @ \/ IsStale(st, w)]
    ELSE StopWorker(st, w, "slowWorkerRefused")

FinalOf(outcome) ==
    IF outcome = "completed" THEN "completed"
    ELSE IF outcome = "sign_in_expired" THEN "stopped"
    ELSE "failed"

\* P4 (6c7ab79): an error after take-in adds 1 to `errors`. With
\* RESTART_IS_ERROR a lost-worker restart adds 1 to both `errors` and
\* `restarts`. Earlier revisions count restarts apart.
Used(tu) == tu.errors

\* Charge one error to the current attempt. A second charge in the same
\* attempt is the double count that `oneChargePerAttempt` forbids: one
\* failure (an error, then the loss of the same worker) used two errors.
Charge(st, tu) == IF tu.charged THEN Flag(st, "doubleCharge") ELSE st

\* A restart charges the lost attempt only when it counts as an error.
ChargeRestart(st, tu) == IF RESTART_IS_ERROR THEN Charge(st, tu) ELSE st

\* The lost attempt has a restart left, and with RESTART_IS_ERROR the
\* restart is not the fifth error. When it is the fifth, the turn ends
\* `failed: lost_worker` (P4).
CanRestart(tu) == tu.restarts < RESTART_LIMIT /\ ~(RESTART_IS_ERROR /\ Used(tu) + 1 >= ERROR_LIMIT)

(***************************************************************************)
(* Init                                                                    *)
(***************************************************************************)
Init ==
    s = [holder |-> 0, holderLive |-> FALSE, sqlVer |-> 1, queue |-> 1,
         wake |-> "due",        \* Redis wakeAtMs: "none", "due", "link"
         idx |-> "due",         \* the wake-time index entry (P7), same values
         send |-> "none",       \* send() of m2: the last P32 step done
         sendDown |-> FALSE,    \* the sender crashed; Slack redelivers
         dirty |-> TRUE,        \* inboxSeq changed since the last worker read
         freshSend |-> TRUE,    \* ghost: a send() came after the last release
         inbox |-> {"m1"}, arrived |-> {"m1"},
         turns |-> [t \in TurnIds |-> NoTurn], nextTurn |-> 1,
         requests |-> [m \in Msgs |-> IF m = "m1" THEN "open" ELSE "none"],
         delivery |-> [d \in DeliveryIds |-> "none"],
         attempts |-> [d \in DeliveryIds |-> 0],
         posts |-> [d \in DeliveryIds |-> 0],        \* what the provider shows
         cleanPosts |-> [d \in DeliveryIds |-> 0],   \* posts with no takeover since the intent
         broken |-> FALSE,
         workers |-> [w \in Workers |-> IdleWorker],
         lastSeq |-> 0, maxRaisedSeq |-> 0,
         lossBudget |-> LOSSES, postFailBudget |-> POST_FAILS,
         staleWrite |-> FALSE, stalePost |-> FALSE,
         finalSeen |-> [t \in TurnIds |-> ""], ex |-> {}]

(***************************************************************************)
(* Environment                                                             *)
(***************************************************************************)

\* Person B sends m2: send() runs the P32 steps one at a time. The sender
\* can crash after each one (Crash_AfterRecordInsert and on). Slack then
\* delivers again, and send() runs again: each step is safe to repeat (the
\* record insert is unique on the inbound message id and the rest goes on),
\* so a redelivery resumes after the last step done.
SendNext ==
    CASE s.send = "none"   -> [s EXCEPT !.send = "record", !.arrived = @ \cup {"m2"},
                                        !.requests["m2"] = "open"]
      [] s.send = "record" -> [s EXCEPT !.send = "append", !.inbox = @ \cup {"m2"}]
      [] s.send = "append" -> [s EXCEPT !.send = "seq", !.wake = "due", !.dirty = TRUE,
                                        !.freshSend = TRUE]
      [] s.send = "seq"    -> [s EXCEPT !.send = "index", !.idx = "due"]
      [] s.send = "index"  -> [s EXCEPT !.send = "done", !.queue = Inc(@)]
SendAtomic ==
    [s EXCEPT !.send = "done", !.arrived = @ \cup {"m2"}, !.requests["m2"] = "open",
              !.inbox = @ \cup {"m2"}, !.wake = "due", !.idx = "due", !.dirty = TRUE,
              !.freshSend = TRUE, !.queue = Inc(@)]
SendEn == WITH_M2 /\ s.send # "done" /\ ~s.sendDown
SendStep == SendEn /\ s' = IF SEND_STEPS THEN SendNext ELSE SendAtomic
SendPoint == CASE s.send = "none" -> "AfterRecordInsert" [] s.send = "record" -> "AfterAppend"
                [] s.send = "append" -> "AfterWakeSet" [] s.send = "seq" -> "AfterWakeIndex"
                [] OTHER -> ""

\* Slack delivers the message again after the sender crashed.
SendRedeliver == s.sendDown /\ s' = Flag([s EXCEPT !.sendDown = FALSE], "sendResumed")

\* A live worker stalls past 90 s with no check-in. Its lock expires. It
\* keeps running and learns of the loss only at its next check-in or write.
LockExpires(w) ==
    /\ s.workers[w].pc # "idle"
    /\ s.holder = s.workers[w].seq /\ s.holderLive
    /\ s.lossBudget > 0
    /\ s' = [s EXCEPT !.holderLive = FALSE, !.lossBudget = @ - 1]

\* The lock of a dead worker expires after 90 s.
ExpireDead ==
    /\ s.holder # 0 /\ s.holderLive
    /\ \A w \in Workers : s.workers[w].seq # s.holder
    /\ s' = [s EXCEPT !.holderLive = FALSE]

\* The reply target refuses every post for good (archived channel).
BreakTarget == WITH_BROKEN /\ ~s.broken /\ s' = [s EXCEPT !.broken = TRUE]

\* A worker that still holds the lock checks in. False: it stops at once.
CheckIn(w) ==
    /\ s.workers[w].pc \notin {"idle", "reread", "notify", "done"}
    /\ ~TokenOk(s, w)
    /\ s' = StopWorker(s, w, "checkInFailed")

\* Ten minutes pass: the sign-in link expires. wakeAtMs is now due. With
\* DELAYED_NOTIFY the queue delivers the delayed notification.
LinkExpires(t) ==
    /\ s.turns[t].status = "paused" /\ s.turns[t].pause = "sign_in"
    /\ ~s.turns[t].linkExpired
    /\ s' = [s EXCEPT !.turns[t].linkExpired = TRUE,
                      !.wake = IF @ = "link" THEN "due" ELSE @,
                      !.idx = IF @ = "link" THEN "due" ELSE @,
                      !.queue = IF DELAYED_NOTIFY /\ s.wake = "link" THEN Inc(@) ELSE @]

\* The person signs in. recordSignIn saves turn_authorized and notifies.
SignIn(t) ==
    /\ s.turns[t].status = "paused" /\ s.turns[t].pause = "sign_in"
    /\ ~s.turns[t].granted
    /\ s' = [s EXCEPT !.turns[t].granted = TRUE, !.queue = Inc(@),
                      !.wake = IF SIGN_IN_WAKES THEN "due" ELSE @,
                      !.idx = IF SIGN_IN_WAKES THEN "due" ELSE @,
                      !.dirty = @ \/ SIGN_IN_WAKES, !.freshSend = TRUE]

\* ab76f5d only: the timer job clears an expired Redis lock and notifies.
TimerJob ==
    /\ ~LOCK_CAS /\ s.holder # 0 /\ ~s.holderLive
    /\ s' = [s EXCEPT !.holder = 0, !.queue = Inc(@)]

\* P7 part 2: notify a worker for a conversation with no live lock whose
\* wakeAtMs passed, or with an open turn. It writes nothing else.
RepairJob ==
    /\ LOCK_CAS
    /\ s.holder = 0 \/ ~s.holderLive
    /\ s.idx = "due" \/ OpenTurnOf(s) # 0
    /\ s.queue = 0
    /\ s' = [s EXCEPT !.queue = Inc(@)]

(***************************************************************************)
(* Worker steps. Each step X has XEn(w) (when it can run), XNext(w) (the   *)
(* state after it) and XPoint(w) (the crash point right after its durable  *)
(* write, or "" for none).                                                 *)
(***************************************************************************)

\* -- acquireWorkerLock -------------------------------------------------
AcquireEn(w) == s.workers[w].pc = "idle" /\ s.queue > 0
LockFree == s.holder = 0 \/ ~s.holderLive
AcquireNext(w) ==
    LET q == [s EXCEPT !.queue = @ - 1]
        seq == s.lastSeq + 1
    IN IF ~LockFree
       THEN q   \* A live lock is held: the notify is dropped (P32, P46 decided).
       ELSE IF LOCK_CAS
       THEN SetW([q EXCEPT !.holder = seq, !.holderLive = TRUE, !.lastSeq = seq,
                           !.sqlVer = s.sqlVer + 1, !.maxRaisedSeq = seq],
                 w, [IdleWorker EXCEPT !.pc = "ready", !.seq = seq, !.ver = s.sqlVer + 1])
       ELSE SetW([q EXCEPT !.holder = seq, !.holderLive = TRUE, !.lastSeq = seq],
                 w, [IdleWorker EXCEPT !.pc = "redis", !.seq = seq])
AcquirePoint(w) ==
    IF ~LockFree THEN "" ELSE IF LOCK_CAS THEN "AfterAcquireLock" ELSE "AfterRedisLock"

\* -- ab76f5d: the SQL raise is a separate write, not tied to the lock ---
RaiseEn(w) == s.workers[w].pc = "redis"
RaiseNext(w) ==
    LET x == s.workers[w]
    IN SetW([s EXCEPT !.sqlVer = @ + 1, !.maxRaisedSeq = Max(@, x.seq)],
            w, [x EXCEPT !.pc = "ready", !.ver = s.sqlVer + 1])
RaisePoint(w) == "AfterRaiseVersion"

\* -- work(): read the open turn and do the first step that applies -------
\* (turn.md, work(), cases 1 to 5). E1: input whose request id the turn
\* row lists is removed from the inbox and not taken in again.
ReadyEn(w) == s.workers[w].pc = "ready"
ReadyBase(w) ==
    LET dup == s.inbox \cap TakenMsgs(s)
        s0r == [s EXCEPT !.dirty = IF WAKE_RULE = "seq" THEN FALSE ELSE @]
    IN IF dup # {} /\ TokenOk(s, w)
       THEN Flag([s0r EXCEPT !.inbox = @ \ dup], "redeliveredPrompt")
       ELSE s0r
ReadyNext(w) ==
    LET t == OpenTurnOf(s)
        x == s.workers[w]
        s0 == ReadyBase(w)
        tu == s.turns[t]
        run(st, nt) == SetW(SetTurn(st, t, nt), w, [x EXCEPT !.pc = "run", !.turn = t])
        fin(st, nt) == SetW(SetTurn(st, t, nt), w, [x EXCEPT !.pc = "fin", !.turn = t])
    IN
    IF t > 0 /\ tu.status = "finishing"
    THEN SetW(s0, w, [x EXCEPT !.pc = "fin", !.turn = t])
    ELSE IF t > 0 /\ tu.status = "running"
    THEN \* No live worker runs it: lost (P8). Restart once, or fail.
         IF CanRestart(tu)
         THEN Fenced(s0, w, Flag(run(ChargeRestart(s0, tu),
                                     [tu EXCEPT !.restarts = @ + 1, !.resumedFrom = "",
                                                !.errors = IF RESTART_IS_ERROR THEN @ + 1 ELSE @,
                                                !.failures = @ + 1,
                                                !.handedOff = FALSE, !.charged = FALSE]),
                                 IF tu.handedOff THEN "restartWithNoLostWorker" ELSE "restart"))
         ELSE IF tu.restarts < RESTART_LIMIT
         THEN \* The restart would be the fifth error: the turn fails.
              Fenced(s0, w, Flag(fin(ChargeRestart(s0, tu),
                                     [tu EXCEPT !.restarts = @ + 1, !.errors = @ + 1,
                                                !.failures = @ + 1, !.status = "finishing",
                                                !.outcome = "lost_worker"]),
                                 "restartUsedLastError"))
         ELSE Fenced(s0, w, Flag(fin(s0, [tu EXCEPT !.status = "finishing", !.outcome = "lost_worker"]),
                                 IF tu.handedOff THEN "lostWorkerWithNoLostWorker" ELSE "lostTwice"))
    ELSE IF t > 0 /\ tu.status = "paused" /\ tu.pause = "sign_in"
    THEN \* access.md, the sign-in table (no stop or supersede here).
         IF tu.granted
         THEN Fenced(s0, w, Flag(run(s0, [tu EXCEPT !.status = "running", !.pause = "",
                                                    !.resumedFrom = "sign_in", !.charged = FALSE]),
                                 "resumedAfterSignIn"))
         ELSE IF tu.linkExpired
         THEN Fenced(s0, w, fin(s0, [tu EXCEPT !.status = "finishing", !.outcome = "sign_in_expired"]))
         ELSE SetW(s0, w, [x EXCEPT !.pc = "rcheck", !.turn = t])   \* others wait
    ELSE IF t > 0 /\ tu.status = "paused"
    THEN Fenced(s0, w, run(s0, [tu EXCEPT !.status = "running", !.pause = "",
                                          !.resumedFrom = tu.pause, !.charged = FALSE]))
    ELSE IF s0.inbox \ TakenMsgs(s0) # {}
    THEN \* startTurn: the unique index allows it only with no open turn.
         LET m == IF "m1" \in s0.inbox /\ "m1" \notin TakenMsgs(s0) THEN "m1" ELSE "m2"
             nt == s0.nextTurn
             prevFailed == nt = 2 /\ s0.turns[1].outcome = "error"
         IN Fenced(s0, w, Flag(SetW(SetTurn([s0 EXCEPT !.nextTurn = nt + 1], nt,
                                            [NoTurn EXCEPT !.status = "running", !.msg = m]),
                                    w, [x EXCEPT !.pc = "remove", !.turn = nt]),
                               IF prevFailed THEN "retriesRanOutNextTurnRuns" ELSE "turnStarted"))
    ELSE SetPc(s0, w, "rcheck")
ReadyPoint(w) ==
    LET t == OpenTurnOf(s)
        tu == s.turns[t]
        dupRemoved == s.inbox \cap TakenMsgs(s) # {} /\ TokenOk(s, w)
    IN IF t > 0 /\ tu.status = "running"
       THEN IF CanRestart(tu) THEN "AfterRestartSave" ELSE "AfterFinishingSave"
       ELSE IF t > 0 /\ tu.status = "paused" /\ tu.pause = "sign_in"
       THEN IF tu.granted THEN "AfterResumeSave"
            ELSE IF tu.linkExpired THEN "AfterFinishingSave"
            ELSE IF dupRemoved THEN "AfterInboxRemove" ELSE ""
       ELSE IF t > 0 /\ tu.status = "paused" THEN "AfterResumeSave"
       ELSE IF t = 0 /\ s.inbox \ TakenMsgs(s) # {} THEN "AfterStartTurn"
       ELSE IF dupRemoved THEN "AfterInboxRemove" ELSE ""

\* -- remove taken-in input from the inbox, after the SQL commit (rule 6) --
RemoveEn(w) == s.workers[w].pc = "remove"
RemoveNext(w) ==
    IF TokenOk(s, w)
    THEN SetPc([s EXCEPT !.inbox = @ \ {s.turns[s.workers[w].turn].msg}], w, "run")
    ELSE StopWorker(s, w, "checkInFailed")
RemovePoint(w) == "AfterInboxRemove"

RunPre(w) == s.workers[w].pc = "run" /\ s.turns[s.workers[w].turn].status = "running"
TurnOf(w) == s.workers[w].turn

\* -- deliver(): check in, then save the delivery intent (fenced) --------
RunIntentEn(w) == RunPre(w) /\ s.delivery[<<TurnOf(w), 0>>] = "none"
RunIntentNext(w) ==
    IF TokenOk(s, w)
    THEN Fenced(s, w, SetPc([s EXCEPT !.delivery[<<TurnOf(w), 0>>] = "intended"], w, "post0"))
    ELSE StopWorker(s, w, "checkInFailed")
RunIntentPoint(w) == "AfterSaveIntent"

\* -- an intent with no message id: ask the provider for the delivery id --
RunRecoverEn(w) == RunPre(w) /\ s.delivery[<<TurnOf(w), 0>>] = "intended"
RunRecoverNext(w) ==
    IF s.posts[<<TurnOf(w), 0>>] > 0
    THEN Fenced(s, w, Flag([s EXCEPT !.delivery[<<TurnOf(w), 0>>] = "sent"], "foundOnRecover"))
    ELSE SetPc(s, w, "post0")
RunRecoverPoint(w) == IF s.posts[<<TurnOf(w), 0>>] > 0 THEN "AfterSaveSent" ELSE ""

\* The post itself. It is not part of a transaction (P5 Limit). Every
\* intent save is fenced, so a worker that is stale at its post saw a
\* takeover between its intent (or its find) and the post.
DoPost(st, w, d, nextPc) ==
    LET clean == ~IsStale(st, w)
    IN SetPc([st EXCEPT !.posts[d] = @ + 1,
                        !.cleanPosts[d] = IF clean THEN @ + 1 ELSE @,
                        !.stalePost = @ \/ ~clean], w, nextPc)

\* A post failed. With DELIVERY_LIMIT, count it; at the limit the delivery
\* is `failed` and the turn ends `failed: post_failed` (P11).
PostFailedRunning(st, w, t) ==
    LET d == <<t, 0>>
        tu == st.turns[t]
        a == st.attempts[d] + 1
    IN IF DELIVERY_LIMIT
       THEN IF a >= POST_LIMIT
            THEN Fenced(st, w, SetPc(SetTurn([st EXCEPT !.attempts[d] = a, !.delivery[d] = "failed"],
                                             t, [tu EXCEPT !.status = "finishing", !.outcome = "post_failed"]),
                                     w, "fin"))
            ELSE Fenced(st, w, SetPc(SetTurn(Wake([st EXCEPT !.attempts[d] = a], "due"),
                                             t, [tu EXCEPT !.status = "paused", !.pause = "post_retry"]),
                                     w, "rcheck"))
       ELSE IF tu.resumedFrom = "post_retry"
       THEN Fenced(st, w, SetPc(SetTurn(st, t, [tu EXCEPT !.status = "finishing", !.outcome = "no_progress"]), w, "fin"))
       ELSE Fenced(st, w, SetPc(SetTurn(st, t, [tu EXCEPT !.status = "paused", !.pause = "post_retry"]), w, "rcheck"))
PostFailedRunningPoint(t) ==
    IF DELIVERY_LIMIT /\ s.attempts[<<t, 0>>] + 1 >= POST_LIMIT THEN "AfterFinishingSave"
    ELSE IF ~DELIVERY_LIMIT /\ s.turns[t].resumedFrom = "post_retry" THEN "AfterFinishingSave"
    ELSE "AfterSavePause"

Post0En(w) == s.workers[w].pc = "post0"
Post0OkEn(w) == Post0En(w) /\ ~s.broken
Post0OkNext(w) == DoPost(s, w, <<TurnOf(w), 0>>, "sent0")
Post0FailEn(w) == Post0En(w) /\ (s.broken \/ s.postFailBudget > 0)
Post0FailNext(w) ==
    IF s.broken THEN PostFailedRunning(s, w, TurnOf(w))
    ELSE PostFailedRunning([s EXCEPT !.postFailBudget = @ - 1], w, TurnOf(w))
Post0FailPoint(w) == PostFailedRunningPoint(TurnOf(w))

\* -- save the provider message id -------------------------------------
Sent0En(w) == s.workers[w].pc = "sent0"
Sent0Next(w) == Fenced(s, w, SetPc([s EXCEPT !.delivery[<<TurnOf(w), 0>>] = "sent"], w, "run"))

\* -- an error after take-in (P22, P31) --------------------------------
RunErrorEn(w) == WITH_ERRORS /\ RunPre(w) /\ Used(s.turns[TurnOf(w)]) < ERROR_LIMIT
RunErrorNext(w) ==
    LET t == TurnOf(w)
        tu == s.turns[t]
        nt == [tu EXCEPT !.errors = @ + 1, !.failures = @ + 1, !.charged = TRUE]
        sc == Charge(s, tu)
    IN IF Used(nt) >= ERROR_LIMIT
       THEN Fenced(s, w, SetPc(SetTurn(sc, t, [nt EXCEPT !.status = "finishing", !.outcome = "error"]), w, "fin"))
       ELSE IF ERROR_PAUSE
       THEN Fenced(s, w, SetPc(SetTurn(sc, t, [nt EXCEPT !.status = "paused", !.pause = "error_retry"]), w, "rcheck"))
       ELSE Fenced(s, w, SetPc(SetTurn(sc, t, nt), w, "rcheck"))
RunErrorPoint(w) ==
    LET tu == s.turns[TurnOf(w)]
    IN IF Used(tu) + 1 >= ERROR_LIMIT THEN "AfterFinishingSave"
       ELSE IF ERROR_PAUSE THEN "AfterSavePause" ELSE "AfterSaveError"

\* -- save a checkpoint and continue later (soft time limit) -----------
RunSoftPauseEn(w) == WITH_SOFT /\ RunPre(w) /\ ~s.turns[TurnOf(w)].softUsed
RunSoftPauseNext(w) ==
    LET t == TurnOf(w)
    IN Fenced(s, w, SetPc(SetTurn(s, t, [s.turns[t] EXCEPT !.status = "paused",
                                         !.pause = "soft_time_limit", !.softUsed = TRUE]), w, "rcheck"))

\* -- pauseForSignIn: sets wakeAtMs to the link expiry (access.md) -----
RunSignInEn(w) == WITH_SIGNIN /\ RunPre(w) /\ ~s.turns[TurnOf(w)].signUsed
RunSignInNext(w) ==
    LET t == TurnOf(w)
    IN Fenced(s, w, SetPc(SetTurn(Wake(s, "link"), t,
                                  [s.turns[t] EXCEPT !.status = "paused", !.pause = "sign_in",
                                                     !.signUsed = TRUE]), w, "rcheck"))

RunDoneEn(w) == RunPre(w) /\ s.delivery[<<TurnOf(w), 0>>] \in {"sent", "failed"}
RunDoneNext(w) ==
    LET t == TurnOf(w)
    IN Fenced(s, w, SetPc(SetTurn(s, t, [s.turns[t] EXCEPT !.status = "finishing",
                                         !.outcome = "completed"]), w, "fin"))

\* -- finishTurn (turn.md, steps 1 to 5) --------------------------------
FinNeeds(w) ==
    LET t == TurnOf(w)
    IN s.turns[t].outcome # "completed" /\ s.delivery[<<t, 1>>] \notin {"sent", "failed"}
FinDeliverEn(w) == s.workers[w].pc = "fin"
FinDeliverNext(w) ==
    LET d == <<TurnOf(w), 1>>
    IN IF ~FinNeeds(w) THEN SetPc(s, w, "fanswer")
       ELSE IF s.delivery[d] = "none"
       THEN IF TokenOk(s, w)
            THEN Fenced(s, w, SetPc([s EXCEPT !.delivery[d] = "intended"], w, "post1"))
            ELSE StopWorker(s, w, "checkInFailed")
       ELSE IF s.posts[d] > 0
       THEN Fenced(s, w, [s EXCEPT !.delivery[d] = "sent"])
       ELSE SetPc(s, w, "post1")
FinDeliverPoint(w) ==
    LET d == <<TurnOf(w), 1>>
    IN IF ~FinNeeds(w) THEN ""
       ELSE IF s.delivery[d] = "none" THEN "AfterSaveIntent"
       ELSE IF s.posts[d] > 0 THEN "AfterSaveSent"
       ELSE ""

\* A failed post while finishing. P33: count it, back off, and at the limit
\* mark the delivery `failed` and go on. ab76f5d: give up the attempt; the
\* turn stays `finishing`.
PostFailedFinishing(st, w, t) ==
    LET d == <<t, 1>>
        a == st.attempts[d] + 1
    IN IF DELIVERY_LIMIT
       THEN IF a >= POST_LIMIT
            THEN Fenced(st, w, SetPc([st EXCEPT !.attempts[d] = a, !.delivery[d] = "failed"], w, "fin"))
            ELSE Fenced(st, w, SetPc(Wake([st EXCEPT !.attempts[d] = a], "due"), w, "rcheck"))
       ELSE SetPc(st, w, "rcheck")

Post1En(w) == s.workers[w].pc = "post1"
Post1OkEn(w) == Post1En(w) /\ ~s.broken
Post1OkNext(w) == DoPost(s, w, <<TurnOf(w), 1>>, "sent1")
Post1FailEn(w) == Post1En(w) /\ (s.broken \/ s.postFailBudget > 0)
Post1FailNext(w) ==
    IF s.broken THEN PostFailedFinishing(s, w, TurnOf(w))
    ELSE PostFailedFinishing([s EXCEPT !.postFailBudget = @ - 1], w, TurnOf(w))
Post1FailPoint(w) == IF DELIVERY_LIMIT THEN "AfterSaveDeliveryAttempt" ELSE ""

Sent1En(w) == s.workers[w].pc = "sent1"
Sent1Next(w) == Fenced(s, w, SetPc([s EXCEPT !.delivery[<<TurnOf(w), 1>>] = "sent"], w, "fin"))

\* Move the record out of open (WHERE status = 'open').
FAnswerEn(w) == s.workers[w].pc = "fanswer"
FAnswerNext(w) ==
    LET tu == s.turns[TurnOf(w)]
        st == IF tu.outcome = "sign_in_expired" THEN "stopped" ELSE "answered"
    IN Fenced(s, w, SetPc([s EXCEPT !.requests[tu.msg] = IF @ = "open" THEN st ELSE @], w, "fdone"))

\* Only finishTurn writes a finished status (rule 7).
FDoneEn(w) == s.workers[w].pc = "fdone"
FDoneNext(w) ==
    LET t == TurnOf(w)
        st == FinalOf(s.turns[t].outcome)
    IN Fenced(s, w, SetPc([s EXCEPT !.finalSeen[t] = st, !.turns[t].status = st], w, "rcheck"))

\* -- releaseWorkerLock (P32) --------------------------------------------
WorkLeftIn(st) == st.inbox # {} \/ OpenTurnOf(st) # 0

\* nextRunAtMs: the next deadline the worker knows of.
NextWake(st) ==
    LET t == OpenTurnOf(st)
        tu == st.turns[t]
    IN IF t > 0 /\ tu.status = "paused" /\ tu.pause = "sign_in" /\ ~tu.granted /\ ~tu.linkExpired THEN "link"
       ELSE IF t > 0 THEN "due"
       ELSE IF st.inbox # {} THEN "due"
       ELSE "none"

\* Only blocked input is left: a sign-in pause with no grant, no expiry.
OnlyBlocked(st) ==
    LET t == OpenTurnOf(st)
        tu == st.turns[t]
    IN t > 0 /\ tu.status = "paused" /\ tu.pause = "sign_in" /\ ~tu.granted /\ ~tu.linkExpired

\* Before release: set wakeAtMs to nextRunAtMs with a compare-and-set on
\* inboxSeq; when inboxSeq changed, read again and retry. One atomic step
\* stands for the read-again loop: a send() lands before it (and is in
\* NextWake) or after it (and sets wakeAtMs to now itself). With
\* DELAYED_NOTIFY the same set queues a delayed notify for a later wake time,
\* modelled by LinkExpires.
RCheckEn(w) == s.workers[w].pc = "rcheck"
RCheckNext(w) ==
    LET x == s.workers[w]
        t == x.turn
        s1 == IF t > 0 /\ s.turns[t].status = "running" /\ s.sqlVer = x.ver
              THEN [s EXCEPT !.turns[t].handedOff = TRUE] ELSE s
        s2 == IF WAKE_RULE = "seq" /\ TokenOk(s, w)
              THEN [Wake(s1, NextWake(s1)) EXCEPT !.dirty = FALSE] ELSE s1
        \* Ghost: the holder's release starts a new window for the wake-loop check.
        s3 == IF TokenOk(s, w) THEN [s2 EXCEPT !.freshSend = FALSE] ELSE s2
    IN SetW(s3, w, [x EXCEPT !.pc = "rel", !.workLeft = WorkLeftIn(s)])
RCheckPoint(w) == IF WAKE_RULE = "seq" /\ TokenOk(s, w) THEN "AfterWakeCompareAndSet" ELSE ""

\* Clear the token (same match as checkIn).
RelEn(w) == s.workers[w].pc = "rel"
RelNext(w) ==
    LET x == s.workers[w]
        s1 == [s EXCEPT !.holder = IF @ = x.seq THEN 0 ELSE @]
    IN IF WAKE_RULE = "prior"
       THEN SetW(s1, w, IF x.workLeft THEN [x EXCEPT !.pc = "notify"] ELSE IdleWorker)
       ELSE SetPc(s1, w, "reread")
RelPoint(w) == "AfterReleaseLock"

\* P32: after the release, read the inbox record.
RereadEn(w) == s.workers[w].pc = "reread"
RereadGo ==
    IF WAKE_RULE = "p32" THEN s.inbox # {} \/ s.wake = "due" ELSE s.dirty \/ s.wake = "due"
RereadNext(w) ==
    LET s1 == IF RereadGo /\ OnlyBlocked(s) /\ ~s.freshSend THEN Flag(s, "wakeLoopWhileBlocked") ELSE s
    IN SetPc(s1, w, IF RereadGo THEN "notify" ELSE "done")
RereadPoint(w) == "AfterInboxRead"

NotifyEn(w) == s.workers[w].pc \in {"notify", "done"}
NotifyNext(w) ==
    SetW([s EXCEPT !.queue = IF s.workers[w].pc = "notify" THEN Inc(@) ELSE @], w, IdleWorker)

(***************************************************************************)
(* Worker actions.                                                         *)
(***************************************************************************)
Acquire(w)      == AcquireEn(w)      /\ s' = Norm(AcquireNext(w))
Raise(w)        == RaiseEn(w)        /\ s' = Norm(RaiseNext(w))
Ready(w)        == ReadyEn(w)        /\ s' = Norm(ReadyNext(w))
Remove(w)       == RemoveEn(w)       /\ s' = Norm(RemoveNext(w))
RunIntent(w)    == RunIntentEn(w)    /\ s' = Norm(RunIntentNext(w))
RunRecover(w)   == RunRecoverEn(w)   /\ s' = Norm(RunRecoverNext(w))
Post0Ok(w)      == Post0OkEn(w)      /\ s' = Norm(Post0OkNext(w))
Post0Fail(w)    == Post0FailEn(w)    /\ s' = Norm(Post0FailNext(w))
Sent0(w)        == Sent0En(w)        /\ s' = Norm(Sent0Next(w))
RunError(w)     == RunErrorEn(w)     /\ s' = Norm(RunErrorNext(w))
RunSoftPause(w) == RunSoftPauseEn(w) /\ s' = Norm(RunSoftPauseNext(w))
RunSignIn(w)    == RunSignInEn(w)    /\ s' = Norm(RunSignInNext(w))
RunDone(w)      == RunDoneEn(w)      /\ s' = Norm(RunDoneNext(w))
FinDeliver(w)   == FinDeliverEn(w)   /\ s' = Norm(FinDeliverNext(w))
Post1Ok(w)      == Post1OkEn(w)      /\ s' = Norm(Post1OkNext(w))
Post1Fail(w)    == Post1FailEn(w)    /\ s' = Norm(Post1FailNext(w))
Sent1(w)        == Sent1En(w)        /\ s' = Norm(Sent1Next(w))
FAnswer(w)      == FAnswerEn(w)      /\ s' = Norm(FAnswerNext(w))
FDone(w)        == FDoneEn(w)        /\ s' = Norm(FDoneNext(w))
RCheck(w)       == RCheckEn(w)       /\ s' = Norm(RCheckNext(w))
Rel(w)          == RelEn(w)          /\ s' = Norm(RelNext(w))
Reread(w)       == RereadEn(w)       /\ s' = Norm(RereadNext(w))
Notify(w)       == NotifyEn(w)       /\ s' = Norm(NotifyNext(w))

Progress(w) ==
    \/ Acquire(w) \/ Raise(w) \/ Ready(w) \/ Remove(w)
    \/ RunIntent(w) \/ RunRecover(w) \/ Post0Ok(w) \/ Post0Fail(w) \/ Sent0(w)
    \/ RunError(w) \/ RunSoftPause(w) \/ RunSignIn(w) \/ RunDone(w)
    \/ FinDeliver(w) \/ Post1Ok(w) \/ Post1Fail(w) \/ Sent1(w) \/ FAnswer(w) \/ FDone(w)
    \/ RCheck(w) \/ Rel(w) \/ Reread(w) \/ Notify(w)

(***************************************************************************)
(* Crash points (P42). A crash is the step's durable write, then the       *)
(* process dies before anything else. The queue redelivers the worker's    *)
(* message. Each Crash_<Point> action is one point of the `faults` port.   *)
(***************************************************************************)
Lose(st, w) ==
    [st EXCEPT !.workers[w] = IdleWorker, !.lossBudget = @ - 1, !.queue = Inc(@)]

\* The step ran its write and the worker is still alive after it (a refused
\* write already stopped the worker, so it cannot crash after it).
CrashVia(en, point, next, p, w) ==
    /\ en /\ point = p /\ s.lossBudget > 0
    /\ next.workers[w].pc # "idle" \/ p = "AfterReleaseLock"
    /\ s' = Norm(Lose(next, w))

CrashAt(p, w) ==
    \/ CrashVia(AcquireEn(w), AcquirePoint(w), AcquireNext(w), p, w)
    \/ CrashVia(RaiseEn(w), RaisePoint(w), RaiseNext(w), p, w)
    \/ CrashVia(ReadyEn(w), ReadyPoint(w), ReadyNext(w), p, w)
    \/ CrashVia(RemoveEn(w), RemovePoint(w), RemoveNext(w), p, w)
    \/ CrashVia(RunIntentEn(w), RunIntentPoint(w), RunIntentNext(w), p, w)
    \/ CrashVia(RunRecoverEn(w), RunRecoverPoint(w), RunRecoverNext(w), p, w)
    \/ CrashVia(Post0OkEn(w), "AfterPost", Post0OkNext(w), p, w)
    \/ CrashVia(Post0FailEn(w), Post0FailPoint(w), Post0FailNext(w), p, w)
    \/ CrashVia(Sent0En(w), "AfterSaveSent", Sent0Next(w), p, w)
    \/ CrashVia(RunErrorEn(w), RunErrorPoint(w), RunErrorNext(w), p, w)
    \/ CrashVia(RunSoftPauseEn(w), "AfterSavePause", RunSoftPauseNext(w), p, w)
    \/ CrashVia(RunSignInEn(w), "AfterSavePause", RunSignInNext(w), p, w)
    \/ CrashVia(RunDoneEn(w), "AfterFinishingSave", RunDoneNext(w), p, w)
    \/ CrashVia(FinDeliverEn(w), FinDeliverPoint(w), FinDeliverNext(w), p, w)
    \/ CrashVia(Post1OkEn(w), "AfterPost", Post1OkNext(w), p, w)
    \/ CrashVia(Post1FailEn(w), Post1FailPoint(w), Post1FailNext(w), p, w)
    \/ CrashVia(Sent1En(w), "AfterSaveSent", Sent1Next(w), p, w)
    \/ CrashVia(FAnswerEn(w), "AfterAnswerRecords", FAnswerNext(w), p, w)
    \/ CrashVia(FDoneEn(w), "AfterFinishedSave", FDoneNext(w), p, w)
    \/ CrashVia(RCheckEn(w), RCheckPoint(w), RCheckNext(w), p, w)
    \/ CrashVia(RelEn(w), RelPoint(w), RelNext(w), p, w)
    \/ CrashVia(RereadEn(w), RereadPoint(w), RereadNext(w), p, w)

\* SQL writes.
Crash_AfterAcquireLock(w)         == CrashAt("AfterAcquireLock", w)
Crash_AfterRaiseVersion(w)        == CrashAt("AfterRaiseVersion", w)        \* ab76f5d only
Crash_AfterStartTurn(w)           == CrashAt("AfterStartTurn", w)
Crash_AfterRestartSave(w)         == CrashAt("AfterRestartSave", w)
Crash_AfterResumeSave(w)          == CrashAt("AfterResumeSave", w)
Crash_AfterSaveIntent(w)          == CrashAt("AfterSaveIntent", w)
Crash_AfterSaveSent(w)            == CrashAt("AfterSaveSent", w)
Crash_AfterSavePause(w)           == CrashAt("AfterSavePause", w)
Crash_AfterSaveError(w)           == CrashAt("AfterSaveError", w)           \* ab76f5d only
Crash_AfterFinishingSave(w)       == CrashAt("AfterFinishingSave", w)
Crash_AfterSaveDeliveryAttempt(w) == CrashAt("AfterSaveDeliveryAttempt", w)
Crash_AfterAnswerRecords(w)       == CrashAt("AfterAnswerRecords", w)
Crash_AfterFinishedSave(w)        == CrashAt("AfterFinishedSave", w)
Crash_AfterReleaseLock(w)         == CrashAt("AfterReleaseLock", w)
\* Redis operations.
Crash_AfterRedisLock(w)           == CrashAt("AfterRedisLock", w)           \* ab76f5d only
Crash_AfterInboxRemove(w)         == CrashAt("AfterInboxRemove", w)
Crash_AfterWakeCompareAndSet(w)   == CrashAt("AfterWakeCompareAndSet", w)
Crash_AfterInboxRead(w)           == CrashAt("AfterInboxRead", w)
\* Posts.
Crash_AfterPost(w)                == CrashAt("AfterPost", w)
\* send() (P32 steps). The step's write, then the sender dies.
CrashSend(p) ==
    /\ SEND_STEPS /\ SendEn /\ SendPoint = p /\ s.lossBudget > 0
    /\ s' = [SendNext EXCEPT !.sendDown = TRUE, !.lossBudget = @ - 1]
Crash_AfterRecordInsert == CrashSend("AfterRecordInsert")
Crash_AfterAppend       == CrashSend("AfterAppend")
Crash_AfterWakeSet      == CrashSend("AfterWakeSet")
Crash_AfterWakeIndex    == CrashSend("AfterWakeIndex")
CrashSender == Crash_AfterRecordInsert \/ Crash_AfterAppend \/ Crash_AfterWakeSet \/ Crash_AfterWakeIndex
\* The provider accepted the post, but the reply was lost with the worker.
Crash_PostAcceptedReplyLost(w) ==
    \/ /\ Post0OkEn(w) /\ s.lossBudget > 0
       /\ s' = Norm(Lose(DoPost(s, w, <<TurnOf(w), 0>>, "sent0"), w))
    \/ /\ Post1OkEn(w) /\ s.lossBudget > 0
       /\ s' = Norm(Lose(DoPost(s, w, <<TurnOf(w), 1>>, "sent1"), w))

Crash(w) ==
    \/ Crash_AfterAcquireLock(w) \/ Crash_AfterRaiseVersion(w) \/ Crash_AfterStartTurn(w)
    \/ Crash_AfterRestartSave(w) \/ Crash_AfterResumeSave(w) \/ Crash_AfterSaveIntent(w)
    \/ Crash_AfterSaveSent(w) \/ Crash_AfterSavePause(w) \/ Crash_AfterSaveError(w)
    \/ Crash_AfterFinishingSave(w) \/ Crash_AfterSaveDeliveryAttempt(w)
    \/ Crash_AfterAnswerRecords(w) \/ Crash_AfterFinishedSave(w) \/ Crash_AfterReleaseLock(w)
    \/ Crash_AfterRedisLock(w) \/ Crash_AfterInboxRemove(w) \/ Crash_AfterWakeCompareAndSet(w)
    \/ Crash_AfterInboxRead(w) \/ Crash_AfterPost(w) \/ Crash_PostAcceptedReplyLost(w)

Fault ==
    \/ BreakTarget \/ CrashSender
    \/ \E t \in TurnIds : SignIn(t)
    \/ \E w \in Workers : Crash(w) \/ LockExpires(w) \/ CheckIn(w)

Time == ExpireDead \/ \E t \in TurnIds : LinkExpires(t)

\* Person B and Slack: send() goes on, and Slack delivers again after a
\* sender crash until the send is acked.
Sender == SendStep \/ SendRedeliver

Next ==
    \/ \E w \in Workers : Progress(w)
    \/ Sender \/ Time \/ TimerJob \/ RepairJob \/ Fault

vars == s

Spec == Init /\ [][Next]_vars

FairCore == WF_vars(Progress("w1")) /\ WF_vars(Progress("w2")) /\ WF_vars(Time) /\ WF_vars(TimerJob)
            /\ WF_vars(Sender)
SpecFairCore == Spec /\ FairCore
SpecFairRepair == Spec /\ FairCore /\ WF_vars(RepairJob)

(***************************************************************************)
(* Safety                                                                  *)
(***************************************************************************)

\* I1: at most one open turn per conversation (rule 1, P2).
i1_oneOpenTurn == Cardinality({t \in TurnIds : s.turns[t].status \in Open}) <= 1

\* I2: a finished turn stays finished (rule 2).
i2_finishedStaysFinished == \A t \in TurnIds : s.finalSeen[t] = "" \/ s.turns[t].status = s.finalSeen[t]

\* I3 (saves): no save from a worker whose lock a newer worker took is
\* accepted (rule 3, P5).
i3_noStaleSave == ~s.staleWrite

\* The newest lock version belongs to the newest lock holder (P5).
versionFollowsLock ==
    \A a, b \in Workers :
        LET x == s.workers[a]
            y == s.workers[b]
        IN (x.ver > 0 /\ y.ver > 0 /\ x.ver > y.ver) => x.seq > y.seq

\* I3 (posts): no post from a worker whose lock a newer worker took. P5
\* "Limit" accepts this window. Expected to fail.
i3_noStalePost == ~s.stalePost

\* I7: each delivery id is posted at most once, unless a takeover came
\* between its intent and its post (P5, then detected by `find`).
i7_noUndetectedDoublePost == \A d \in DeliveryIds : s.cleanPosts[d] <= 1

\* A restart only follows a lost worker, never a worker that gave the turn
\* back after an error (Decided; P4, P8, P31).
restartOnlyAfterLoss == "restartWithNoLostWorker" \notin s.ex

\* `failed: lost_worker` only when a worker was lost.
lostWorkerIsReal == "lostWorkerWithNoLostWorker" \notin s.ex

\* A message is taken into at most one turn.
takenOnce ==
    \A a, b \in TurnIds :
        (a # b /\ s.turns[a].status # "none" /\ s.turns[b].status # "none")
            => s.turns[a].msg # s.turns[b].msg

\* P4 (decided): at most 1 restart, and errors seen plus restarts stay
\* within the limit of 5 (`failures`, a ghost that counts both in every
\* revision).
errorBudget ==
    \A t \in TurnIds :
        /\ s.turns[t].restarts <= RESTART_LIMIT
        /\ s.turns[t].failures <= ERROR_LIMIT
        /\ s.turns[t].errors <= ERROR_LIMIT

\* One failure uses at most one error: an attempt that saved error_retry is
\* not charged again as a lost worker.
oneChargePerAttempt == "doubleCharge" \notin s.ex

\* A release does not notify a worker when the only work left waits for a
\* sign-in and nothing was sent since the previous release (the wake loop).
noWakeLoopWhileBlocked == "wakeLoopWhileBlocked" \notin s.ex

safety ==
    /\ i1_oneOpenTurn /\ i2_finishedStaysFinished /\ i3_noStaleSave /\ versionFollowsLock
    /\ i7_noUndetectedDoublePost /\ restartOnlyAfterLoss /\ lostWorkerIsReal /\ takenOnce
    /\ errorBudget /\ oneChargePerAttempt

(***************************************************************************)
(* Worked examples. Each holds until the example happens, so its violation *)
(* is the example's trace (it must be reachable).                          *)
(***************************************************************************)
ex_turn_E1_redeliveredPrompt == "redeliveredPrompt" \notin s.ex
ex_turn_E2_deadWorker == "restart" \notin s.ex
ex_turn_E2_lostTwice == "lostTwice" \notin s.ex
ex_turn_E3_slowWorker == "slowWorkerRefused" \notin s.ex
ex_turn_E4_retriesRunOut == "retriesRanOutNextTurnRuns" \notin s.ex
ex_turn_E6_finishingDeliveryFails == ~(s.turns[1].status = "failed" /\ s.delivery[<<1, 1>>] = "failed")
ex_turn_E7_messageWhileLocked ==
    ~(s.turns[2].status # "none" /\ s.turns[2].msg = "m2" /\ s.turns[1].status = "completed")
ex_edges_E1_findBeforeRepost == "foundOnRecover" \notin s.ex
ex_access_E2_linkExpires == ~(s.turns[1].outcome = "sign_in_expired" /\ s.turns[1].status = "stopped")
ex_signInResumes == "resumedAfterSignIn" \notin s.ex
\* Notifies pile up in the queue (the count has no cap).
ex_notifyPileUp == s.queue < 3
\* A redelivery resumes send() after a sender crash.
ex_sendResumedAfterCrash == ~(s.send = "done" /\ "sendResumed" \in s.ex)
\* P4: the restart after a lost worker uses the turn's last error.
ex_restartUsesLastError == "restartUsedLastError" \notin s.ex

(***************************************************************************)
(* Liveness. Run with SpecFairCore or SpecFairRepair (see checks.txt).     *)
(***************************************************************************)
Quiet == (\A w \in Workers : s.workers[w].pc = "idle") /\ s.queue = 0

\* L1: every request record ends answered or stopped.
l1_requestsEnd == \A m \in Msgs : [](s.requests[m] = "open" => <>(s.requests[m] # "open"))

\* L2: no turn stays `finishing` forever.
l2_finishingEnds == \A t \in TurnIds : [](s.turns[t].status = "finishing" => <>(s.turns[t].status \in Final))

\* L3: a paused turn is eventually resumed or finished.
l3_pausedResumed == \A t \in TurnIds : [](s.turns[t].status = "paused" => <>(s.turns[t].status # "paused"))
\* L3 with no fairness for the repair job (SpecFairCore). It holds in runs
\* with no lost notify (wakeLive_design). Documented limit (P46, decided):
\* after a lost notify a paused turn waits for the repair job, as a lost
\* running turn does (errors_design: expected to fail).
l3_pausedResumedNoRepair == l3_pausedResumed

\* A running turn whose worker was lost is picked up. Run with SpecFairCore.
lostTurnPickedUpNoRepair == \A t \in TurnIds : [](s.turns[t].status = "running" => <>(s.turns[t].status # "running"))

\* When all work is done, workers stop being notified (no wake loop).
quiesces == <>[]Quiet

=============================================================================
