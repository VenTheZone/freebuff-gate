import XCTest
@testable import FreebuffGate

final class WebSessionLoadGuardTests: XCTestCase {

    func testSuppressesConcurrentAndDuplicateLoads() {
        let loadGuard = WebSessionLoadGuard()
        let key = "d_1:https://relay.example.test"

        XCTAssertTrue(loadGuard.shouldLoad(key: key))
        loadGuard.begin(key: key)
        XCTAssertFalse(loadGuard.shouldLoad(key: key))
        XCTAssertFalse(loadGuard.shouldLoad(key: "d_2:https://relay.example.test"))
        loadGuard.finish(key: key, cookieExpiresAt: .distantFuture)
        XCTAssertFalse(loadGuard.shouldLoad(key: key))
    }

    func testChangedSessionStartsANewLoad() {
        let loadGuard = WebSessionLoadGuard()
        loadGuard.begin(key: "d_1:https://relay.example.test")
        loadGuard.finish(key: "d_1:https://relay.example.test", cookieExpiresAt: .distantFuture)

        XCTAssertTrue(loadGuard.shouldLoad(key: "d_2:https://relay.example.test"))
        XCTAssertTrue(loadGuard.shouldLoad(key: "d_1:https://other.example.test"))
    }

    func testFailureAllowsRetryOnlyWhenRequested() {
        let loadGuard = WebSessionLoadGuard()
        let key = "d_1:https://relay.example.test"
        loadGuard.begin(key: key)
        loadGuard.fail(key: key)

        XCTAssertFalse(loadGuard.shouldLoad(key: key))
        XCTAssertTrue(loadGuard.shouldLoad(key: "d_2:https://relay.example.test"))
        loadGuard.retry(key: key)
        XCTAssertTrue(loadGuard.shouldLoad(key: key))
    }

    func testInvalidateAllowsReloadAfterRevocation() {
        let loadGuard = WebSessionLoadGuard()
        let key = "d_1:https://relay.example.test"
        loadGuard.begin(key: key)
        loadGuard.finish(key: key, cookieExpiresAt: .distantFuture)
        XCTAssertFalse(loadGuard.shouldLoad(key: key))

        loadGuard.invalidate()
        XCTAssertTrue(loadGuard.shouldLoad(key: key))
    }

    func testInvalidatingInFlightKeyAllowsReplacementLoad() {
        let loadGuard = WebSessionLoadGuard()
        loadGuard.begin(key: "d_1:https://relay.example.test")
        loadGuard.invalidate()

        let replacement = "d_2:https://relay.example.test"
        XCTAssertTrue(loadGuard.shouldLoad(key: replacement))
        loadGuard.begin(key: replacement)
        loadGuard.finish(key: replacement, cookieExpiresAt: .distantFuture)
        loadGuard.finish(key: "d_1:https://relay.example.test", cookieExpiresAt: .distantFuture)

        XCTAssertFalse(loadGuard.shouldLoad(key: replacement))
        XCTAssertTrue(loadGuard.shouldLoad(key: "d_1:https://relay.example.test"))
    }

    func testExpiredCookieEnablesRefreshButFreshCookieDoesNot() {
        let loadGuard = WebSessionLoadGuard()
        let key = "d_1:https://relay.example.test"
        let now = Date(timeIntervalSince1970: 1_700_000_000)

        loadGuard.begin(key: key)
        loadGuard.finish(key: key, cookieExpiresAt: now.addingTimeInterval(7 * 24 * 60 * 60))
        loadGuard.refreshIfCookieExpiresSoon(key: key, now: now)
        XCTAssertFalse(loadGuard.shouldLoad(key: key))

        loadGuard.refreshIfCookieExpiresSoon(key: key, now: now.addingTimeInterval(7 * 24 * 60 * 60))
        XCTAssertTrue(loadGuard.shouldLoad(key: key))
    }

    func testSessionKeyIgnoresAccessTokenRotation() throws {
        let url = try XCTUnwrap(URL(string: "https://relay.example.test"))
        let first = makeSession(deviceId: "d_1", accessToken: "token-a")
        let rotated = makeSession(deviceId: "d_1", accessToken: "token-b")
        let otherDevice = makeSession(deviceId: "d_2", accessToken: "token-a")

        XCTAssertEqual(WebSessionKey.make(session: first, url: url), WebSessionKey.make(session: rotated, url: url))
        XCTAssertNotEqual(WebSessionKey.make(session: first, url: url), WebSessionKey.make(session: otherDevice, url: url))
        XCTAssertNotEqual(
            WebSessionKey.make(session: first, url: url),
            WebSessionKey.make(session: first, url: try XCTUnwrap(URL(string: "https://other.example.test")))
        )
    }

    private func makeSession(deviceId: String, accessToken: String) -> PairingSession {
        PairingSession(
            gatewayBaseUrl: "https://relay.example.test",
            deviceId: deviceId,
            deviceToken: "device-token",
            accessToken: accessToken,
            accessTokenExpiresAt: "2027-01-01T00:00:00Z",
            deviceExpiresAt: "2027-01-01T00:00:00Z",
            relayUrl: "wss://relay.example.test",
            uiUrl: "https://relay.example.test"
        )
    }
}
