import Foundation

/// Holds the APNs device token and the active pairing session, and uploads
/// the token to the relay whenever both are available so the relay can push
/// turn-finished notifications to this device (background delivery).
final class PushTokenStore {
    static let shared = PushTokenStore()

    private let queue = DispatchQueue(label: "com.freebuff.gate.push-token")
    private var deviceToken: String?
    private var session: PairingSession?

    private init() {}

    func setDeviceToken(_ token: String) {
        queue.sync {
            deviceToken = token.isEmpty ? nil : token
        }
        uploadIfPossible()
    }

    func setSession(_ session: PairingSession?) {
        queue.sync {
            self.session = session
        }
        uploadIfPossible()
    }

    func uploadIfPossible() {
        let pair = queue.sync { () -> (token: String, session: PairingSession)? in
            guard let token = deviceToken, let session = session else { return nil }
            return (token, session)
        }
        guard let pair else { return }
        Task {
            do {
                try await PairingApi(rawBaseUrl: pair.session.gatewayBaseUrl)
                    .uploadPushToken(session: pair.session, token: pair.token)
            } catch {
                // Best effort: retried on the next connect (setSession is
                // called again from the reconnect listener).
            }
        }
    }
}
