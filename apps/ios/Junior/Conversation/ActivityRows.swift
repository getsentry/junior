import JuniorKit
import SwiftUI

/// The activity between two messages (`TranscriptActivityGroup.tsx`): one
/// collapsed line, "2 events · 5.0s", that opens to its reasoning and tool
/// calls. The running Turn's group counts its time up and shows its latest
/// step while closed.
struct ActivityGroupRow: View {
  @Environment(AppModel.self) private var app
  let group: ActivityGroup
  let live: Bool
  @State private var open = false

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Button {
        withAnimation(.snappy(duration: 0.2)) { open.toggle() }
      } label: {
        HStack(spacing: 4) {
          title.lineLimit(1)
          Icon("chevron-right", size: 12, stroke: 2.2)
            .opacity(0.55)
            .rotationEffect(.degrees(open ? 90 : 0))
        }
        .type(.xs)
        .foregroundStyle(Tokens.textMuted)
        .frame(minHeight: 24)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      if live, !open {
        LiveStep(group: group)
      }
      if open {
        VStack(alignment: .leading, spacing: 4) {
          ForEach(group.steps) { step in
            switch step {
            case .reasoning(_, let text, _): ReasoningRow(text: text)
            case .tool(let tool): ToolRow(tool: tool)
            }
          }
        }
      }
    }
    .padding(.leading, 32)
    .padding(.vertical, 2)
  }

  @ViewBuilder private var title: some View {
    if live, let start = group.startedAt {
      // A running Turn counts its time up, like a stopwatch.
      TimelineView(.periodic(from: .now, by: 1)) { context in
        let now = app.fixedNow ?? context.date
        Text("Working for \(formatWorkingTime(Int(now.timeIntervalSince(start) * 1000)))")
      }
    } else {
      Text(open ? "Hide \(group.label)" : group.label)
    }
  }
}

/// The running Turn's latest reasoning, then what it does now
/// (`TranscriptLiveStep.tsx`).
private struct LiveStep: View {
  let group: ActivityGroup

  // Say what a running tool call does, like "Running" a command.
  private static let actions: [String: (icon: String, verb: String)] = [
    "bash": ("square-terminal", "Running"),
    "executeTool": ("wrench", "Calling"),
    "loadSkill": ("sparkles", "Loading"),
    "spawnAgent": ("bot", "Starting"),
    "webFetch": ("globe", "Reading"),
    "webSearch": ("globe", "Searching"),
  ]

  var body: some View {
    let step = group.liveStep
    let action = step.tool.map { Self.actions[$0.name] ?? (icon: "wrench", verb: $0.name) }
    VStack(alignment: .leading, spacing: 6) {
      if let reasoning = step.reasoning {
        Text(reasoning)
          .type(.sm, lineHeight: 1.625)
          .foregroundStyle(Tokens.textMuted)
          .lineLimit(3)
          .transition(.opacity)
          .id(reasoning)
      }
      HStack(spacing: 6) {
        if let action {
          Icon(action.icon, size: 14).foregroundStyle(Tokens.textFaint)
        }
        Pulsing { Text(action?.verb ?? "Thinking").type(.sm) }
      }
      .foregroundStyle(Tokens.textMuted)
      .frame(minHeight: 24)
      .accessibilityElement(children: .combine)
    }
  }
}

/// Reasoning (`TranscriptReasoningView.tsx`): a one-line preview that opens
/// to the full text.
private struct ReasoningRow: View {
  let text: String
  @State private var open = false

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Button {
        withAnimation(.snappy(duration: 0.2)) { open.toggle() }
      } label: {
        HStack(spacing: 8) {
          Icon("lightbulb", size: 14).foregroundStyle(Color.palette(.violet, 200).opacity(0.8))
          Group {
            if open {
              Text("Reasoning")
            } else {
              Text(text).italic().lineLimit(1)
            }
          }
          .type(.xs)
          .foregroundStyle(Tokens.textMuted)
          Spacer(minLength: 0)
        }
        .frame(minHeight: 28)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(open ? "Reasoning" : "Reasoning: \(text)")
      if open {
        MarkdownView(text, step: .sm, color: Tokens.textSubtle)
          .padding(.horizontal, 12)
          .padding(.vertical, 10)
      }
    }
  }
}

/// One tool call (`TranscriptToolView.tsx`): its name and how long it ran.
/// The public API has no tool input or output to open.
private struct ToolRow: View {
  let tool: ActivityTool

  var body: some View {
    HStack(spacing: 8) {
      Icon(failed ? "triangle-alert" : "wrench", size: 14)
        .foregroundStyle(failed ? Color.palette(.rose, 300) : Tokens.textFaint)
      Group {
        if tool.status == "running" {
          Pulsing { Text(tool.name).bold() }.foregroundStyle(Tokens.textMuted)
        } else {
          Text(tool.name).bold().foregroundStyle(failed ? Color.palette(.rose, 300) : Tokens.text)
        }
      }
      .type(.xs)
      .lineLimit(1)
      Spacer(minLength: 8)
      if let duration {
        Text(duration).type(.xs).monospacedDigit().foregroundStyle(Tokens.textMuted)
      }
    }
    .frame(minHeight: 28)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilityName)
  }

  private var failed: Bool { tool.status == "error" }

  private var accessibilityName: String {
    tool.status == "running" ? "\(tool.name) (running)" : failed ? "\(tool.name) (failed)" : tool.name
  }

  private var duration: String? {
    guard let start = tool.startedAt, let end = tool.endedAt, end >= start else { return nil }
    return formatDuration(Int((end.timeIntervalSince(start) * 1000).rounded(.down)))
  }
}

/// Fades its content in and out while work runs, like the web's shimmer;
/// still under Reduce Motion.
private struct Pulsing<Content: View>: View {
  @ViewBuilder var content: Content
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var dim = false

  var body: some View {
    content
      .opacity(reduceMotion ? 1 : (dim ? 0.45 : 1))
      .animation(reduceMotion ? nil : .easeInOut(duration: 0.9).repeatForever(), value: dim)
      .onAppear { dim = true }
  }
}
