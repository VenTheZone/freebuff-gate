import XCTest
@testable import FreebuffGate

final class PairingModelsTests: XCTestCase {

    func testPairingPayloadReadsFragmentTokenWithoutQueryCredential() throws {
        let payload = try PairingPayload.parse(
            raw: "https://mobile.example.test/pair#pairingId=p_test&token=one-time-token"
        )
        XCTAssertEqual(payload.baseUrl, "https://mobile.example.test")
        XCTAssertEqual(payload.pairingId, "p_test")
        XCTAssertEqual(payload.token, "one-time-token")
    }

    func testPairingPayloadRejectsNonHttpsEndpoint() {
        XCTAssertThrowsError(
            try PairingPayload.parse(raw: "http://mobile.example.test/pair#pairingId=p&token=t")
        ) { error in
            XCTAssertTrue(error.localizedDescription.contains("HTTPS"))
        }
    }

    func testPairingPayloadRejectsMissingFragment() {
        XCTAssertThrowsError(
            try PairingPayload.parse(raw: "https://mobile.example.test/pair")
        )
    }

    func testPairingPayloadRejectsIncompleteFragment() {
        XCTAssertThrowsError(
            try PairingPayload.parse(raw: "https://mobile.example.test/pair#pairingId=p")
        )
    }

    func testNormalizeBaseUrlLowercasesHostAndDropsPath() {
        let normalized = PairingApi.normalizeBaseUrl("https://Relay.Example.Test:8443/pair#x")
        XCTAssertEqual(normalized, "https://relay.example.test:8443")
    }

    func testSessionFromGatewayResponse() throws {
        let json: [String: Any] = [
            "deviceId": "d_1",
            "deviceToken": "refresh-token",
            "accessToken": "access-token",
            "accessTokenExpiresAt": "2026-01-01T00:00:00Z",
            "deviceExpiresAt": "2027-01-01T00:00:00Z",
            "relayUrl": "wss://relay.example.test:8443",
            "uiUrl": "https://relay.example.test:8443",
        ]
        let session = try PairingSession.fromGatewayResponse(
            baseUrl: "https://relay.example.test:8443",
            json: json
        )
        XCTAssertEqual(session.deviceId, "d_1")
        XCTAssertEqual(session.relayUrl, "wss://relay.example.test:8443")
        XCTAssertEqual(session.uiUrl, "https://relay.example.test:8443")
    }

    func testSessionFromGatewayResponseKeepsDeviceTokenOnRefresh() throws {
        let json: [String: Any] = [
            "deviceId": "d_1",
            "deviceToken": "rotated-refresh-token",
            "accessToken": "access-token",
            "accessTokenExpiresAt": "2026-01-01T00:00:00Z",
            "deviceExpiresAt": "2027-01-01T00:00:00Z",
        ]
        let session = try PairingSession.fromGatewayResponse(
            baseUrl: "https://relay.example.test",
            json: json,
            deviceTokenOverride: "original-device-token",
            deviceExpiresAtOverride: "2027-02-01T00:00:00Z"
        )
        XCTAssertEqual(session.deviceToken, "original-device-token")
        XCTAssertEqual(session.deviceExpiresAt, "2027-02-01T00:00:00Z")
    }

    func testSessionFromGatewayResponseRejectsMissingFields() {
        XCTAssertThrowsError(
            try PairingSession.fromGatewayResponse(baseUrl: "https://relay.example.test", json: [:])
        )
    }
}
