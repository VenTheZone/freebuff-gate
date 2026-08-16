import CryptoKit
import Foundation
import Security

/// Stores the encrypted pairing session in the Keychain. The AES-GCM key is
/// derived from a random key stored in the Keychain; only ciphertext ever
/// touches the app sandbox's file storage.
class SecureSessionStore {
    private let service = "com.freebuff.gate.session"
    private let keyService = "com.freebuff.gate.session-key"

    func save(session: PairingSession) throws {
        let encoder = JSONEncoder()
        let data = try encoder.encode(session)
        let key = try loadOrCreateKey()
        let sealed = try AES.GCM.seal(data, using: key)
        var payload: [String: Data] = [:]
        payload["iv"] = sealed.nonce.withUnsafeBytes { Data($0) }
        payload["ct"] = sealed.ciphertext
        payload["tag"] = sealed.tag
        try writeKeychain(data: JSONEncoder().encode(payload), service: service)
    }

    func load() -> PairingSession? {
        guard let raw = readKeychain(service: service) else { return nil }
        do {
            let payload = try JSONDecoder().decode([String: Data].self, from: raw)
            guard let iv = payload["iv"], let ct = payload["ct"], let tag = payload["tag"] else {
                throw KeychainError.unexpected("Stored session is malformed")
            }
            let key = try loadOrCreateKey()
            let nonce = try AES.GCM.Nonce(data: iv)
            let sealed = AES.GCM.SealedBox(nonce: nonce, ciphertext: ct, tag: tag)
            let data = try AES.GCM.open(sealed, using: key)
            return try JSONDecoder().decode(PairingSession.self, from: data)
        } catch {
            try? clear()
            return nil
        }
    }

    func clear() {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
        ] as CFDictionary)
    }

    private func loadOrCreateKey() throws -> SymmetricKey {
        if let raw = readKeychain(service: keyService), raw.count == 32 {
            return SymmetricKey(data: raw)
        }
        let key = SymmetricKey(size: .bits256)
        let data = key.withUnsafeBytes { Data($0) }
        try writeKeychain(data: data, service: keyService)
        return key
    }

    private func writeKeychain(data: Data, service: String) throws {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        SecItemDelete(base as CFDictionary)
        var insert = base
        insert[kSecValueData as String] = data
        let status = SecItemAdd(insert as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw KeychainError.unexpected("Keychain write failed (\(status))")
        }
    }

    private func readKeychain(service: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess else { return nil }
        return item as? Data
    }
}
