import Foundation
import Security

class DeviceIdentity {
    private let keyTag = "com.freebuff.gate.device-key"

    func publicKeyForPairing() throws -> String {
        let keyPair = try loadOrCreateKeyPair()
        guard let publicKey = SecKeyCopyPublicKey(keyPair) else {
            throw KeychainError.unexpected("No public key")
        }
        var error: Unmanaged<CFError>?
        guard let data = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
            throw error?.takeRetainedValue() as? Error ?? KeychainError.unexpected("Could not export public key")
        }
        return data.base64EncodedString(options: [])
    }

    private func loadOrCreateKeyPair() throws -> SecKey {
        let query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: keyTag.data(using: .utf8)!,
            kSecReturnRef as String: true,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecSuccess {
            return item as! SecKey
        }
        if status != errSecItemNotFound {
            throw KeychainError.unexpected("Key lookup failed (\(status))")
        }

        let attributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecAttrApplicationTag as String: keyTag.data(using: .utf8)!,
        ]
        var error: Unmanaged<CFError>?
        guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
            throw error?.takeRetainedValue() as? Error ?? KeychainError.unexpected("Could not create device key")
        }
        return key
    }
}

enum KeychainError: LocalizedError {
    case unexpected(String)

    var errorDescription: String? {
        switch self {
        case .unexpected(let message):
            return message
        }
    }
}
