import XCTest
@testable import FreebuffGate

final class OriginConfigTests: XCTestCase {

    func testBlankOrMissingConfigurationYieldsNil() throws {
        XCTAssertNil(try OriginConfig.configuredOrigin(nil))
        XCTAssertNil(try OriginConfig.configuredOrigin(""))
        XCTAssertNil(try OriginConfig.configuredOrigin("   "))
    }

    func testValidHttpsOriginIsNormalized() throws {
        XCTAssertEqual(
            try OriginConfig.configuredOrigin("https://Relay.Example.Test:8443/path"),
            "https://relay.example.test:8443"
        )
    }

    func testProductionOriginOnlyMatchesItself() throws {
        let configured = try OriginConfig.configuredOrigin("https://relay.example.test")
        XCTAssertEqual(configured, "https://relay.example.test")
        XCTAssertNotEqual(configured, RestrictedWebViewController.originOf("https://relay.example.test:8443/"))
        XCTAssertNotEqual(configured, RestrictedWebViewController.originOf("https://evil.example.test/"))
    }

    func testGenericBuildPinsWebViewToPairingRelayOrigin() throws {
        XCTAssertTrue(try OriginConfig.allowsWebUrl(
            "https://relay.example.test/ui",
            configuredWebOrigin: nil,
            pairingOrigin: "https://relay.example.test"
        ))
        XCTAssertFalse(try OriginConfig.allowsWebUrl(
            "https://evil.example.test/ui",
            configuredWebOrigin: nil,
            pairingOrigin: "https://relay.example.test"
        ))
    }

    func testConfiguredWebOriginOverridesPairingRelayForUi() throws {
        XCTAssertTrue(try OriginConfig.allowsWebUrl(
            "https://ui.example.test/app",
            configuredWebOrigin: "https://UI.Example.Test/path",
            pairingOrigin: "https://relay.example.test"
        ))
        XCTAssertFalse(try OriginConfig.allowsWebUrl(
            "https://relay.example.test/app",
            configuredWebOrigin: "https://ui.example.test",
            pairingOrigin: "https://relay.example.test"
        ))
    }

    func testInsecureCredentialedOrMalformedOriginsAreRejected() {
        for raw in ["http://relay.example.test", "https://user:pass@relay.example.test", "not a url"] {
            XCTAssertThrowsError(try OriginConfig.configuredOrigin(raw))
        }
    }
}
