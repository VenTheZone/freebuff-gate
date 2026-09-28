import Foundation
import Security

/// Device identity keypair used for pairing.
///
/// Prefers a Secure Enclave–backed P-256 key where the hardware has one. The
/// iOS Simulator (and Macs without a Secure Enclave) reject the enclave token
/// attribute, so this falls back to a normal P-256 private key persisted in
/// the Keychain. The public key encoding sent to the relay is identical in
/// both cases (the uncompressed EC point, base64-encoded), so the pairing
/// protocol and relay-side fingerprint are unaffected by the fallback.
///
/// Private key material is never logged or exported; only the public key
/// leaves this type.
final class DeviceIdentity {
    private let keyTag = "com.freebuff.gate.device-key"
    private let keyTagData: Data

    init() {
        self.keyTagData = Data(keyTag.utf8)
    }

    func publicKeyForPairing() throws -> String {
        let key = try loadOrCreateKey()
        guard let publicKey = SecKeyCopyPublicKey(key) else {
            throw KeychainError.unexpected("No public key")
        }
        var error: Unmanaged<CFError>?
        guard let data = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
            throw error?.takeRetainedValue() as? Error ?? KeychainError.unexpected("Could not export public key")
        }
        return data.base64EncodedString(options: [])
    }

    private func loadOrCreateKey() throws -> SecKey {
        if let existing = try loadKey() {
            return existing
        }
        do {
            return try createKey(secureEnclave: true)
        } catch {
            guard Self.canUseSoftwareKey(afterSecureEnclaveError: error) else { throw error }
            return try createKey(secureEnclave: false)
        }
    }

    private func loadKey() throws -> SecKey? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: keyTagData,
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecReturnRef as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess, let item else {
            throw KeychainError.unexpected("Key lookup failed (\(status))")
        }
        // kSecReturnRef for key-class items returns a SecKey reference.
        return (item as! SecKey)
    }

    private func createKey(secureEnclave: Bool) throws -> SecKey {
        var privateAttributes: [String: Any] = [
            kSecAttrIsPermanent as String: true,
            kSecAttrApplicationTag as String: keyTagData,
        ]
        if secureEnclave {
            guard let access = SecAccessControlCreateWithFlags(
                nil,
                kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
                [],
                nil
            ) else {
                throw KeychainError.unexpected("Could not create key access control")
            }
            privateAttributes[kSecAttrAccessControl as String] = access
        } else {
            privateAttributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        }

        var attributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecPrivateKeyAttrs as String: privateAttributes,
        ]
        if secureEnclave {
            attributes[kSecAttrTokenID as String] = kSecAttrTokenIDSecureEnclave
        }

        var error: Unmanaged<CFError>?
        guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
            throw error?.takeRetainedValue() as? Error ?? KeychainError.unexpected("Could not create device key")
        }
        return key
    }

    /// The Security framework reports unsupported Secure Enclave key requests
    /// as parameter-not-supported/unavailable errors on simulator and older
    /// devices. Other failures may indicate a Keychain or signing problem and
    /// must remain visible rather than silently weakening key protection.
    static func canUseSoftwareKey(afterSecureEnclaveError error: Error) -> Bool {
        let nsError = error as NSError
        guard nsError.domain == NSOSStatusErrorDomain else { return false }
        return nsError.code == Int(errSecParam)
            || nsError.code == Int(errSecNotAvailable)
            || nsError.code == Int(errSecUnimplemented)
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
