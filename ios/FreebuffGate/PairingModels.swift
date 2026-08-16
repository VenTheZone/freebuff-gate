import Foundation

enum ConnectionState: String {
    case unpaired
    case pairing
    case connecting
    case connected
    case reconnecting
    case offline
    case pairingRequired
    case revoked
    case disconnected
    case error
}

/// Data carried in the QR URL fragment. Never log this struct: token is a
/// bearer secret.
struct PairingPayload: Equatable {
    let baseUrl: String
    let pairingId: String
    let token: String

    init(baseUrl: String, pairingId: String, token: String) {
        self.baseUrl = baseUrl
        self.pairingId = pairingId
        self.token = token
    }

    static func parse(raw: String) throws -> PairingPayload {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let uri = URL(string: text), uri.scheme?.lowercased() == "https" else {
            throw PairingError.invalidUrl("Pairing URL must use HTTPS")
        }
        guard uri.user == nil && !(uri.host ?? "").isEmpty else {
            throw PairingError.invalidUrl("Pairing URL must have a normal HTTPS host")
        }
        guard let fragment = uri.fragment, !fragment.isEmpty else {
            throw PairingError.invalidUrl("Pairing URL has no token fragment")
        }
        var values: [String: String] = [:]
        for part in fragment.split(separator: "&") where !part.isEmpty {
            let pieces = part.split(separator: "=", maxSplits: 1)
            let key = String(pieces[0]).removingPercentEncoding ?? String(pieces[0])
            let value = pieces.count > 1
                ? (String(pieces[1]).removingPercentEncoding ?? String(pieces[1]))
                : ""
            values[key] = value
        }
        let pairingId = values["pairingId"] ?? ""
        let token = values["token"] ?? ""
        guard !pairingId.isEmpty && !token.isEmpty else {
            throw PairingError.invalidUrl("Pairing URL fragment is incomplete")
        }
        let base = PairingApi.normalizeBaseUrl("\(uri.scheme!)://\(uri.host!)\(uri.port.map { ":\($0)" } ?? "")")
        return PairingPayload(baseUrl: base, pairingId: pairingId, token: token)
    }
}

struct PairingSession: Equatable, Codable {
    let gatewayBaseUrl: String
    let deviceId: String
    let deviceToken: String
    let accessToken: String
    let accessTokenExpiresAt: String
    let deviceExpiresAt: String
    let relayUrl: String?
    let uiUrl: String?

    init(
        gatewayBaseUrl: String,
        deviceId: String,
        deviceToken: String,
        accessToken: String,
        accessTokenExpiresAt: String,
        deviceExpiresAt: String,
        relayUrl: String?,
        uiUrl: String?
    ) {
        self.gatewayBaseUrl = gatewayBaseUrl
        self.deviceId = deviceId
        self.deviceToken = deviceToken
        self.accessToken = accessToken
        self.accessTokenExpiresAt = accessTokenExpiresAt
        self.deviceExpiresAt = deviceExpiresAt
        self.relayUrl = relayUrl
        self.uiUrl = uiUrl
    }

    static func fromGatewayResponse(
        baseUrl: String,
        json: [String: Any],
        deviceTokenOverride: String? = nil,
        deviceExpiresAtOverride: String? = nil
    ) throws -> PairingSession {
        func required(_ name: String) throws -> String {
            guard let value = (json[name] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !value.isEmpty else {
                throw PairingError.badResponse("Gateway response missing \(name)")
            }
            return value
        }
        func optional(_ name: String) -> String? {
            guard let value = json[name] as? String else { return nil }
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
        return PairingSession(
            gatewayBaseUrl: baseUrl,
            deviceId: try required("deviceId"),
            deviceToken: try (deviceTokenOverride ?? required("deviceToken")),
            accessToken: try required("accessToken"),
            accessTokenExpiresAt: try required("accessTokenExpiresAt"),
            deviceExpiresAt: try (deviceExpiresAtOverride ?? required("deviceExpiresAt")),
            relayUrl: optional("relayUrl"),
            uiUrl: optional("uiUrl")
        )
    }
}

enum PairingError: LocalizedError {
    case invalidUrl(String)
    case badResponse(String)
    case http(status: Int, message: String)

    var errorDescription: String? {
        switch self {
        case .invalidUrl(let message), .badResponse(let message):
            return message
        case .http(let status, let message):
            return message.isEmpty ? "Gateway request failed (HTTP \(status))" : message
        }
    }
}
