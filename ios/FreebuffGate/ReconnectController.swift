import Foundation
import Network

/// Serializes connect/refresh work so only one operation is in flight. The
/// controller drives all access from its serial queue; keeping the gate as a
/// separate, dependency-free type lets the mutual-exclusion rule be tested
/// without a network or a live Keychain.
final class ConnectGate {
    private var inFlight = false

    /// Returns true exactly when the caller now owns the gate and must call
    /// `end()` when the operation completes.
    func tryBegin() -> Bool {
        if inFlight { return false }
        inFlight = true
        return true
    }

    func end() {
        inFlight = false
    }

    var isInFlight: Bool { inFlight }
}

class ReconnectController {
    typealias Listener = (ConnectionState, String, PairingSession?) -> Void

    private let sessionStore: SecureSessionStore
    private let listener: Listener
    private let queue = DispatchQueue(label: "com.freebuff.gate.reconnect")
    private let monitor: NWPathMonitor
    private let gate = ConnectGate()

    private var manualDisconnect = false
    private var retryAttempt = 0
    private var started = false
    private var pendingConnect: DispatchWorkItem?
    private var refreshTask: Task<Void, Never>?
    private var operationGeneration = 0
    private var connectRequested = false

    init(sessionStore: SecureSessionStore, listener: @escaping Listener) {
        self.sessionStore = sessionStore
        self.listener = listener
        self.monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            if path.status == .satisfied {
                self.scheduleConnect(immediate: true)
            } else if !self.manualDisconnect {
                self.emit(.offline, "Network unavailable", self.sessionStore.load())
            }
        }
    }

    func start() {
        queue.async { [weak self] in
            guard let self, !self.started else { return }
            self.started = true
            self.manualDisconnect = false
            self.monitor.start(queue: self.queue)
            if self.gate.isInFlight {
                self.connectRequested = true
            } else {
                self.scheduleConnect(immediate: true)
            }
        }
    }

    func onResume() {
        queue.async { [weak self] in
            guard let self else { return }
            guard self.started else {
                self.started = true
                self.manualDisconnect = false
                self.monitor.start(queue: self.queue)
                if self.gate.isInFlight {
                    self.connectRequested = true
                } else {
                    self.scheduleConnect(immediate: true)
                }
                return
            }
            guard !self.manualDisconnect else { return }
            guard !self.gate.isInFlight else {
                self.connectRequested = true
                return
            }
            // Skip a redundant refresh while the stored access token is still
            // valid: rotating it here races the web-session exchange that the
            // running WebView just performed (surfaced as a spurious 401).
            if let stored = self.sessionStore.load(),
               Self.isTokenFresh(expiresAt: stored.accessTokenExpiresAt) {
                return
            }
            self.scheduleConnect(immediate: true)
        }
    }

    func disconnect(clearSession: Bool) {
        queue.async { [weak self] in
            guard let self else { return }
            self.operationGeneration += 1
            self.connectRequested = false
            self.manualDisconnect = true
            self.pendingConnect?.cancel()
            self.pendingConnect = nil
            self.refreshTask?.cancel()
            self.refreshTask = nil
            if clearSession { self.sessionStore.clear() }
            self.emit(
                clearSession ? .unpaired : .disconnected,
                clearSession ? "Pairing removed" : "Disconnected by user",
                self.sessionStore.load()
            )
        }
    }

    func reconnect() {
        queue.async { [weak self] in
            guard let self else { return }
            self.operationGeneration += 1
            self.manualDisconnect = false
            self.retryAttempt = 0
            if self.gate.isInFlight {
                self.connectRequested = true
            } else {
                self.scheduleConnect(immediate: true, force: true)
            }
        }
    }

    func close() {
        queue.async { [weak self] in
            guard let self else { return }
            self.operationGeneration += 1
            self.connectRequested = false
            self.monitor.cancel()
            self.pendingConnect?.cancel()
            self.pendingConnect = nil
            self.refreshTask?.cancel()
            self.refreshTask = nil
            self.started = false
        }
    }

    private func scheduleConnect(immediate: Bool, force: Bool = false) {
        if manualDisconnect || !started { return }
        if !force, gate.isInFlight { return }
        pendingConnect?.cancel()
        let delay = immediate ? 0.0 : retryDelayMs()
        let work = DispatchWorkItem { [weak self] in self?.connectOnce() }
        pendingConnect = work
        queue.asyncAfter(deadline: .now() + delay / 1000.0, execute: work)
    }

    private func connectOnce() {
        if manualDisconnect { return }
        guard gate.tryBegin() else { return }
        connectRequested = false
        guard let stored = sessionStore.load() else {
            gate.end()
            emit(.unpaired, "Scan a pairing QR code", nil)
            return
        }
        let generation = operationGeneration
        let reconnecting = retryAttempt > 0
        emit(
            reconnecting ? .reconnecting : .connecting,
            reconnecting ? "Retrying gateway connection" : "Connecting to gateway",
            stored
        )
        Task { [weak self] in
            guard let self else { return }
            let result: Result<PairingSession, Error>
            do {
                let refreshed = try await PairingApi(rawBaseUrl: stored.gatewayBaseUrl).refresh(session: stored)
                result = .success(refreshed)
            } catch {
                result = .failure(error)
            }
            self.queue.async {
                // Release before handling the result. Retry scheduling must
                // retain its backoff, while an explicit reconnect received
                // during this request should run immediately afterward.
                self.gate.end()
                let reconnectWasRequested = self.connectRequested
                self.connectRequested = false

                // Disconnect/reconnect invalidates this response. Never let a
                // stale refresh restore a cleared session or emit connected.
                guard Self.isCurrentOperation(
                    generation: generation,
                    currentGeneration: self.operationGeneration,
                    manuallyDisconnected: self.manualDisconnect
                ) else {
                    if reconnectWasRequested && !self.manualDisconnect {
                        self.scheduleConnect(immediate: true)
                    }
                    return
                }
                switch result {
                case .success(let refreshed):
                    do {
                        try self.sessionStore.save(session: refreshed)
                    } catch {
                        self.scheduleRetry(stored, detail: "Waiting for network")
                        return
                    }
                    self.retryAttempt = 0
                    self.scheduleSessionRefresh(session: refreshed)
                    self.emit(.connected, "Gateway authenticated", refreshed)
                case .failure(let error as PairingError):
                    switch error {
                    case .http(let status, _) where status == 401 || status == 403:
                        self.sessionStore.clear()
                        self.refreshTask?.cancel()
                        self.refreshTask = nil
                        self.emit(.pairingRequired, "Pairing expired or revoked", nil)
                    default:
                        self.scheduleRetry(stored, detail: error.localizedDescription)
                    }
                case .failure:
                    self.scheduleRetry(stored, detail: "Waiting for network")
                }
            }
        }
    }

    private func scheduleSessionRefresh(session: PairingSession) {
        refreshTask?.cancel()
        let expiresAt = ISO8601DateFormatter().date(from: session.accessTokenExpiresAt)?.timeIntervalSince1970
            ?? (Date().timeIntervalSince1970 + 10 * 60)
        let now = Date().timeIntervalSince1970
        let delay = max(30, min(600, expiresAt - now - 60))
        refreshTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled, let self else { return }
            self.queue.async {
                self.refreshTask = nil
                if !self.manualDisconnect {
                    self.connectOnce()
                }
            }
        }
    }

    private func scheduleRetry(_ session: PairingSession, detail: String) {
        retryAttempt += 1
        emit(.reconnecting, detail, session)
        scheduleConnect(immediate: false, force: true)
    }

    private func retryDelayMs() -> Double {
        Self.backoffBaseMs(attempt: retryAttempt) * Double.random(in: 0.8...1.2)
    }

    private func emit(_ state: ConnectionState, _ detail: String, _ session: PairingSession?) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.listener(state, detail, session)
        }
    }

    // MARK: - Testable rules

    static func isCurrentOperation(
        generation: Int,
        currentGeneration: Int,
        manuallyDisconnected: Bool
    ) -> Bool {
        generation == currentGeneration && !manuallyDisconnected
    }

    /// Jittered exponential backoff base: 1s doubling to a 60s cap.
    static func backoffBaseMs(attempt: Int) -> Double {
        let exponent = min(max(attempt - 1, 0), 6)
        return min(60_000.0, 1_000.0 * pow(2.0, Double(exponent)))
    }

    /// True while the access token is still valid for at least `minimumValidity`
    /// seconds, so a lifecycle resume does not rotate a fresh token.
    static func isTokenFresh(
        expiresAt: String,
        now: Date = Date(),
        minimumValidity: TimeInterval = 120
    ) -> Bool {
        guard let expiry = ISO8601DateFormatter().date(from: expiresAt) else { return false }
        return expiry.timeIntervalSince(now) > minimumValidity
    }
}
