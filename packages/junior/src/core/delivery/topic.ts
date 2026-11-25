// The queue topic of delivery messages. It has no imports, so the host's
// build-time queue route table can read it without loading runtime config.

/** Queue topic of delivery messages. */
export const DELIVERY_TOPIC = "junior_delivery";
