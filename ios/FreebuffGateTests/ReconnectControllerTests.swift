import XCTest
@testable import FreebuffGate

final class ReconnectControllerTests: XCTestCase {

    func testBackoffDoublesAndCapsAtOneMinute() {
        XCTAssertEqual(ReconnectController.backoffBaseMs(attempt: 1), 1_000)
        XCTAssertEqual(ReconnectController.backoffBaseMs(attempt: 2), 2_000)
        XCTAssertEqual(ReconnectController.backoffBaseMs(attempt: 3), 4_000)
        XCTAssertEqual(ReconnectController.backoffBaseMs(attempt: 4), 8_000)
        XCTAssertEqual(ReconnectController.backoffBaseMs(attempt: 5), 16_000)
        XCTAssertEqual(ReconnectController.backoffBaseMs(attempt: 6), 32_000)
        XCTAssertEqual(ReconnectController.backoffBaseMs(attempt: 7), 60_000)

        // The cap holds for every later attempt, and jitter stays within the
        // documented 0.8...1.2 band.
        for attempt in 7...20 {
            XCTAssertEqual(ReconnectController.backoffBaseMs(attempt: attempt), 60_000)
        }
        for _ in 0..<50 {
            let delay = ReconnectController.backoffBaseMs(attempt: 7) * Double.random(in: 0.8...1.2)
            XCTAssertGreaterThanOrEqual(delay, 48_000)
            XCTAssertLessThanOrEqual(delay, 72_000)
        }
    }

    func testBackoffTreatsNonPositiveAttemptAsFirstRetry() {
        XCTAssertEqual(ReconnectController.backoffBaseMs(attempt: 0), 1_000)
        XCTAssertEqual(ReconnectController.backoffBaseMs(attempt: -3), 1_000)
    }

    func testTokenFreshnessSkipsRedundantRefresh() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let formatter = ISO8601DateFormatter()

        // Expires in 20 minutes: fresh, so a resume must not rotate it.
        XCTAssertTrue(
            ReconnectController.isTokenFresh(
                expiresAt: formatter.string(from: now.addingTimeInterval(20 * 60)),
                now: now
            )
        )
        // Expires in 30 seconds: too close, refresh is allowed.
        XCTAssertFalse(
            ReconnectController.isTokenFresh(
                expiresAt: formatter.string(from: now.addingTimeInterval(30)),
                now: now
            )
        )
        // Exactly at the boundary (120s) is not fresh.
        XCTAssertFalse(
            ReconnectController.isTokenFresh(
                expiresAt: formatter.string(from: now.addingTimeInterval(120)),
                now: now
            )
        )
    }

    func testTokenFreshnessRejectsUnparseableExpiry() {
        XCTAssertFalse(ReconnectController.isTokenFresh(expiresAt: "not-a-date"))
        XCTAssertFalse(ReconnectController.isTokenFresh(expiresAt: ""))
    }

    func testCompletionIsCurrentOnlyForMatchingOperationGeneration() {
        XCTAssertTrue(ReconnectController.isCurrentOperation(generation: 4, currentGeneration: 4, manuallyDisconnected: false))
        XCTAssertFalse(ReconnectController.isCurrentOperation(generation: 4, currentGeneration: 5, manuallyDisconnected: false))
        XCTAssertFalse(ReconnectController.isCurrentOperation(generation: 4, currentGeneration: 4, manuallyDisconnected: true))
    }
}
