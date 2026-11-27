// The queue topics of core Turns. They have no imports, so the host's
// build-time queue route table can read them without loading runtime config.

/** Queue topic of Turn step messages. */
export const TURN_STEP_TOPIC = "junior_turn_step";

/** Queue topic of the messages that say a Turn ended. */
export const TURN_ENDED_TOPIC = "junior_turn_ended";
