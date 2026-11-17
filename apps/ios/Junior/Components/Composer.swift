import JuniorKit
import SwiftUI
import UniformTypeIdentifiers

/// The docked composer frame (`ComposerDock.tsx`).
struct ComposerDock<Content: View>: View {
  @ViewBuilder var content: Content

  var body: some View {
    content
      .padding(.horizontal, 8)
      .padding(.top, 6)
      .padding(.bottom, 6)
      .background(Tokens.bg)
      .hairline(.top, Tokens.borderSubtle)
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
    .font(.dashboard(.base))
    .lineSpacing(6)
    .foregroundStyle(Tokens.text)
    .lineLimit(1...4)
    .focused(focused)
    .padding(.horizontal, 12)
    .padding(.vertical, 15)
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
    }
    .buttonStyle(.plain)
    .disabled(!enabled)
    .accessibilityLabel("Send")
  }
}

/// Attach button and the uploads it starts.
struct AttachButton: View {
  @Binding var files: [PendingUpload]
  @State private var picking = false

  var body: some View {
    Button {
      picking = true
    } label: {
      Icon("paperclip", size: 16)
        .foregroundStyle(Tokens.textMuted)
        .frame(width: 36, height: 36)
    }
    .buttonStyle(PressableStyle(radius: 6))
    .accessibilityLabel("Attach files")
    .fileImporter(isPresented: $picking, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
      guard case .success(let urls) = result else { return }
      for url in urls.prefix(10 - files.count) {
        files.append(PendingUpload(url: url))
      }
    }
  }
}

/// A file the person picked, before the composer sends it.
struct PendingUpload: Identifiable, Hashable {
  let id = UUID()
  let url: URL

  var filename: String { url.lastPathComponent }
}

/// Chips for picked files, each removable.
struct UploadChips: View {
  @Binding var files: [PendingUpload]

  var body: some View {
    if !files.isEmpty {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 6) {
          ForEach(files) { file in
            HStack(spacing: 4) {
              Icon("file-text", size: 12)
              Text(file.filename).lineLimit(1)
              Button {
                files.removeAll { $0.id == file.id }
              } label: {
                Icon("x", size: 12)
              }
              .buttonStyle(.plain)
              .accessibilityLabel("Remove \(file.filename)")
            }
            .font(.dashboard(.xxs, .medium))
            .foregroundStyle(Tokens.textMuted)
            .padding(.horizontal, 6)
            .frame(height: 24)
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Tokens.border))
          }
        }
        .padding(.horizontal, 12)
        .padding(.top, 10)
      }
    }
  }
}

/// Upload picked files the dashboard way: ask for a signed target, then send
/// the bytes there. Returns the upload ids for the message.
func uploadFiles(_ files: [PendingUpload], client: JuniorClient) async throws -> [String] {
  struct Ask: Encodable {
    var idempotencyKey: String
    var bytes: Int
    var contentType: String
    var filename: String
  }
  struct Target: Decodable {
    var url: String
    var method: String?
    var headers: [String: String]?
  }
  struct Answer: Decodable {
    var target: Target
    var uploadId: String
  }
  var ids: [String] = []
  for file in files {
    let scoped = file.url.startAccessingSecurityScopedResource()
    defer { if scoped { file.url.stopAccessingSecurityScopedResource() } }
    let data = try Data(contentsOf: file.url)
    let type = UTType(filenameExtension: file.url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
    let answer: Answer = try await client.send(
      "POST", "/api/conversations/attachment-uploads",
      body: Ask(idempotencyKey: file.id.uuidString, bytes: data.count, contentType: type, filename: file.filename))
    guard let url = URL(string: answer.target.url, relativeTo: client.server.baseURL) else { continue }
    var request = URLRequest(url: url)
    request.httpMethod = answer.target.method ?? "PUT"
    for (name, value) in answer.target.headers ?? [:] { request.setValue(value, forHTTPHeaderField: name) }
    let (_, response) = try await URLSession.shared.upload(for: request, from: data)
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      throw JuniorAPIError.server(status: (response as? HTTPURLResponse)?.statusCode ?? 0, message: "Could not upload \(file.filename).")
    }
    ids.append(answer.uploadId)
  }
  return ids
}

/// The home composer: start a new Conversation (`POST /api/conversations`).
struct NewConversationComposer: View {
  @Environment(AppModel.self) private var app
  @State private var text = ""
  @State private var visibility: ConversationVisibility = .public
  @State private var files: [PendingUpload] = []
  @State private var sending = false
  @State private var error: String?
  @State private var idempotencyKey = UUID()
  @FocusState private var focused: Bool

  private var canSend: Bool {
    !sending && (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !files.isEmpty)
  }

  var body: some View {
    ComposerDock {
      VStack(alignment: .leading, spacing: 6) {
        if let error { InlineError(text: error).padding(.horizontal, 4) }
        ComposerSurface(focused: focused) {
          VStack(alignment: .leading, spacing: 0) {
            UploadChips(files: $files)
            ComposerField(text: $text, placeholder: "Message \(app.agentName)…", focused: $focused)
            HStack(spacing: 8) {
              AttachButton(files: $files)
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
  }

  private func send() {
    let message = text.trimmingCharacters(in: .whitespacesAndNewlines)
    sending = true
    error = nil
    Task {
      defer { sending = false }
      struct Body: Encodable {
        var idempotencyKey: String
        var message: String
        var visibility: String
        var uploadIds: [String]?
      }
      struct Accepted: Decodable { var conversationId: String }
      do {
        let uploads = try await uploadFiles(files, client: app.client)
        let accepted: Accepted = try await app.client.send(
          "POST", "/api/conversations",
          body: Body(
            idempotencyKey: idempotencyKey.uuidString, message: String(message.prefix(32_000)),
            visibility: visibility.rawValue, uploadIds: uploads.isEmpty ? nil : uploads))
        text = ""
        files = []
        idempotencyKey = UUID()
        focused = false
        app.didWrite()
        app.path.append(.conversation(accepted.conversationId))
      } catch let failure as JuniorAPIError where failure == .readOnlyToken {
        error = failure.localizedDescription
      } catch {
        self.error = "Message failed to send. Try again."
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
      .font(.dashboard(.xs, .medium))
      .foregroundStyle(Tokens.textMuted)
      .padding(.leading, 10)
      .padding(.trailing, 8)
      .frame(height: 36)
      .background(Tokens.surfacePanel, in: RoundedRectangle(cornerRadius: 8))
      .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Tokens.borderEmphasis))
    }
    .accessibilityLabel("ConversationVisibility, \(visibility == .private ? "Private" : "Public")")
  }
}
