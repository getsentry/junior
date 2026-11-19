import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { noValueSwitchRule } from "./no-value-switch.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const valueSwitch = [{ messageId: "valueSwitch" }];
const actionSwitch = [{ messageId: "actionSwitch" }];

new RuleTester().run("no-value-switch", noValueSwitchRule, {
  valid: [
    `function f(k) {
  switch (k) {
    case "a":
      return "A";
    case "b":
      return "B";
    case "c":
      return "C";
    case "d":
      return "D";
    case "e":
      return "E";
    case "f":
      return "F";
    case "g":
      return "G";
    default:
      return "none";
  }
}`,
    `function f(k) {
  switch (k) {
    case "a":
      return handleA(k);
    case "b":
      return "B";
    case "c":
      return "C";
    case "d":
      return "D";
    case "e":
      return "E";
    case "f":
      return "F";
    case "g":
      return "G";
    case "h":
      return "H";
  }
}`,
    `function f(k) {
  switch (k) {
    case "a":
    case "b":
    case "c":
    case "d":
    case "e":
      return "E";
    case "f":
      return "F";
    case "g":
      return "G";
  }
}`,
    // Two cases read fine.
    `function f(k) {
  switch (k) {
    case "a":
      run("a");
      break;
    case "b":
      run("b");
      break;
  }
}`,
    // No case runs an action: a small value switch.
    `function f(k) {
  switch (k) {
    case "a":
      return "A";
    case "b":
      return "B";
    case "c":
      return "C";
  }
}`,
    // The cases read fields that the discriminant narrows.
    `function f(event) {
  switch (event.kind) {
    case "a":
      record(event.a);
      break;
    case "b":
      record(event.b);
      break;
    case "c":
      record(event.c);
      break;
  }
}`,
    // An exhaustive `never` check reads the narrowed value.
    `function f(k) {
  switch (k) {
    case "a":
      run("a");
      break;
    case "b":
      run("b");
      break;
    case "c":
      run("c");
      break;
    default:
      assertNever(k);
  }
}`,
    `function f(k) {
  switch (k) {
    case "a":
      run("a");
      break;
    case "b":
      run("b");
      break;
    case "c":
      run("c");
      break;
    default: {
      const unreachable = k;
      throw new Error(unreachable);
    }
  }
}`,
    // Real control flow in a case.
    `function f(k) {
  switch (k) {
    case "a":
      if (shift) return false;
      run("a");
      break;
    case "b":
      run("b");
      break;
    case "c":
      if (ready) run("c");
      else wait();
      break;
  }
}`,
    `function f(k) {
  switch (k) {
    case "a":
      run("a");
      break;
    case "b":
      run("b");
      break;
    case "c":
      throw new Error("c");
  }
}`,
    `function f(k) {
  for (const item of items) {
    switch (k) {
      case "a":
        run("a");
        continue;
      case "b":
        run("b");
        break;
      case "c":
        run("c");
        break;
    }
  }
}`,
    // A case that falls through shares the next case's work.
    `function f(k) {
  switch (k) {
    case "a":
      prepare();
    case "b":
      run("b");
      break;
    case "c":
      run("c");
      break;
  }
}`,
    // A procedure, not one action.
    `function f(k) {
  switch (k) {
    case "a":
      one();
      two();
      three();
      four();
      break;
    case "b":
      run("b");
      break;
    case "c":
      run("c");
      break;
  }
}`,
  ],
  invalid: [
    {
      code: `function f(k) {
  switch (k) {
    case "a":
      return "A";
    case "b":
      return "B";
    case "c":
      return "C";
    case "d":
      return "D";
    case "e":
      return "E";
    case "f":
      return "F";
    case "g":
      return "G";
    case "h":
      return "H";
  }
}`,
      errors: valueSwitch,
    },
    {
      code: `function f(k) {
  switch (k) {
    case "a":
      return "A";
    case "b":
      return "B";
    case "c":
      return "C";
    case "d":
      return "D";
    case "e":
      return "E";
    case "f":
      return "F";
    case "g":
      return "G";
    case "h": {
      const value = k.length;
      return \`\${value}\`;
    }
    default:
      return "none";
  }
}`,
      errors: valueSwitch,
    },
    {
      code: `function f(k) {
  switch (k) {
    case "a":
      return data.items.map((item) => item.name).join(", ");
    case "b":
      return data.items.map((item) => item.name).join(", ");
    case "c":
      return data.items.map((item) => item.name).join(", ");
    case "d":
      return data.items.map((item) => item.name).join(", ");
    case "e":
      return data.items.map((item) => item.name).join(", ");
    case "f":
      return data.items.map((item) => item.name).join(", ");
    case "g":
      return data.items.map((item) => item.name).join(", ");
    case "h":
      return data.items.map((item) => item.name).join(", ");
  }
}`,
      errors: valueSwitch,
    },
    {
      code: `function onKey(key) {
  switch (key) {
    case "down":
      setActiveIndex((active + 1) % rows.length);
      return true;
    case "up":
      setActiveIndex((active - 1 + rows.length) % rows.length);
      return true;
    case "select":
      if (!pending) onSelect(rows[active]);
      return true;
    case "close":
      typeahead.dismiss();
      return true;
    default:
      return false;
  }
}`,
      errors: actionSwitch,
    },
    {
      code: `function plan(tools) {
  for (const [name, definition] of Object.entries(tools)) {
    switch (exposure(definition)) {
      case "direct":
        directTools[name] = definition;
        catalogTools[name] = definition;
        scriptTools[name] = definition;
        break;
      case "deferred":
        catalogTools[name] = definition;
        scriptTools[name] = definition;
        break;
      case "modelOnly":
        directTools[name] = definition;
        break;
      case "hidden":
        break;
    }
  }
}`,
      errors: actionSwitch,
    },
    {
      code: `function f(k) {
  switch (k) {
    case "a":
      log("a");
      return 1;
    case "b":
      log("b");
      return 1;
    case "c":
      log("c");
      return 1;
    case "d":
      log("d");
      return 1;
    case "e":
      log("e");
      return 1;
    case "f":
      log("f");
      return 1;
    case "g":
      log("g");
      return 1;
    case "h":
      log("h");
      return 1;
  }
}`,
      errors: actionSwitch,
    },
    {
      code: `function f(k) {
  switch (k) {
    case "a":
      total += 1;
      break;
    case "b":
      total += 1;
      break;
    case "c":
      total += 1;
      break;
    case "d":
      total += 1;
      break;
    case "e":
      total += 1;
      break;
    case "f":
      total += 1;
      break;
    case "g":
      total += 1;
      break;
    case "h":
      total += 1;
      break;
  }
}`,
      errors: actionSwitch,
    },
    {
      code: `function f(k) {
  switch (k) {
    case "a":
      run("a");
      break;
    case "b":
      run("b");
      break;
    case "c":
      run("c");
    default:
  }
}`,
      errors: actionSwitch,
    },
  ],
});
