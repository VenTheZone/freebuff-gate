import AVFoundation
import SwiftUI

/// Camera preview that reports the first QR code it finds. Mirrors the
/// Android ML Kit scanner: only QR format, single-result delivery.
struct QrScannerView: UIViewRepresentable {
    let onResult: (String) -> Void
    let onError: (String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onResult: onResult, onError: onError)
    }

    func makeUIView(context: Context) -> ScannerPreviewView {
        let view = ScannerPreviewView(frame: .zero)
        view.session = context.coordinator.session
        view.videoPreviewLayer.session = context.coordinator.session
        view.videoPreviewLayer.videoGravity = .resizeAspectFill
        context.coordinator.start()
        return view
    }

    func updateUIView(_ uiView: ScannerPreviewView, context: Context) {}

    static func dismantleUIView(_ uiView: ScannerPreviewView, coordinator: Coordinator) {
        coordinator.stop()
    }

    final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {
        private let onResult: (String) -> Void
        private let onError: (String) -> Void
        let session = AVCaptureSession()
        @Atomic private var resultDelivered = false

        init(onResult: @escaping (String) -> Void, onError: @escaping (String) -> Void) {
            self.onResult = onResult
            self.onError = onError
        }

        func start() {
            session.beginConfiguration()
            defer { session.commitConfiguration() }
            guard let device = AVCaptureDevice.default(for: .video),
                  let input = try? AVCaptureDeviceInput(device: device),
                  session.canAddInput(input) else {
                onError("Camera could not start")
                return
            }
            session.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else {
                onError("Camera could not start")
                return
            }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: DispatchQueue.main)
            if output.availableMetadataObjectTypes.contains(.qr) {
                output.metadataObjectTypes = [.qr]
            }
            // startRunning blocks; run it off the main thread like AVFoundation
            // expects.
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                self?.session.startRunning()
            }
        }

        func stop() {
            session.stopRunning()
        }

        func metadataOutput(
            _ output: AVCaptureMetadataOutput,
            didOutput metadataObjects: [AVMetadataObject],
            from connection: AVCaptureConnection
        ) {
            if resultDelivered { return }
            guard let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
                  object.type == .qr,
                  let value = object.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !value.isEmpty else { return }
            resultDelivered = true
            onResult(value)
        }
    }
}

final class ScannerPreviewView: UIView {
    var session: AVCaptureSession? {
        didSet { videoPreviewLayer.session = session }
    }

    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }

    var videoPreviewLayer: AVCaptureVideoPreviewLayer {
        layer as! AVCaptureVideoPreviewLayer
    }
}

@propertyWrapper
struct Atomic<Value> {
    private var value: Value
    private let lock = NSLock()

    init(wrappedValue: Value) {
        self.value = wrappedValue
    }

    var wrappedValue: Value {
        get {
            lock.lock()
            defer { lock.unlock() }
            return value
        }
        set {
            lock.lock()
            defer { lock.unlock() }
            value = newValue
        }
    }
}
