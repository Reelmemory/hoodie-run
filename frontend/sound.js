// Tiny procedural sound engine. Everything here is synthesized with
// oscillators via the Web Audio API — no audio files to load or license.
// The AudioContext is created lazily on the first sound request, since
// browsers require a user gesture (a tap/keypress) before audio can play;
// by the time any of these fire, the player has already interacted (jump,
// duck, etc.), so this "just works" without extra setup.

const Sound = (() => {
  let ctx = null;
  let muted = false;

  try {
    muted = localStorage.getItem("hoodie_run_muted") === "1";
  } catch {
    // ignore — default to unmuted if storage isn't available
  }

  function ensureCtx() {
    if (!ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      ctx = new AudioCtx();
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  // One short tone. `glideTo`, if set, slides the pitch across the note —
  // cheap way to get a "boing" or "whoosh" feel out of a plain oscillator.
  function tone({ freq = 440, duration = 0.12, type = "square", volume = 0.15, glideTo = null, delay = 0 }) {
    if (muted) return;
    const audioCtx = ensureCtx();
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime + delay;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, glideTo), t0 + duration);
    gain.gain.setValueAtTime(volume, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  function jump() {
    tone({ freq: 340, glideTo: 640, duration: 0.14, type: "square", volume: 0.11 });
  }

  function duck() {
    tone({ freq: 200, glideTo: 110, duration: 0.1, type: "sine", volume: 0.09 });
  }

  // Quiet footstep tick — kept very subtle since it repeats often.
  function step() {
    tone({ freq: 100, duration: 0.03, type: "square", volume: 0.025 });
  }

  function hit() {
    tone({ freq: 220, glideTo: 55, duration: 0.32, type: "sawtooth", volume: 0.16 });
    tone({ freq: 130, glideTo: 40, duration: 0.4, type: "square", volume: 0.1, delay: 0.05 });
  }

  // Cheerful ascending chime for when a reward actually lands.
  function reward() {
    tone({ freq: 523.25, duration: 0.12, type: "sine", volume: 0.14 });
    tone({ freq: 659.25, duration: 0.12, type: "sine", volume: 0.14, delay: 0.11 });
    tone({ freq: 783.99, duration: 0.2, type: "sine", volume: 0.14, delay: 0.22 });
  }

  function setMuted(value) {
    muted = value;
    try {
      localStorage.setItem("hoodie_run_muted", value ? "1" : "0");
    } catch {
      // ignore — muting still works for this session even if storage fails
    }
  }

  function isMuted() {
    return muted;
  }

  return { jump, duck, step, hit, reward, setMuted, isMuted };
})();
