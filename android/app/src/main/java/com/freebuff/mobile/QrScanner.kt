package com.freebuff.mobile

import android.annotation.SuppressLint
import android.content.Context
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

class QrScanner(
    private val context: Context,
    private val lifecycleOwner: LifecycleOwner,
    private val previewView: PreviewView,
    private val onResult: (String) -> Unit,
    private val onError: (String) -> Unit,
) {
    private val cameraExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private val scanner: BarcodeScanner = BarcodeScanning.getClient(
        BarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .build(),
    )
    private var cameraProvider: ProcessCameraProvider? = null
    @Volatile
    private var resultDelivered = false

    fun start() {
        resultDelivered = false
        val providerFuture = ProcessCameraProvider.getInstance(context)
        providerFuture.addListener({
            runCatching { bind(providerFuture.get()) }
                .onFailure { onError(it.message ?: "Camera could not start") }
        }, ContextCompat.getMainExecutor(context))
    }

    fun stop() {
        cameraProvider?.unbindAll()
        cameraProvider = null
    }

    fun close() {
        stop()
        scanner.close()
        cameraExecutor.shutdownNow()
    }

    @SuppressLint("UnsafeOptInUsageError")
    private fun bind(provider: ProcessCameraProvider) {
        cameraProvider = provider
        val preview = Preview.Builder().build().also {
            it.setSurfaceProvider(previewView.surfaceProvider)
        }
        val analysis = ImageAnalysis.Builder()
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .build()
        analysis.setAnalyzer(cameraExecutor) { imageProxy -> analyze(imageProxy) }

        provider.unbindAll()
        provider.bindToLifecycle(
            lifecycleOwner,
            CameraSelector.DEFAULT_BACK_CAMERA,
            preview,
            analysis,
        )
    }

    @SuppressLint("UnsafeOptInUsageError")
    private fun analyze(imageProxy: ImageProxy) {
        if (resultDelivered) {
            imageProxy.close()
            return
        }
        val mediaImage = imageProxy.image
        if (mediaImage == null) {
            imageProxy.close()
            return
        }

        val image = InputImage.fromMediaImage(
            mediaImage,
            imageProxy.imageInfo.rotationDegrees,
        )
        scanner.process(image)
            .addOnSuccessListener { codes ->
                val value = codes.firstOrNull()?.rawValue?.trim().orEmpty()
                if (value.isNotEmpty() && !resultDelivered) {
                    resultDelivered = true
                    onResult(value)
                }
            }
            .addOnFailureListener { onError(it.message ?: "QR scan failed") }
            .addOnCompleteListener { imageProxy.close() }
    }
}
