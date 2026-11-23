import JuniorKit
import SwiftUI

/// "Conversation details" (`ConversationDetails.tsx`): the Brief (summary,
/// outcome, intent, decisions, facts, links) and activity, in a sheet or in a
/// panel beside a wide transcript.
struct ConversationDetailsSheet: View {
  @Environment(AppModel.self) private var app
  @Environment(WindowModel.self) private var window
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
          if let brief = state.brief {
            Text(brief.summary)
              .type(.sm, lineHeight: 1.71)
              .foregroundStyle(Tokens.text)
              .padding(.bottom, 4)
            briefSections(brief)
          } else {
            Text("No Brief yet. \(app.agentName) writes one as the conversation goes.")
              .type(.sm)
              .foregroundStyle(Tokens.textMuted)
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

  @ViewBuilder private func briefSections(_ brief: Brief) -> some View {
    section("Outcome") {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(outcomeLabel(brief.outcome.status))
          .type(.xs, .medium)
          .foregroundStyle(outcomeColor(brief.outcome.status))
          .padding(.horizontal, 6)
          .padding(.vertical, 2)
          .background(outcomeColor(brief.outcome.status).opacity(0.12), in: Capsule())
        Text(brief.outcome.text).type(.sm).foregroundStyle(Tokens.text)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    section("Intent") {
      Text(brief.intent).type(.sm).foregroundStyle(Tokens.text).fixedSize(horizontal: false, vertical: true)
    }
    if !brief.decisions.isEmpty {
      section("Decisions", count: brief.decisions.count) {
        ForEach(brief.decisions, id: \.self) { decision in
          bullet(
            decision.text, detail: [decision.kind.capitalized, decision.by].compactMap { $0 }.joined(separator: " · "))
        }
      }
    }
    if !brief.facts.isEmpty {
      section("Facts", count: brief.facts.count) {
        ForEach(brief.facts, id: \.self) { fact in bullet(fact, detail: nil) }
      }
    }
    if !brief.links.isEmpty {
      section("Links", count: brief.links.count) {
        ForEach(brief.links, id: \.self) { link in
          let presentation = ObjectPresentation(objectType: link.kind, status: link.status)
          Button {
            window.openLink(link.url)
          } label: {
            HStack(alignment: .top, spacing: 10) {
              PathIcon.octicon(presentation.icon, size: 16).foregroundStyle(presentation.color)
              HStack(spacing: 4) {
                Text(link.label).type(.sm, .medium).foregroundStyle(Tokens.text).multilineTextAlignment(.leading)
                Icon("external-link", size: 11).foregroundStyle(Tokens.textMuted).opacity(0.6)
              }
              Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
        }
      }
    }
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
              window.openLink(url)
            } label: {
              stat("Location", location)
            }
            .buttonStyle(.plain)
          } else {
            stat("Location", location)
          }
        }
        if let updated = state.brief?.updatedAt.date { stat("Brief updated", app.clock.relative(updated)) }
      }
    }
  }

  private func bullet(_ text: String, detail: String?) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text("•").type(.sm).foregroundStyle(Tokens.textFaint)
      VStack(alignment: .leading, spacing: 2) {
        Text(text).type(.sm).foregroundStyle(Tokens.text).fixedSize(horizontal: false, vertical: true)
        if let detail, !detail.isEmpty { Text(detail).type(.xs).foregroundStyle(Tokens.textMuted) }
      }
    }
    .accessibilityElement(children: .combine)
  }

  private func outcomeLabel(_ status: String) -> String {
    status.replacingOccurrences(of: "_", with: " ").capitalized
  }

  private func outcomeColor(_ status: String) -> Color {
    switch status {
    case "done", "answered": .palette(.emerald, 400)
    case "blocked", "abandoned": .palette(.rose, 400)
    case "partial": .palette(.amber, 400)
    default: .palette(.sky, 400)
    }
  }

  private func section<Content: View>(
    _ title: String?, count: Int? = nil, @ViewBuilder content: () -> Content
  ) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      if let title {
        HStack(spacing: 6) {
          Text(title).type(.xs, .semibold).foregroundStyle(Tokens.text)
          if let count { Text("\(count)").type(.xs).foregroundStyle(Tokens.textFaint) }
        }
        .accessibilityAddTraits(.isHeader)
      }
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
