import Foundation

class PairingApi {
    let baseUrl: String

    init(rawBaseUrl: String) {
        self.baseUrl = Self.normalizeBaseUrl(rawBaseUrl)
    }

    func claim(payload: PairingPayload, deviceName: String, devicePublicKey: String) async throws -> PairingSession {
        guard payload.baseUrl == baseUrl else {
            throw PairingError.invalidUrl("Pairing payload endpoint changed")
        }
        let body: [String: Any] = [
            "pairingId": payload.pairingId,
            "token": payload.token,
            "deviceName": deviceName.trimmingCharacters(in: .whitespacesAndNewlines),
            "devicePublicKey": devicePublicKey,
        ]
        let result = try await request(
            baseUrl: baseUrl,
            path: "/v1/pairings/claim",
            method: "POST",
            body: body,
            headers: [:]
        )
        return try PairingSession.fromGatewayResponse(baseUrl: baseUrl, json: result.json)
    }

    func refresh(session: PairingSession) async throws -> PairingSession {
        guard session.gatewayBaseUrl == baseUrl else {
            throw PairingError.invalidUrl("Session endpoint changed")
        }
        let body: [String: Any] = [
            "deviceId": session.deviceId,
            "deviceToken": session.deviceToken,
        ]
        let result = try await request(
            baseUrl: baseUrl,
            path: "/v1/sessions/refresh",
            method: "POST",
            body: body,
            headers: [:]
        )
        return try PairingSession.fromGatewayResponse(
            baseUrl: baseUrl,
            json: result.json,
            deviceTokenOverride: session.deviceToken,
            deviceExpiresAtOverride: session.deviceExpiresAt
        )
    }

    /// Exchanges short-lived access token for relay-owned Secure/HttpOnly
    /// cookie. The cookie is installed into the WKWebView cookie store by
    /// native code; the access token is never injected into page JavaScript.
    /// Registers (or clears, with an empty token) the device's APNs token
    /// with the relay so it can push turn-finished notifications while the
    /// app is backgrounded.
    func uploadPushToken(session: PairingSession, token: String) async throws {
        guard session.gatewayBaseUrl == baseUrl else {
            throw PairingError.invalidUrl("Session endpoint changed")
        }
        let body: [String: Any] = ["token": token]
        _ = try await request(
            baseUrl: baseUrl,
            path: "/v1/mobile/push-token",
            method: "POST",
            body: body,
            headers: ["Authorization": "Bearer \(session.accessToken)"]
        )
    }

    func establishWebSession(webBaseUrl: String, accessToken: String) async throws -> String {
        let webOrigin = Self.normalizeBaseUrl(webBaseUrl)
        let result = try await request(
            baseUrl: webOrigin,
            path: "/v1/mobile/session",
            method: "GET",
            body: nil,
            headers: ["Authorization": "Bearer \(accessToken)"]
        )
        guard let cookie = result.setCookie, !cookie.isEmpty else {
            throw PairingError.badResponse("Relay did not return a session cookie")
        }
        return cookie
    }

    static func normalizeBaseUrl(_ raw: String) -> String {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let uri = URL(string: text), uri.scheme?.lowercased() == "https" else {
            fatalError("Gateway endpoint must use HTTPS")
        }
        guard uri.user == nil && !(uri.host ?? "").isEmpty else {
            fatalError("Gateway endpoint must not contain credentials")
        }
        var base = "\(uri.scheme!.lowercased())://\(uri.host!.lowercased())"
        if let port = uri.port {
            base += ":\(port)"
        }
        return base.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    private struct HttpResult {
        let json: [String: Any]
        let setCookie: String?
    }

    private func request(
        baseUrl: String,
        path: String,
        method: String,
        body: [String: Any]?,
        headers: [String: String]
    ) async throws -> HttpResult {
        guard let url = URL(string: "\(baseUrl)\(path)") else {
            throw PairingError.invalidUrl("Invalid gateway URL")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 15
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        for (name, value) in headers {
            request.setValue(value, forHTTPHeaderField: name)
        }
        if let body {
            request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw PairingError.badResponse("Gateway returned a non-HTTP response")
        }
        let status = http.statusCode
        let json: [String: Any] = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard (200...299).contains(status) else {
            let message = (json["message"] as? String) ?? "Gateway request failed"
            throw PairingError.http(status: status, message: message)
        }
        let setCookie = http.value(forHTTPHeaderField: "Set-Cookie")
        return HttpResult(json: json, setCookie: setCookie)
    }
}
