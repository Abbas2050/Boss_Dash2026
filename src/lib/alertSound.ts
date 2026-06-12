const PREF_KEY = "alert_sound_enabled_v1";

export function isSoundEnabled(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === "1";
  } catch {
    return false;
  }
}

export function setSoundEnabled(on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

let audioCtx: AudioContext | null = null;
let activeStop: (() => void) | null = null;

/** Must be called from a user gesture once before sound can play (browser autoplay policy). */
export function primeAudio(): void {
  try {
    if (!audioCtx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctor) audioCtx = new Ctor();
    }
    if (audioCtx && audioCtx.state === "suspended") void audioCtx.resume();
  } catch {
    /* ignore */
  }
}

export function stopAlarm(): void {
  try {
    activeStop?.();
  } catch {
    /* ignore */
  }
  activeStop = null;
}

/**
 * Play a LONG, LOUD two-tone siren alarm (~6s by default). Distinct cadence per kind.
 * No-op if audio is unavailable or not primed.
 */
export function playAlarm(kind: "disconnect" | "lp-margin", durationMs = 6000): void {
  try {
    primeAudio();
    if (!audioCtx) return;
    stopAlarm();
    const ctx = audioCtx;
    const now = ctx.currentTime;
    const end = now + durationMs / 1000;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.6, now + 0.05); // loud
    gain.gain.setValueAtTime(0.6, end - 0.06);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    gain.connect(ctx.destination);

    const osc = ctx.createOscillator();
    osc.type = "square";
    const hi = kind === "lp-margin" ? 1046 : 1318;
    const lo = kind === "lp-margin" ? 659 : 880;
    const step = kind === "lp-margin" ? 0.4 : 0.25; // distinct cadence
    const steps = Math.ceil(durationMs / 1000 / step);
    for (let i = 0; i < steps; i++) {
      osc.frequency.setValueAtTime(i % 2 === 0 ? hi : lo, now + i * step);
    }
    osc.connect(gain);
    osc.start(now);
    osc.stop(end);

    const stop = () => {
      try {
        osc.stop();
      } catch {
        /* already stopped */
      }
      try {
        gain.disconnect();
      } catch {
        /* ignore */
      }
    };
    activeStop = stop;
    osc.onended = () => {
      if (activeStop === stop) activeStop = null;
    };
  } catch {
    /* ignore */
  }
}
