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
  @State private var planError: String?
  @State private var autoArchive: Bool
  @State private var autoArchiveError: String?
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
          .type(.lg, .semibold)
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
              .type(.sm, lineHeight: 1.71)
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
        PlanRow(
          item: item, assignee: assignee(item.assignee), canEdit: detail.isParticipant == true,
          icon: AnyView(planIcon(item.status))
        ) { status in setPlan(item, status) }
      }
      if let planError { InlineError(text: planError) }
      if !closed.isEmpty {
        Button {
          showClosedPlan.toggle()
        } label: {
          HStack(spacing: 10) {
            Icon("chevron-right", size: 14).rotationEffect(.degrees(showClosedPlan ? 90 : 0))
            Text(showClosedPlan ? "Show less" : "Show \(closed.count) more")
          }
          .type(.sm, .medium)
          .foregroundStyle(Tokens.textMuted)
        }
        .buttonStyle(.plain)
      }
    }
  }

  /// Mark done, cancel, or reopen one Plan item (`PATCH …/plan/{id}`).
  private func setPlan(_ item: ConversationPlan.Item, _ status: String) {
    struct Body: Encodable { var status: String }
    Task {
      do {
        try await app.client.perform("PATCH", "\(path)/plan/\(item.id)", body: Body(status: status))
        let loaded: ConversationPlan? = try? await app.client.get("\(path)/plan")
        plan = loaded?.items ?? plan
        planError = nil
      } catch {
        planError = (error as? JuniorAPIError)?.localizedDescription ?? "Could not update the plan."
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
              VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 4) {
                  Text(annotation.label).type(.sm, .medium).foregroundStyle(Tokens.text)
                  Icon("external-link", size: 11).foregroundStyle(Tokens.textMuted).opacity(0.6)
                }
                if let title = annotation.title, title != annotation.label {
                  Text(title).type(.xs).foregroundStyle(Tokens.textMuted)
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
              autoArchiveError = nil
            } catch {
              autoArchive = !next
              let failure = error as? JuniorAPIError
              autoArchiveError =
                failure == .readOnlyToken
                ? failure?.localizedDescription : "Could not save auto-archive. Try again."
            }
          }
        } label: {
          HStack(spacing: 10) {
            RoundedRectangle(cornerRadius: 4)
              .strokeBorder(autoArchive ? Tokens.accent : Tokens.borderInteractive)
              .background(autoArchive ? Tokens.accent : .clear, in: RoundedRectangle(cornerRadius: 4))
              .overlay { if autoArchive { Icon("check", size: 12, stroke: 3).foregroundStyle(Tokens.textInverse) } }
              .frame(width: 16, height: 16)
            Text("Auto archive").type(.sm, .medium).foregroundStyle(Tokens.text)
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
      if let autoArchiveError { InlineError(text: autoArchiveError) }
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
          if let url = detail.locationUrl.flatMap(URL.init(string:)) {
            HStack {
              Text("Location").foregroundStyle(Tokens.textMuted)
              Spacer()
              Link(destination: url) {
                HStack(spacing: 4) {
                  Text(location).underline(color: Tokens.borderHeavy)
                  Icon("external-link", size: 10.4).opacity(0.6)
                }
                .foregroundStyle(Tokens.text)
              }
            }
            .type(.xs)
          } else {
            stat("Location", location)
          }
        }
        if let seen = detail.lastSeenAt?.date { stat("Last activity", app.clock.relative(seen)) }
        if let runtime = detail.cumulativeDurationMs {
          HStack {
            Text("Runtime").foregroundStyle(Tokens.textMuted)
            Spacer()
            Text(formatEventDuration(runtime)).foregroundStyle(Tokens.text).monospacedDigit()
              .underline(pattern: .dot, color: Tokens.borderHeavy)
          }
          .type(.xs)
          .accessibilityElement(children: .combine)
        }
      }
      if let usage = detail.cumulativeUsage {
        Rectangle().fill(Tokens.borderSubtle).frame(height: 1).padding(.vertical, 4)
        Button {
          usageOpen.toggle()
        } label: {
          HStack(spacing: 8) {
            Icon("chevron-right", size: 14).rotationEffect(.degrees(usageOpen ? 90 : 0))
            Text("Usage").type(.sm, .semibold).foregroundStyle(Tokens.text)
            Spacer()
            Text(usageSummary(usage)).type(.sm).foregroundStyle(Tokens.textMuted)
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
            Avatar(kind: .person(person), size: 28)
              .overlay(Circle().strokeBorder(Tokens.bgElevated, lineWidth: 2))
          }
          if people.count > 3 {
            Text("+\(people.count - 3)")
              .font(.dashboard(.xxs, .semibold))
              .foregroundStyle(Tokens.textMuted)
              .frame(width: 28, height: 28)
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

/// One Plan item: status icon, title, assignee, and its menu; notes span the
/// row under the title.
private struct PlanRow: View {
  let item: ConversationPlan.Item
  let assignee: String
  let canEdit: Bool
  let icon: AnyView
  let setStatus: (String) -> Void

  var body: some View {
    // The menu is its own top-aligned column, so it neither floats above the
    // title nor makes the row taller (`ConversationPlan.tsx`).
    HStack(alignment: .top, spacing: 4) {
      VStack(alignment: .leading, spacing: 2) {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
          icon
          Text(item.title ?? "Hidden item")
            .type(.sm, .medium)
            .foregroundStyle(item.isOpen ? Tokens.text : Tokens.textMuted)
            .strikethrough(!item.isOpen)
            .frame(maxWidth: .infinity, alignment: .leading)
          Text(assignee).type(.xs).foregroundStyle(Tokens.textMuted).lineLimit(1)
        }
        if let notes = item.notes {
          Text(notes).type(.xs).foregroundStyle(Tokens.textMuted).padding(.leading, 24)
        }
      }
      if canEdit { menu.padding(.vertical, -5) }
    }
    .padding(.vertical, 2.5)
    .accessibilityElement(children: .contain)
  }

  private var menu: some View {
    Menu {
      if item.isOpen {
        Button("Mark done", systemImage: "checkmark.circle") { setStatus("done") }
        Button("Cancel", systemImage: "xmark.circle") { setStatus("cancelled") }
      } else {
        Button("Reopen", systemImage: "arrow.uturn.backward.circle") { setStatus("pending") }
      }
    } label: {
      Icon("ellipsis", size: 16).foregroundStyle(Tokens.textMuted).frame(width: 28, height: 28).hitArea()
    }
    .accessibilityLabel("Plan item actions")
  }
}
