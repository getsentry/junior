// -*- mode: Bluespec; -*-
// Model 2: the stop time and the clocks it is compared with (P34).
//
// One conversation, one person actor. The person sends m1 and m2 and
// clicks stop, in any order, at distinct real times. Each source stamps its
// action with its own clock: an input's createdAtMs = 2*(real + IN_SKEW),
// the stop input's createdAtMs = 2*(real + STOP_SKEW). The database clock
// is the real time, so a turn's startedAtMs = 2*now + 1 at startTurn
// (design.md:225-226). Source stamps are even and database stamps odd, so
// no comparison is a tie. Junior gets each action after any lag, in any
// order.
//
// The worker is atomic per SQL write (model 1 covers the worker lock). A
// turn takes in input (startTurn, or join now through saveCheckpoint),
// saves one delivery intent, posts it, and finishes at a safe point.
//
// Ground truth is the person's own order of actions (real times). "Older
// than the stop" means the person sent it before clicking stop.
module stopClock {
  // Clock offsets from the database clock, in ticks.
  const IN_SKEW: int
  const STOP_SKEW: int
  // How a turn is tested against the stop time:
  // "started": stopAtMs > turn.startedAtMs (5ed29c2, design.md:648-649).
  // "input":   stopAtMs > createdAtMs of the turn's starting input.
  // "oldest":  stopAtMs > the oldest createdAtMs the turn took in (start
  //            or join now). Proposed.
  // "seq":     arrival order. send() numbers each message (inboxSeq);
  //            stop() saves the number it saw. Input is older than the stop
  //            when its number is at most that one. No clock.
  const STOP_TEST: str
  // Proposed extra rules: a join refuses input older than the stop time,
  // and finishTurn(stopped) re-sends taken-in input that is newer than it.
  const JOIN_FIX: bool

  pure val MSGS = Set("m1", "m2")
  pure val TURNS = Set(1, 2)
  pure val TMAX = 6
  pure val NONE = -100

  type Msg = { sent: bool, real: int, created: int, seq: int, arrived: bool, inInbox: bool, ended: str }
  type Turn = {
    status: str, // none, running, completed, stopped
    first: str,
    inputs: Set[str],
    startedAt: int,
    intents: int,
    posted: int,
  }
  type State = {
    now: int,
    msgs: str -> Msg,
    stopClicked: bool,
    stopReal: int,
    stopCreated: int,
    stopAt: int, // conversation row; NONE until stop() runs
    stopSeq: int, // "seq" rule: inboxSeq when stop() ran
    inboxSeq: int,
    turns: int -> Turn,
    nextTurn: int,
    ex: Set[str], // ghost flags
  }

  var s: State

  pure val noMsg: Msg = { sent: false, real: NONE, created: NONE, seq: NONE, arrived: false, inInbox: false, ended: "" }
  pure val noTurn: Turn = { status: "none", first: "", inputs: Set(), startedAt: NONE, intents: 0, posted: 0 }
  pure def flag(st: State, f: str): State = { ...st, ex: st.ex.union(Set(f)) }
  pure def flagIf(st: State, c: bool, f: str): State = if (c) flag(st, f) else st

  action init = s' = {
    now: 0, msgs: MSGS.mapBy(m => noMsg), stopClicked: false, stopReal: NONE,
    stopCreated: NONE, stopAt: NONE, stopSeq: NONE, inboxSeq: 0, turns: TURNS.mapBy(t => noTurn), nextTurn: 1, ex: Set(),
  }

  def openTurn: int = TURNS.fold(0, (a, t) => if (s.turns.get(t).status == "running") t else a)

  // Ground truth.
  pure def sentBeforeClick(st: State, m: str): bool = st.stopClicked and st.msgs.get(m).real < st.stopReal
  pure def sentAfterClick(st: State, m: str): bool = st.stopClicked and st.msgs.get(m).real > st.stopReal
  // The design's test for an input (startTurn, design.md:646-647).
  pure def olderThanStop(st: State, m: str): bool =
    st.stopAt != NONE and
      (if (STOP_TEST == "seq") st.msgs.get(m).seq <= st.stopSeq else st.msgs.get(m).created < st.stopAt)
  // The design's test for a turn.
  pure def underStop(st: State, tu: Turn): bool =
    st.stopAt != NONE and
      (if (STOP_TEST == "started") st.stopAt > tu.startedAt
       else if (STOP_TEST == "input") st.stopAt > st.msgs.get(tu.first).created
       else tu.inputs.exists(m => olderThanStop(st, m)))

  // ---------- the person and the sources ----------

  action tick = all { s.now < TMAX, s' = { ...s, now: s.now + 1 } }

  // Person actions take one tick each, so real times are distinct.
  action personSends(m: str): bool = all {
    s.now < TMAX, not(s.msgs.get(m).sent),
    s' = { ...s, now: s.now + 1, msgs: s.msgs.set(m, { ...noMsg, sent: true, real: s.now, created: 2 * (s.now + IN_SKEW) }) },
  }

  action personClicksStop = all {
    s.now < TMAX, not(s.stopClicked),
    s' = { ...s, now: s.now + 1, stopClicked: true, stopReal: s.now, stopCreated: 2 * (s.now + STOP_SKEW) },
  }

  // send(): the message reaches the inbox, after any lag.
  action arrive(m: str): bool = all {
    s.msgs.get(m).sent, not(s.msgs.get(m).arrived),
    s' = { ...s, inboxSeq: s.inboxSeq + 1,
      msgs: s.msgs.set(m, { ...s.msgs.get(m), seq: s.inboxSeq + 1, arrived: true, inInbox: true }) },
  }

  // stop(): saves the stop input's own createdAtMs (design.md:642-644).
  action stopArrives = all {
    s.stopClicked, s.stopAt == NONE,
    s' = { ...s, stopAt: s.stopCreated, stopSeq: s.inboxSeq },
  }

  // ---------- the worker ----------

  // startTurn (one transaction): input older than the stop time ends
  // through a closing turn as "not run"; otherwise a turn opens.
  action start(m: str): bool = all {
    openTurn == 0,
    s.nextTurn <= 2,
    s.msgs.get(m).inInbox,
    // Inbox order: oldest createdAtMs first.
    MSGS.forall(o => (o != m and s.msgs.get(o).inInbox) implies s.msgs.get(o).created >= s.msgs.get(m).created),
    val x = s.msgs.get(m)
    if (olderThanStop(s, m)) {
      val s1 = { ...s, msgs: s.msgs.set(m, { ...x, inInbox: false, ended: "notRun" }) }
      s' = flagIf(s1, sentAfterClick(s, m), "newerInputRefused")
    } else {
      val t = s.nextTurn
      val tu = { ...noTurn, status: "running", first: m, inputs: Set(m), startedAt: 2 * s.now + 1 }
      val s1 = { ...s, nextTurn: t + 1, turns: s.turns.set(t, tu), msgs: s.msgs.set(m, { ...x, inInbox: false }) }
      // I11 (ground truth): after stop(), no turn starts with input the
      // person sent before the click.
      s' = flagIf(s1, s.stopAt != NONE and sentBeforeClick(s, m), "olderStartedAfterStop")
    },
  }

  // Join now: saveCheckpoint with takeIn. Fenced, so refused under the stop.
  // The design checks input age only in startTurn; JOIN_FIX checks it here.
  action join(t: int, m: str): bool = all {
    val tu = s.turns.get(t)
    val x = s.msgs.get(m)
    all {
      tu.status == "running", x.inInbox, not(underStop(s, tu)),
      if (JOIN_FIX and olderThanStop(s, m)) {
        val s1 = { ...s, msgs: s.msgs.set(m, { ...x, inInbox: false, ended: "notRun" }) }
        s' = flagIf(s1, sentAfterClick(s, m), "newerInputRefused")
      } else {
        val s1 = { ...s,
          turns: s.turns.set(t, { ...tu, inputs: tu.inputs.union(Set(m)) }),
          msgs: s.msgs.set(m, { ...x, inInbox: false }) }
        s' = flagIf(s1, s.stopAt != NONE and sentBeforeClick(s, m), "olderJoinedAfterStop")
      },
    }
  }

  // Save a delivery intent (fenced; refused under the stop).
  action saveIntent(t: int): bool = all {
    val tu = s.turns.get(t)
    all {
      tu.status == "running", tu.intents == tu.posted, tu.intents < 1,
      not(underStop(s, tu)),
      val s1 = { ...s, turns: s.turns.set(t, { ...tu, intents: tu.intents + 1 }) }
      // I10 (ground truth): after stop(), a turn that holds input the
      // person sent before the click saves no new intent.
      s' = flagIf(s1, s.stopAt != NONE and tu.inputs.exists(m => sentBeforeClick(s, m)), "olderIntentAfterStop"),
    }
  }

  action post(t: int): bool = all {
    val tu = s.turns.get(t)
    all {
      tu.intents > tu.posted,
      s' = { ...s, turns: s.turns.set(t, { ...tu, posted: tu.posted + 1 }) },
    }
  }

  // Safe point: finishTurn(stopped) under the stop, else completed after the post.
  action safePoint(t: int): bool = all {
    val tu = s.turns.get(t)
    all {
      tu.status == "running", tu.intents == tu.posted,
      if (underStop(s, tu)) {
        // With JOIN_FIX, taken-in input newer than the stop time goes back
        // to the inbox instead of ending as stopped.
        val back = if (JOIN_FIX) tu.inputs.filter(m => not(olderThanStop(s, m))) else Set()
        val ms2 = MSGS.mapBy(m =>
          if (back.contains(m)) { ...s.msgs.get(m), inInbox: true }
          else if (tu.inputs.contains(m)) { ...s.msgs.get(m), ended: "stopped" }
          else s.msgs.get(m))
        val s1 = { ...s, msgs: ms2, turns: s.turns.set(t, { ...tu, status: "stopped" }) }
        // The stop must spare a turn that holds only input the person sent
        // after the click (turn-stop spec, "Older stop").
        val s2 = flagIf(s1, tu.inputs.forall(m => sentAfterClick(s, m)), "newerTurnStopped")
        // And no input sent after the click ends as stopped.
        s' = flagIf(s2, tu.inputs.exclude(back).exists(m => sentAfterClick(s, m)), "newerInputStopped")
      } else all {
        tu.posted == 1,
        s' = { ...s, turns: s.turns.set(t, { ...tu, status: "completed" }) },
      },
    }
  }

  action step = any {
    tick, personClicksStop, stopArrives,
    nondet m = MSGS.oneOf()
    any { personSends(m), arrive(m), start(m) },
    nondet t = TURNS.oneOf()
    nondet m = MSGS.oneOf()
    any { saveIntent(t), post(t), safePoint(t), join(t, m) },
  }

  // ---------- properties ----------

  /// I10, ground truth: after stop(), a turn with input the person sent
  /// before the click saves no new delivery intent (so it posts only from
  /// intents saved before the stop).
  val i10_noOlderIntentAfterStop = not(s.ex.contains("olderIntentAfterStop"))
  /// I11, ground truth: after stop(), no turn starts with input the person
  /// sent before the click.
  val i11_noOlderStartAfterStop = not(s.ex.contains("olderStartedAfterStop"))
  /// I11 extended to join now: older input never joins a turn after stop().
  val i11j_noOlderJoinAfterStop = not(s.ex.contains("olderJoinedAfterStop"))
  /// "Older stop" (turn-stop spec): a stop never stops a turn that holds
  /// only input the person sent after the click.
  val spareNewerTurn = not(s.ex.contains("newerTurnStopped"))
  /// No input the person sent after the click ends as stopped or not run.
  val spareNewerInput = not(s.ex.contains("newerInputStopped")) and not(s.ex.contains("newerInputRefused"))

  val safety = i10_noOlderIntentAfterStop and i11_noOlderStartAfterStop and i11j_noOlderJoinAfterStop
    and spareNewerTurn and spareNewerInput

  // Witnesses (expected violated: the example is reachable).
  /// turn E5: a stop after a post ends the turn stopped; the post stays.
  val ex_turn_E5_stopAfterPost = not(TURNS.exists(t => s.turns.get(t).status == "stopped" and s.turns.get(t).posted == 1))
  /// "Stop races a turn start": startTurn refuses older input as not run.
  val ex_stop_refusesOlderInput = not(MSGS.exists(m => s.msgs.get(m).ended == "notRun" and sentBeforeClick(s, m)))
  /// "Older stop": a newer turn runs to completed after the stop.
  val ex_stop_newerTurnRuns = not(TURNS.exists(t => s.turns.get(t).status == "completed" and sentAfterClick(s, s.turns.get(t).first) and s.stopAt != NONE))
}

// IN_SKEW is the input source's clock offset, STOP_SKEW the stop's.
// Same source (a Slack message and the Slack stop button): one clock, which
// may run ahead of or behind the database clock.
module stop_design_same { import stopClock(IN_SKEW = 0, STOP_SKEW = 0, STOP_TEST = "started", JOIN_FIX = false).* }
module stop_design_ahead { import stopClock(IN_SKEW = 3, STOP_SKEW = 3, STOP_TEST = "started", JOIN_FIX = false).* }
module stop_design_behind { import stopClock(IN_SKEW = -3, STOP_SKEW = -3, STOP_TEST = "started", JOIN_FIX = false).* }
// The parent agent's suggestion alone: compare with the starting input.
module stop_input_same { import stopClock(IN_SKEW = 0, STOP_SKEW = 0, STOP_TEST = "input", JOIN_FIX = false).* }
// Proposed: oldest taken-in input, join refuses older input, re-send newer.
module stop_proposed_same { import stopClock(IN_SKEW = 0, STOP_SKEW = 0, STOP_TEST = "oldest", JOIN_FIX = true).* }
module stop_proposed_ahead { import stopClock(IN_SKEW = 3, STOP_SKEW = 3, STOP_TEST = "oldest", JOIN_FIX = true).* }
module stop_proposed_behind { import stopClock(IN_SKEW = -3, STOP_SKEW = -3, STOP_TEST = "oldest", JOIN_FIX = true).* }
// Two clocks (a dashboard stop on a Slack thread; a tree stop into a child
// whose input core mints): the stop clock runs 2 ticks ahead or behind.
module stop_proposed_crossAhead { import stopClock(IN_SKEW = 0, STOP_SKEW = 2, STOP_TEST = "oldest", JOIN_FIX = true).* }
module stop_proposed_crossBehind { import stopClock(IN_SKEW = 0, STOP_SKEW = -2, STOP_TEST = "oldest", JOIN_FIX = true).* }
// Arrival order instead of a clock.
module stop_seq_same { import stopClock(IN_SKEW = 0, STOP_SKEW = 0, STOP_TEST = "seq", JOIN_FIX = true).* }
