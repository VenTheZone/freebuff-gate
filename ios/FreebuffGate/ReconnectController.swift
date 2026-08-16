import Foundation
import Network

class ReconnectController {
    typealias Listener = (ConnectionState, String, PairingSession?) -> Void

    private let sessionStore: SecureSessionStore
    private let listener: Listener
    private let queue = DispatchQueue(label: "com.freebuff.gate.reconnect")
    private let monitor: NWPathMonitor

    private var manualDisconnect = false
    private var retryAttempt = 0
    private var started = false
    private var pendingConnect: DispatchWorkItem?
    private var refreshTask: Task<Void, Never>?

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
        if started { return }
        started = true
        manualDisconnect = false
        monitor.start(queue: queue)
        scheduleConnect(immediate: true)
    }

    func onResume() {
        if !started { start() } else if !manualDisconnect {
            scheduleConnect(immediate: true)
        }
    }

    func disconnect(clearSession: Bool) {
        manualDisconnect = true
        pendingConnect?.cancel()
        pendingConnect = nil
        refreshTask?.cancel()
        refreshTask = nil
        if clearSession { sessionStore.clear() }
        emit(
            clearSession ? .unpaired : .disconnected,
            clearSession ? "Pairing removed" : "Disconnected by user",
            sessionStore.load()
        )
    }

    func reconnect() {
        manualDisconnect = false
        retryAttempt = 0
        scheduleConnect(immediate: true)
    }

    func close() {
        monitor.cancel()
        pendingConnect?.cancel()
        refreshTask?.cancel()
        started = false
    }

    private func scheduleConnect(immediate: Bool) {
        if manualDisconnect || !started { return }
        pendingConnect?.cancel()
        let delay = immediate ? 0.0 : retryDelayMs()
        let work = DispatchWorkItem { [weak self] in self?.connectOnce() }
        pendingConnect = work
        queue.asyncAfter(deadline: .now() + delay / 1000.0, execute: work)
    }

    private func connectOnce() {
        if manualDisconnect { return }
        let stored = sessionStore.load()
        if stored == nil {
            emit(.unpaired, "Scan a pairing QR code", nil)
            return
        }
        let reconnecting = retryAttempt > 0
        emit(
            reconnecting ? .reconnecting : .connecting,
            reconnecting ? "Retrying gateway connection" : "Connecting to gateway",
            stored
        )
        Task {
            do {
                let refreshed = try await PairingApi(rawBaseUrl: stored.gatewayBaseUrl).refresh(session: stored)
                try sessionStore.save(session: refreshed)
                retryAttempt = 0
                scheduleSessionRefresh(session: refreshed)
                emit(.connected, "Gateway authenticated", refreshed)
            } catch let error as PairingError {
                switch error {
                case .http(let status, _) where status == 401 || status == 403:
                    sessionStore.clear()
                    refreshTask?.cancel()
                    refreshTask = nil
                    emit(.pairingRequired, "Pairing expired or revoked", nil)
                default:
                    scheduleRetry(stored, detail: error.localizedDescription)
                }
            } catch {
                scheduleRetry(stored, detail: "Waiting for network")
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
            guard !Task.isCancelled else { return }
            self?.refreshTask = nil
            if !(self?.manualDisconnect ?? true) {
                self?.connectOnce()
            }
        }
    }

    private func scheduleRetry(_ session: PairingSession, detail: String) {
        retryAttempt += 1
        emit(.reconnecting, detail, session)
        scheduleConnect(immediate: false)
    }

    private func retryDelayMs() -> Double {
        let exponent = min(retryAttempt - 1, 6)
        let base = min(60_000.0, 1_000.0 * pow(2.0, Double(exponent)))
        let jitter = Double.random(in: 0.8...1.2)
        return base * jitter
    }

    private func emit(_ state: ConnectionState, _ detail: String, _ session: PairingSession?) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.listener(state, detail, session)
        }
    }
}
