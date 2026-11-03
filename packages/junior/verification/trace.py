#!/usr/bin/env python3
"""Print a TLC counterexample (from `-dumpTrace json`) one line per step.

Each line has the step number, the action and the fields that it changed.
Usage: python3 trace.py .out/<instance>.<property>.trace.json
"""
import json
import sys

# Budgets: they change on every fault and add noise.
SKIP = {"crashes", "expiries", "flips", "lossBudget", "postFailBudget"}


def flat(value, prefix=""):
    if isinstance(value, list) and any(isinstance(v, (dict, list)) for v in value):
        value = {str(i + 1): v for i, v in enumerate(value)}
    if isinstance(value, dict):
        out = {}
        for key, inner in value.items():
            out.update(flat(inner, f"{prefix}.{key}" if prefix else key))
        return out
    return {prefix: json.dumps(value)}


def main(path):
    steps = json.load(open(path))["counterexample"]["action"]
    prev = None
    for begin, action, end in steps:
        if prev is None:
            prev = flat(begin[1])
            print(f"{begin[0]:>3} Init")
        now = flat(end[1])
        changed = [
            f"{k}={v}"
            for k, v in now.items()
            if prev.get(k) != v and k.split(".")[-1] not in SKIP and k.split(".")[0] not in SKIP
        ]
        print(f"{end[0]:>3} {action['name']:<22} {'; '.join(changed)}")
        prev = now


if __name__ == "__main__":
    main(sys.argv[1])
