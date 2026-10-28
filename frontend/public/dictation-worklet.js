// AudioWorklet do ditado: reduz o áudio da taxa do AudioContext para 16 kHz (média por bloco),
// converte para Int16 little-endian e posta ~100 ms por mensagem, com o RMS do bloco (medidor).
class DictationProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.pos = 0;
    this.sum = 0;
    this.count = 0;
    this.out = new Int16Array(1600);
    this.n = 0;
    this.sq = 0;
    this.sqn = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      const x = channel[i];
      this.sq += x * x;
      this.sqn++;
      this.sum += x;
      this.count++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        let v = this.sum / this.count;
        this.sum = 0;
        this.count = 0;
        v = Math.max(-1, Math.min(1, v));
        this.out[this.n++] = v < 0 ? v * 32768 : v * 32767;
        if (this.n === this.out.length) {
          const rms = this.sqn ? Math.sqrt(this.sq / this.sqn) : 0;
          const buffer = this.out.buffer;
          this.port.postMessage({ pcm: buffer, rms }, [buffer]);
          this.out = new Int16Array(1600);
          this.n = 0;
          this.sq = 0;
          this.sqn = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("dictation-processor", DictationProcessor);
