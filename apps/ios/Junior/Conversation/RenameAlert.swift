import JuniorKit
import SwiftUI

extension View {
  /// Ask for a new title while `conversation` is set
  /// (`RenameConversationDialog.tsx`). Save is off until the title changes.
  func renameAlert(
    _ conversation: Binding<MCPConversation?>, onSave: @escaping (MCPConversation, String) -> Void
  ) -> some View {
    modifier(RenameAlert(conversation: conversation, onSave: onSave))
  }
}

private struct RenameAlert: ViewModifier {
  @Binding var conversation: MCPConversation?
  let onSave: (MCPConversation, String) -> Void
  @State private var draft = ""

  func body(content: Content) -> some View {
    content
      .alert(
        "Rename conversation",
        isPresented: Binding(get: { conversation != nil }, set: { if !$0 { conversation = nil } }),
        presenting: conversation
      ) { row in
        TextField("Title", text: $draft)
        Button("Cancel", role: .cancel) {}
        Button("Save") {
          if let title = renamedTitle(draft, current: row.title) { onSave(row, title) }
        }
        .disabled(renamedTitle(draft, current: row.title) == nil)
      }
      .onChange(of: conversation?.conversationId) { _, id in
        if id != nil { draft = conversation?.title ?? "" }
      }
  }
}
