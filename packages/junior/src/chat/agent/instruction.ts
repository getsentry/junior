import type { AgentInstruction, AgentInstructionInput } from "./types";

/**
 * Build the instruction for Turn inputs. Each input keeps its own prompt
 * content part, and `text` joins them for action review.
 */
export function instructionForInputs(
  inputs: readonly AgentInstructionInput[],
): Pick<AgentInstruction, "inputs" | "text"> {
  return {
    inputs,
    text: inputs
      .map((input) => input.text.trim())
      .filter(Boolean)
      .join("\n\n"),
  };
}
