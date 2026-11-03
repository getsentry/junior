----------------------------- MODULE StopClock -----------------------------
(***************************************************************************)
(* Model 2: the stop time on one receive clock (P34, P44 option 1).        *)
(*                                                                         *)
(* One conversation, one person actor. The person sends m1 and m2 and      *)
(* clicks stop, in any order, at distinct real times. Core stamps each     *)
(* input with database now() when it receives it (inbox append), and each  *)
(* stop with database now() in the stop() transaction. Core-minted child   *)
(* input gets the stamp of its own transaction, the same path. "Older than *)
(* the stop" means Junior received it earlier: its stamp is below the stop *)
(* time.                                                                   *)
(*                                                                         *)
(* Each source also stamps its own createdAtMs with its own clock (IN_SKEW,*)
(* STOP_SKEW). The rule never reads it. It is kept to show that a skewed   *)
(* source (a dashboard stop on a Slack thread, a tree stop into a child)   *)
(* does not change the result.                                             *)
(*                                                                         *)
(* Two gaps are their own steps, so races with them are explored:          *)
(* - receive: an input reads now() for its stamp, then the inbox append    *)
(*   comes in a later step;                                                *)
(* - stop(): now() is fixed at the transaction start, and the commit (when *)
(*   workers can see the stop time) comes in a later step.                 *)
(*                                                                         *)
(* The worker is atomic per SQL write (model 1 covers the worker lock).    *)
(***************************************************************************)
EXTENDS Integers

CONSTANTS
    IN_SKEW,    \* input source clock minus the database clock (ghost only)
    STOP_SKEW,  \* stop source clock minus the database clock (ghost only)
    JOIN_FIX    \* P34 rules 2 and 4: joins refuse older input, newer input goes back

Msgs == {"m1", "m2"}
TurnIds == {1, 2}
TMAX == 6
NONE == -100
\* A .cfg file cannot hold a negative number. These name the skews.
Behind2 == -2
Behind3 == -3

VARIABLE s

NoMsg == [sent |-> FALSE,
          real |-> NONE,      \* when the person sent it (ghost)
          created |-> NONE,   \* source createdAtMs (ghost; never read by the rule)
          stamp |-> NONE,     \* database now() at receive
          inInbox |-> FALSE, appended |-> FALSE,
          ended |-> ""]       \* "", "notRun", "stopped"
NoTurn == [status |-> "none", inputs |-> {}, intents |-> 0, posted |-> 0]

Flag(st, f) == [st EXCEPT !.ex = @ \cup {f}]
FlagIf(st, c, f) == IF c THEN Flag(st, f) ELSE st

Init ==
    s = [now |-> 0, msgs |-> [m \in Msgs |-> NoMsg],
         stopClicked |-> FALSE, stopReal |-> NONE, stopCreated |-> NONE,
         stopTx |-> NONE,   \* now() of the open stop() transaction
         stopAt |-> NONE,   \* the committed stop time on the conversation row
         turns |-> [t \in TurnIds |-> NoTurn], nextTurn |-> 1, ex |-> {}]

OpenTurn == IF \E t \in TurnIds : s.turns[t].status = "running"
            THEN CHOOSE t \in TurnIds : s.turns[t].status = "running" ELSE 0

\* The rule, and the invariants: receive order against the committed stop.
Older(st, m) == st.stopAt # NONE /\ st.msgs[m].stamp # NONE /\ st.msgs[m].stamp < st.stopAt
Newer(st, m) == st.stopAt # NONE /\ ~Older(st, m)
UnderStop(st, tu) == \E m \in tu.inputs : Older(st, m)
\* The person's own order, for the accepted-behavior witnesses only.
SentBeforeClick(st, m) == st.stopClicked /\ st.msgs[m].real < st.stopReal
SentAfterClick(st, m) == st.stopClicked /\ st.msgs[m].real > st.stopReal

(***************************************************************************)
(* The person and the sources                                              *)
(***************************************************************************)
Tick == s.now < TMAX /\ s' = [s EXCEPT !.now = @ + 1]

PersonSends(m) ==
    /\ s.now < TMAX /\ ~s.msgs[m].sent
    /\ s' = [s EXCEPT !.now = @ + 1,
                      !.msgs[m] = [NoMsg EXCEPT !.sent = TRUE, !.real = s.now, !.created = s.now + IN_SKEW]]

PersonClicksStop ==
    /\ s.now < TMAX /\ ~s.stopClicked
    /\ s' = [s EXCEPT !.now = @ + 1, !.stopClicked = TRUE, !.stopReal = s.now,
                      !.stopCreated = s.now + STOP_SKEW]

\* send(), part 1: read database now() for the stamp. Any lag before it.
Receive(m) ==
    /\ s.msgs[m].sent /\ s.msgs[m].stamp = NONE
    /\ s' = [s EXCEPT !.msgs[m].stamp = s.now]

\* send(), part 2: the inbox append.
AppendInbox(m) ==
    /\ s.msgs[m].stamp # NONE /\ ~s.msgs[m].appended
    /\ s' = [s EXCEPT !.msgs[m].appended = TRUE, !.msgs[m].inInbox = TRUE]

\* stop(): the transaction starts (now() is fixed here), then commits.
StopBegins ==
    /\ s.stopClicked /\ s.stopTx = NONE /\ s.stopAt = NONE
    /\ s' = [s EXCEPT !.stopTx = s.now]
StopCommits ==
    /\ s.stopTx # NONE /\ s.stopAt = NONE
    /\ s' = [s EXCEPT !.stopAt = s.stopTx]

(***************************************************************************)
(* The worker                                                              *)
(***************************************************************************)

\* startTurn (one transaction): input older than the stop time ends through
\* a closing turn as "not run"; otherwise a turn opens. Oldest stamp first.
Start(m) ==
    /\ OpenTurn = 0 /\ s.nextTurn <= 2 /\ s.msgs[m].inInbox
    /\ \A o \in Msgs : (o # m /\ s.msgs[o].inInbox) => s.msgs[o].stamp >= s.msgs[m].stamp
    /\ IF Older(s, m)
       THEN s' = [s EXCEPT !.msgs[m].inInbox = FALSE, !.msgs[m].ended = "notRun"]
       ELSE s' = [s EXCEPT !.nextTurn = @ + 1, !.msgs[m].inInbox = FALSE,
                           !.turns[s.nextTurn] = [NoTurn EXCEPT !.status = "running", !.inputs = {m}]]

\* Join now: saveCheckpoint with takeIn. Fenced, so refused under the stop.
Join(t, m) ==
    LET tu == s.turns[t]
    IN /\ tu.status = "running" /\ s.msgs[m].inInbox /\ ~UnderStop(s, tu)
       /\ IF JOIN_FIX /\ Older(s, m)
          THEN s' = [s EXCEPT !.msgs[m].inInbox = FALSE, !.msgs[m].ended = "notRun"]
          ELSE s' = FlagIf([s EXCEPT !.turns[t].inputs = @ \cup {m}, !.msgs[m].inInbox = FALSE],
                           Older(s, m), "olderJoinedAfterStop")

\* Save a delivery intent (fenced; refused under the stop).
SaveIntent(t) ==
    LET tu == s.turns[t]
    IN /\ tu.status = "running" /\ tu.intents = tu.posted /\ tu.intents < 1
       /\ ~UnderStop(s, tu)
       /\ s' = FlagIf([s EXCEPT !.turns[t].intents = @ + 1],
                      \E m \in tu.inputs : Older(s, m), "olderIntentAfterStop")

Post(t) ==
    /\ s.turns[t].intents > s.turns[t].posted
    /\ s' = [s EXCEPT !.turns[t].posted = @ + 1]

\* Safe point: finishTurn(stopped) under the stop, else completed after the
\* post. With JOIN_FIX, taken-in input not older than the stop goes back.
SafePoint(t) ==
    LET tu == s.turns[t]
        back == IF JOIN_FIX THEN {m \in tu.inputs : ~Older(s, m)} ELSE {}
    IN /\ tu.status = "running" /\ tu.intents = tu.posted
       /\ IF UnderStop(s, tu)
          THEN s' = FlagIf([s EXCEPT
                               !.msgs = [m \in Msgs |->
                                   IF m \in back THEN [s.msgs[m] EXCEPT !.inInbox = TRUE]
                                   ELSE IF m \in tu.inputs THEN [s.msgs[m] EXCEPT !.ended = "stopped"]
                                   ELSE s.msgs[m]],
                               !.turns[t].status = "stopped"],
                           \A m \in tu.inputs : Newer(s, m), "newerTurnStopped")
          ELSE tu.posted = 1 /\ s' = [s EXCEPT !.turns[t].status = "completed"]

Next ==
    \/ Tick \/ PersonClicksStop \/ StopBegins \/ StopCommits
    \/ \E m \in Msgs : PersonSends(m) \/ Receive(m) \/ AppendInbox(m) \/ Start(m)
    \/ \E t \in TurnIds : SaveIntent(t) \/ Post(t) \/ SafePoint(t) \/ \E m \in Msgs : Join(t, m)

Spec == Init /\ [][Next]_s

(***************************************************************************)
(* Invariants (receive order)                                              *)
(***************************************************************************)

\* I10: after the stop commits, no delivery intent is saved for a turn that
\* holds input received before the stop.
i10_noOlderIntentAfterStop == "olderIntentAfterStop" \notin s.ex

\* I11: an open turn that holds input received before the stop is under the
\* stop, so its saves refuse.
i11_noOlderStartAfterStop ==
    \A t \in TurnIds :
        (s.turns[t].status = "running" /\ \E m \in s.turns[t].inputs : Older(s, m))
            => UnderStop(s, s.turns[t])

\* I11 for joins (i11j): no join takes in input received before the stop.
i11j_noOlderJoinAfterStop == "olderJoinedAfterStop" \notin s.ex

\* I14: a stop never stops a turn that holds only input received after it.
spareNewerTurn == "newerTurnStopped" \notin s.ex

\* I14: no input received after the stop ends as stopped or not run.
spareNewerInput == \A m \in Msgs : s.msgs[m].ended # "" => Older(s, m)

safety ==
    i10_noOlderIntentAfterStop /\ i11_noOlderStartAfterStop /\ i11j_noOlderJoinAfterStop
    /\ spareNewerTurn /\ spareNewerInput

(***************************************************************************)
(* Witnesses: each holds until the example happens, so its violation is    *)
(* the example's trace.                                                    *)
(***************************************************************************)

\* turn E5: a stop after a post ends the turn stopped; the post stays.
ex_turn_E5_stopAfterPost == ~\E t \in TurnIds : s.turns[t].status = "stopped" /\ s.turns[t].posted = 1

\* "Stop races a turn start": older input ends as not run.
ex_stop_refusesOlderInput == ~\E m \in Msgs : s.msgs[m].ended = "notRun"

\* "Older stop": a turn with input received after the stop completes.
ex_stop_newerTurnRuns ==
    ~\E t \in TurnIds : s.turns[t].status = "completed" /\ \E m \in s.turns[t].inputs : Newer(s, m)

\* P34 rule 4: newer taken-in input goes back to the inbox.
ex_stop_newerInputRequeued ==
    ~\E t \in TurnIds : s.turns[t].status = "stopped"
                        /\ \E m \in s.turns[t].inputs : Newer(s, m) /\ s.msgs[m].ended = ""

\* ACCEPTED (P44 option 1): the person sent it before clicking stop, but
\* Junior received it after the stop, so it runs.
acc_lateSentBeforeStopRuns ==
    ~\E t \in TurnIds : s.turns[t].status = "completed"
                        /\ \E m \in s.turns[t].inputs : SentBeforeClick(s, m) /\ Newer(s, m)

\* ACCEPTED (P44 option 1): the person sent it after clicking stop, but
\* Junior received it before the stop committed, so it does not run.
acc_earlySentAfterStopNotRun == ~\E m \in Msgs : s.msgs[m].ended # "" /\ SentAfterClick(s, m)

=============================================================================
