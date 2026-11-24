/**
 * capture-worklet.js - AudioWorklet that copies microphone input into fixed
 * 2048-sample blocks and posts each full block to the main thread. Outputs
 * silence. The block size is independent of the render quantum (128 frames).
 */

const BLOCK_SAMPLES = 2048;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(BLOCK_SAMPLES);
    this._pos = 0;
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (input) {
      let i = 0;
      while (i < input.length) {
        const n = Math.min(input.length - i, BLOCK_SAMPLES - this._pos);
        this._buf.set(input.subarray(i, i + n), this._pos);
        this._pos += n;
        i += n;
        if (this._pos === BLOCK_SAMPLES) {
          const full = this._buf;
          this.port.postMessage(full, [full.buffer]);
          this._buf = new Float32Array(BLOCK_SAMPLES);
          this._pos = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('capture', CaptureProcessor);
