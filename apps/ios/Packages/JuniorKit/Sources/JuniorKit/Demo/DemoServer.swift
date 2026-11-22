import Foundation

/// Junior's MCP server in process, over mock data, for people who have no
/// Junior to sign in to, such as App Review. The tools follow the real ones
/// closely enough that every screen works; a new message gets a canned
/// reply. `scripts/export-demo-data.mjs` writes the data from the mock
/// server, so the demo and the UI tests show the same Conversations.
public actor DemoServer {
  private var conversations: [DemoConversation]
  private var inboxItems: [JSONObject]
  /// `getAutomation` results: `{ automation, runs }`.
  private var automations: [JSONObject]
  /// Idempotency keys of sent messages, so a retry sends nothing.
  private var sent: [String: (conversationId: String, messageId: String)] = [:]
  private let now: @Sendable () -> Date

  /// How long Junior "works" before the canned reply.
  static let replyDelay: TimeInterval = 2
  static let reply =
    "This is the demo, so I can't act on that here. In your workspace, I work on the request with your tools and reply in this conversation."

  public init(now: @escaping @Sendable () -> Date = { Date() }) {
    let data = DemoData.load(movedTo: now())
    conversations = data.conversations
    inboxItems = data.inboxItems
    automations = data.automations
    self.now = now
  }

  /// A transport for `MCPClient` that answers from this server.
  public nonisolated var transport: HTTPTransport {
    { request in try await self.respond(to: request) }
  }

  /// Answer one JSON-RPC request to `/api/mcp`.
  func respond(to request: URLRequest) throws -> (Data, URLResponse) {
    let body = try JSONDecoder().decode(JSONValue.self, from: request.httpBody ?? Data())
    let params = body["params"]?.object ?? [:]
    var envelope: JSONObject = ["jsonrpc": "2.0", "id": body["id"] ?? .null]
    switch body["method"]?.string {
    case "initialize":
      envelope["result"] = .object([
        "protocolVersion": params["protocolVersion"] ?? "2025-06-18", "capabilities": .object([:]),
        "serverInfo": .object(["name": "junior"]),
      ])
    case "tools/call":
      envelope["result"] = toolResult(params["name"]?.string ?? "", params["arguments"]?.object ?? [:])
    default:
      envelope["error"] = .object(["code": -32601, "message": "Method not found"])
    }
    let data = try JSONEncoder().encode(JSONValue.object(envelope))
    let response = HTTPURLResponse(
      url: request.url ?? JuniorServer.demo.mcpURL, statusCode: 200, httpVersion: nil,
      headerFields: ["Content-Type": "application/json"])!
    return (data, response)
  }

  private func toolResult(_ name: String, _ arguments: JSONObject) -> JSONValue {
    deliverReplies()
    do {
      let value = try call(name, arguments)
      return .object(["content": .array([text(value.jsonText)]), "structuredContent": value])
    } catch let error as DemoToolError {
      return .object(["content": .array([text(error.message)]), "isError": true])
    } catch {
      return .object(["content": .array([text("\(name) failed.")]), "isError": true])
    }
  }

  private func text(_ value: String) -> JSONValue { .object(["type": "text", "text": .string(value)]) }

  private func call(_ name: String, _ arguments: JSONObject) throws -> JSONValue {
    switch name {
    case "searchConversations": return searchConversations(arguments)
    case "getConversation": return try getConversation(arguments)
    case "listConversationMessages": return try listMessages(arguments)
    case "createConversation": return try createConversation(arguments)
    case "sendMessage": return try sendMessage(arguments)
    case "archiveConversation": return try archive(arguments)
    case "archiveDoneConversations": return archiveDone()
    case "pinConversation": return try pin(arguments)
    case "setConversationAutoArchive":
      _ = try conversationIndex(arguments)
      return .object(["autoArchive": .bool(arguments.flag("autoArchive") ?? true)])
    case "setConversationSubscription": return try subscribe(arguments)
    case "markConversationRead":
      let index = try conversationIndex(arguments)
      let lastReadSeq = arguments.integer("lastReadSeq") ?? conversations[index].lastSeq
      return .object(["lastReadSeq": .number(Double(lastReadSeq))])
    case "stopConversation": return try stop(arguments)
    case "cancelQueuedMessages":
      let index = try conversationIndex(arguments)
      let ids = conversations[index].pending.compactMap { $0["messageId"] }
      conversations[index].pending = []
      return .object([
        "cancelledCount": .number(Double(ids.count)), "cancelledInboundMessageIds": .array(ids),
        "conversationId": .string(conversations[index].id),
      ])
    case "searchInboxItems": return searchInboxItems(arguments)
    case "getInboxItem":
      guard let item = inboxItems.first(where: { $0["id"]?.string == arguments.text("id") }) else {
        throw DemoToolError("Inbox item not found.")
      }
      return .object(["item": .object(item)])
    case "searchAutomations": return searchAutomations(arguments)
    case "getAutomation":
      guard let entry = automations.first(where: { $0["automation"]?["id"]?.string == arguments.text("id") }) else {
        throw DemoToolError("Automation not found.")
      }
      return .object(entry)
    default: throw DemoToolError("Unknown tool \(name).")
    }
  }

  // MARK: Conversations

  private func searchConversations(_ arguments: JSONObject) -> JSONValue {
    var rows = conversations.filter(\.listed)
    if let query = arguments.text("q")?.lowercased() {
      // A search finds archived Conversations too.
      rows = rows.filter { $0.searchText.contains(query) }
    } else {
      let archived = arguments.text("status") == "archived"
      rows = rows.filter { $0.summary.has("archivedAt") == archived }
    }
    rows.sort { $0.lastSeenAt > $1.lastSeenAt }
    return .object(["conversations": .array(rows.prefix(50).map { JSONValue.object($0.summary) })])
  }

  private func getConversation(_ arguments: JSONObject) throws -> JSONValue {
    let conversation = try conversations[conversationIndex(arguments)]
    var result = conversation.state
    if let after = arguments.text("after") {
      guard let afterSeq = cursorSeq(after) else {
        throw DemoToolError("The cursor is not valid. Omit `after` to read the current state.")
      }
      let newer = conversation.messages.filter { messageSeq($0) > afterSeq }
      let page = Array(newer.prefix(20))
      result["messages"] = .array(page.map { JSONValue.object($0) })
      if newer.count > page.count { result["hasMore"] = true }
      result["cursor"] = cursor(page.last.map(messageSeq) ?? afterSeq)
    } else {
      if let reply = conversation.messages.last(where: { $0["role"]?.string == "assistant" }) {
        result["lastReply"] = .object(reply)
      }
      result["cursor"] = cursor(conversation.lastSeq)
    }
    return .object(result)
  }

  private func listMessages(_ arguments: JSONObject) throws -> JSONValue {
    let conversation = try conversations[conversationIndex(arguments)]
    var older = conversation.messages
    if let before = arguments.text("before") {
      guard let beforeSeq = cursorSeq(before) else {
        throw DemoToolError("The cursor is not valid. Omit `before` to read the newest messages.")
      }
      older = older.filter { messageSeq($0) < beforeSeq }
    }
    let page = Array(older.suffix(min(max(arguments.integer("limit") ?? 10, 1), 50)))
    var result: JSONObject = ["messages": .array(page.map { JSONValue.object($0) })]
    if older.count > page.count, let first = page.first { result["nextCursor"] = cursor(messageSeq(first)) }
    return .object(result)
  }

  private func createConversation(_ arguments: JSONObject) throws -> JSONValue {
    let message = try messageText(arguments)
    if let duplicate = try duplicate(arguments) { return duplicate }
    let id = "demo:\(UUID().uuidString.lowercased())"
    let stamp = timestamp(now())
    var conversation = DemoConversation(
      summary: [
        "conversationId": .string(id), "title": .string(arguments.text("title") ?? title(for: message)),
        "status": "working", "turnActive": true, "surface": "api", "startedAt": stamp, "lastSeenAt": stamp,
        "url": .string(JuniorServer.demo.page("/conversations/\(id)")!.absoluteString),
      ], brief: nil, messages: [], pending: [], authorization: nil, listed: true)
    let messageId = append(message, to: &conversation)
    conversations.insert(conversation, at: 0)
    remember(arguments, id, messageId)
    return accepted(conversation, messageId: messageId, status: "accepted", cursor: -1)
  }

  private func sendMessage(_ arguments: JSONObject) throws -> JSONValue {
    let index = try conversationIndex(arguments)
    let message = try messageText(arguments)
    if let duplicate = try duplicate(arguments) { return duplicate }
    let lastSeq = conversations[index].lastSeq
    let messageId = append(message, to: &conversations[index])
    remember(arguments, conversations[index].id, messageId)
    return accepted(conversations[index], messageId: messageId, status: "accepted", cursor: lastSeq)
  }

  /// A person's message: Junior starts working, and a new message restores
  /// an archived Conversation.
  private func append(_ text: String, to conversation: inout DemoConversation) -> String {
    let messageId = UUID().uuidString.lowercased()
    let stamp = timestamp(now())
    conversation.messages.append([
      "seq": .number(Double(conversation.lastSeq + 1)), "messageId": .string(messageId), "createdAt": stamp,
      "role": "user", "author": "You", "text": .string(text),
    ])
    conversation.summary["status"] = "working"
    conversation.summary["turnActive"] = true
    conversation.summary["lastSeenAt"] = stamp
    conversation.summary["archivedAt"] = nil
    conversation.replyAt = now().addingTimeInterval(Self.replyDelay)
    return messageId
  }

  /// The canned replies that are due, as a finished Turn.
  private func deliverReplies() {
    let date = now()
    for index in conversations.indices {
      guard let replyAt = conversations[index].replyAt, replyAt <= date else { continue }
      let stamp = timestamp(date)
      conversations[index].messages.append([
        "seq": .number(Double(conversations[index].lastSeq + 1)), "messageId": .string(UUID().uuidString.lowercased()),
        "createdAt": stamp, "role": "assistant", "author": "Junior", "text": .string(Self.reply),
      ])
      conversations[index].summary["status"] = "done"
      conversations[index].summary["turnActive"] = false
      conversations[index].summary["lastSeenAt"] = stamp
      conversations[index].replyAt = nil
    }
  }

  private func accepted(_ conversation: DemoConversation, messageId: String, status: String, cursor seq: Int)
    -> JSONValue
  {
    var result: JSONObject = [
      "conversationId": .string(conversation.id), "messageId": .string(messageId), "status": .string(status),
      "pendingMessages": .array(conversation.pending), "cursor": cursor(seq),
    ]
    result["url"] = conversation.summary["url"]
    result["authorization"] = conversation.authorization
    return .object(result)
  }

  private func duplicate(_ arguments: JSONObject) throws -> JSONValue? {
    guard let key = arguments.text("idempotencyKey"), let sent = sent[key],
      let conversation = conversations.first(where: { $0.id == sent.conversationId })
    else { return nil }
    // The cursor starts before the message, so a follow still reads its reply.
    let seq = conversation.messages.first { $0["messageId"]?.string == sent.messageId }.map(messageSeq) ?? 0
    return accepted(conversation, messageId: sent.messageId, status: "duplicate", cursor: seq - 1)
  }

  private func remember(_ arguments: JSONObject, _ conversationId: String, _ messageId: String) {
    if let key = arguments.text("idempotencyKey") { sent[key] = (conversationId, messageId) }
  }

  private func archive(_ arguments: JSONObject) throws -> JSONValue {
    let index = try conversationIndex(arguments)
    let archived = arguments.flag("archived") ?? true
    // Like the real tool, archive takes the newest activity time.
    if archived, arguments.text("lastSeenAt").flatMap(Date.junior) != conversations[index].lastSeenAt {
      throw DemoToolError("Conversation received new activity.")
    }
    conversations[index].summary["archivedAt"] = archived ? timestamp(now()) : nil
    return .object(["archivedAt": conversations[index].summary["archivedAt"] ?? .null])
  }

  /// Done Conversations that nobody pinned and that wait on nobody.
  private func archiveDone() -> JSONValue {
    var count = 0
    for index in conversations.indices {
      let summary = conversations[index].summary
      guard conversations[index].listed, summary["status"]?.string == "done", summary["turnActive"]?.bool != true,
        !summary.has("pinnedAt"), !summary.has("archivedAt")
      else { continue }
      conversations[index].summary["archivedAt"] = timestamp(now())
      count += 1
    }
    return .object(["archived": .number(Double(count))])
  }

  private func pin(_ arguments: JSONObject) throws -> JSONValue {
    let index = try conversationIndex(arguments)
    let pinned = arguments.flag("pinned") ?? true
    conversations[index].summary["pinnedAt"] = pinned ? timestamp(now()) : nil
    // A pin restores an archived Conversation.
    if pinned { conversations[index].summary["archivedAt"] = nil }
    return .object(["pinnedAt": conversations[index].summary["pinnedAt"] ?? .null])
  }

  /// Unsubscribe removes the Conversation from the viewer's feed.
  private func subscribe(_ arguments: JSONObject) throws -> JSONValue {
    let index = try conversationIndex(arguments)
    let subscribed = arguments.flag("subscribed") ?? true
    conversations[index].listed = subscribed
    if !subscribed { conversations[index].summary["pinnedAt"] = nil }
    return .object([
      "archivedAt": conversations[index].summary["archivedAt"] ?? .null, "subscribed": .bool(subscribed),
    ])
  }

  private func stop(_ arguments: JSONObject) throws -> JSONValue {
    let index = try conversationIndex(arguments)
    let id = JSONValue.string(conversations[index].id)
    guard conversations[index].summary["turnActive"]?.bool == true else {
      return .object([
        "conversationId": id, "status": "no_work", "stoppedInboundMessageIds": .array([]),
        "stoppedMessages": .array([]),
      ])
    }
    let dropped = conversations[index].pending.compactMap { $0["messageId"] }
    conversations[index].pending = []
    conversations[index].replyAt = nil
    conversations[index].summary["turnActive"] = false
    conversations[index].summary["status"] = "done"
    return .object([
      "conversationId": id, "status": "requested", "stoppedInboundMessageIds": .array(dropped),
      "stoppedMessages": .array([]),
    ])
  }

  private func conversationIndex(_ arguments: JSONObject) throws -> Int {
    guard let index = conversations.firstIndex(where: { $0.id == arguments.text("conversationId") }) else {
      throw DemoToolError("Conversation not found.")
    }
    return index
  }

  private func messageText(_ arguments: JSONObject) throws -> String {
    guard let message = arguments.text("message") else { throw DemoToolError("The message is empty.") }
    return String(message.prefix(32_000))
  }

  /// Junior titles a new Conversation from its first message.
  private func title(for message: String) -> String {
    let line = message.split(whereSeparator: \.isNewline).first.map(String.init) ?? message
    return line.count > 60 ? "\(line.prefix(59))…" : line
  }

  // MARK: Inbox items and Automations

  private func searchInboxItems(_ arguments: JSONObject) -> JSONValue {
    let words = arguments.text("q")?.lowercased()
    let conversationId = arguments.text("conversationId")
    let limit = min(max(arguments.integer("limit") ?? 20, 1), 50)
    let items = inboxItems.filter { item in
      guard item["status"]?.string == "open" else { return false }
      if let words {
        let text = "\(item["title"]?.string ?? "")\n\(item["body"]?.string ?? "")"
        guard text.lowercased().contains(words) else { return false }
      }
      if let conversationId {
        guard item["conversationIds"]?.array?.contains(.string(conversationId)) == true else { return false }
      }
      return true
    }
    .sorted { parsedDate($0["updatedAt"]) > parsedDate($1["updatedAt"]) }
    return .object([
      "items": .array(items.prefix(limit).map { JSONValue.object($0) }), "truncated": .bool(items.count > limit),
    ])
  }

  /// `attention`: blocked, unable to run, or a problem in the last run.
  private func searchAutomations(_ arguments: JSONObject) -> JSONValue {
    let query = arguments.text("q")?.lowercased()
    let scope = arguments.text("scope") ?? "all"
    let state = arguments.text("state") ?? "all"
    let skill = arguments.text("skill")
    let matches = automations.compactMap { $0["automation"]?.object }.filter { automation in
      let status = automation["status"]?.string ?? ""
      let task = automation["task"]?.object ?? [:]
      if let query {
        let fields = [automation["title"], task["instruction"], task["skill"], task["context"]]
        let text = fields.compactMap { $0?.string }.joined(separator: "\n").lowercased()
        guard text.contains(query) else { return false }
      }
      if scope == "mine", automation["ownedByYou"]?.bool != true { return false }
      if scope == "attention" {
        let problem = ["blocked", "failed"].contains(automation["lastRunStatus"]?.string ?? "")
        guard status == "blocked" || status == "unavailable" || problem else { return false }
      }
      if state != "all", status != state { return false }
      if let skill, task["skill"]?.string != skill { return false }
      return true
    }
    let pageSize = 20
    let page = max(arguments.integer("page") ?? 1, 1)
    let rows = matches.dropFirst((page - 1) * pageSize).prefix(pageSize)
    return .object([
      "automations": .array(rows.map { JSONValue.object($0) }), "total": .number(Double(matches.count)),
    ])
  }

  // MARK: Helpers

  private func cursor(_ seq: Int) -> JSONValue { .string("demo.\(seq)") }

  private func cursorSeq(_ cursor: String) -> Int? {
    cursor.hasPrefix("demo.") ? Int(cursor.dropFirst(5)) : nil
  }

  private func timestamp(_ date: Date) -> JSONValue { .string(demoTimestamp(date)) }
}

struct DemoToolError: Error {
  let message: String
  init(_ message: String) { self.message = message }
}

typealias JSONObject = [String: JSONValue]

/// One Conversation of the demo: the fields that `getConversation` returns,
/// whether the viewer's feed lists it, and when its canned reply comes.
struct DemoConversation {
  var summary: JSONObject
  var brief: JSONValue?
  var messages: [JSONObject]
  var pending: [JSONValue]
  var authorization: JSONValue?
  var listed: Bool
  var replyAt: Date?

  var id: String { summary["conversationId"]?.string ?? "" }
  var lastSeq: Int { messages.last.map(messageSeq) ?? -1 }
  var lastSeenAt: Date { parsedDate(summary["lastSeenAt"]) }

  /// Titles and Briefs, as the real search reads them.
  var searchText: String {
    [summary["title"]?.string, brief?["summary"]?.string].compactMap { $0 }.joined(separator: "\n").lowercased()
  }

  /// The `getConversation` fields without the cursor and messages.
  var state: JSONObject {
    var state: JSONObject = ["conversation": .object(summary), "pendingMessages": .array(pending)]
    state["brief"] = brief
    state["authorization"] = authorization
    return state
  }
}

func messageSeq(_ message: JSONObject) -> Int { Int(message["seq"]?.number ?? -1) }

func parsedDate(_ value: JSONValue?) -> Date { value?.string.flatMap(Date.junior) ?? .distantPast }

/// ISO 8601 with milliseconds, as Junior writes times.
func demoTimestamp(_ date: Date) -> String {
  date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
}

extension JSONValue {
  var object: [String: JSONValue]? {
    if case .object(let value) = self { return value }
    return nil
  }

  var bool: Bool? {
    if case .bool(let value) = self { return value }
    return nil
  }

  var number: Double? {
    if case .number(let value) = self { return value }
    return nil
  }
}

extension [String: JSONValue] {
  /// A trimmed string argument, or nil when it is missing or empty.
  func text(_ key: String) -> String? {
    let value = self[key]?.string?.trimmingCharacters(in: .whitespacesAndNewlines)
    return value?.isEmpty == false ? value : nil
  }

  func flag(_ key: String) -> Bool? { self[key]?.bool }

  func integer(_ key: String) -> Int? { self[key]?.number.map { Int($0) } }

  /// A key with a value other than null.
  func has(_ key: String) -> Bool {
    if case .some(.null) = self[key] { return false }
    return self[key] != nil
  }
}
