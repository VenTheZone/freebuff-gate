import XCTest
@testable import FreebuffGate

final class PushTokenStoreTests: XCTestCase {

    private func makeSession(deviceId: String = "d_test", accessToken: String = "access-token", expiresAt: String = "2027-01-01T00:00:00Z") -> PairingSession {
        PairingSession(
            gatewayBaseUrl: "https://relay.example.test",
            deviceId: deviceId,
            deviceToken: "device-token",
            accessToken: accessToken,
            accessTokenExpiresAt: expiresAt,
            deviceExpiresAt: "2027-01-01T00:00:00Z",
            relayUrl: "wss://relay.example.test",
            uiUrl: "https://relay.example.test"
        )
    }

    func testUploadsOnceBothTokenAndSessionArePresent() async {
        let uploaded = expectation(description: "token uploaded")
        var seen: (PairingSession, String)?
        let store = PushTokenStore(
            upload: { session, token in
                seen = (session, token)
                uploaded.fulfill()
            },
            erase: { _ in }
        )

        store.setDeviceToken("apns-token")
        store.setSession(makeSession())

        await fulfillment(of: [uploaded], timeout: 2)
        XCTAssertEqual(seen?.1, "apns-token")
        XCTAssertEqual(seen?.0.deviceId, "d_test")
    }

    func testDoesNotUploadWithOnlyOneHalf() async {
        let upload = expectation(description: "no upload")
        upload.isInverted = true
        let store = PushTokenStore(
            upload: { _, _ in upload.fulfill() },
            erase: { _ in }
        )

        store.setDeviceToken("apns-token")
        store.setSession(nil)

        await fulfillment(of: [upload], timeout: 0.3)
    }

    func testUnregisterDeletesRelayTokenExactlyOnce() async {
        let erased = expectation(description: "token deleted")
        erased.expectedFulfillmentCount = 1
        erased.assertForOverFulfill = true
        let store = PushTokenStore(
            upload: { _, _ in },
            erase: { _ in erased.fulfill() }
        )

        store.setDeviceToken("apns-token")
        store.setSession(makeSession())

        store.unregister()
        store.unregister()

        await fulfillment(of: [erased], timeout: 2)
    }

    func testUnregisterWithoutDeviceTokenSkipsRelayCall() async {
        let erased = expectation(description: "no relay call")
        erased.isInverted = true
        let store = PushTokenStore(
            upload: { _, _ in },
            erase: { _ in erased.fulfill() }
        )

        store.setSession(makeSession())
        store.unregister()

        await fulfillment(of: [erased], timeout: 0.3)
    }

    func testUploadDoesNotReoccurAfterUnregisterWithoutNewSession() async {
        let uploaded = expectation(description: "single upload")
        uploaded.expectedFulfillmentCount = 1
        uploaded.assertForOverFulfill = true
        let store = PushTokenStore(
            upload: { _, _ in uploaded.fulfill() },
            erase: { _ in }
        )

        store.setDeviceToken("apns-token")
        store.setSession(makeSession())
        await fulfillment(of: [uploaded], timeout: 2)

        store.unregister()
        store.uploadIfPossible()

        try? await Task.sleep(nanoseconds: 200_000_000)
        await fulfillment(of: [uploaded], timeout: 0.3)
    }

    func testPairingAgainUploadsRetainedDeviceToken() async {
        let firstUpload = expectation(description: "first session token uploaded")
        let secondUpload = expectation(description: "new session token uploaded")
        let erased = expectation(description: "old relay registration erased")
        let store = PushTokenStore(
            upload: { session, token in
                XCTAssertEqual(token, "apns-token")
                if session.deviceId == "d_test" {
                    firstUpload.fulfill()
                } else {
                    secondUpload.fulfill()
                }
            },
            erase: { _ in erased.fulfill() }
        )

        store.setDeviceToken("apns-token")
        store.setSession(makeSession())
        await fulfillment(of: [firstUpload], timeout: 2)
        store.unregister()
        await fulfillment(of: [erased], timeout: 2)

        store.setSession(makeSession(deviceId: "d_new"))
        await fulfillment(of: [secondUpload], timeout: 2)
    }

    func testUnregisterWaitsForInFlightUpload() async {
        let uploadStarted = expectation(description: "upload started")
        let deleted = expectation(description: "token deleted after upload")
        let order = OrderRecorder()
        let store = PushTokenStore(
            upload: { _, _ in
                uploadStarted.fulfill()
                try? await Task.sleep(nanoseconds: 100_000_000)
                order.append("upload")
            },
            erase: { _ in
                order.append("delete")
                deleted.fulfill()
            }
        )

        store.setDeviceToken("apns-token")
        store.setSession(makeSession())
        await fulfillment(of: [uploadStarted], timeout: 2)
        store.unregister()
        await fulfillment(of: [deleted], timeout: 2)

        XCTAssertEqual(order.values, ["upload", "delete"])
    }

    func testExpiredAccessTokenIsRefreshedAndRefreshedSessionIsDeleted() async {
        let original = makeSession(
            accessToken: "expired-token",
            expiresAt: "2020-01-01T00:00:00Z"
        )
        let refreshed = makeSession(
            accessToken: "fresh-token",
            expiresAt: "2027-01-01T00:00:00Z"
        )
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        var refreshInput: PairingSession?
        var deleteInput: PairingSession?

        await PushTokenStore.eraseSession(
            original,
            now: now,
            refresh: { session in
                refreshInput = session
                return refreshed
            },
            delete: { session in
                deleteInput = session
            }
        )

        XCTAssertEqual(refreshInput, original)
        XCTAssertEqual(deleteInput, refreshed)
    }

    func testFreshAccessTokenDeletesWithoutRefresh() async {
        let fresh = makeSession(
            accessToken: "fresh-token",
            expiresAt: "2023-11-14T22:14:30Z"
        )
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        var refreshCalled = false
        var deleteInput: PairingSession?

        await PushTokenStore.eraseSession(
            fresh,
            now: now,
            refresh: { _ in
                refreshCalled = true
                return makeSession(accessToken: "unexpected")
            },
            delete: { session in deleteInput = session }
        )

        XCTAssertFalse(refreshCalled)
        XCTAssertEqual(deleteInput, fresh)
    }

    func testRefreshFailureStillAttemptsBestEffortDelete() async {
        let expired = makeSession(accessToken: "expired-token", expiresAt: "2020-01-01T00:00:00Z")
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        var deleteInput: PairingSession?

        await PushTokenStore.eraseSession(
            expired,
            now: now,
            refresh: { _ in throw PairingError.http(status: 401, message: "revoked") },
            delete: { session in deleteInput = session }
        )

        XCTAssertEqual(deleteInput, expired)
    }

    private final class OrderRecorder {
        private let lock = NSLock()
        private var entries: [String] = []

        var values: [String] {
            lock.lock()
            defer { lock.unlock() }
            return entries
        }

        func append(_ value: String) {
            lock.lock()
            defer { lock.unlock() }
            entries.append(value)
        }
    }
}
