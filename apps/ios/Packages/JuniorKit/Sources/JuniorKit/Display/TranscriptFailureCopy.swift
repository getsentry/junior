import Foundation

/// Title and description for a failed Turn, as `transcriptFailure.ts` words
/// them. `agentName` is the dashboard's agent name.
public func transcriptFailureCopy(
  code: String?, reason: String?, agentName: String
) -> (title: String, description: String) {
  if code == "model_execution_failed", let reason {
    switch reason {
    case "auth":
      return (
        "Model credentials rejected", "The model service rejected credentials. An admin needs to fix configuration."
      )
    case "permission":
      return ("Model access denied", "The model service denied access to this model or request.")
    case "rate_limit":
      return ("Model rate limited", "The model is rate limited. Try again shortly.")
    case "capacity":
      return ("Model at capacity", "The selected model is at capacity. Try again shortly.")
    case "timeout":
      return ("Model timed out", "The model service timed out before the turn finished.")
    case "network":
      return ("Model connection failed", "The model service had a connection problem before the turn finished.")
    case "server":
      return ("Model service error", "The model service returned an error.")
    case "invalid_request":
      return ("Invalid model request", "The model service rejected this request as invalid.")
    case "invalid_response":
      return ("Invalid model response", "The model service returned an invalid response.")
    case "quota":
      return ("Model quota exhausted", "The model service quota is exhausted. An admin needs to fix billing or limits.")
    case "content_policy":
      return ("Blocked by content policy", "The model service blocked this request under its content policy.")
    case "empty_output":
      return ("Empty model response", "The model returned no usable text before \(agentName) finished this turn.")
    case "tool_errors":
      return ("Tool failed", "A tool failed and the turn could not finish.")
    case "suppressed_output":
      return ("Model output was dropped", "The model produced text that \(agentName) could not deliver.")
    default:
      return ("Model service error", "The model service failed for an unknown reason.")
    }
  }
  switch code {
  case "delivery_failed": return ("Message delivery failed", "\(agentName) could not deliver this message.")
  case "model_execution_failed": return ("Model failed", "The model stopped before \(agentName) finished this turn.")
  case "persistence_failed": return ("Save failed", "\(agentName) could not save the result of this turn.")
  default: return ("Internal error", "\(agentName) hit an internal error during this turn.")
  }
}
