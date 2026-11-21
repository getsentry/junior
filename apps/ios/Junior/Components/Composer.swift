import JuniorKit
import SwiftUI
import UniformTypeIdentifiers

/// The docked composer frame (`ComposerDock.tsx`). `above` (queued
/// messages) sits flush on the composer, inside the dock, with no hairline.
struct ComposerDock<Above: View, Content: View>: View {
  var hasAbove = false
  @ViewBuilder var above: Above
  @ViewBuilder var content: Content

  var body: some View {
    VStack(spacing: 0) {
      above.readableWidth()
      content
        .padding(.horizontal, 8)
        .padding(.top, hasAbove ? 0 : 6)
        .padding(.bottom, 6)
        .readableWidth()
    }
    .background(Tokens.bg)
    .hairline(.top, hasAbove ? .clear : Tokens.borderSubtle)
  }
}

extension ComposerDock where Above == EmptyView {
  init(@ViewBuilder content: () -> Content) {
    self.init(hasAbove: false, above: { EmptyView() }, content: content)
  }
}

/// The rounded composer surface: radius 12, `border-emphasis`,
/// `surface-raised`, soft shadow.
struct ComposerSurface<Content: View>: View {
  var focused = false
  @ViewBuilder var content: Content
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    content
      .background {
        // Shadow the surface only; a shadow on the content would shadow every control.
        RoundedRectangle(cornerRadius: 12)
          .fill(Tokens.surfaceRaised)
          .shadow(
            color: .black.opacity(scheme == .light ? 0.12 : 0.35), radius: scheme == .light ? 10 : 16,
            y: scheme == .light ? 4 : 8)
      }
      .overlay(
        RoundedRectangle(cornerRadius: 12).strokeBorder(focused ? Tokens.focus.opacity(0.7) : Tokens.borderEmphasis))
  }
}

/// The message field: 16pt text, 1.625 line height, 48-112pt tall.
struct ComposerField: View {
  @Binding var text: String
  let placeholder: String
  var focused: FocusState<Bool>.Binding

  var body: some View {
    TextField(
      "", text: $text, prompt: Text(placeholder).foregroundStyle(Tokens.textFaint), axis: .vertical
    )
    .type(.base, lineHeight: 1.625)
    .foregroundStyle(Tokens.text)
    .lineLimit(1...4)
    .focused(focused)
    .padding(.horizontal, 12)
    .padding(.vertical, 12)
    .frame(minHeight: 48, alignment: .topLeading)
    .accessibilityLabel(placeholder)
  }
}

/// Send button: `text-solid` fill with an inverse icon; muted when disabled.
struct SendButton: View {
  let enabled: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Icon("send", size: 14)
        .foregroundStyle(enabled ? Tokens.textInverse : Tokens.textMuted)
        .frame(width: 40, height: 36)
        .background(enabled ? Tokens.textSolid : Tokens.fillHover, in: RoundedRectangle(cornerRadius: 6))
        .hitArea()
    }
    // The label shows its own disabled colors; `.plain` would dim them again
    // (`disabled:!opacity-100` on the web).
    .buttonStyle(UndimmedButtonStyle())
    .disabled(!enabled)
    .accessibilityLabel("Send")
  }
}

/// Press feedback only: no system dimming when disabled.
struct UndimmedButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.opacity(configuration.isPressed ? 0.8 : 1)
  }
}

extension View {
  /// Grow the touch target to 44pt without changing the drawn size.
  func hitArea(_ size: CGFloat = 44) -> some View {
    background(Color.clear.frame(width: size, height: size).contentShape(Rectangle()))
  }
}

/// The home composer: start a new Conversation (`createConversation`).
/// Attachments are not part of the public API. `docked` puts it at the
/// bottom of the screen, under the list.
struct NewConversationComposer: View {
  @Environment(AppModel.self) private var app
  var docked = true
  @State private var text = ""
  @State private var visibility: ConversationVisibility = .private
  @State private var sending = false
  @State private var error: String?
  @State private var idempotencyKey = UUID()
  @FocusState private var focused: Bool

  private var canSend: Bool {
    !sending && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  var body: some View {
    if docked {
      ComposerDock { form }
    } else {
      form
    }
  }

  private var form: some View {
    VStack(alignment: .leading, spacing: 6) {
      if let error { InlineError(text: error).padding(.horizontal, 4) }
      ComposerSurface(focused: focused) {
        VStack(alignment: .leading, spacing: 0) {
          ComposerField(text: $text, placeholder: "Message \(app.agentName)…", focused: $focused)
          HStack(spacing: 12) {
            VisibilityMenu(visibility: $visibility)
            Spacer()
            SendButton(enabled: canSend, action: send)
          }
          .padding(.horizontal, 8)
          .padding(.vertical, 6)
        }
      }
    }
  }

  private func send() {
    let message = text.trimmingCharacters(in: .whitespacesAndNewlines)
    sending = true
    error = nil
    Task {
      defer { sending = false }
      do {
        let accepted = try await app.call(
          "createConversation",
          [
            "message": .string(String(message.prefix(32_000))), "visibility": .string(visibility.rawValue),
            "idempotencyKey": .string(idempotencyKey.uuidString),
          ], as: AcceptedMessage.self)
        text = ""
        idempotencyKey = UUID()
        focused = false
        app.didWrite()
        app.path = [.conversation(accepted.conversationId)]
      } catch {
        self.error = (error as? JuniorAPIError)?.localizedDescription ?? "Message failed to send. Try again."
      }
    }
  }
}

/// Public / Private picker for a new Conversation.
private struct VisibilityMenu: View {
  @Binding var visibility: ConversationVisibility

  var body: some View {
    Menu {
      Picker("Visibility", selection: $visibility) {
        Label {
          Text("Public")
          Text("Other conversations can read it")
        } icon: {
          Image(systemName: "globe")
        }
        .tag(ConversationVisibility.public)
        Label {
          Text("Private")
          Text("Other conversations can't see it")
        } icon: {
          Image(systemName: "lock")
        }
        .tag(ConversationVisibility.private)
      }
    } label: {
      HStack(spacing: 6) {
        Icon(visibility == .private ? "lock-keyhole" : "earth", size: 12)
        Text(visibility == .private ? "Private" : "Public")
        Icon("chevron-down", size: 14)
      }
      .type(.xs, .medium)
      .foregroundStyle(Tokens.textMuted)
      .padding(.leading, 10)
      .padding(.trailing, 8)
      .frame(height: 36)
      .background(Tokens.surfacePanel, in: RoundedRectangle(cornerRadius: 8))
      .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Tokens.borderEmphasis))
    }
    .accessibilityLabel("Visibility, \(visibility == .private ? "Private" : "Public")")
  }
}
