package expo.modules.stablediffusion

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import android.util.Log
import org.tensorflow.lite.Interpreter
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * On-device NSFW classifier run on every generated image before it is
 * handed back to JS. Both engines (local-dream and sd-server) return
 * their PNG through [ExpoStableDiffusionModule.generate], so this one
 * check covers every model, including ones users import themselves.
 *
 * Three small classifiers run as an ensemble, because each misses nudes
 * the others catch:
 *   - Marqo nsfw-image-detection-384 (ViT-tiny) → P(nsfw). Strongest on
 *     AI-generated and drawn images.
 *   - opennsfw2 (Yahoo open_nsfw, ResNet-50 thin) → P(nsfw). Strongest
 *     on photographic nudity and classical paintings.
 *   - GantMan nsfw_model (MobileNetV2) → drawings, hentai, neutral,
 *     porn, sexy. Its "sexy" class also fires on gowns and gym wear, so
 *     it only counts when another signal agrees.
 *
 * Thresholds were calibrated on 408 images from the shipped checkpoints
 * (AbsoluteReality, DreamShaper 8, SD 1.5, AnythingV5, MeinaPastel,
 * SDXL) with prompts that pass the keyword filter, plus public-domain
 * nudes (Titian, Manet, Botticelli, Michelangelo). No nude image passed;
 * 9 of 120 safe images were withheld (AnythingV5 anime, which Marqo
 * over-scores, and SDXL).
 *
 * Models live in assets/nsfw/ (see NOTICE there for licences).
 */
internal class NsfwFilter(private val context: Context) {

  data class Verdict(
    val blocked: Boolean,
    val marqo: Float,
    val openNsfw: Float,
    val porn: Float,
    val hentai: Float,
    val sexy: Float,
  )

  companion object {
    private const val TAG = "NsfwFilter"
    private const val MARQO_MODEL = "nsfw/nsfw_vit_marqo.tflite"
    private const val OPEN_NSFW_MODEL = "nsfw/opennsfw2.tflite"
    private const val GANTMAN_MODEL = "nsfw/nsfw_mobilenet_v2.tflite"
    private const val MARQO_THRESHOLD = 0.3f
    private const val OPEN_NSFW_THRESHOLD = 0.3f
    private const val PORN_HENTAI_THRESHOLD = 0.3f
    // "sexy" ≥ 0.4 blocks only when backed by one of these weaker signals.
    private const val SEXY_THRESHOLD = 0.4f
    private const val SEXY_OPEN_NSFW_SUPPORT = 0.1f
    private const val SEXY_PORN_HENTAI_SUPPORT = 0.15f
    private const val MARQO_SIZE = 384
    private const val GANTMAN_SIZE = 224
    private const val OPEN_NSFW_SIZE = 224
    private const val OPEN_NSFW_RESIZE = 256
    // GantMan class order: drawings, hentai, neutral, porn, sexy
    private const val GM_HENTAI = 1
    private const val GM_PORN = 3
    private const val GM_SEXY = 4
  }

  private var marqo: Interpreter? = null
  private var openNsfw: Interpreter? = null
  private var gantman: Interpreter? = null

  @Synchronized
  fun check(pngBase64: String): Verdict {
    val bytes = Base64.decode(pngBase64, Base64.DEFAULT)
    val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
      ?: throw IllegalStateException("Generated image could not be decoded for the safety check")

    val mq = marqo ?: loadModel(MARQO_MODEL).also { marqo = it }
    val open = openNsfw ?: loadModel(OPEN_NSFW_MODEL).also { openNsfw = it }
    val gm = gantman ?: loadModel(GANTMAN_MODEL).also { gantman = it }

    val mqOut = Array(1) { FloatArray(2) }
    mq.run(marqoInput(bitmap), mqOut)
    val openOut = Array(1) { FloatArray(2) }
    open.run(openNsfwInput(bitmap), openOut)
    val gmOut = Array(1) { FloatArray(5) }
    gm.run(gantmanInput(bitmap), gmOut)
    bitmap.recycle()

    val marqoScore = mqOut[0][0] // [NSFW, SFW]
    val openScore = openOut[0][1] // [SFW, NSFW]
    val porn = gmOut[0][GM_PORN]
    val hentai = gmOut[0][GM_HENTAI]
    val sexy = gmOut[0][GM_SEXY]
    val pornHentai = porn + hentai
    val blocked = marqoScore >= MARQO_THRESHOLD ||
      openScore >= OPEN_NSFW_THRESHOLD ||
      pornHentai >= PORN_HENTAI_THRESHOLD ||
      (sexy >= SEXY_THRESHOLD &&
        (openScore >= SEXY_OPEN_NSFW_SUPPORT || pornHentai >= SEXY_PORN_HENTAI_SUPPORT))

    Log.i(
      TAG,
      "scores marqo=%.3f openNsfw=%.3f porn=%.3f hentai=%.3f sexy=%.3f → %s".format(
        marqoScore, openScore, porn, hentai, sexy, if (blocked) "BLOCKED" else "ok",
      ),
    )
    return Verdict(blocked, marqoScore, openScore, porn, hentai, sexy)
  }

  @Synchronized
  fun close() {
    marqo?.close()
    openNsfw?.close()
    gantman?.close()
    marqo = null
    openNsfw = null
    gantman = null
  }

  private fun loadModel(asset: String): Interpreter {
    val bytes = context.assets.open(asset).use { it.readBytes() }
    val buffer = ByteBuffer.allocateDirect(bytes.size).order(ByteOrder.nativeOrder())
    buffer.put(bytes)
    buffer.rewind()
    return Interpreter(buffer, Interpreter.Options().setNumThreads(2))
  }

  /**
   * createScaledBitmap's bilinear filter aliases on large downscales,
   * which shifted classifier scores by up to 0.75 against the calibration
   * (512 px → 224 px). Halving first is an exact 2×2 box filter, so the
   * final resize stays under 2× like the antialiased reference.
   */
  private fun resize(src: Bitmap, size: Int): Bitmap {
    var b = src
    while (b.width >= size * 2 && b.height >= size * 2) {
      val half = Bitmap.createScaledBitmap(b, b.width / 2, b.height / 2, true)
      if (b !== src) b.recycle()
      b = half
    }
    val out = Bitmap.createScaledBitmap(b, size, size, true)
    if (b !== src && b !== out) b.recycle()
    return out
  }

  private fun pixels(src: Bitmap, size: Int): IntArray {
    val scaled = resize(src, size)
    val out = IntArray(size * size)
    scaled.getPixels(out, 0, size, 0, 0, size, size)
    if (scaled !== src) scaled.recycle()
    return out
  }

  private fun floatBuffer(count: Int): ByteBuffer =
    ByteBuffer.allocateDirect(4 * count * 3).order(ByteOrder.nativeOrder())

  /** Resize to 384, RGB scaled to [-1, 1]. */
  private fun marqoInput(src: Bitmap): ByteBuffer {
    val px = pixels(src, MARQO_SIZE)
    val buf = floatBuffer(px.size)
    for (p in px) {
      buf.putFloat(((p shr 16) and 0xFF) / 127.5f - 1f)
      buf.putFloat(((p shr 8) and 0xFF) / 127.5f - 1f)
      buf.putFloat((p and 0xFF) / 127.5f - 1f)
    }
    buf.rewind()
    return buf
  }

  /** Resize to 256, center-crop 224, BGR minus the Caffe/VGG channel means. */
  private fun openNsfwInput(src: Bitmap): ByteBuffer {
    val scaled = resize(src, OPEN_NSFW_RESIZE)
    val offset = (OPEN_NSFW_RESIZE - OPEN_NSFW_SIZE) / 2
    val px = IntArray(OPEN_NSFW_SIZE * OPEN_NSFW_SIZE)
    scaled.getPixels(px, 0, OPEN_NSFW_SIZE, offset, offset, OPEN_NSFW_SIZE, OPEN_NSFW_SIZE)
    if (scaled !== src) scaled.recycle()
    val buf = floatBuffer(px.size)
    for (p in px) {
      buf.putFloat((p and 0xFF) - 104f)
      buf.putFloat(((p shr 8) and 0xFF) - 117f)
      buf.putFloat(((p shr 16) and 0xFF) - 123f)
    }
    buf.rewind()
    return buf
  }

  /** Resize to 224, RGB scaled to [0, 1]. */
  private fun gantmanInput(src: Bitmap): ByteBuffer {
    val px = pixels(src, GANTMAN_SIZE)
    val buf = floatBuffer(px.size)
    for (p in px) {
      buf.putFloat(((p shr 16) and 0xFF) / 255f)
      buf.putFloat(((p shr 8) and 0xFF) / 255f)
      buf.putFloat((p and 0xFF) / 255f)
    }
    buf.rewind()
    return buf
  }
}
