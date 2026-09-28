import XCTest
@testable import FreebuffGate

final class WebSessionCredentialTests: XCTestCase {
    func testAcceptsCookieWithValidFutureExpiry() throws {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let credential = try WebSessionCredential.parse(
            cookieHeader: "__Host-freebuff_session=secret; Path=/; Max-Age=604800; Secure; HttpOnly; SameSite=Strict",
            expiresAt: "2023-11-21T22:13:20.000Z",
            now: now
        )
        XCTAssertEqual(credential.cookieHeader, "__Host-freebuff_session=secret; Path=/; Max-Age=604800; Secure; HttpOnly; SameSite=Strict")
        XCTAssertEqual(credential.expiresAt.timeIntervalSince1970, 1_700_604_800, accuracy: 0.001)
    }

    func testAcceptsExpiryWithoutFractionalSeconds() throws {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        XCTAssertNoThrow(try WebSessionCredential.parse(
            cookieHeader: "session=value; Secure",
            expiresAt: "2023-11-15T00:00:01Z",
            now: now
        ))
    }

    func testRejectsMissingCookieOrExpiry() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        XCTAssertThrowsError(try WebSessionCredential.parse(cookieHeader: nil, expiresAt: "2023-11-21T22:13:20Z", now: now))
        XCTAssertThrowsError(try WebSessionCredential.parse(cookieHeader: "session=value", expiresAt: nil, now: now))
        XCTAssertThrowsError(try WebSessionCredential.parse(cookieHeader: "session=value", expiresAt: "invalid", now: now))
        XCTAssertThrowsError(try WebSessionCredential.parse(cookieHeader: "session=value", expiresAt: "2023-11-14T22:13:20Z", now: now))
    }
}
