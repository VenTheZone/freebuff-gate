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

    @StateObject private var controller = SessionController()

    var body: some View {
        ZStack {
            Color(.systemBackground).ignoresSafeArea()

            if showWebView, let webTarget {
                RestrictedWebViewHost(url: webTarget, controller: controller)
                    .transition(.opacity)
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
                    if let session, let target = webTargetFor(session) {
                        webTarget = target
                        showWebView = true
                    }
                case .unpaired, .pairingRequired, .revoked, .disconnected:
                    showWebView = false
                default:
                    break
                }
            }
            controller.start()
        }
        .onDisappear { controller.close() }
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
                if let configured = Self.configuredOrigin() {
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

    private func webTargetFor(_ session: PairingSession) -> URL? {
        guard let candidate = session.uiUrl ?? session.relayUrl?.replacingOccurrences(of: "wss://", with: "https://"),
              let url = URL(string: candidate),
              url.scheme == "https", url.host != nil else {
            return nil
        }
        if let configured = Self.configuredOrigin(), RestrictedWebViewController.originOf(url.absoluteString) != configured {
            return nil
        }
        return url
    }

    private static func configuredOrigin() -> String? {
        let raw = Bundle.main.object(forInfoDictionaryKey: "FBDefaultWebOrigin") as? String ?? ""
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return PairingApi.normalizeBaseUrl(trimmed)
    }
}

/// Wraps the restricted WKWebView controller and installs the session cookie
/// before the first load.
struct RestrictedWebViewHost: UIViewControllerRepresentable {
    let url: URL
    let controller: SessionController

    func makeUIViewController(context: Context) -> RestrictedWebViewController {
        let vc = RestrictedWebViewController(
            allowedOrigin: RestrictedWebViewController.originOf(url.absoluteString) ?? "",
            onBlockedNavigation: { _ in }
        )
        return vc
    }

    func updateUIViewController(_ vc: RestrictedWebViewController, context: Context) {
        Task {
            // Establish the session cookie first, then load: the relay's UI
            // page requires it before any API call succeeds.
            if let session = controller.sessionStore.load(),
               let cookie = try? await PairingApi(rawBaseUrl: session.gatewayBaseUrl)
                   .establishWebSession(webBaseUrl: url.absoluteString, accessToken: session.accessToken) {
                await vc.installCookie(cookie, for: url)
            }
            vc.loadRemoteUi(url: url)
        }
    }
}

/// Owns the session store and reconnect loop so they survive SwiftUI view
/// churn (equivalent of Android's Activity-scoped controller).
final class SessionController: ObservableObject {
    let sessionStore = SecureSessionStore()
    private var reconnect: ReconnectController?
    var listener: ((ConnectionState, String, PairingSession?) -> Void)?

    func start() {
        guard reconnect == nil else { return }
        reconnect = ReconnectController(sessionStore: sessionStore) { [weak self] state, detail, session in
            self?.listener?(state, detail, session)
        }
        reconnect?.start()
    }

    func onResume() { reconnect?.onResume() }

    func reconnect() { reconnect?.reconnect() }

    func disconnect(clearSession: Bool) { reconnect?.disconnect(clearSession: clearSession) }

    func close() { reconnect?.close() }
}
