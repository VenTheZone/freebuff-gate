import XCTest
import Security
@testable import FreebuffGate

final class DeviceIdentityTests: XCTestCase {

    /// Runs on the Simulator (no Secure Enclave) and on device (Secure
    /// Enclave). Both paths must produce a stable, valid P-256 public key so
    /// the relay-side fingerprint does not change between calls.
    func testIdentityIsStableAndExportsUncompressedP256Point() throws {
        let identity = DeviceIdentity()

        let first = try identity.publicKeyForPairing()
        let second = try identity.publicKeyForPairing()

        XCTAssertEqual(first, second, "the device identity key must be stable across calls")
        XCTAssertFalse(first.isEmpty)

        guard let data = Data(base64Encoded: first) else {
            return XCTFail("public key must be base64")
        }
        // `SecKeyCopyExternalRepresentation` for an EC key returns the
        // uncompressed ANSI X9.63 point: 0x04 || X(32) || Y(32).
        XCTAssertEqual(data.count, 65)
        XCTAssertEqual(data.first, 0x04)

        // Reconstructing a fresh type instance must observe the same persisted
        // key, not generate a new one.
        let third = try DeviceIdentity().publicKeyForPairing()
        XCTAssertEqual(first, third)
    }

    func testSoftwareFallbackIsLimitedToSecureEnclaveUnavailableErrors() {
        let enclaveUnavailable = NSError(domain: NSOSStatusErrorDomain, code: Int(errSecNotAvailable))
        let unsupportedParameters = NSError(domain: NSOSStatusErrorDomain, code: Int(errSecParam))
        let unimplemented = NSError(domain: NSOSStatusErrorDomain, code: Int(errSecUnimplemented))
        let keychainFailure = NSError(domain: NSOSStatusErrorDomain, code: Int(errSecAuthFailed))
        let unrelatedFailure = NSError(domain: "TestError", code: Int(errSecNotAvailable))

        XCTAssertTrue(DeviceIdentity.canUseSoftwareKey(afterSecureEnclaveError: enclaveUnavailable))
        XCTAssertTrue(DeviceIdentity.canUseSoftwareKey(afterSecureEnclaveError: unsupportedParameters))
        XCTAssertTrue(DeviceIdentity.canUseSoftwareKey(afterSecureEnclaveError: unimplemented))
        XCTAssertFalse(DeviceIdentity.canUseSoftwareKey(afterSecureEnclaveError: keychainFailure))
        XCTAssertFalse(DeviceIdentity.canUseSoftwareKey(afterSecureEnclaveError: unrelatedFailure))
    }
}
