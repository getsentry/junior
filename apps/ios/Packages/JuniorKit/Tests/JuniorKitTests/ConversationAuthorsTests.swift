import Foundation
import Testing

@testable import JuniorKit

struct ConversationAuthorsTests {
  @Test func namesEachPhotoAsMessagesNameTheAuthor() throws {
    let json = #"""
      {"authors":{
        "i1":{"avatarUrl":"/api/people/avatars/i1?v=a","email":"jordan@example.com","fullName":"Jordan Blake"},
        "i2":{"avatarUrl":"/api/people/avatars/i2?v=b","slackUserName":"riley"},
        "i3":{"email":"casey@example.com"}
      },"events":[]}
      """#
    let authors = try JSONDecoder.junior.decode(ConversationAuthors.self, from: Data(json.utf8))
    #expect(authors.photos == ["Jordan Blake": "/api/people/avatars/i1?v=a", "riley": "/api/people/avatars/i2?v=b"])
  }

  @Test func readsAConversationWithNoAuthors() throws {
    let authors = try JSONDecoder.junior.decode(ConversationAuthors.self, from: Data(#"{"events":[]}"#.utf8))
    #expect(authors.photos.isEmpty)
  }
}

// In the serialized `MCPClientTests` suite, because `StubServer` holds one
// handler at a time.
extension MCPClientTests {
  @Test func sendsTheSessionOnlyForADashboardAPIPhoto() async throws {
    let session = StubServer.serve { _ in (200, "photo") }
    let store = MemorySessionStore(SessionCredentials(server: server, token: "jr_ses_t1", expiresAt: .distantFuture))
    let client = DashboardClient(server: server, store: store, session: session)
    #expect(try await client.data("/api/people/avatars/i1?v=a") == Data("photo".utf8))
    let request = try #require(StubServer.requests.first)
    #expect(request.url.absoluteString == "https://junior.example.com/api/people/avatars/i1?v=a")
    #expect(request.headers["Authorization"] == "Bearer jr_ses_t1")
    for path in ["https://evil.example.com/api/people/avatars/i1", "//evil.example.com/api/x"] {
      await #expect(throws: JuniorAPIError.self) { try await client.data(path) }
    }
    #expect(StubServer.requests.count == 1)
  }
}
