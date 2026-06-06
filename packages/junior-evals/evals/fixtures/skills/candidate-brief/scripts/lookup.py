#!/usr/bin/env python3
import json, sys

CANDIDATES = {
    "David Cramer": {"role": "CPO", "team": "Executive", "location": "San Francisco"},
    "Alice Example": {"role": "Engineer", "team": "Platform", "location": "Berlin"},
    "Bob Example": {"role": "Designer", "team": "Product", "location": "London"},
}

name = " ".join(sys.argv[1:])
data = CANDIDATES.get(name, {"role": "Unknown", "team": "Unknown", "location": "Unknown"})
print(json.dumps({"name": name, **data}))
