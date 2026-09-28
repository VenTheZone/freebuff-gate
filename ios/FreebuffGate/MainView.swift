import SwiftUI
import UIKit
import WebKit

struct MainView: View {
    @State private var state: ConnectionState = .unpaired
    @State private var stateDetail = "Not connected"
    @State private var pairingUrl = ""
    @State private var deviceName = UIDevice.current.name
    @State private var showScanner = false
    @State private var showWebView = false
    @State private var webTarget: URL?
    @State private var pairing = false
    @State private var hasSession = false
    @State private var blockedExternalUrl: URL?
    @State private var webSessionError: String?
    @State private var webSessionRetry = 0
    @State private var webSessionExpiresAt: Date?

    @StateObject private var controller = SessionController()

    @Environment(\.scenePhase) private var scenePhase

    private var webSessionCookieExpiring: Bool {
        guard let webSessionExpiresAt else { return false }
        return webSessionExpiresAt.timeIntervalSinceNow <= WebSessionLoadGuard.cookieRefreshMargin
    }

    var body: some View {
        ZStack {
            Color(.systemBackground).ignoresSafeArea()

            if showWebView, let webTarget {
                ZStack {
                    RestrictedWebViewHost(
                        url: webTarget,
                        controller: controller,
                        retryID: webSessionRetry,
                        onBlockedNavigation: { raw in
                            blockedExternalUrl = URL(string: raw)
                        },
                        onSessionError: { message in
                            webSessionError = message
                        },
                        onSessionReady: { expiresAt in
                            webSessionExpiresAt = expiresAt
                            webSessionError = nil
                        }
                    )
                    .transition(.opacity)

                    if let webSessionError {
                        VStack(spacing: 12) {
                            Text("Could not establish relay web session")
                                .font(.headline)
                            Text(webSessionError)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                            Button("Retry") {
                                controller.reconnect()
                            }
                            .buttonStyle(.borderedProminent)
                        }
                        .padding(24)
                        .background(.regularMaterial)
                        .clipShape(RoundedRectangle(cornerRadius: 16))
                        .padding()
                    }
                }
            } else if showScanner {
                scannerView
            } else {
                setupView
            }
        }
        .onAppear {
            controller.listener = { newState, detail, session in
                state = newState
                stateDetail = detail
                hasSession = session != nil
                switch newState {
                case .connected:
                    // Keep the push token registered with the relay for the
                    // active session so background notifications work.
                    PushTokenStore.shared.setSession(session)
                    if webSessionError != nil || webSessionCookieExpiring {
                        // Refresh token before replacing cookie so the web
                        // session exchange cannot race an access-token rotation.
                        webSessionRetry += 1
                        webSessionError = nil
                    }
                    if let session {
                        do {
                            if let target = try webTargetFor(session) {
                                webTarget = target
                                showWebView = true
                            } else {
                                state = .error
                                stateDetail = "Connected, but relay did not provide a valid HTTPS UI URL"
                                showWebView = false
                            }
                        } catch {
                            state = .error
                            stateDetail = "Connected, but relay origin configuration is invalid: \(error.localizedDescription)"
                            showWebView = false
                        }
                    }
                case .unpaired, .pairingRequired, .revoked, .disconnected:
                    // Drop the active session and, best effort, clear the
                    // relay-side APNs token so a disconnected or revoked
                    // pairing stops receiving pushes.
                    PushTokenStore.shared.setSession(nil)
                    PushTokenStore.shared.unregister()
                    showWebView = false
                    webSessionExpiresAt = nil
                default:
                    break
                }
            }
            controller.start()
        }
        .onDisappear { controller.close() }
        .onChange(of: scenePhase) { phase in
            if phase == .active {
                if webSessionCookieExpiring {
                    controller.reconnect()
                } else {
                    controller.onResume()
                }
            }
        }
        .alert(
            "Open in browser?",
            isPresented: Binding(
                get: { blockedExternalUrl != nil },
                set: { if !$0 { blockedExternalUrl = nil } }
            )
        ) {
            Button("Open") {
                if let url = blockedExternalUrl {
                    UIApplication.shared.open(url)
                }
                blockedExternalUrl = nil
            }
            Button("Close", role: .cancel) {
                blockedExternalUrl = nil
            }
        } message: {
            if let url = blockedExternalUrl {
                Text("Open \"\(url.host?.replacingOccurrences(of: "www.", with: "") ?? url.absoluteString)\" in your external browser?")
            }
        }
    }

    private var setupView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Freebuff Gate")
                    .font(.largeTitle.bold())
                Text("\(state.rawValue.uppercased())\n\(stateDetail)")
                    .font(.body)
                    .foregroundStyle(.secondary)

                Button("Scan QR code") {
                    showScanner = true
                }
                .buttonStyle(.borderedProminent)
                .frame(maxWidth: .infinity)

                TextField("Paste pairing URL or scan QR", text: $pairingUrl)
                    .textFieldStyle(.roundedBorder)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()

                TextField("Device name", text: $deviceName)
                    .textFieldStyle(.roundedBorder)

                Button("Pair device") {
                    pair()
                }
                .buttonStyle(.borderedProminent)
                .frame(maxWidth: .infinity)
                .disabled(pairing || pairingUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .opacity(pairing ? 0.6 : 1)

                if hasSession {
                    Button("Disconnect", role: .destructive) {
                        controller.disconnect(clearSession: true)
                        PushTokenStore.shared.unregister()
                        webTarget = nil
                        showWebView = false
                        pairingUrl = ""
                    }
                    .frame(maxWidth: .infinity)
                }
            }
            .padding(24)
        }
    }

    private var scannerView: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            QrScannerView { value in
                pairingUrl = value
                showScanner = false
            } onError: { message in
                stateDetail = message
                state = .error
                showScanner = false
            }
            .ignoresSafeArea()
            VStack {
                HStack {
                    Spacer()
                    Button("Close scanner") {
                        showScanner = false
                    }
                    .padding()
                    .background(.thinMaterial)
                    .clipShape(Capsule())
                }
                Spacer()
            }
            .padding()
        }
    }

    private func pair() {
        let raw = pairingUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = deviceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? UIDevice.current.name
            : deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else {
            state = .error
            stateDetail = "Scan or paste pairing URL"
            return
        }
        pairing = true
        state = .pairing
        stateDetail = "Pairing device securely"
        Task {
            do {
                let payload = try PairingPayload.parse(raw: raw)
                if let configured = try Self.configuredPairingOrigin() {
                    guard payload.baseUrl == configured else {
                        throw PairingError.invalidUrl("Pairing URL is not from configured Freebuff relay")
                    }
                }
                let identity = DeviceIdentity()
                let publicKey = try identity.publicKeyForPairing()
                let session = try await PairingApi(rawBaseUrl: payload.baseUrl).claim(
                    payload: payload,
                    deviceName: name,
                    devicePublicKey: publicKey
                )
                try controller.sessionStore.save(session: session)
                await MainActor.run {
                    pairing = false
                    controller.reconnect()
                    state = .connecting
                    stateDetail = "Pairing accepted; connecting"
                }
            } catch {
                await MainActor.run {
                    pairing = false
                    state = .error
                    stateDetail = "Pairing failed: \(error.localizedDescription)"
                }
            }
        }
    }

    private func webTargetFor(_ session: PairingSession) throws -> URL? {
        guard let candidate = session.uiUrl ?? session.relayUrl?.replacingOccurrences(of: "wss://", with: "https://"),
              let url = URL(string: candidate),
              url.scheme == "https", url.host != nil else {
            return nil
        }
        let originAllowed = try OriginConfig.allowsWebUrl(
            url.absoluteString,
            configuredWebOrigin: Bundle.main.object(forInfoDictionaryKey: "FBDefaultWebOrigin") as? String,
            pairingOrigin: session.gatewayBaseUrl
        )
        guard originAllowed else { return nil }
        return url
    }

    private static func configuredPairingOrigin() throws -> String? {
        try OriginConfig.configuredOrigin(Bundle.main.object(forInfoDictionaryKey: "FBDefaultPairingOrigin") as? String)
    }
}

/// Hosts the restricted WKWebView and establishes the relay web session once
/// per device and UI URL, renewing its cookie after long periods in background.
struct RestrictedWebViewHost: UIViewControllerRepresentable {
    let url: URL
    let controller: SessionController
    var retryID = 0
    var onBlockedNavigation: (String) -> Void = { _ in }
    var onSessionError: (String) -> Void = { _ in }
    var onSessionReady: (Date) -> Void = { _ in }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIViewController(context: Context) -> RestrictedWebViewController {
        RestrictedWebViewController(
            allowedOrigin: RestrictedWebViewController.originOf(url.absoluteString) ?? "",
            onBlockedNavigation: onBlockedNavigation
        )
    }

    func updateUIViewController(_ viewController: RestrictedWebViewController, context: Context) {
        context.coordinator.loadIfNeeded(
            viewController: viewController,
            url: url,
            sessionStore: controller.sessionStore,
            retryID: retryID,
            onSessionError: onSessionError,
            onSessionReady: onSessionReady
        )
    }

    static func dismantleUIViewController(
        _ viewController: RestrictedWebViewController,
        coordinator: Coordinator
    ) {
        coordinator.cancel()
    }

    /// SwiftUI re-invokes `updateUIViewController` on every state change, so
    /// the guard prevents duplicate exchange and load work.
    final class Coordinator {
        private let loadGuard = WebSessionLoadGuard()
        private var lastRetryID = 0
        private var activeKey: String?
        private var task: Task<Void, Never>?

        @MainActor
        func loadIfNeeded(
            viewController: RestrictedWebViewController,
            url: URL,
            sessionStore: SecureSessionStore,
            retryID: Int,
            onSessionError: @escaping (String) -> Void,
            onSessionReady: @escaping (Date) -> Void
        ) {
            guard let session = sessionStore.load() else {
                cancel()
                return
            }
            let key = WebSessionKey.make(session: session, url: url)
            if activeKey != nil && activeKey != key {
                cancel()
            }
            activeKey = key
            if retryID != lastRetryID {
                lastRetryID = retryID
                loadGuard.retry(key: key)
                loadGuard.refreshIfCookieExpiresSoon(key: key)
            }
            guard loadGuard.shouldLoad(key: key) else { return }
            loadGuard.begin(key: key)
            task = Task { @MainActor in
                do {
                    let credential = try await PairingApi(rawBaseUrl: session.gatewayBaseUrl)
                        .establishWebSession(webBaseUrl: url.absoluteString, accessToken: session.accessToken)
                    try Task.checkCancellation()
                    guard self.activeKey == key else { return }
                    try await viewController.installCookie(credential.cookieHeader, for: url)
                    try Task.checkCancellation()
                    guard self.activeKey == key else { return }
                    loadGuard.finish(key: key, cookieExpiresAt: credential.expiresAt)
                    task = nil
                    onSessionReady(credential.expiresAt)
                    viewController.loadRemoteUi(url: url)
                } catch {
                    guard self.activeKey == key else { return }
                    loadGuard.fail(key: key)
                    task = nil
                    onSessionError(error.localizedDescription)
                }
            }
        }

        @MainActor
        func cancel() {
            task?.cancel()
            task = nil
            activeKey = nil
            loadGuard.invalidate()
        }
    }
}

/// Owns the session store and reconnect loop so they survive SwiftUI view
/// churn (equivalent of Android's Activity-scoped controller).
final class SessionController: ObservableObject {
    let sessionStore = SecureSessionStore()
    private var reconnectController: ReconnectController?
    var listener: ((ConnectionState, String, PairingSession?) -> Void)?

    func start() {
        guard reconnectController == nil else { return }
        reconnectController = ReconnectController(sessionStore: sessionStore) { [weak self] state, detail, session in
            self?.listener?(state, detail, session)
        }
        reconnectController?.start()
    }

    func onResume() { reconnectController?.onResume() }

    func reconnect() { reconnectController?.reconnect() }

    func disconnect(clearSession: Bool) { reconnectController?.disconnect(clearSession: clearSession) }

    func close() { reconnectController?.close() }
}
