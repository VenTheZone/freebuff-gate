import XCTest
@testable import FreebuffGate

final class PairingApiNormalizationTests: XCTestCase {

    func testValidHttpsHostIsNormalized() throws {
        XCTAssertEqual(
            try PairingApi.normalizeBaseUrl("https://relay.example.test"),
            "https://relay.example.test"
        )
    }

    func testTrailingSlashAndPathAreDropped() throws {
        XCTAssertEqual(
            try PairingApi.normalizeBaseUrl("https://relay.example.test/pair/"),
            "https://relay.example.test"
        )
    }

    func testPortIsPreservedAndHostLowercased() throws {
        XCTAssertEqual(
            try PairingApi.normalizeBaseUrl("  HTTPS://Relay.Example.Test:8443/  "),
            "https://relay.example.test:8443"
        )
    }

    func testMalformedUrlThrowsInsteadOfCrashing() {
        for raw in ["not a url", "", "   "] {
            XCTAssertThrowsError(try PairingApi.normalizeBaseUrl(raw), "should reject \(raw.debugDescription)")
        }
    }

    func testNonHttpsUrlIsRejected() {
        XCTAssertThrowsError(try PairingApi.normalizeBaseUrl("http://relay.example.test")) { error in
            XCTAssertTrue(error.localizedDescription.contains("HTTPS"))
        }
        XCTAssertThrowsError(try PairingApi.normalizeBaseUrl("wss://relay.example.test"))
    }

    func testCredentialsAreRejected() {
        XCTAssertThrowsError(try PairingApi.normalizeBaseUrl("https://user:pass@relay.example.test")) { error in
            XCTAssertTrue(error.localizedDescription.contains("credentials"))
        }
    }

    func testMissingHostIsRejected() {
        XCTAssertThrowsError(try PairingApi.normalizeBaseUrl("https:///pair"))
    }

    func testInitializerRejectsBadBaseUrlAndAcceptsGoodOne() throws {
        XCTAssertThrowsError(try PairingApi(rawBaseUrl: "http://relay.example.test"))
        XCTAssertThrowsError(try PairingApi(rawBaseUrl: "garbage"))
        let api = try PairingApi(rawBaseUrl: "https://Relay.Example.Test/")
        XCTAssertEqual(api.baseUrl, "https://relay.example.test")
    }
}
