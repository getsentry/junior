import Foundation

/// The longest title that `renameConversation` saves
/// (`CONVERSATION_TITLE_MAX_LENGTH`), in UTF-16 code units as Zod counts.
let conversationTitleMaxLength = 200

/// The title that a rename saves from `draft`, trimmed as Junior trims it.
/// Nil when there is nothing to save: the title is empty, too long, or the
/// same as `current`.
public func renamedTitle(_ draft: String, current: String) -> String? {
  let title = draft.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !title.isEmpty, title != current, title.utf16.count <= conversationTitleMaxLength else { return nil }
  return title
}

/// A title that this app saved for one Conversation. A screen that already
/// shows that Conversation applies it at once, before its next read.
public struct SavedTitle: Sendable {
  public let conversationId: String
  public let title: String

  public init(conversationId: String, title: String) {
    self.conversationId = conversationId
    self.title = title
  }
}

extension ConversationState {
  /// This state with `saved` applied, when `saved` is for this Conversation.
  public func applying(_ saved: SavedTitle?) -> ConversationState {
    guard let saved, saved.conversationId == conversation.conversationId else { return self }
    var state = self
    state.conversation.title = saved.title
    return state
  }
}
