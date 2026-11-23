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
