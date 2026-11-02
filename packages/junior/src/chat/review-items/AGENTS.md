# Review items

- An action item is the only way the agent asks a person for input. Do not
  add another path.
- `access.ts` owns every access rule. Do not copy a rule into a caller.
- A plugin notice is assigned only to people in its Conversation, public or
  private. Junior leaves out the other assignees that the plugin gives.
- Agent tools read as the Conversation, not the Actor
  (`readReviewItemAgentScope`), so an agent cannot copy private content into
  another Conversation of the same User.
- An agent close is an Event and does not give user approval. A person action
  is a web Message with the authority of that person.
- `closeReviewItemsAnsweredByReply` saves the message before it closes items,
  so the reply always reaches the agent.
- Tests have no reply decision model. The classifier eval
  `review-item-replies.eval.ts` checks which items a reply answers.
- An open private item from an Automation run survives a purge, because a
  later run can change it.
