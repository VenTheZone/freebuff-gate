import Foundation

/// Holds the APNs device token and the active pairing session. Uploads the
/// token to the relay whenever both are available so the relay can push
/// turn-finished notifications, and deletes the relay-side token when the user
/// disconnects or the pairing is revoked.
final class PushTokenStore {
    static let shared = PushTokenStore()

    typealias UploadHandler = (PairingSession, String) async -> Void
    typealias EraseHandler = (PairingSession) async -> Void

    private let queue = DispatchQueue(label: "com.freebuff.gate.push-token")
    private let upload: UploadHandler
    private let erase: EraseHandler

    private var deviceToken: String?
    private var session: PairingSession?
    private var lastSession: PairingSession?
    private var registrationActive = false
    private var sessionGeneration = 0
    private var networkTask: Task<Void, Never>?

    init(
        upload: @escaping UploadHandler = PushTokenStore.uploadToRelay,
        erase: @escaping EraseHandler = PushTokenStore.eraseFromRelay
    ) {
        self.upload = upload
        self.erase = erase
    }

    func setDeviceToken(_ token: String) {
        queue.sync {
            self.deviceToken = token.isEmpty ? nil : token
            self.sessionGeneration += 1
        }
        uploadIfPossible()
    }

    func setSession(_ session: PairingSession?) {
        queue.sync {
            self.sessionGeneration += 1
            self.session = session
            if let session {
                self.lastSession = session
            }
        }
        uploadIfPossible()
    }

    func uploadIfPossible() {
        queue.sync {
            guard let token = self.deviceToken, let session = self.session else { return }
            self.registrationActive = true
            let generation = self.sessionGeneration
            self.enqueueNetworkOperation {
                await self.upload(session, token)
                self.queue.async {
                    guard self.sessionGeneration == generation else { return }
                    if self.session?.deviceId != session.deviceId {
                        self.registrationActive = false
                    }
                }
            }
        }
    }

    /// Best-effort relay cleanup. Only the first call while a relay
    /// registration is active issues a request, so repeated state transitions
    /// do not spam `DELETE /v1/mobile/push-token`. Requests are serialized so a
    /// late upload cannot re-register a token after this delete. The APNs token
    /// remains local so a later pairing can register it again without another
    /// APNs callback.
    func unregister() {
        queue.sync {
            let shouldErase = self.registrationActive
            self.registrationActive = false
            self.sessionGeneration += 1
            self.session = nil
            guard shouldErase, let session = self.lastSession else { return }
            self.enqueueNetworkOperation { await self.erase(session) }
        }
    }

    private func enqueueNetworkOperation(_ operation: @escaping () async -> Void) {
        let previous = networkTask
        networkTask = Task {
            await previous?.value
            await operation()
        }
    }

    private static func uploadToRelay(session: PairingSession, token: String) async {
        guard let api = try? PairingApi(rawBaseUrl: session.gatewayBaseUrl) else { return }
        try? await api.uploadPushToken(session: session, token: token)
    }

    private static func eraseFromRelay(session: PairingSession) async {
        guard let api = try? PairingApi(rawBaseUrl: session.gatewayBaseUrl) else { return }
        await eraseSession(
            session,
            refresh: { try await api.refresh(session: $0) },
            delete: { try? await api.deletePushToken(session: $0) }
        )
    }

    /// Refreshes an expired access token before cleanup. Kept as the production
    /// path and injected at the HTTP boundary so tests verify refresh selection
    /// and which session is actually used for DELETE.
    static func eraseSession(
        _ session: PairingSession,
        now: Date = Date(),
        refresh: (PairingSession) async throws -> PairingSession,
        delete: (PairingSession) async -> Void
    ) async {
        var deleteSession = session
        if !ReconnectController.isTokenFresh(
            expiresAt: session.accessTokenExpiresAt,
            now: now,
            minimumValidity: 30
        ) {
            do {
                deleteSession = try await refresh(session)
            } catch {
                // An expired or revoked device may no longer be cleanable with
                // its access token; the relay will reject the best-effort DELETE.
            }
        }
        await delete(deleteSession)
    }
}
