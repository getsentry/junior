import JuniorKit
import SwiftUI

/// Route `/automations/:id` (`AutomationPage.tsx`): status, actions, recent
/// runs, instruction, and settings.
struct AutomationScreen: View {
  enum Tab { case overview, runs }

  @Environment(AppModel.self) private var app
  @Environment(\.dismiss) private var dismiss
  let automationId: String
  @State private var automation: Automation?
  @State private var runs: [AutomationRun] = []
  @State private var error: JuniorAPIError?
  @State private var actionError: String?
  @State private var tab: Tab = .overview
  @State private var updating = false
  @State private var confirmDelete = false
  @State private var showHelp = false

  var body: some View {
    VStack(spacing: 0) {
      AppHeader(title: app.agentName)
      SegmentedTabs(tabs: [(.overview, "Overview"), (.runs, "Runs")], selection: $tab)
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          Button {
            dismiss()
          } label: {
            HStack(spacing: 8) {
              Icon("arrow-left", size: 15)
              Text("Automations")
            }
            .font(.dashboard(.sm, .medium, family: .display))
            .foregroundStyle(Tokens.textMuted)
          }
          .buttonStyle(.plain)
          if let automation {
            switch tab {
            case .overview: overview(automation)
            case .runs: runList
            }
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
      }
      .refreshable { await load() }
    }
    .background(Tokens.bg)
    .toolbar(.hidden, for: .navigationBar)
    .task { await load() }
    .alert("Delete automation?", isPresented: $confirmDelete) {
      Button("Cancel", role: .cancel) {}
      Button("Delete automation", role: .destructive) { Task { await delete() } }
    } message: {
      Text(
        "Delete \(automation?.title ?? "this automation")? This removes the Automation and stops future triggers. Work already queued or running may finish."
      )
    }
    .alert("Pause and resume", isPresented: $showHelp) {
      Button("OK", role: .cancel) {}
    } message: {
      Text(
        "Pausing stops new runs. Work already queued or running may finish. Resuming skips missed runs and waits for the next scheduled time or new event."
      )
    }
  }

  @ViewBuilder private func overview(_ automation: Automation) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(automation.title)
        .font(.dashboard(.xxxl, .light, family: .display))
        .tracking(-0.9)
        .foregroundStyle(Tokens.text)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityAddTraits(.isHeader)
      statusLine(automation)
    }
    actions(automation)
      .padding(.top, 8)
    Rectangle().fill(Tokens.borderSubtle).frame(height: 1)
    if let actionError { InlineError(text: actionError) }
    RecentRunsCard(automation: automation, runs: runs) { tab = .runs }
    if let instruction = automation.task?.instruction {
      VStack(alignment: .leading, spacing: 12) {
        Text("Instruction").font(.dashboard(.sm, .semibold)).foregroundStyle(Tokens.text)
        Text(instruction).font(.dashboard(.sm)).lineSpacing(8).foregroundStyle(Tokens.text)
          .lineLimit(8)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(16)
      .listCard()
    }
    VStack(alignment: .leading, spacing: 8) {
      Text("Settings").font(.dashboard(.sm, .semibold)).foregroundStyle(Tokens.text)
      setting("When", whenText(automation))
      if let destination = automation.destination?.label { setting("Posts to", destination) }
      setting("Accounts", automation.ownedByViewer == true ? "Connected by you" : "Connected by \(automation.createdBy ?? "the creator")")
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(12)
    .panelCard()
  }

  private func statusLine(_ automation: Automation) -> some View {
    let color: Color =
      switch automation.status {
      case .active: .palette(.emerald, 300)
      case .blocked: .palette(.amber, 300)
      default: Tokens.textMuted
      }
    var parts: [String] = [automation.kind == .scheduled ? (automation.schedule ?? "Scheduled") : automation.triggerSummary]
    if let destination = automation.destination?.label { parts.append(destination) }
    parts.append(automation.ownedByViewer == true ? "Created by you" : "Created by \(automation.createdBy ?? "someone")")
    return SeparatedFlow {
      HStack(spacing: 6) {
        Dot(color: color)
        Text(automation.status.rawValue.capitalized).foregroundStyle(color)
      }
      .padding(.trailing, 16)
      ForEach(Array(parts.enumerated()), id: \.offset) { index, part in
        if index > 0 {
          Text("·").opacity(0.45).frame(width: 16).layoutValue(key: IsSeparator.self, value: true)
        }
        Text(part)
      }
    }
    .font(.dashboard(.xs))
    .foregroundStyle(Tokens.textMuted)
    .accessibilityElement(children: .combine)
  }

  private func actions(_ automation: Automation) -> some View {
    HStack(spacing: 8) {
      Button {
        app.openOnWeb("/automations/\(automation.id.pathEscaped)/edit")
      } label: {
        HStack(spacing: 8) {
          Icon("pencil", size: 14)
          Text("Edit automation")
        }
      }
      .buttonStyle(.dashboard(automation.problem == nil ? .primary : .outline))
      if automation.status != .completed {
        Button(updating ? "Updating…" : (automation.status == .paused || automation.status == .blocked ? "Resume" : "Pause")) {
          Task { await toggleLifecycle(automation) }
        }
        .buttonStyle(.dashboard(.outline))
        .disabled(updating)
      }
      Button {
        showHelp = true
      } label: {
        Icon("circle-question-mark", size: 16)
      }
      .buttonStyle(.dashboard(.ghostIcon))
      .accessibilityLabel("About pausing")
      Button {
        confirmDelete = true
      } label: {
        Icon("trash-2", size: 16)
      }
      .buttonStyle(.dashboard(.destructive))
      .accessibilityLabel("Delete automation")
    }
  }

  private var runList: some View {
    VStack(spacing: 0) {
      if runs.isEmpty {
        EmptyBox(text: "No runs yet.")
      }
      ForEach(Array(runs.enumerated()), id: \.element.id) { index, run in
        RunRow(run: run).hairline(.top, index == 0 ? .clear : Tokens.borderSubtle)
      }
    }
    .listCard()
  }

  private func whenText(_ automation: Automation) -> String {
    guard automation.kind == .scheduled else { return automation.triggerSummary }
    let schedule = automation.schedule ?? "Scheduled"
    return automation.timezone.map { "\(schedule) (\($0))" } ?? schedule
  }

  private func setting(_ label: String, _ value: String) -> some View {
    HStack(alignment: .firstTextBaseline) {
      Text(label).foregroundStyle(Tokens.textMuted)
      Spacer(minLength: 12)
      Text(value).foregroundStyle(Tokens.text).multilineTextAlignment(.trailing)
    }
    .font(.dashboard(.xs))
    .accessibilityElement(children: .combine)
  }

  private func load() async {
    let path = "/api/automations/\(automationId.pathEscaped)"
    do {
      automation = try await app.client.get(path)
      error = nil
      let executions: AutomationExecutions? = try? await app.client.get("\(path)/executions")
      runs = executions?.executions ?? []
    } catch let error as JuniorAPIError {
      self.error = error
    } catch {}
  }

  /// Read the edit revision, then pause or resume against it.
  private func toggleLifecycle(_ automation: Automation) async {
    struct Edit: Decodable {
      var revision: String
      var status: Automation.Status?
    }
    struct Body: Encodable {
      var action: String
      var revision: String
    }
    updating = true
    defer { updating = false }
    let path = "/api/automations/\(automation.id.pathEscaped)"
    do {
      let edit: Edit = try await app.client.get("\(path)/edit")
      if let status = edit.status, status != automation.status {
        await load()
        return
      }
      let resume = automation.status == .paused || automation.status == .blocked
      try await app.client.perform(
        "POST", "\(path)/lifecycle", body: Body(action: resume ? "resume" : "pause", revision: edit.revision))
      actionError = nil
      await load()
    } catch {
      actionError = (error as? JuniorAPIError)?.localizedDescription ?? "Could not update the automation."
    }
  }

  private func delete() async {
    do {
      try await app.client.perform(
        "DELETE", "/api/automations/\(automationId.pathEscaped)", body: Optional<[String: String]>.none)
      dismiss()
    } catch {
      actionError = (error as? JuniorAPIError)?.localizedDescription ?? "Could not delete the automation."
    }
  }
}

/// Recent runs: a bar per run, the next run, and the latest run rows.
private struct RecentRunsCard: View {
  @Environment(AppModel.self) private var app
  let automation: Automation
  let runs: [AutomationRun]
  let viewAll: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Text("Recent runs").font(.dashboard(.sm, .semibold)).foregroundStyle(Tokens.text)
        Spacer()
        Button("View all runs", action: viewAll)
          .font(.dashboard(.xs))
          .underline()
          .foregroundStyle(Tokens.text)
          .buttonStyle(.plain)
      }
      .padding(.horizontal, 16)
      .padding(.top, 16)
      bars
        .padding(.horizontal, 16)
        .padding(.top, 12)
      if let next = automation.nextRunAt {
        VStack(alignment: .leading, spacing: 2) {
          Text("Next \(app.clock.relative(next))").font(.dashboard(.sm)).foregroundStyle(Tokens.text)
          Text(app.clock.dateTimeWithZone(next)).font(.dashboard(.xs)).foregroundStyle(Tokens.textMuted)
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
      }
      VStack(spacing: 0) {
        ForEach(runs.prefix(6)) { run in
          row(run)
        }
      }
      .padding(.top, 12)
    }
    .listCard()
  }

  /// The last 48 runs, oldest first, right-aligned. Height follows the
  /// run's duration against the slowest completed run (at least 30%);
  /// failed and blocked runs are full height.
  private var bars: some View {
    let recent = Array(runs.prefix(48).reversed())
    let slowest = recent.filter { $0.status == .completed }.compactMap(\.durationMs).max() ?? 1
    // The strip draws in an overlay so its 48 slots never widen the page.
    return Color.clear
      .frame(height: 64)
      .frame(maxWidth: .infinity)
      .overlay(alignment: .bottomTrailing) {
        HStack(alignment: .bottom, spacing: 4) {
          ForEach(0..<max(0, 48 - recent.count), id: \.self) { _ in
            Capsule().fill(Tokens.fillStrong).frame(width: 8, height: 2)
          }
          ForEach(recent) { run in
            let ratio = run.status == .completed ? max(0.3, (run.durationMs ?? 0) / slowest) : 1
            RoundedRectangle(cornerRadius: 1)
              .fill(runColor(run.status).opacity(0.8))
              .frame(width: 8, height: 64 * ratio)
          }
        }
        .fixedSize()
      }
      .clipped()
    .accessibilityElement()
    .accessibilityLabel("Last \(recent.count) runs")
  }

  private func row(_ run: AutomationRun) -> some View {
    HStack(alignment: .center, spacing: 16) {
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 12) {
          Dot(color: runColor(run.status))
          Text(run.executedAt.map { app.clock.relative($0) } ?? "").foregroundStyle(Tokens.text)
        }
        if let error = run.error, run.status == .failed {
          Text(error).foregroundStyle(Color.palette(.rose, 300)).lineLimit(2).padding(.leading, 18)
        } else if run.status == .blocked {
          Text(run.error ?? "Blocked").foregroundStyle(Color.palette(.amber, 300)).lineLimit(2).padding(.leading, 18)
        } else if let title = run.title, title != automation.title {
          Text(title).foregroundStyle(Tokens.textMuted).lineLimit(1).padding(.leading, 18)
        }
      }
      .padding(.vertical, 10)
      Spacer(minLength: 0)
      Text(
        [run.durationMs.map { formatEventDuration($0) }, run.costUsd.map { formatCost($0) }]
          .compactMap { $0 }.joined(separator: " · ")
      )
      .foregroundStyle(Tokens.textMuted)
      Button {
        if let id = run.conversationId { app.path.append(.conversation(id)) }
      } label: {
        Icon("message-square-text", size: 15).foregroundStyle(Tokens.textMuted).frame(width: 36, height: 36)
      }
      .buttonStyle(PressableStyle(radius: 6))
      .disabled(run.conversationId == nil)
      .accessibilityLabel("Open conversation")
    }
    .font(.dashboard(.xs))
    .padding(.leading, 16)
    .padding(.trailing, 8)
    .hairline(.top, Tokens.borderSubtle)
  }
}

/// Marks a separator in `SeparatedFlow`.
struct IsSeparator: LayoutValueKey {
  static let defaultValue = false
}

/// Wraps items onto lines and hides a separator that would start a line, as
/// the dashboard's status line does.
struct SeparatedFlow: Layout {
  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let lines = arrange(width: proposal.width ?? .infinity, subviews: subviews)
    let width = lines.map(\.width).max() ?? 0
    let height = lines.map(\.height).reduce(0, +) + CGFloat(max(0, lines.count - 1)) * 4
    return CGSize(width: proposal.width ?? width, height: height)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    var y = bounds.minY
    let lines = arrange(width: bounds.width, subviews: subviews)
    let placed = Set(lines.flatMap(\.items))
    for line in lines {
      var x = bounds.minX
      for index in line.items {
        let size = subviews[index].sizeThatFits(.unspecified)
        subviews[index].place(
          at: CGPoint(x: x, y: y + (line.height - size.height) / 2), proposal: ProposedViewSize(size))
        x += size.width
      }
      y += line.height + 4
    }
    // Hidden separators get no space.
    for index in subviews.indices where !placed.contains(index) {
      subviews[index].place(at: CGPoint(x: -10_000, y: -10_000), proposal: .zero)
    }
  }

  private struct Line {
    var items: [Int] = []
    var width: CGFloat = 0
    var height: CGFloat = 0
  }

  private func arrange(width: CGFloat, subviews: Subviews) -> [Line] {
    var lines = [Line()]
    for index in subviews.indices {
      let size = subviews[index].sizeThatFits(.unspecified)
      let separator = subviews[index][IsSeparator.self]
      if lines[lines.count - 1].width + size.width > width, !lines[lines.count - 1].items.isEmpty {
        if separator { continue }
        lines.append(Line())
      }
      if separator, lines[lines.count - 1].items.isEmpty { continue }
      lines[lines.count - 1].items.append(index)
      lines[lines.count - 1].width += size.width
      lines[lines.count - 1].height = max(lines[lines.count - 1].height, size.height)
    }
    // A separator that ends a line has nothing after it on that line.
    for line in lines.indices {
      while let last = lines[line].items.last, subviews[last][IsSeparator.self] {
        lines[line].items.removeLast()
        lines[line].width -= subviews[last].sizeThatFits(.unspecified).width
      }
    }
    return lines.filter { !$0.items.isEmpty }
  }
}
