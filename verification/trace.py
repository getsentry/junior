#!/usr/bin/env python3
"""Print a stop_clock.qnt ITF trace (from `quint run --mbt --out-itf`) as one
line per step. Usage: trace.py trace.itf.json"""
import json
import sys


def val(x):
    if isinstance(x, dict):
        if "#bigint" in x:
            return int(x["#bigint"])
        if "#set" in x:
            return sorted(val(i) for i in x["#set"])
        if "#map" in x:
            return {val(k): val(w) for k, w in x["#map"]}
        if "#tup" in x:
            return tuple(val(i) for i in x["#tup"])
        return {k: val(w) for k, w in x.items()}
    if isinstance(x, list):
        return [val(i) for i in x]
    return x


def main(path):
    trace = json.load(open(path))
    for i, raw in enumerate(trace["states"]):
        state = {k.split("::")[-1]: val(w) for k, w in raw.items() if k != "#meta"}
        s = state["s"]
        action = state.get("actionTaken", "")
        picks = {k: v for k, v in state.get("nondetPicks", {}).items() if v.get("tag") == "Some"}
        args = ",".join(f"{k}={v['value']}" for k, v in picks.items())
        msgs = " ".join(
            f"{m}(real {x['real']}, created {x['created']}{', inbox' if x['inInbox'] else ''}{', ' + x['ended'] if x['ended'] else ''})"
            for m, x in s["msgs"].items() if x["sent"])
        stop = ""
        if s["stopClicked"]:
            stop = f"stop(real {s['stopReal']}, created {s['stopCreated']}, stopAtMs {s['stopAt'] if s['stopAt'] > -100 else '-'})"
        turns = " ".join(
            f"T{t}[{x['status']} first={x['first']} inputs={','.join(x['inputs'])} startedAtMs={x['startedAt']} intents={x['intents']} posted={x['posted']}]"
            for t, x in s["turns"].items() if x["status"] != "none")
        flags = ",".join(s["ex"])
        step = f"{action}({args}) " if action else ""
        print(f"{i:2} now={s['now']} {step}| {msgs} | {stop} | {turns} | {flags}")


if __name__ == "__main__":
    main(sys.argv[1])
