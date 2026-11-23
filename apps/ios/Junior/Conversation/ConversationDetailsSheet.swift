import JuniorKit
import SwiftUI

/// "Conversation details" (`ConversationDetails.tsx`): the summary and
/// activity, in a sheet or in a panel beside a wide transcript.
struct ConversationDetailsSheet: View {
  @Environment(AppModel.self) private var app
  let state: ConversationState
  let close: () -> Void

  private var conversation: MCPConversation { state.conversation }

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Text("Conversation details")
          .type(.lg, .semibold)
          .foregroundStyle(Tokens.text)
          .accessibilityAddTraits(.isHeader)
        Spacer()
        Button(action: close) {
          Icon("x", size: 16).foregroundStyle(Tokens.textMuted).frame(width: 36, height: 36)
        }
        .buttonStyle(PressableStyle(radius: 6))
        .accessibilityLabel("Close conversation details")
      }
      .padding(.leading, 16)
      .padding(.trailing, 8)
      .padding(.vertical, 10)
      .hairline(.bottom, Tokens.borderSubtle)

      ScrollView {
        VStack(alignment: .leading, spacing: 8) {
          if let summary = conversation.summary {
            Text(summary)
              .type(.sm, lineHeight: 1.71)
              .foregroundStyle(Tokens.text)
              .padding(.bottom, 4)
          }
          stats
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
      }
    }
    .background(Tokens.bgElevated)
  }

  private var stats: some View {
    section("Activity") {
      VStack(spacing: 8) {
        stat("Status", conversation.status.rawValue.capitalized)
        if let started = conversation.startedAt.date { stat("Started", app.clock.dateTimeWithZone(started)) }
        if let last = conversation.lastSeenAt.date { stat("Last activity", app.clock.relative(last)) }
        if let location = conversation.locationLabel {
          if let url = conversation.locationUrl {
            Button {
              app.openLink(url)
            } label: {
              stat("Location", location)
            }
            .buttonStyle(.plain)
          } else {
            stat("Location", location)
          }
        }
      }
    }
  }

  private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(title).type(.xs, .semibold).foregroundStyle(Tokens.text).accessibilityAddTraits(.isHeader)
      content()
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.top, 12)
    .hairline(.top, Tokens.borderSubtle)
  }

  private func stat(_ label: String, _ value: String) -> some View {
    HStack {
      Text(label).foregroundStyle(Tokens.textMuted)
      Spacer()
      Text(value).foregroundStyle(Tokens.text).monospacedDigit()
    }
    .type(.xs)
    .accessibilityElement(children: .combine)
  }
}
