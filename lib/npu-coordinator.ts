// lib/npu-coordinator.ts
//
// Coordinates ownership of the Qualcomm Hexagon NPU between the LLM
// (llama.rn HTP backend) and the image generator (local-dream QNN).
// Both clients open FastRPC sessions to the same DSP — Hexagon has
// limited concurrent unsigned PD slots, so loading one while the other
// holds the DSP yields contention errors like "QNNUNET exec failed".
//
// Policy:
//   • Image NPU has priority. Loading an NPU image model evicts any
//     text on the NPU, reloading the text model on GPU/CPU through the
//     registered eviction handler.
//   • Text NPU yields. If image owns the NPU, text loads transparently
//     on GPU/CPU instead.
//   • Both subsystems can run concurrently when neither uses the NPU
//     (CPU/GPU paths share no DSP resources).
//
// Only NPU paths consult the coordinator — non-NPU loads on either
// side are completely unaffected.

type NpuOwner = 'none' | 'text' | 'image';
type TextEvictHandler = () => Promise<void>;

class NpuCoordinator {
  private owner: NpuOwner = 'none';
  private mutex: Promise<void> = Promise.resolve();
  private textEvictHandler: TextEvictHandler | null = null;

  registerTextEvictHandler(fn: TextEvictHandler | null): void {
    this.textEvictHandler = fn;
  }

  getOwner(): NpuOwner {
    return this.owner;
  }

  /**
   * Image asks for the NPU. Always succeeds. If text currently owns it,
   * the registered evict handler runs first (typically reloading the
   * text model on GPU/CPU), then waits a settle window for the kernel
   * FastRPC session to fully tear down before returning. Callers should
   * await this BEFORE invoking the QNN backend.
   */
  async acquireForImage(): Promise<void> {
    return this.runExclusive(async () => {
      const wasText = this.owner === 'text';
      // Set ownership FIRST so any concurrent text reservation is denied.
      this.owner = 'image';
      if (wasText && this.textEvictHandler) {
        try {
          await this.textEvictHandler();
        } catch (e) {
          console.warn('[NpuCoordinator] text evict handler threw:', e);
        }
        // FastRPC teardown is async on the kernel side. Without this
        // delay the QNN HTP backend can hit EBUSY attaching to a DSP
        // slot that's still being released.
        await new Promise<void>((r) => setTimeout(r, 1500));
      }
    });
  }

  /** Image was unloaded — release ownership. No-op if image isn't owner. */
  releaseImage(): void {
    if (this.owner === 'image') this.owner = 'none';
  }

  /**
   * Text reserves the NPU before invoking initLlama with HTP devices.
   * Returns true if the reservation succeeded (caller may proceed with
   * HTP), false if image owns the NPU (caller must use GPU/CPU).
   * On failure of the HTP load, caller MUST call noteTextNotOnNpu() to
   * release the reservation.
   */
  async reserveText(): Promise<boolean> {
    return this.runExclusive(async () => {
      if (this.owner === 'image') return false;
      this.owner = 'text';
      return true;
    });
  }

  /**
   * After a successful HTP load, confirm that the reservation still
   * holds. Returns false if image acquired the NPU during the load —
   * in that case the caller must unload the just-loaded HTP context
   * and re-init on GPU/CPU.
   */
  confirmText(): boolean {
    return this.owner === 'text';
  }

  /**
   * Text loaded on a non-NPU backend, or text HTP load failed after
   * reserveText() returned true. Releases the reservation.
   */
  noteTextNotOnNpu(): void {
    if (this.owner === 'text') this.owner = 'none';
  }

  /** Text was fully unloaded. */
  noteTextUnloaded(): void {
    if (this.owner === 'text') this.owner = 'none';
  }

  private async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.mutex;
    let release!: () => void;
    this.mutex = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export const npuCoordinator = new NpuCoordinator();
