// -*- mode: Bluespec; -*-
// Model 1: worker lock, lock version, turn row, checkpoint saves,
// deliveries, finishTurn, sign-in pause and wake-ups.
//
// One conversation. Two workers. Two inbox messages: m1 (person A, in the
// inbox at start) and m2 (person B, may arrive at any time). Each message
// starts its own turn. Each turn has two deliveries: index 0 is the
// assistant response, index 1 is the error message or ending note that
// finishTurn sends.
//
// A worker can crash, stall or run slowly between any two writes. A stall
// is the worker lock expiring while the worker still runs. Every write is
// its own action, so every interleaving of the two workers is explored.
// A crashed worker's "notify a worker" message comes back from the queue.
// A worker that stops on LockLostError acks its message.
//
// Lock versions and acquisition numbers are kept relative (`norm`), so the
// state space is finite. Only "equal" and "older" comparisons read them.
//
// Constants select a design. `priorDraft` is the plan at ab76f5d.
// `rev2` is the plan at 5122bb7. `design` is the plan at 5ed29c2.
// `proposed` adds the fixes this model suggests. See README.md.
module workerLock {
  // P5: take the worker lock and raise the lock version in one SQL
  // compare-and-set. False: Redis lock, then a separate SQL raise.
  const LOCK_CAS: bool
  // P31: an error saves `paused: error_retry`. False: the turn stays
  // `running`, so the next worker takes it for a lost worker.
  const ERROR_PAUSE: bool
  // P11, P33: each delivery has an attempt limit, then `failed`.
  const DELIVERY_LIMIT: bool
  // How a worker gives back the conversation:
  // "prior": decide "work left", release, then notify (ab76f5d).
  // "p32":   release, then read the inbox record: notify when the inbox
  //          has work or wakeAtMs <= now (5122bb7, P32).
  // "seq":   5ed29c2 (P32): before release, set wakeAtMs to nextRunAtMs
  //          with a compare-and-set on inboxSeq; release; read again and
  //          notify when nextRunAtMs <= now. `dirty` stands for "inboxSeq
  //          changed since this worker read it".
  const WAKE_RULE: str
  // recordSignIn raises inboxSeq and sets wakeAtMs to now before it
  // notifies (proposed). False: it only saves the grant and notifies.
  const SIGN_IN_WAKES: bool
  // The queue holds a delayed "notify a worker" for wakeAtMs, so a wake
  // time fires without the repair job (proposed). False: only the repair
  // job's wake-time index fires it (P7 part 2).
  const DELAYED_NOTIFY: bool

  // Scenario bounds. Each scenario turns on only the features it needs, so
  // TLC can explore it exhaustively.
  const WITH_M2: bool      // person B may send m2
  const WITH_SIGNIN: bool  // turns may pause for sign-in
  const WITH_ERRORS: bool  // attempts may fail with an error
  const WITH_SOFT: bool    // attempts may pause at the soft time limit
  const WITH_BROKEN: bool  // the reply target may refuse every post
  const LOSSES: int        // crashes plus stalls, over the whole run
  const POST_FAILS: int    // posts that fail once and then work

  pure val WORKERS = Set("w1", "w2")
  pure val TURN_IDS = Set(1, 2)
  pure val DELIVERY_IDS = tuples(TURN_IDS, Set(0, 1))
  // Abstracts the limit of 5 turn errors.
  pure val ERROR_LIMIT = 2
  // Abstracts the limit of 5 post attempts per delivery.
  pure val POST_LIMIT = 2
  pure val RESTART_LIMIT = 1
  pure val QUEUE_CAP = 2
  pure val OPEN = Set("running", "paused", "finishing")
  pure val FINAL = Set("completed", "failed", "stopped")

  type Turn = {
    status: str, // none, running, paused, finishing, completed, failed, stopped
    msg: str,
    errors: int,
    restarts: int,
    pause: str, // "", soft_time_limit, post_retry, error_retry, sign_in
    resumedFrom: str,
    outcome: str, // "", completed, error, lost_worker, no_progress, post_failed, sign_in_expired
    softUsed: bool,
    signUsed: bool,
    granted: bool, // turn_authorized saved by recordSignIn
    linkExpired: bool,
    // Ghost: a live worker gave the conversation back with this turn still
    // `running` (no worker was lost).
    handedOff: bool,
  }

  type Worker = {
    pc: str,
    seq: int, // order in which it took the worker lock (0: none)
    ver: int, // lock version it holds (0: none)
    turn: int,
    workLeft: bool,
  }

  type State = {
    // The worker lock: acquisition number of the holder, 0 when free.
    holder: int,
    holderLive: bool,
    // SQL lock version counter.
    sqlVer: int,
    // "Notify a worker" messages on the real work queue.
    queue: int,
    // Redis wakeAtMs: "none", "due" (<= now) or "link" (link expiry, later).
    wake: str,
    // A send() or recordSignIn() came after the last worker read (proposed).
    dirty: bool,
    // Ghost: a send() or recordSignIn() came after the lock holder's last
    // release step.
    freshSend: bool,
    inbox: Set[str],
    arrived: Set[str],
    turns: int -> Turn,
    nextTurn: int,
    requests: str -> str, // none, open, answered, stopped
    delivery: (int, int) -> str, // none, intended, sent, failed
    attempts: (int, int) -> int,
    // What the provider shows: posts with this delivery id.
    posts: (int, int) -> int,
    // Posts with no takeover between their intent and the post.
    cleanPosts: (int, int) -> int,
    broken: bool,
    workers: str -> Worker,
    // Ghost state, read only by properties.
    lastSeq: int,
    maxRaisedSeq: int,
    lossBudget: int,
    postFailBudget: int,
    staleWrite: bool,
    stalePost: bool,
    finalSeen: int -> str,
    ex: Set[str],
  }

  var s: State

  pure val idleWorker: Worker = { pc: "idle", seq: 0, ver: 0, turn: 0, workLeft: false }
  pure val noTurn: Turn = {
    status: "none", msg: "", errors: 0, restarts: 0, pause: "", resumedFrom: "",
    outcome: "", softUsed: false, signUsed: false, granted: false,
    linkExpired: false, handedOff: false,
  }

  // ---------- helpers ----------

  pure def maxOf(a: int, b: int): int = if (a > b) a else b
  pure def inc(q: int): int = if (q < QUEUE_CAP) q + 1 else q

  // Keep lock versions and acquisition numbers small. Each value >= 1 is
  // replaced by its rank among the values in use. 0 keeps meaning "none".
  // Only "equal" and "older" comparisons read these values, and ranking
  // keeps both, so this is an exact abstraction.
  pure def rank(used: Set[int], v: int): int =
    if (v > 0) used.filter(u => u > 0 and u <= v).size() else 0

  pure def norm(st: State): State = {
    val vers = WORKERS.map(w => st.workers.get(w).ver).union(Set(st.sqlVer))
    val seqs = WORKERS.map(w => st.workers.get(w).seq).union(Set(st.holder, st.lastSeq, st.maxRaisedSeq))
    {
      ...st,
      sqlVer: rank(vers, st.sqlVer),
      holder: rank(seqs, st.holder),
      lastSeq: rank(seqs, st.lastSeq),
      maxRaisedSeq: rank(seqs, st.maxRaisedSeq),
      workers: st.workers.keys().mapBy(w => {
        val x = st.workers.get(w)
        { ...x, ver: rank(vers, x.ver), seq: rank(seqs, x.seq) }
      }),
    }
  }

  pure def setW(st: State, w: str, x: Worker): State = { ...st, workers: st.workers.set(w, x) }
  pure def setPc(st: State, w: str, pc: str): State = setW(st, w, { ...st.workers.get(w), pc: pc })
  pure def setTurn(st: State, t: int, x: Turn): State = { ...st, turns: st.turns.set(t, x) }
  pure def flag(st: State, f: str): State = { ...st, ex: st.ex.union(Set(f)) }

  pure def openTurnOf(st: State): int =
    TURN_IDS.fold(0, (acc, t) => if (OPEN.contains(st.turns.get(t).status)) t else acc)
  pure def takenMsgs(st: State): Set[str] =
    TURN_IDS.filter(t => st.turns.get(t).status != "none").map(t => st.turns.get(t).msg)
  pure def isStale(st: State, w: str): bool = st.workers.get(w).seq < st.maxRaisedSeq
  pure def tokenOk(st: State, w: str): bool = st.holder == st.workers.get(w).seq and st.holderLive

  // The worker stops at once: LockLostError or a failed check-in.
  pure def stopWorker(st: State, w: str, why: str): State = flag(setW(st, w, idleWorker), why)

  // One SQL transaction that first checks token and lock version (P5).
  pure def fenced(st: State, w: str, after: State): State =
    if (st.sqlVer == st.workers.get(w).ver and (LOCK_CAS implies tokenOk(st, w)))
      { ...after, staleWrite: after.staleWrite or isStale(st, w) }
    else stopWorker(st, w, "slowWorkerRefused")

  pure def finalOf(outcome: str): str =
    if (outcome == "completed") "completed"
    else if (outcome == "sign_in_expired") "stopped"
    else "failed"

  // ---------- init ----------

  action init = s' = {
    holder: 0, holderLive: false, sqlVer: 1, queue: 1, wake: "due", dirty: true, freshSend: true,
    inbox: Set("m1"), arrived: Set("m1"),
    turns: TURN_IDS.mapBy(t => noTurn), nextTurn: 1,
    requests: Map("m1" -> "open", "m2" -> "none"),
    delivery: DELIVERY_IDS.mapBy(d => "none"),
    attempts: DELIVERY_IDS.mapBy(d => 0),
    posts: DELIVERY_IDS.mapBy(d => 0),
    cleanPosts: DELIVERY_IDS.mapBy(d => 0),
    broken: false,
    workers: WORKERS.mapBy(w => idleWorker),
    lastSeq: 0, maxRaisedSeq: 0, lossBudget: LOSSES, postFailBudget: POST_FAILS,
    staleWrite: false, stalePost: false, finalSeen: TURN_IDS.mapBy(t => ""), ex: Set(),
  }

  // ---------- environment ----------

  // Person B sends m2: append, set wakeAtMs to now, notify (P32).
  action sendM2 = all {
    WITH_M2,
    not(s.arrived.contains("m2")),
    s' = { ...s, arrived: s.arrived.union(Set("m2")), inbox: s.inbox.union(Set("m2")),
           requests: s.requests.set("m2", "open"), queue: inc(s.queue), wake: "due", dirty: true, freshSend: true },
  }

  // A worker process dies between two writes. The queue redelivers its
  // message.
  action crash(w: str): bool = all {
    s.workers.get(w).pc != "idle",
    s.lossBudget > 0,
    s' = norm({ ...setW(s, w, idleWorker), lossBudget: s.lossBudget - 1, queue: inc(s.queue) }),
  }

  // A live worker stalls past 90 s with no check-in. Its lock expires. It
  // keeps running and learns of the loss only at its next check-in or write.
  action stall(w: str): bool = all {
    s.workers.get(w).pc != "idle",
    s.holder == s.workers.get(w).seq, s.holderLive,
    s.lossBudget > 0,
    s' = { ...s, holderLive: false, lossBudget: s.lossBudget - 1 },
  }

  // The lock of a dead worker expires after 90 s.
  action expireDead = all {
    s.holder != 0, s.holderLive,
    WORKERS.forall(w => s.workers.get(w).seq != s.holder),
    s' = { ...s, holderLive: false },
  }

  // The reply target refuses every post for good (archived channel).
  action breakTarget = all { WITH_BROKEN, not(s.broken), s' = { ...s, broken: true } }

  // A worker checks in. False: it stops at once.
  // Only a worker that still holds the lock checks in: after the release
  // (reread, notify, done) it has no lock to lose.
  action checkIn(w: str): bool = all {
    not(Set("idle", "reread", "notify", "done").contains(s.workers.get(w).pc)),
    not(tokenOk(s, w)),
    s' = stopWorker(s, w, "checkInFailed"),
  }

  // Ten minutes pass: the sign-in link expires. wakeAtMs is now due.
  // With DELAYED_NOTIFY the queue delivers the delayed notification.
  action linkExpires(t: int): bool = all {
    s.turns.get(t).status == "paused", s.turns.get(t).pause == "sign_in",
    not(s.turns.get(t).linkExpired),
    s' = { ...setTurn(s, t, { ...s.turns.get(t), linkExpired: true }),
           wake: if (s.wake == "link") "due" else s.wake,
           queue: if (DELAYED_NOTIFY and s.wake == "link") inc(s.queue) else s.queue },
  }

  // The person signs in. recordSignIn saves turn_authorized and notifies.
  action signIn(t: int): bool = all {
    s.turns.get(t).status == "paused", s.turns.get(t).pause == "sign_in",
    not(s.turns.get(t).granted),
    s' = { ...setTurn(s, t, { ...s.turns.get(t), granted: true }), queue: inc(s.queue),
           wake: if (SIGN_IN_WAKES) "due" else s.wake, dirty: s.dirty or SIGN_IN_WAKES, freshSend: true },
  }

  // ab76f5d only: the timer job clears an expired Redis lock and notifies.
  action timerJob = all {
    not(LOCK_CAS), s.holder != 0, not(s.holderLive),
    s' = { ...s, holder: 0, queue: inc(s.queue) },
  }

  // P7 part 2: notify a worker for a conversation with no live lock whose
  // wakeAtMs passed, or with an open turn. It writes nothing else.
  action repairJob = all {
    LOCK_CAS,
    s.holder == 0 or not(s.holderLive),
    s.wake == "due" or openTurnOf(s) != 0,
    s.queue == 0,
    s' = { ...s, queue: inc(s.queue) },
  }

  // ---------- worker ----------

  action acquire(w: str): bool = all {
    s.workers.get(w).pc == "idle",
    s.queue > 0,
    val free = s.holder == 0 or not(s.holderLive)
    val q = { ...s, queue: s.queue - 1 }
    val seq = s.lastSeq + 1
    s' = norm(
      if (not(free)) q // a live lock is held: this notification is dropped
      else if (LOCK_CAS)
        setW({ ...q, holder: seq, holderLive: true, lastSeq: seq, sqlVer: s.sqlVer + 1, maxRaisedSeq: seq },
             w, { ...idleWorker, pc: "ready", seq: seq, ver: s.sqlVer + 1 })
      else
        setW({ ...q, holder: seq, holderLive: true, lastSeq: seq }, w, { ...idleWorker, pc: "redis", seq: seq })),
  }

  // ab76f5d: the SQL raise is a separate write, not tied to the lock.
  action raise(w: str): bool = all {
    s.workers.get(w).pc == "redis",
    val x = s.workers.get(w)
    s' = norm(setW({ ...s, sqlVer: s.sqlVer + 1, maxRaisedSeq: maxOf(s.maxRaisedSeq, x.seq) },
                   w, { ...x, pc: "ready", ver: s.sqlVer + 1 })),
  }

  // work(): read the open turn and do the first step that applies
  // (turn.md, work(), cases 1 to 5).
  action ready(w: str): bool = all {
    s.workers.get(w).pc == "ready",
    val t = openTurnOf(s)
    val x = s.workers.get(w)
    val dup = s.inbox.intersect(takenMsgs(s))
    // The worker reads the inbox record. E1: input whose request id the
    // turn row lists is removed and not taken in again.
    val s0r = { ...s, dirty: if (WAKE_RULE == "seq") false else s.dirty }
    val s0 = if (dup != Set() and tokenOk(s, w))
               flag({ ...s0r, inbox: s.inbox.exclude(dup) }, "redeliveredPrompt")
             else s0r
    val tu = s.turns.get(t)
    s' = norm(
      if (t > 0 and tu.status == "finishing")
        setW(s0, w, { ...x, pc: "fin", turn: t })
      else if (t > 0 and tu.status == "running")
        // No live worker runs it: lost (P8). Restart once, or fail.
        if (tu.restarts < RESTART_LIMIT)
          fenced(s0, w, flag(setW(setTurn(s0, t, { ...tu, restarts: tu.restarts + 1, resumedFrom: "", handedOff: false }),
                                  w, { ...x, pc: "run", turn: t }),
                             if (tu.handedOff) "restartWithNoLostWorker" else "restart"))
        else
          fenced(s0, w, flag(setW(setTurn(s0, t, { ...tu, status: "finishing", outcome: "lost_worker" }),
                                  w, { ...x, pc: "fin", turn: t }),
                             if (tu.handedOff) "lostWorkerWithNoLostWorker" else "lostTwice"))
      else if (t > 0 and tu.status == "paused" and tu.pause == "sign_in")
        // access.md, the sign-in table (no stop or supersede in this model).
        if (tu.granted)
          fenced(s0, w, flag(setW(setTurn(s0, t, { ...tu, status: "running", pause: "", resumedFrom: "sign_in" }),
                                  w, { ...x, pc: "run", turn: t }), "resumedAfterSignIn"))
        else if (tu.linkExpired)
          fenced(s0, w, setW(setTurn(s0, t, { ...tu, status: "finishing", outcome: "sign_in_expired" }),
                             w, { ...x, pc: "fin", turn: t }))
        else
          // Others wait. Nothing to do.
          setW(s0, w, { ...x, pc: "rcheck", turn: t })
      else if (t > 0 and tu.status == "paused")
        fenced(s0, w, setW(setTurn(s0, t, { ...tu, status: "running", pause: "", resumedFrom: tu.pause }),
                           w, { ...x, pc: "run", turn: t }))
      else if (s0.inbox.exclude(takenMsgs(s0)) != Set())
        // startTurn: the unique index allows it only with no open turn.
        val m = if (s0.inbox.contains("m1") and not(takenMsgs(s0).contains("m1"))) "m1" else "m2"
        val nt = s0.nextTurn
        val prevFailed = nt == 2 and s0.turns.get(1).outcome == "error"
        fenced(s0, w, flag(setW(setTurn({ ...s0, nextTurn: nt + 1 }, nt, { ...noTurn, status: "running", msg: m }),
                                w, { ...x, pc: "remove", turn: nt }),
                           if (prevFailed) "retriesRanOutNextTurnRuns" else "turnStarted"))
      else setPc(s0, w, "rcheck")),
  }

  // Remove taken-in input from the inbox, after the SQL commit (rule 6).
  action remove(w: str): bool = all {
    s.workers.get(w).pc == "remove",
    val x = s.workers.get(w)
    s' = norm(if (tokenOk(s, w))
                setPc({ ...s, inbox: s.inbox.exclude(Set(s.turns.get(x.turn).msg)) }, w, "run")
              else stopWorker(s, w, "checkInFailed")),
  }

  def runPre(w: str): bool = all {
    s.workers.get(w).pc == "run",
    s.turns.get(s.workers.get(w).turn).status == "running",
  }

  // Check in, then save the delivery intent with its text (fenced).
  action runIntent(w: str): bool = {
    val t = s.workers.get(w).turn
    all {
      runPre(w),
      s.delivery.get((t, 0)) == "none",
      s' = norm(if (tokenOk(s, w))
                  fenced(s, w, setW({ ...s, delivery: s.delivery.set((t, 0), "intended") }, w,
                                    { ...s.workers.get(w), pc: "post0" }))
                else stopWorker(s, w, "checkInFailed")),
    }
  }

  // An intent with no message id: ask the provider for the delivery id.
  action runRecover(w: str): bool = {
    val t = s.workers.get(w).turn
    all {
      runPre(w),
      s.delivery.get((t, 0)) == "intended",
      s' = norm(if (s.posts.get((t, 0)) > 0)
                  fenced(s, w, flag({ ...s, delivery: s.delivery.set((t, 0), "sent") }, "foundOnRecover"))
                else setW(s, w, { ...s.workers.get(w), pc: "post0" })),
    }
  }

  pure def doPost(st: State, w: str, d: (int, int), nextPc: str): State = {
    // Every intent save is fenced, so a worker that is stale at its post
    // saw a takeover between its intent (or its find) and the post.
    val stale = isStale(st, w)
    val clean = not(stale)
    setPc({ ...st,
      posts: st.posts.set(d, st.posts.get(d) + 1),
      cleanPosts: if (clean) st.cleanPosts.set(d, st.cleanPosts.get(d) + 1) else st.cleanPosts,
      stalePost: st.stalePost or stale }, w, nextPc)
  }

  // A post failed. With DELIVERY_LIMIT, count it; at the limit the
  // delivery is `failed` and the turn ends `failed: post_failed` (P11).
  pure def postFailedRunning(st: State, w: str, t: int): State = {
    val d = (t, 0)
    val tu = st.turns.get(t)
    val a = st.attempts.get(d) + 1
    if (DELIVERY_LIMIT)
      if (a >= POST_LIMIT)
        fenced(st, w, setPc(setTurn({ ...st, attempts: st.attempts.set(d, a), delivery: st.delivery.set(d, "failed") },
                                    t, { ...tu, status: "finishing", outcome: "post_failed" }), w, "fin"))
      else
        fenced(st, w, setPc(setTurn({ ...st, attempts: st.attempts.set(d, a), wake: "due" },
                                    t, { ...tu, status: "paused", pause: "post_retry" }), w, "rcheck"))
    else if (tu.resumedFrom == "post_retry")
      fenced(st, w, setPc(setTurn(st, t, { ...tu, status: "finishing", outcome: "no_progress" }), w, "fin"))
    else
      fenced(st, w, setPc(setTurn(st, t, { ...tu, status: "paused", pause: "post_retry" }), w, "rcheck"))
  }

  // The post itself. It is not part of a transaction (P5 Limit).
  action post0(w: str): bool = all {
    s.workers.get(w).pc == "post0",
    val t = s.workers.get(w).turn
    any {
      all { not(s.broken), s' = norm(doPost(s, w, (t, 0), "sent0")) },
      all { not(s.broken), s.postFailBudget > 0,
            s' = norm(postFailedRunning({ ...s, postFailBudget: s.postFailBudget - 1 }, w, t)) },
      all { s.broken, s' = norm(postFailedRunning(s, w, t)) },
    },
  }

  action sent0(w: str): bool = all {
    s.workers.get(w).pc == "sent0",
    val t = s.workers.get(w).turn
    s' = norm(fenced(s, w, setPc({ ...s, delivery: s.delivery.set((t, 0), "sent") }, w, "run"))),
  }

  // An error after take-in (P22).
  action runError(w: str): bool = {
    val t = s.workers.get(w).turn
    val tu = s.turns.get(t)
    val e = tu.errors + 1
    all {
      WITH_ERRORS,
      runPre(w),
      tu.errors < ERROR_LIMIT,
      s' = norm(
        if (e >= ERROR_LIMIT)
          fenced(s, w, setPc(setTurn(s, t, { ...tu, errors: e, status: "finishing", outcome: "error" }), w, "fin"))
        else if (ERROR_PAUSE)
          fenced(s, w, setPc(setTurn(s, t, { ...tu, errors: e, status: "paused", pause: "error_retry" }), w, "rcheck"))
        else
          fenced(s, w, setPc(setTurn(s, t, { ...tu, errors: e }), w, "rcheck"))),
    }
  }

  // Save a checkpoint and continue later (soft time limit).
  action runSoftPause(w: str): bool = {
    val t = s.workers.get(w).turn
    val tu = s.turns.get(t)
    all {
      WITH_SOFT,
      runPre(w),
      not(tu.softUsed),
      s' = norm(fenced(s, w, setPc(setTurn(s, t, { ...tu, status: "paused", pause: "soft_time_limit", softUsed: true }), w, "rcheck"))),
    }
  }

  // pauseForSignIn: person actor, canAskUser. Sets wakeAtMs to the link
  // expiry (access.md).
  action runSignIn(w: str): bool = {
    val t = s.workers.get(w).turn
    val tu = s.turns.get(t)
    all {
      WITH_SIGNIN,
      runPre(w),
      not(tu.signUsed),
      s' = norm(fenced(s, w, setPc(setTurn({ ...s, wake: "link" }, t,
                                           { ...tu, status: "paused", pause: "sign_in", signUsed: true }), w, "rcheck"))),
    }
  }

  action runDone(w: str): bool = {
    val t = s.workers.get(w).turn
    all {
      runPre(w),
      Set("sent", "failed").contains(s.delivery.get((t, 0))),
      s' = norm(fenced(s, w, setPc(setTurn(s, t, { ...s.turns.get(t), status: "finishing", outcome: "completed" }), w, "fin"))),
    }
  }

  // ---------- finishTurn (turn.md, steps 1 to 5) ----------

  action finDeliver(w: str): bool = all {
    s.workers.get(w).pc == "fin",
    val t = s.workers.get(w).turn
    val tu = s.turns.get(t)
    val needs = tu.outcome != "completed" and not(Set("sent", "failed").contains(s.delivery.get((t, 1))))
    s' = norm(
      if (not(needs)) setPc(s, w, "fanswer")
      else if (s.delivery.get((t, 1)) == "none")
        if (tokenOk(s, w))
          fenced(s, w, setW({ ...s, delivery: s.delivery.set((t, 1), "intended") }, w,
                            { ...s.workers.get(w), pc: "post1" }))
        else stopWorker(s, w, "checkInFailed")
      else if (s.posts.get((t, 1)) > 0)
        fenced(s, w, { ...s, delivery: s.delivery.set((t, 1), "sent") })
      else setW(s, w, { ...s.workers.get(w), pc: "post1" })),
  }

  // A failed post while finishing. P33: count it, back off, and at the
  // limit mark the delivery `failed` and go on. ab76f5d: give up the
  // attempt; the turn stays `finishing`.
  pure def postFailedFinishing(st: State, w: str, t: int): State = {
    val d = (t, 1)
    val a = st.attempts.get(d) + 1
    if (DELIVERY_LIMIT)
      if (a >= POST_LIMIT)
        fenced(st, w, setPc({ ...st, attempts: st.attempts.set(d, a), delivery: st.delivery.set(d, "failed") }, w, "fin"))
      else
        fenced(st, w, setPc({ ...st, attempts: st.attempts.set(d, a), wake: "due" }, w, "rcheck"))
    else setPc(st, w, "rcheck")
  }

  action post1(w: str): bool = all {
    s.workers.get(w).pc == "post1",
    val t = s.workers.get(w).turn
    any {
      all { not(s.broken), s' = norm(doPost(s, w, (t, 1), "sent1")) },
      all { not(s.broken), s.postFailBudget > 0,
            s' = norm(postFailedFinishing({ ...s, postFailBudget: s.postFailBudget - 1 }, w, t)) },
      all { s.broken, s' = norm(postFailedFinishing(s, w, t)) },
    },
  }

  action sent1(w: str): bool = all {
    s.workers.get(w).pc == "sent1",
    val t = s.workers.get(w).turn
    s' = norm(fenced(s, w, setPc({ ...s, delivery: s.delivery.set((t, 1), "sent") }, w, "fin"))),
  }

  // Move the record out of open (WHERE status = 'open').
  action fanswer(w: str): bool = all {
    s.workers.get(w).pc == "fanswer",
    val tu = s.turns.get(s.workers.get(w).turn)
    val st = if (tu.outcome == "sign_in_expired") "stopped" else "answered"
    s' = norm(fenced(s, w, setPc({ ...s, requests: if (s.requests.get(tu.msg) == "open") s.requests.set(tu.msg, st) else s.requests },
                                 w, "fdone"))),
  }

  // Only finishTurn writes a finished status (rule 7).
  action fdone(w: str): bool = all {
    s.workers.get(w).pc == "fdone",
    val t = s.workers.get(w).turn
    val tu = s.turns.get(t)
    val st = finalOf(tu.outcome)
    s' = norm(fenced(s, w, setPc(setTurn({ ...s, finalSeen: s.finalSeen.set(t, st) }, t, { ...tu, status: st }), w, "rcheck"))),
  }

  // ---------- release ----------

  pure def workLeftIn(st: State): bool = st.inbox != Set() or openTurnOf(st) != 0

  // Proposed: the next deadline this worker knows of.
  pure def nextWake(st: State): str = {
    val t = openTurnOf(st)
    val tu = st.turns.get(t)
    if (t > 0 and tu.status == "paused" and tu.pause == "sign_in" and not(tu.granted) and not(tu.linkExpired)) "link"
    else if (t > 0) "due"
    else if (st.inbox != Set()) "due"
    else "none"
  }

  // Only blocked input is left: a sign-in pause with no grant, no expiry.
  pure def onlyBlocked(st: State): bool = {
    val t = openTurnOf(st)
    val tu = st.turns.get(t)
    t > 0 and tu.status == "paused" and tu.pause == "sign_in" and not(tu.granted) and not(tu.linkExpired)
  }

  action rcheck(w: str): bool = all {
    s.workers.get(w).pc == "rcheck",
    val x = s.workers.get(w)
    val t = x.turn
    val s1 = if (t > 0 and s.turns.get(t).status == "running" and s.sqlVer == x.ver)
               setTurn(s, t, { ...s.turns.get(t), handedOff: true }) else s
    // P32 (5ed29c2): set wakeAtMs to nextRunAtMs with a compare-and-set on
    // inboxSeq. When inboxSeq changed, read again and retry. One atomic step
    // stands for the read-again loop: a send() lands before it (and is in
    // nextWake) or after it (and sets wakeAtMs to now itself).
    val s2 = if (WAKE_RULE == "seq" and tokenOk(s, w)) { ...s1, wake: nextWake(s1), dirty: false } else s1
    // Ghost: the lock holder's release starts a new "since the last
    // release" window for the wake-loop check.
    val s3 = if (tokenOk(s, w)) { ...s2, freshSend: false } else s2
    s' = norm(setW(s3, w, { ...x, pc: "rel", workLeft: workLeftIn(s) })),
  }

  // Clear the token (same match as checkIn).
  action rel(w: str): bool = all {
    s.workers.get(w).pc == "rel",
    val x = s.workers.get(w)
    val s1 = { ...s, holder: if (s.holder == x.seq) 0 else s.holder }
    s' = norm(
      if (WAKE_RULE == "prior") setW(s1, w, if (x.workLeft) { ...x, pc: "notify" } else idleWorker)
      else setPc(s1, w, "reread")),
  }

  // P32: after the release, read the inbox record.
  action reread(w: str): bool = all {
    s.workers.get(w).pc == "reread",
    val go = if (WAKE_RULE == "p32") s.inbox != Set() or s.wake == "due" else s.dirty or s.wake == "due"
    val s1 = if (go and onlyBlocked(s) and not(s.freshSend)) flag(s, "wakeLoopWhileBlocked") else s
    s' = norm(setPc(s1, w, if (go) "notify" else "done")),
  }

  action notify(w: str): bool = all {
    Set("notify", "done").contains(s.workers.get(w).pc),
    s' = norm(setW({ ...s, queue: if (s.workers.get(w).pc == "notify") inc(s.queue) else s.queue }, w, idleWorker)),
  }

  // ---------- step ----------

  action progress(w: str): bool = any {
    acquire(w), raise(w), ready(w), remove(w), runIntent(w), runRecover(w),
    post0(w), sent0(w), runError(w), runSoftPause(w), runSignIn(w), runDone(w),
    finDeliver(w), post1(w), sent1(w), fanswer(w), fdone(w), rcheck(w), rel(w), reread(w), notify(w),
  }

  action fault = any {
    sendM2, breakTarget,
    nondet t = TURN_IDS.oneOf()
    signIn(t),
    nondet w = WORKERS.oneOf()
    any { crash(w), stall(w), checkIn(w) },
  }

  action time = any { expireDead, nondet t = TURN_IDS.oneOf() linkExpires(t) }

  action stutter = s' = s

  action step = all {
    any {
      nondet w = WORKERS.oneOf()
      progress(w),
      time, timerJob, repairJob, fault, stutter,
    },
  }

  // ---------- safety ----------

  /// I1: at most one open turn per conversation (rule 1, P2).
  val i1_oneOpenTurn = TURN_IDS.filter(t => OPEN.contains(s.turns.get(t).status)).size() <= 1

  /// I2: a finished turn stays finished (rule 2).
  val i2_finishedStaysFinished =
    TURN_IDS.forall(t => s.finalSeen.get(t) == "" or s.turns.get(t).status == s.finalSeen.get(t))

  /// I3 (saves): no save from a worker whose lock a newer worker took is
  /// accepted (rule 3, P5).
  val i3_noStaleSave = not(s.staleWrite)

  /// The newest lock version belongs to the newest lock holder (P5).
  val versionFollowsLock = WORKERS.forall(a => WORKERS.forall(b =>
    val x = s.workers.get(a)
    val y = s.workers.get(b)
    (x.ver > 0 and y.ver > 0 and x.ver > y.ver) implies x.seq > y.seq))

  /// I3 (posts): no post from a worker whose lock a newer worker took.
  /// P5 "Limit" (design.md:348-350) accepts this window. Expected to fail.
  val i3_noStalePost = not(s.stalePost)

  /// I7: each delivery id is posted at most once, unless a takeover came
  /// between its intent and its post (P5, then detected by `find`).
  val i7_noUndetectedDoublePost = DELIVERY_IDS.forall(d => s.cleanPosts.get(d) <= 1)

  /// A restart only follows a lost worker, never a worker that gave the
  /// turn back after an error (Decided; P4, P8, P31).
  val restartOnlyAfterLoss = not(s.ex.contains("restartWithNoLostWorker"))

  /// `failed: lost_worker` only when a worker was lost.
  val lostWorkerIsReal = not(s.ex.contains("lostWorkerWithNoLostWorker"))

  /// A message is taken into at most one turn.
  val takenOnce = TURN_IDS.forall(a => TURN_IDS.forall(b =>
    (a != b and s.turns.get(a).status != "none" and s.turns.get(b).status != "none")
      implies s.turns.get(a).msg != s.turns.get(b).msg))

  /// A release does not notify a worker when the only work left waits for
  /// a sign-in and nothing was sent since the previous release (the wake
  /// loop). One extra notify for a send() that another worker already
  /// read is allowed: the next release clears it.
  val noWakeLoopWhileBlocked = not(s.ex.contains("wakeLoopWhileBlocked"))

  val safety = i1_oneOpenTurn and i2_finishedStaysFinished and i3_noStaleSave and versionFollowsLock
    and i7_noUndetectedDoublePost and restartOnlyAfterLoss and lostWorkerIsReal and takenOnce

  // ---------- worked examples: each must be reachable ----------
  // Each `ex_*` holds until the example happens. Its violation is the trace.
  val ex_turn_E1_redeliveredPrompt = not(s.ex.contains("redeliveredPrompt"))
  val ex_turn_E2_deadWorker = not(s.ex.contains("restart"))
  val ex_turn_E2_lostTwice = not(s.ex.contains("lostTwice"))
  val ex_turn_E3_slowWorker = not(s.ex.contains("slowWorkerRefused"))
  val ex_turn_E4_retriesRunOut = not(s.ex.contains("retriesRanOutNextTurnRuns"))
  val ex_turn_E6_finishingDeliveryFails = not(s.turns.get(1).status == "failed" and s.delivery.get((1, 1)) == "failed")
  val ex_turn_E7_messageWhileLocked = not(s.turns.get(2).status != "none" and s.turns.get(2).msg == "m2" and s.turns.get(1).status == "completed")
  val ex_edges_E1_findBeforeRepost = not(s.ex.contains("foundOnRecover"))
  val ex_access_E2_linkExpires = not(s.turns.get(1).outcome == "sign_in_expired" and s.turns.get(1).status == "stopped")
  val ex_signInResumes = not(s.ex.contains("resumedAfterSignIn"))

  // ---------- liveness ----------

  temporal fairCore = all {
    weakFair(progress("w1"), s),
    weakFair(progress("w2"), s),
    weakFair(time, s),
    weakFair(timerJob, s),
  }
  temporal fairRepair = fairCore and weakFair(repairJob, s)

  def quiet: bool = WORKERS.forall(w => s.workers.get(w).pc == "idle") and s.queue == 0

  /// L1: every request record ends answered or stopped.
  temporal l1_requestsEnd = fairRepair implies Set("m1", "m2").forall(m =>
    always(s.requests.get(m) == "open" implies eventually(s.requests.get(m) != "open")))

  /// L2: no turn stays `finishing` forever.
  temporal l2_finishingEnds = fairRepair implies TURN_IDS.forall(t =>
    always(s.turns.get(t).status == "finishing" implies eventually(FINAL.contains(s.turns.get(t).status))))

  /// L3: a paused turn is eventually resumed or finished, with no help
  /// from the repair job.
  temporal l3_pausedResumedNoRepair = fairCore implies TURN_IDS.forall(t =>
    always(s.turns.get(t).status == "paused" implies eventually(s.turns.get(t).status != "paused")))

  /// L3 with the repair job.
  temporal l3_pausedResumed = fairRepair implies TURN_IDS.forall(t =>
    always(s.turns.get(t).status == "paused" implies eventually(s.turns.get(t).status != "paused")))

  /// A running turn whose worker was lost is picked up, with no repair job.
  temporal lostTurnPickedUpNoRepair = fairCore implies TURN_IDS.forall(t =>
    always(s.turns.get(t).status == "running" implies eventually(s.turns.get(t).status != "running")))

  /// When all work is done, workers stop being notified (no wake loop).
  temporal quiesces = fairRepair implies eventually(always(quiet))
}

// Instances: <scenario>_<design>. priorDraft = ab76f5d, rev2 = 5122bb7,
// design = 5ed29c2 (the head this model checks), proposed = design plus
// this model's fixes.
// Scenario lock: B may send m2; 2 losses.
module lock_priorDraft {
  import workerLock(LOCK_CAS = false, ERROR_PAUSE = false, DELIVERY_LIMIT = false, WAKE_RULE = "prior", SIGN_IN_WAKES = false, DELAYED_NOTIFY = false,
    WITH_M2 = true, WITH_SIGNIN = false, WITH_ERRORS = false, WITH_SOFT = false, WITH_BROKEN = false, LOSSES = 2, POST_FAILS = 0).*
}
module lock_rev2 {
  import workerLock(LOCK_CAS = true, ERROR_PAUSE = true, DELIVERY_LIMIT = true, WAKE_RULE = "p32", SIGN_IN_WAKES = false, DELAYED_NOTIFY = false,
    WITH_M2 = true, WITH_SIGNIN = false, WITH_ERRORS = false, WITH_SOFT = false, WITH_BROKEN = false, LOSSES = 2, POST_FAILS = 0).*
}
module lock_design {
  import workerLock(LOCK_CAS = true, ERROR_PAUSE = true, DELIVERY_LIMIT = true, WAKE_RULE = "seq", SIGN_IN_WAKES = false, DELAYED_NOTIFY = false,
    WITH_M2 = true, WITH_SIGNIN = false, WITH_ERRORS = false, WITH_SOFT = false, WITH_BROKEN = false, LOSSES = 2, POST_FAILS = 0).*
}
module lock_proposed {
  import workerLock(LOCK_CAS = true, ERROR_PAUSE = true, DELIVERY_LIMIT = true, WAKE_RULE = "seq", SIGN_IN_WAKES = true, DELAYED_NOTIFY = true,
    WITH_M2 = true, WITH_SIGNIN = false, WITH_ERRORS = false, WITH_SOFT = false, WITH_BROKEN = false, LOSSES = 2, POST_FAILS = 0).*
}

// Scenario errors: B may send m2; errors and 1 loss.
module errors_priorDraft {
  import workerLock(LOCK_CAS = false, ERROR_PAUSE = false, DELIVERY_LIMIT = false, WAKE_RULE = "prior", SIGN_IN_WAKES = false, DELAYED_NOTIFY = false,
    WITH_M2 = true, WITH_SIGNIN = false, WITH_ERRORS = true, WITH_SOFT = false, WITH_BROKEN = false, LOSSES = 1, POST_FAILS = 0).*
}
module errors_rev2 {
  import workerLock(LOCK_CAS = true, ERROR_PAUSE = true, DELIVERY_LIMIT = true, WAKE_RULE = "p32", SIGN_IN_WAKES = false, DELAYED_NOTIFY = false,
    WITH_M2 = true, WITH_SIGNIN = false, WITH_ERRORS = true, WITH_SOFT = false, WITH_BROKEN = false, LOSSES = 1, POST_FAILS = 0).*
}
module errors_design {
  import workerLock(LOCK_CAS = true, ERROR_PAUSE = true, DELIVERY_LIMIT = true, WAKE_RULE = "seq", SIGN_IN_WAKES = false, DELAYED_NOTIFY = false,
    WITH_M2 = true, WITH_SIGNIN = false, WITH_ERRORS = true, WITH_SOFT = false, WITH_BROKEN = false, LOSSES = 1, POST_FAILS = 0).*
}
module errors_proposed {
  import workerLock(LOCK_CAS = true, ERROR_PAUSE = true, DELIVERY_LIMIT = true, WAKE_RULE = "seq", SIGN_IN_WAKES = true, DELAYED_NOTIFY = true,
    WITH_M2 = true, WITH_SIGNIN = false, WITH_ERRORS = true, WITH_SOFT = false, WITH_BROKEN = false, LOSSES = 1, POST_FAILS = 0).*
}

// Scenario delivery: failing posts and 1 loss.
module delivery_priorDraft {
  import workerLock(LOCK_CAS = false, ERROR_PAUSE = false, DELIVERY_LIMIT = false, WAKE_RULE = "prior", SIGN_IN_WAKES = false, DELAYED_NOTIFY = false,
    WITH_M2 = false, WITH_SIGNIN = false, WITH_ERRORS = false, WITH_SOFT = false, WITH_BROKEN = true, LOSSES = 1, POST_FAILS = 1).*
}
module delivery_rev2 {
  import workerLock(LOCK_CAS = true, ERROR_PAUSE = true, DELIVERY_LIMIT = true, WAKE_RULE = "p32", SIGN_IN_WAKES = false, DELAYED_NOTIFY = false,
    WITH_M2 = false, WITH_SIGNIN = false, WITH_ERRORS = false, WITH_SOFT = false, WITH_BROKEN = true, LOSSES = 1, POST_FAILS = 1).*
}
module delivery_design {
  import workerLock(LOCK_CAS = true, ERROR_PAUSE = true, DELIVERY_LIMIT = true, WAKE_RULE = "seq", SIGN_IN_WAKES = false, DELAYED_NOTIFY = false,
    WITH_M2 = false, WITH_SIGNIN = false, WITH_ERRORS = false, WITH_SOFT = false, WITH_BROKEN = true, LOSSES = 1, POST_FAILS = 1).*
}
module delivery_proposed {
  import workerLock(LOCK_CAS = true, ERROR_PAUSE = true, DELIVERY_LIMIT = true, WAKE_RULE = "seq", SIGN_IN_WAKES = true, DELAYED_NOTIFY = true,
    WITH_M2 = false, WITH_SIGNIN = false, WITH_ERRORS = false, WITH_SOFT = false, WITH_BROKEN = true, LOSSES = 1, POST_FAILS = 1).*
}

// Scenario wake: B may send m2; sign-in and soft pauses; 1 loss.
module wake_priorDraft {
  import workerLock(LOCK_CAS = false, ERROR_PAUSE = false, DELIVERY_LIMIT = false, WAKE_RULE = "prior", SIGN_IN_WAKES = false, DELAYED_NOTIFY = false,
    WITH_M2 = true, WITH_SIGNIN = true, WITH_ERRORS = false, WITH_SOFT = true, WITH_BROKEN = false, LOSSES = 1, POST_FAILS = 0).*
}
module wake_rev2 {
  import workerLock(LOCK_CAS = true, ERROR_PAUSE = true, DELIVERY_LIMIT = true, WAKE_RULE = "p32", SIGN_IN_WAKES = false, DELAYED_NOTIFY = false,
    WITH_M2 = true, WITH_SIGNIN = true, WITH_ERRORS = false, WITH_SOFT = true, WITH_BROKEN = false, LOSSES = 1, POST_FAILS = 0).*
}
module wake_design {
  import workerLock(LOCK_CAS = true, ERROR_PAUSE = true, DELIVERY_LIMIT = true, WAKE_RULE = "seq", SIGN_IN_WAKES = false, DELAYED_NOTIFY = false,
    WITH_M2 = true, WITH_SIGNIN = true, WITH_ERRORS = false, WITH_SOFT = true, WITH_BROKEN = false, LOSSES = 1, POST_FAILS = 0).*
}
module wake_proposed {
  import workerLock(LOCK_CAS = true, ERROR_PAUSE = true, DELIVERY_LIMIT = true, WAKE_RULE = "seq", SIGN_IN_WAKES = true, DELAYED_NOTIFY = true,
    WITH_M2 = true, WITH_SIGNIN = true, WITH_ERRORS = false, WITH_SOFT = true, WITH_BROKEN = false, LOSSES = 1, POST_FAILS = 0).*
}


// Scenario wakeLive: like wake, with no losses and no soft pause, so TLC
// can finish the liveness checks. B may send m2; sign-in pauses.
module wakeLive_rev2 {
  import workerLock(LOCK_CAS = true, ERROR_PAUSE = true, DELIVERY_LIMIT = true, WAKE_RULE = "p32", SIGN_IN_WAKES = false, DELAYED_NOTIFY = false,
    WITH_M2 = true, WITH_SIGNIN = true, WITH_ERRORS = false, WITH_SOFT = false, WITH_BROKEN = false, LOSSES = 0, POST_FAILS = 0).*
}
module wakeLive_design {
  import workerLock(LOCK_CAS = true, ERROR_PAUSE = true, DELIVERY_LIMIT = true, WAKE_RULE = "seq", SIGN_IN_WAKES = false, DELAYED_NOTIFY = false,
    WITH_M2 = true, WITH_SIGNIN = true, WITH_ERRORS = false, WITH_SOFT = false, WITH_BROKEN = false, LOSSES = 0, POST_FAILS = 0).*
}
module wakeLive_proposed {
  import workerLock(LOCK_CAS = true, ERROR_PAUSE = true, DELIVERY_LIMIT = true, WAKE_RULE = "seq", SIGN_IN_WAKES = true, DELAYED_NOTIFY = true,
    WITH_M2 = true, WITH_SIGNIN = true, WITH_ERRORS = false, WITH_SOFT = false, WITH_BROKEN = false, LOSSES = 0, POST_FAILS = 0).*
}
