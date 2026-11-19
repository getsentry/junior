import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { noValueSwitchRule } from "./no-value-switch.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const valueSwitch = [{ messageId: "valueSwitch" }];

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
    `function f(k) {
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
  ],
});
