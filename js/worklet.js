'use strict';
/* 采集端 AudioWorklet：把麦克风的实时 PCM 按 ~50ms 聚合成块 post 给主线程。
   只采集不上送扬声器（输出保持静音连接，见 voice.js 的零增益 mute 节点）。 */
class CapProc extends AudioWorkletProcessor {
  constructor() {
    super();
    this.acc = new Float32Array(16384);   // ≥ 50ms @96kHz(4800)
    this.n = 0;
    this.emit = Math.round(sampleRate * 0.05);
  }
  process(inputs) {
    const input = inputs[0];
    const s = input && input[0];
    if (s) {
      for (let i = 0; i < s.length; i++) {
        this.acc[this.n++] = s[i];
        if (this.n >= this.emit) {
          const out = this.acc.slice(0, this.n);
          this.port.postMessage({ pcm: out, sr: sampleRate }, [out.buffer]);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('cap-proc', CapProc);
