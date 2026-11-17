import JuniorKit
import SwiftUI

/// "Conversation details" (`ConversationDetails.tsx`, mobile sheet): Brief,
/// Plan, linked work, auto-archive, activity, usage, and Participants.
struct ConversationDetailsSheet: View {
  @Environment(AppModel.self) private var app
  @Environment(\.dismiss) private var dismiss
  let detail: ConversationDetail
  @State private var plan: [ConversationPlan.Item] = []
  @State private var showClosedPlan = false
  @State private var autoArchive: Bool
  @State private var autoArchiveError = false
  @State private var showAutoArchiveHelp = false
  @State private var usageOpen = false

  init(detail: ConversationDetail) {
    self.detail = detail
    _autoArchive = State(initialValue: detail.autoArchive ?? false)
  }

  private var path: String { "/api/conversations/\(detail.conversationId.pathEscaped)" }

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Text("Conversation details")
          .font(.dashboard(.lg, .semibold))
          .foregroundStyle(Tokens.text)
          .accessibilityAddTraits(.isHeader)
        Spacer()
        Button {
          dismiss()
        } label: {
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
          if let summary = detail.brief?.content?.summary {
            Text(summary)
              .font(.dashboard(.sm))
              .lineSpacing(9)
              .foregroundStyle(Tokens.text)
              .padding(.bottom, 4)
          }
          if !plan.isEmpty { planSection }
          linkedWork
          if detail.autoArchive != nil { autoArchiveCard }
          stats
          participants
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
      }
    }
    .background(Tokens.bgElevated)
    .task {
      let loaded: ConversationPlan? = try? await app.client.get("\(path)/plan")
      plan = loaded?.items ?? []
    }
    .alert("Auto archive", isPresented: $showAutoArchiveHelp) {
      Button("OK", role: .cancel) {}
    } message: {
      Text(
        "Archive this conversation for everyone when its linked work is merged or closed and nobody replies during your wait time."
      )
    }
  }

  private var planSection: some View {
    let open = plan.filter(\.isOpen)
    let closed = plan.filter { !$0.isOpen }
    return section("Plan", count: open.count) {
      ForEach(open + (showClosedPlan ? closed : [])) { item in
        HStack(alignment: .firstTextBaseline, spacing: 10) {
          planIcon(item.status)
          VStack(alignment: .leading, spacing: 2) {
            Text(item.title)
              .font(.dashboard(.sm, .medium))
              .foregroundStyle(item.isOpen ? Tokens.text : Tokens.textMuted)
              .strikethrough(!item.isOpen)
            if let notes = item.notes {
              Text(notes).font(.dashboard(.xs)).foregroundStyle(Tokens.textMuted)
            }
          }
          Spacer(minLength: 8)
          Text(assignee(item.assignee))
            .font(.dashboard(.xs, family: item.assignee?.kind == "agent" ? .mono : .sans))
            .foregroundStyle(Tokens.textMuted)
            .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
      }
      if !closed.isEmpty {
        Button {
          showClosedPlan.toggle()
        } label: {
          HStack(spacing: 10) {
            Icon("chevron-right", size: 14).rotationEffect(.degrees(showClosedPlan ? 90 : 0))
            Text(showClosedPlan ? "Show less" : "Show \(closed.count) more")
          }
          .font(.dashboard(.sm, .medium))
          .foregroundStyle(Tokens.textMuted)
        }
        .buttonStyle(.plain)
      }
    }
  }

  @ViewBuilder private func planIcon(_ status: String) -> some View {
    switch status {
    case "in_progress": Icon("circle-dashed", size: 14).foregroundStyle(Tokens.accent)
    case "blocked": Icon("circle-alert", size: 14).foregroundStyle(Color.palette(.amber, 400))
    case "done": Icon("circle-check", size: 14).foregroundStyle(Tokens.textFaint)
    case "cancelled": Icon("circle-x", size: 14).foregroundStyle(Tokens.textFaint)
    default: Icon("circle", size: 14).foregroundStyle(Tokens.textMuted)
    }
  }

  private func assignee(_ assignee: ConversationPlan.Item.Assignee?) -> String {
    switch assignee?.kind {
    case "self": app.agentName
    case "agent", "user": assignee?.name ?? ""
    default: ""
    }
  }

  @ViewBuilder private var linkedWork: some View {
    let links = (detail.annotations ?? []).filter { $0.url != nil }
    if !links.isEmpty {
      section("Linked work", count: links.count) {
        ForEach(links, id: \.key) { annotation in
          let presentation = ObjectPresentation(objectType: annotation.objectType, status: annotation.status)
          Link(destination: URL(string: annotation.url!)!) {
            HStack(alignment: .top, spacing: 10) {
              PathIcon.octicon(presentation.icon, size: 16).foregroundStyle(presentation.color)
              VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                  Text(annotation.label).font(.dashboard(.sm, .medium)).foregroundStyle(Tokens.text)
                  Icon("external-link", size: 11).foregroundStyle(Tokens.textMuted).opacity(0.6)
                }
                if let title = annotation.title, title != annotation.label {
                  Text(title).font(.dashboard(.xs)).foregroundStyle(Tokens.textMuted)
                }
              }
            }
          }
        }
      }
    }
  }

  private var autoArchiveCard: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 10) {
        Button {
          let next = !autoArchive
          autoArchive = next
          Task {
            struct Body: Encodable { var autoArchive: Bool }
            do {
              try await app.client.perform("PATCH", "\(path)/auto-archive", body: Body(autoArchive: next))
              autoArchiveError = false
            } catch {
              autoArchive = !next
              autoArchiveError = true
            }
          }
        } label: {
          HStack(spacing: 10) {
            RoundedRectangle(cornerRadius: 4)
              .strokeBorder(autoArchive ? Tokens.accent : Tokens.borderInteractive)
              .background(autoArchive ? Tokens.accent : .clear, in: RoundedRectangle(cornerRadius: 4))
              .overlay { if autoArchive { Icon("check", size: 12, stroke: 3).foregroundStyle(Tokens.textInverse) } }
              .frame(width: 16, height: 16)
            Text("Auto archive").font(.dashboard(.sm, .medium)).foregroundStyle(Tokens.text)
          }
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(autoArchive ? .isSelected : [])
        Button {
          showAutoArchiveHelp = true
        } label: {
          Icon("circle-question-mark", size: 14).foregroundStyle(Tokens.textMuted)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("About auto archive")
      }
      if autoArchiveError { InlineError(text: "Could not save auto-archive. Try again.") }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(12)
    .listCard()
    .padding(.top, 4)
  }

  private var stats: some View {
    section(nil) {
      VStack(spacing: 10) {
        if let location = slackLocationLabel(
          channel: detail.channel, name: detail.channelName, redacted: detail.channelNameRedacted)
        {
          stat("Location", location)
        }
        if let seen = detail.lastSeenAt { stat("Last activity", app.clock.relative(seen)) }
        if let runtime = detail.cumulativeDurationMs { stat("Runtime", formatEventDuration(runtime)) }
      }
      if let usage = detail.cumulativeUsage {
        Rectangle().fill(Tokens.borderSubtle).frame(height: 1).padding(.vertical, 4)
        Button {
          usageOpen.toggle()
        } label: {
          HStack(spacing: 8) {
            Icon("chevron-right", size: 14).rotationEffect(.degrees(usageOpen ? 90 : 0))
            Text("Usage").font(.dashboard(.sm, .semibold)).foregroundStyle(Tokens.text)
            Spacer()
            Text(usageSummary(usage)).font(.dashboard(.sm)).foregroundStyle(Tokens.textMuted)
          }
          .foregroundStyle(Tokens.textMuted)
        }
        .buttonStyle(.plain)
        if usageOpen {
          VStack(spacing: 8) {
            stat("Input tokens", formatCompactCount(usage.inputTokens ?? 0))
            stat("Output tokens", formatCompactCount(usage.outputTokens ?? 0))
            stat("Cached input tokens", formatCompactCount(usage.cachedInputTokens ?? 0))
          }
          .padding(.leading, 22)
        }
      }
    }
  }

  private func usageSummary(_ usage: ConversationDetail.Usage) -> String {
    let tokens = "\(formatCompactCount(usage.totalTokens)) tokens"
    guard let cost = usage.cost?.total else { return tokens }
    return "\(tokens) · \(formatCost(cost, lowerBound: detail.status == .active))"
  }

  @ViewBuilder private var participants: some View {
    if let people = detail.participants, !people.isEmpty {
      section("Participants") {
        HStack(spacing: -4) {
          ForEach(Array(people.prefix(3).enumerated()), id: \.offset) { _, person in
            Avatar(kind: .person(person), size: 24)
              .overlay(Circle().strokeBorder(Tokens.bgElevated, lineWidth: 2))
          }
          if people.count > 3 {
            Text("+\(people.count - 3)")
              .font(.dashboard(.xxs, .semibold))
              .foregroundStyle(Tokens.text)
              .frame(width: 24, height: 24)
              .background(Tokens.surfaceActive, in: Circle())
              .overlay(Circle().strokeBorder(Tokens.bgElevated, lineWidth: 2))
          }
        }
        .accessibilityElement()
        .accessibilityLabel(people.map(\.displayName).joined(separator: ", "))
      }
    }
  }

  private func section<Content: View>(
    _ title: String?, count: Int? = nil, @ViewBuilder content: () -> Content
  ) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      if let title {
        HStack(spacing: 6) {
          Text(title).font(.dashboard(.xs, .semibold)).foregroundStyle(Tokens.text)
          if let count { Text("\(count)").font(.dashboard(.xs)).foregroundStyle(Tokens.textFaint) }
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
    .font(.dashboard(.xs))
    .accessibilityElement(children: .combine)
  }
}
