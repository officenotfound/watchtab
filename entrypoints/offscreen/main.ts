import { browser } from 'wxt/browser';

/**
 * Offscreen document: MV3 service workers can't play audio directly, so the
 * background worker creates this hidden document (via chrome.offscreen) and
 * messages it to play a short alert tone. Nothing here ever transmits data
 * anywhere; it's local playback only.
 *
 * The tone is synthesized directly via the Web Audio API rather than an
 * embedded audio file: a light two-note chime (a bright fifth up, then a
 * soft settle) with a fast attack and gentle exponential decay, aiming for
 * the same "small, modern, non-jarring" register as a phone's default
 * notification sound without reproducing any specific platform's actual
 * proprietary tone.
 */
let sharedContext: AudioContext | null = null;

function getContext(): AudioContext {
  if (!sharedContext || sharedContext.state === 'closed') {
    sharedContext = new AudioContext();
  }
  return sharedContext;
}

function playChimeNote(ctx: AudioContext, startAt: number, frequency: number, duration: number, peakGain: number): void {
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(frequency, startAt);

  // A quiet, slightly-detuned higher harmonic gives the note a touch of
  // "bell" shimmer instead of a flat, synthetic sine-wave beep.
  const harmonic = ctx.createOscillator();
  harmonic.type = 'sine';
  harmonic.frequency.setValueAtTime(frequency * 2.01, startAt);
  const harmonicGain = ctx.createGain();
  harmonicGain.gain.setValueAtTime(peakGain * 0.18, startAt);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(peakGain, startAt + 0.012); // fast, soft attack
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration); // gentle decay

  osc.connect(gain);
  harmonic.connect(harmonicGain);
  harmonicGain.connect(gain);
  gain.connect(ctx.destination);

  osc.start(startAt);
  harmonic.start(startAt);
  osc.stop(startAt + duration + 0.05);
  harmonic.stop(startAt + duration + 0.05);
}

function playChime(): void {
  const ctx = getContext();
  const now = ctx.currentTime;
  // A perfect fifth up (E6 -> B6), the classic "bright, resolved" interval
  // most light notification chimes use, each note ~0.22s with a bit of
  // overlap so it reads as one quick, modern chime rather than two beeps.
  playChimeNote(ctx, now, 1318.51, 0.22, 0.22);
  playChimeNote(ctx, now + 0.1, 1975.53, 0.28, 0.16);
}

browser.runtime.onMessage.addListener((message: { type: string }) => {
  if (message.type !== 'play-alert-sound') return;
  try {
    playChime();
  } catch (err) {
    console.error('watchtab offscreen: chime playback failed', err);
  }
});
