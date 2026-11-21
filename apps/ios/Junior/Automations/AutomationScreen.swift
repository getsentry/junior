import JuniorKit
import SwiftUI

/// Route `/automations/:id` (`AutomationPage.tsx`) through `getAutomation`:
/// status, trigger, task, and recent runs. Pausing and editing happen on
/// the web; the public API reads Automations only.
struct AutomationScreen: View {
  @Environment(AppModel.self) private var app
  @Environment(\.dismiss) private var dismiss
  @Environment(\.splitColumn) private var column
  let automationId: String
  @State private var detail: AutomationDetail?
  @State private var error: JuniorAPIError?

  var body: some View {
    VStack(spacing: 0) {
      AppHeader(title: app.agentName)
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          // Beside the list, there is nothing to go back to.
          if column != .detailRoot {
            Button {
              dismiss()
            } label: {
              HStack(spacing: 8) {
                Icon("arrow-left", size: 15)
                Text("Automations")
              }
              .type(.sm, .medium, family: .display)
              .foregroundStyle(Tokens.textMuted)
            }
            .buttonStyle(.plain)
          }
          if let detail {
            overview(detail.automation)
            runs(detail.runs)
          } else if let error {
            EmptyBox(text: error.localizedDescription) { Task { await load() } }
          } else {
            VStack(alignment: .leading, spacing: 12) {
              Skeleton(width: 260, height: 30)
              Skeleton(width: 220, height: 14)
              Skeleton(height: 180, radius: 8)
            }
          }
        }
        .padding(16)
        .readableWidth()
      }
      .refreshable { await load() }
    }
    .background(Tokens.bg)
    .toolbar(.hidden, for: .navigationBar)
    .task { await load() }
  }

  private func load() async {
    do {
      detail = try await app.call("getAutomation", ["id": .string(automationId)], as: AutomationDetail.self)
      error = nil
    } catch let failure as JuniorAPIError {
      if detail == nil { error = failure }
    } catch {}
  }

  private func overview(_ automation: Automation) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      VStack(alignment: .leading, spacing: 8) {
        Text(automation.title)
          .type(.xxl, .light, family: .display, lineHeight: 1.1)
          .foregroundStyle(Tokens.text)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityAddTraits(.isHeader)
        HStack(spacing: 8) {
          Dot(color: statusColor(automation.status))
          Text(automation.status.capitalized).type(.xs, .medium).foregroundStyle(statusColor(automation.status))
          if let next = automation.nextRunAt?.date, automation.status == "active" {
            Text("· Next \(app.clock.relative(next))").type(.xs).foregroundStyle(Tokens.textMuted)
          }
        }
        if let reason = automation.statusReason {
          Text(reason).type(.xs).foregroundStyle(Color.palette(.amber, 300)).fixedSize(
            horizontal: false, vertical: true)
        }
      }
      VStack(alignment: .leading, spacing: 10) {
        fact("calendar-clock", automation.kind == "scheduled" ? "Schedule" : "Trigger", automation.trigger)
        fact("hash", "Posts to", automation.destination)
        fact("user", "Created by", automation.ownedByYou ? "You" : automation.createdBy)
      }
      .padding(16)
      .frame(maxWidth: .infinity, alignment: .leading)
      .panelCard(radius: 10)
      VStack(alignment: .leading, spacing: 8) {
        Text(automation.task.kind == "skill" ? "Skill" : "Instruction")
          .type(.xs, .semibold).foregroundStyle(Tokens.text).accessibilityAddTraits(.isHeader)
        MarkdownView(blocks: parseMarkdown(automation.task.text), step: .sm, color: Tokens.text)
      }
      if let url = automation.url {
        Button("Edit on the web") { app.openLink(url) }
          .buttonStyle(.dashboard(.outline))
      }
    }
  }

  private func runs(_ runs: [AutomationRun]) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        Text("Recent runs").type(.sm, .semibold).foregroundStyle(Tokens.text)
        Text("\(runs.count)").type(.sm).foregroundStyle(Tokens.textFaint)
      }
      .accessibilityElement(children: .combine)
      .accessibilityAddTraits(.isHeader)
      if runs.isEmpty {
        Text("No runs yet.").type(.sm).foregroundStyle(Tokens.textMuted)
      } else {
        VStack(spacing: 0) {
          ForEach(Array(runs.enumerated()), id: \.offset) { index, run in
            RunRow(run: run).hairline(.top, index == 0 ? .clear : Tokens.borderSubtle)
          }
        }
        .listCard()
      }
    }
    .padding(.top, 8)
  }

  private func fact(_ icon: String, _ label: String, _ value: String) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Icon(icon, size: 13).foregroundStyle(Tokens.textMuted)
      Text(label).type(.xs).foregroundStyle(Tokens.textMuted).frame(width: 76, alignment: .leading)
      Text(value).type(.xs, .medium).foregroundStyle(Tokens.text).fixedSize(horizontal: false, vertical: true)
    }
    .accessibilityElement(children: .combine)
  }

  private func statusColor(_ status: String) -> Color {
    switch status {
    case "active": .palette(.emerald, 400)
    case "blocked": .palette(.amber, 400)
    default: Tokens.textMuted
    }
  }
}

/// One run: time and status, its error, and its Conversation.
private struct RunRow: View {
  @Environment(AppModel.self) private var app
  let run: AutomationRun

  var body: some View {
    Button {
      if let id = run.conversationId { app.path.append(.conversation(id)) }
    } label: {
      HStack(alignment: .top, spacing: 10) {
        Dot(color: color, size: 8).padding(.top, 5)
        VStack(alignment: .leading, spacing: 2) {
          Text(run.executedAt.date.map(app.clock.dateTimeWithZone) ?? run.executedAt.raw)
            .type(.sm, .medium).foregroundStyle(Tokens.text)
          Text(run.status.capitalized).type(.xs).foregroundStyle(color)
          if let error = run.error {
            Text(error).type(.xs).foregroundStyle(Tokens.textMuted).lineLimit(3)
          }
        }
        Spacer(minLength: 0)
        if run.conversationId != nil {
          Icon("chevron-right", size: 14).foregroundStyle(Tokens.textMuted).padding(.top, 3)
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 12)
      .contentShape(Rectangle())
    }
    .buttonStyle(PressableStyle(radius: 0, pressedFill: Tokens.fillSoft))
    .disabled(run.conversationId == nil)
    .accessibilityElement(children: .combine)
  }

  private var color: Color {
    switch run.status {
    case "completed": .palette(.emerald, 400)
    case "failed": .palette(.rose, 400)
    default: .palette(.amber, 400)
    }
  }
}
