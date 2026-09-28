import Foundation

struct WebSessionCredential {
    let cookieHeader: String
    let expiresAt: Date

    static func parse(
        cookieHeader: String?,
        expiresAt rawExpiry: String?,
        now: Date = Date()
    ) throws -> WebSessionCredential {
        guard let cookieHeader, !cookieHeader.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw PairingError.badResponse("Relay did not return a session cookie")
        }
        guard let rawExpiry, let expiresAt = parseDate(rawExpiry), expiresAt > now else {
            throw PairingError.badResponse("Relay did not return a valid session cookie expiry")
        }
        return WebSessionCredential(cookieHeader: cookieHeader, expiresAt: expiresAt)
    }

    private static func parseDate(_ raw: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: raw) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: raw)
    }
}

class PairingApi {
    let baseUrl: String

    /// - Throws: `PairingError.invalidUrl` when the endpoint is not a valid,
    ///   credential-free HTTPS origin. Callers surface this through the normal
    ///   pairing error path; it must never terminate the process.
    init(rawBaseUrl: String) throws {
        self.baseUrl = try Self.normalizeBaseUrl(rawBaseUrl)
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

    /// Registers the device's APNs token with the relay so it can push
    /// turn-finished notifications while the app is backgrounded.
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

    /// Best-effort relay cleanup so a disconnected or revoked pairing stops
    /// receiving APNs pushes. An already-expired access token returns 401,
    /// which callers may ignore.
    func deletePushToken(session: PairingSession) async throws {
        guard session.gatewayBaseUrl == baseUrl else {
            throw PairingError.invalidUrl("Session endpoint changed")
        }
        _ = try await request(
            baseUrl: baseUrl,
            path: "/v1/mobile/push-token",
            method: "DELETE",
            body: nil,
            headers: ["Authorization": "Bearer \(session.accessToken)"]
        )
    }

    /// Exchanges a short-lived access token for a relay-owned Secure/HttpOnly
    /// cookie and validates expiry metadata so the cookie can be renewed after
    /// a long period in the background. The access token is never exposed to JS.
    func establishWebSession(webBaseUrl: String, accessToken: String) async throws -> WebSessionCredential {
        let webOrigin = try Self.normalizeBaseUrl(webBaseUrl)
        let result = try await request(
            baseUrl: webOrigin,
            path: "/v1/mobile/session",
            method: "GET",
            body: nil,
            headers: ["Authorization": "Bearer \(accessToken)"]
        )
        return try WebSessionCredential.parse(
            cookieHeader: result.setCookie,
            expiresAt: result.json["expiresAt"] as? String
        )
    }

    /// Normalizes an endpoint to `https://host[:port]` with a lowercased host,
    /// dropping any path, query, fragment, or trailing slash.
    ///
    /// - Throws: `PairingError.invalidUrl` for empty input, a malformed URL, a
    ///   non-HTTPS scheme, a missing host, or embedded credentials.
    static func normalizeBaseUrl(_ raw: String) throws -> String {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let components = URLComponents(string: text) else {
            throw PairingError.invalidUrl("Gateway endpoint is not a valid URL")
        }
        guard components.scheme?.lowercased() == "https" else {
            throw PairingError.invalidUrl("Gateway endpoint must use HTTPS")
        }
        guard components.user == nil, components.password == nil else {
            throw PairingError.invalidUrl("Gateway endpoint must not contain credentials")
        }
        guard let host = components.host?.lowercased(), !host.isEmpty else {
            throw PairingError.invalidUrl("Gateway endpoint must have an HTTPS host")
        }
        var base = "https://\(host)"
        if let port = components.port {
            base += ":\(port)"
        }
        return base
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
