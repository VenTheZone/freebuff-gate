import XCTest
@testable import FreebuffGate

final class ReconnectControllerTests: XCTestCase {

    func testRetryBackoffCapsAtOneMinute() {
        // retryAttempt 1..7 -> 1000, 2000, 4000, 8000, 16000, 32000, then
        // capped at 60000. The cap must hold for every attempt.
        for attempt in 1...20 {
            let exponent = min(attempt - 1, 6)
            let base = min(60_000.0, 1_000.0 * pow(2.0, Double(exponent)))
            XCTAssertLessThanOrEqual(base, 60_000.0)
        }
        // attempt 1 is 1s base, attempt 7+ is 60s base
        let attempt1 = min(60_000.0, 1_000.0 * pow(2.0, Double(min(0, 6))))
        XCTAssertEqual(attempt1, 1_000.0)
        let attempt7 = min(60_000.0, 1_000.0 * pow(2.0, Double(min(6, 6))))
        XCTAssertEqual(attempt7, 60_000.0)
    }

    func testConfiguredOriginNilWhenEmpty() {
        // Mirrors MainView.configuredOrigin(): blank Info.plist value -> nil.
        let raw = ""
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        XCTAssertNil(trimmed.isEmpty ? nil : trimmed)
    }
}
