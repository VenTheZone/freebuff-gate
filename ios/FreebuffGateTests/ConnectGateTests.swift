import XCTest
@testable import FreebuffGate

final class ConnectGateTests: XCTestCase {

    func testGateAdmitsOnlyOneOperationAtATime() {
        let gate = ConnectGate()

        XCTAssertTrue(gate.tryBegin(), "first connect should be admitted")
        XCTAssertTrue(gate.isInFlight)

        // A lifecycle resume or second network callback must not start a
        // parallel refresh while one is running.
        XCTAssertFalse(gate.tryBegin())
        XCTAssertFalse(gate.tryBegin())

        gate.end()
        XCTAssertFalse(gate.isInFlight)
        XCTAssertTrue(gate.tryBegin(), "gate should be reusable after completion")
        gate.end()
    }
}
