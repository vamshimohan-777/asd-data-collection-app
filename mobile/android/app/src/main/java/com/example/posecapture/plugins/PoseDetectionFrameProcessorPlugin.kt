package com.example.posecapture.plugins

import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.pose.PoseDetection
import com.google.mlkit.vision.pose.defaults.PoseDetectorOptions
import com.mrousavy.camera.core.types.Orientation
import com.mrousavy.camera.frameprocessors.Frame
import com.mrousavy.camera.frameprocessors.FrameProcessorPlugin
import com.mrousavy.camera.frameprocessors.FrameProcessorPluginRegistry
import com.mrousavy.camera.frameprocessors.VisionCameraProxy
import kotlin.math.max

@Suppress("UNCHECKED_CAST")
class PoseDetectionFrameProcessorPlugin(
  @Suppress("unused") private val proxy: VisionCameraProxy,
  options: Map<String, Any>?,
) : FrameProcessorPlugin() {
  private val detector =
    PoseDetection.getClient(
      PoseDetectorOptions
        .Builder()
        .setDetectorMode(parseDetectorMode(options))
        .build(),
    )

  override fun callback(
    frame: Frame,
    params: Map<String, Any>?,
  ): Any? {
    val modeOverride = (params?.get("mode") as? String)?.lowercase()
    if (modeOverride == "single") {
      // Kept for API compatibility; detector remains in stream mode.
    }

    val mediaImage = frame.image
    val rotationDegrees = toInputImageRotationDegrees(frame)
    val inputImage = InputImage.fromMediaImage(mediaImage, rotationDegrees)
    val pose = Tasks.await(detector.process(inputImage))

    if (pose.allPoseLandmarks.isEmpty()) {
      return null
    }

    val rawWidth = inputImage.width.toDouble().coerceAtLeast(1.0)
    val rawHeight = inputImage.height.toDouble().coerceAtLeast(1.0)
    val needsSwap = rotationDegrees == 90 || rotationDegrees == 270
    val width = if (needsSwap) rawHeight else rawWidth
    val height = if (needsSwap) rawWidth else rawHeight
    val zScale = max(width, height)

    val output = ArrayList<ArrayList<Double>>(33)
    for (index in 0 until 33) {
      output.add(arrayListOf(0.0, 0.0, 0.0, 0.0))
    }

    for (landmark in pose.allPoseLandmarks) {
      val type = landmark.landmarkType
      if (type < 0 || type >= output.size) {
        continue
      }

      val position = landmark.position
      val normalizedX = (position.x.toDouble() / width).coerceIn(0.0, 1.0)
      val normalizedY = (position.y.toDouble() / height).coerceIn(0.0, 1.0)
      val normalizedZ = extractLandmarkZ(landmark) / zScale
      val visibility = landmark.inFrameLikelihood.toDouble().coerceIn(0.0, 1.0)

      val tuple = output[type]
      tuple[0] = normalizedX
      tuple[1] = normalizedY
      tuple[2] = normalizedZ
      tuple[3] = visibility
    }

    return hashMapOf(
      "keypoints" to output,
      "sourceWidth" to width,
      "sourceHeight" to height,
      "isMirrored" to frame.isMirrored,
      "rotationDegrees" to rotationDegrees,
    )
  }

  private fun parseDetectorMode(options: Map<String, Any>?): Int {
    val mode = (options?.get("mode") as? String)?.lowercase()
    return if (mode == "single") {
      PoseDetectorOptions.SINGLE_IMAGE_MODE
    } else {
      PoseDetectorOptions.STREAM_MODE
    }
  }

  private fun toInputImageRotationDegrees(frame: Frame): Int {
    // VisionCamera Frame.orientation is reversed from CameraX imageInfo.rotationDegrees.
    // Convert it back to MLKit's expected rotation degrees.
    return when (frame.orientation) {
      Orientation.PORTRAIT -> 0
      Orientation.LANDSCAPE_RIGHT -> 90
      Orientation.PORTRAIT_UPSIDE_DOWN -> 180
      Orientation.LANDSCAPE_LEFT -> 270
    }
  }

  private fun extractLandmarkZ(landmark: Any): Double {
    return try {
      val getPosition3D = landmark.javaClass.methods.firstOrNull { method ->
        method.name == "getPosition3D" && method.parameterCount == 0
      } ?: return 0.0
      val point3D = getPosition3D.invoke(landmark) ?: return 0.0
      val getZ = point3D.javaClass.methods.firstOrNull { method ->
        method.name == "getZ" && method.parameterCount == 0
      } ?: return 0.0
      val zValue = getZ.invoke(point3D) as? Number ?: return 0.0
      zValue.toDouble()
    } catch (_: Throwable) {
      0.0
    }
  }

  companion object {
    @Volatile
    private var registered = false

    @JvmStatic
    fun registerPlugins() {
      if (registered) {
        return
      }
      synchronized(this) {
        if (registered) {
          return
        }

        try {
          FrameProcessorPluginRegistry.addFrameProcessorPlugin("poseDetection") { proxy, options ->
            PoseDetectionFrameProcessorPlugin(proxy, options as? Map<String, Any>)
          }
        } catch (_: Throwable) {
          // Ignore duplicate registration across hot restarts.
        }

        try {
          FrameProcessorPluginRegistry.addFrameProcessorPlugin("PoseDetection") { proxy, options ->
            PoseDetectionFrameProcessorPlugin(proxy, options as? Map<String, Any>)
          }
        } catch (_: Throwable) {
          // Ignore duplicate registration across hot restarts.
        }

        registered = true
      }
    }
  }
}