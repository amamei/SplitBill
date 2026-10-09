// Procedural sound design synced to the film timeline -> audio.wav (48 kHz stereo, 16-bit)
const fs = require('fs');
const SR = 48000, DUR = 30, N = SR * DUR;
const L = new Float32Array(N), R = new Float32Array(N);
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
const hz = m => 440 * Math.pow(2, (m - 69) / 12);

function add(t0, len, fn, gain = 1, pan = 0) {
  const s0 = Math.floor(t0 * SR), n = Math.floor(len * SR);
  const gl = gain * Math.cos((pan + 1) * Math.PI / 4), gr = gain * Math.sin((pan + 1) * Math.PI / 4);
  for (let i = 0; i < n; i++) { const k = s0 + i; if (k < 0 || k >= N) continue; const v = fn(i / SR); L[k] += v * gl; R[k] += v * gr; }
}

// ---- pad: chord per section, slow swells
const CHORDS = [
  [0, 9.0, [53, 57, 60, 64]],      // Fmaj7
  [9.0, 15.0, [57, 60, 64, 67]],   // Am7
  [15.0, 21.0, [48, 55, 59, 64]],  // Cmaj7
  [21.0, 25.6, [55, 59, 62, 64]],  // G6
  [25.6, 28.2, [53, 57, 60, 67]],  // Fadd9
  [28.2, 30.0, [48, 55, 62, 64, 71]], // Cmaj9 resolve
];
CHORDS.forEach(([a, b, notes], ci) => {
  const len = b - a + 1.2;
  notes.forEach((m, j) => {
    [-0.07, 0.07].forEach((det, d) => {
      const f = hz(m + det);
      let lp = 0;
      add(a - 0.3, len, t => {
        const env = Math.min(1, t / 1.1) * Math.min(1, Math.max(0, (len - t) / 1.2));
        const trem = 1 + 0.12 * Math.sin(2 * Math.PI * (0.25 + j * 0.07) * t);
        const raw = Math.sin(2 * Math.PI * f * t) + 0.18 * Math.sin(4 * Math.PI * f * t + 1);
        lp += 0.2 * (raw - lp);
        return lp * env * trem;
      }, 0.010 * (ci === 5 ? 1.3 : 1), d ? 0.45 : -0.45);
    });
  });
  // sub
  add(a - 0.2, len, t => Math.sin(2 * Math.PI * hz(notes[0] - 12) * t) * Math.min(1, t / 0.8) * Math.min(1, Math.max(0, (len - t) / 1.0)), 0.016);
});

// ---- sound atoms
const pop = (t, f = 700, g = 0.16, pan = 0) => add(t, 0.18, x => Math.sin(2 * Math.PI * (f * (1 + 0.6 * Math.exp(-x * 40))) * x) * Math.exp(-x * 28), g, pan);
const tick = (t, g = 0.05, pan = 0) => { let lp = 0; add(t, 0.03, x => { lp += 0.5 * (rnd() - lp); return lp * Math.exp(-x * 220); }, g, pan); };
function whoosh(t, len = 0.6, g = 0.09, pan = 0) {
  let lp = 0, lp2 = 0;
  add(t, len, x => {
    const p = x / len, env = Math.sin(Math.PI * Math.pow(p, 0.7)) ** 2;
    const c = 0.02 + 0.25 * Math.sin(Math.PI * p);
    lp += c * (rnd() - lp); lp2 += c * (lp - lp2);
    return (lp - lp2 * 0.6) * env;
  }, g, pan);
}
const thump = (t, g = 0.3) => add(t, 0.4, x => Math.sin(2 * Math.PI * (55 + 90 * Math.exp(-x * 30)) * x) * Math.exp(-x * 9), g);
function bell(t, m, g = 0.08, pan = 0, len = 2.2) {
  const f = hz(m);
  add(t, len, x => (Math.sin(2 * Math.PI * f * x) + 0.35 * Math.sin(2 * Math.PI * f * 2.01 * x) * Math.exp(-x * 3) + 0.15 * Math.sin(2 * Math.PI * f * 3.02 * x) * Math.exp(-x * 6)) * Math.exp(-x * 2.2) * Math.min(1, x * 200), g, pan);
}
const shimmer = (t, base = 76, g = 0.035) => [0, 4, 7, 11, 14].forEach((d, i) => bell(t + i * 0.055, base + d, g, -0.6 + i * 0.3, 1.2));
const click = t => { tick(t, 0.18); pop(t, 1400, 0.06); };

// ---- timeline
// scene 1
whoosh(0.15, 0.8, 0.05);
[0, 1, 2, 3].forEach(i => pop(0.62 + i * 0.09, 520 + i * 70, 0.14, -0.5 + i * 0.33));
[0, 1, 2, 3].forEach(i => pop(1.66 + i * 0.12, 880 + i * 60, 0.09, -0.6 + i * 0.4));
whoosh(2.3, 0.6, 0.05);
whoosh(3.65, 0.9, 0.1);
// scene 2: typing
const MSG = 'Borya paid 1,200 for food. Anya: hookahs 800 and wine 600. Vika tipped 260.';
for (let i = 0; i < MSG.length; i++) { const t = 4.85 + (i / MSG.length) * 2.1; if (MSG[i] !== ' ') tick(t + (rnd() * 0.006), 0.035 + Math.abs(rnd()) * 0.02, -0.4 + rnd() * 0.15); }
click(7.02);
whoosh(7.08, 0.6, 0.08, 0.4);
thump(7.62, 0.22); bell(7.62, 79, 0.05, 0.4, 1.5);
[0, 1, 2].forEach(i => { pop(7.8 + i * 0.3, 760, 0.08, 0.5); bell(8.08 + i * 0.3, 84 + i * 2, 0.025, 0.5, 0.8); });
whoosh(8.65, 0.9, 0.1, -0.2);
// scene 3: code stream + component landings
const T3 = [9.55, 9.95, 10.25, 10.6, 10.95, 11.15, 11.5, 11.85, 12.15, 12.45];
const TG = [1, 0, 1, 1, 1, 0, 1, 1, 0, 1];
T3.forEach((a, i) => {
  for (let k = 0; k < 6; k++) tick(a + k * 0.05, 0.025, -0.5);
  if (TG[i]) { whoosh(a + 0.3, 0.45, 0.035, 0.3); pop(a + 0.8, 600 + i * 45, 0.1, 0.5); }
});
shimmer(13.25, 76, 0.03);
tick(14.15, 0.08, 0.4);
whoosh(14.55, 1.0, 0.11);
// scene 4
click(16.55); thump(16.6, 0.12);
pop(17.0, 990, 0.06, 0.3);
whoosh(18.0, 0.6, 0.05, -0.3);
pop(18.5, 640, 0.11, -0.5);
shimmer(19.25, 79, 0.028);
whoosh(20.45, 0.9, 0.1);
// scene 5
[0, 1, 2, 3].forEach(i => bell(21.5 + i * 0.12, [72, 71, 64, 62][i], 0.04, 0.4));
whoosh(22.95, 0.9, 0.07, 0.2);
[23.75, 23.95, 24.15].forEach((a, i) => { whoosh(a, 0.6, 0.04, 0.3); pop(a + 0.4, 820 + i * 80, 0.09, 0.4); });
bell(24.6, 84, 0.05, 0.2, 1.4); bell(24.66, 88, 0.04, 0.3, 1.4);
whoosh(25.1, 0.8, 0.09);
// scene 6
[0, 1, 2].forEach(i => pop(25.85 + i * 0.16, 700 + i * 90, 0.1, -0.5 + i * 0.5));
whoosh(27.4, 0.7, 0.1);
thump(28.3, 0.35);
[60, 67, 72, 76, 79].forEach((m, i) => bell(28.3 + i * 0.07, m, 0.07 - i * 0.008, -0.4 + i * 0.2, 2.0));
shimmer(28.75, 88, 0.02);

// ---- master: soft clip, normalize to -1.5 dBFS, fade edges
let peak = 0;
for (let i = 0; i < N; i++) { L[i] = Math.tanh(L[i] * 1.2) / 1.2; R[i] = Math.tanh(R[i] * 1.2) / 1.2; peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); }
const g = 0.84 / peak;
const buf = Buffer.alloc(44 + N * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) {
  const t = i / SR, f = Math.min(1, t / 0.05, (DUR - t) / 0.6);
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i] * g * f)) * 32767), 44 + i * 4);
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i] * g * f)) * 32767), 46 + i * 4);
}
fs.writeFileSync(__dirname + '/audio.wav', buf);
console.log('peak', peak.toFixed(3), 'gain', g.toFixed(2));
