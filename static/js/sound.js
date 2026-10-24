// Wszystkie dźwięki są generowane w przeglądarce (Web Audio API) - bez plików audio.
const Sound = (() => {
  let ctx = null, master = null, noiseBuf = null;
  let enabled = true;
  try { enabled = localStorage.getItem("sound") !== "off"; } catch (e) {}
  let lastTick = 0;

  function ac() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = 0.5;
      const comp = ctx.createDynamicsCompressor();
      master.connect(comp).connect(ctx.destination);
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  function tone(freq, start, dur, { type = "sine", vol = 0.3, attack = 0.005, slideTo = null, dest = null } = {}) {
    const c = ac();
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, start);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, start + dur);
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(vol, start + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g).connect(dest || master);
    o.start(start);
    o.stop(start + dur + 0.05);
  }

  function noise(start, dur, { vol = 0.3, freq = 2000, q = 1, type = "bandpass", slideTo = null } = {}) {
    const c = ac();
    const s = c.createBufferSource(); s.buffer = noiseBuf;
    const f = c.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, start); f.Q.value = q;
    if (slideTo) f.frequency.exponentialRampToValueAtTime(slideTo, start + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(vol, start);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    s.connect(f).connect(g).connect(master);
    s.start(start); s.stop(start + dur + 0.05);
  }

  // ton z vibrato (LFO na wysokości), przesuwający się od "from" do "to"; tremolo - drganie głośności (Hz)
  function warble(start, dur, from, to, { rate = 6, depth = 20, vol = 0.1, type = "sine", tremolo = 0 } = {}) {
    const c = ac();
    const o = c.createOscillator(), g = c.createGain(), lfo = c.createOscillator(), lg = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(from, start);
    o.frequency.exponentialRampToValueAtTime(to, start + dur);
    lfo.frequency.value = rate; lg.gain.value = depth;
    lfo.connect(lg).connect(o.frequency);
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(vol, start + Math.min(0.25, dur / 4));
    g.gain.setValueAtTime(vol, start + dur * 0.7);
    g.gain.linearRampToValueAtTime(0, start + dur);
    let out = g;
    if (tremolo) {
      const tg = c.createGain(), tl = c.createOscillator(), td = c.createGain();
      tg.gain.value = 0.6; tl.frequency.value = tremolo; td.gain.value = 0.4;
      tl.connect(td).connect(tg.gain);
      g.connect(tg); out = tg;
      tl.start(start); tl.stop(start + dur + 0.05);
    }
    o.connect(g); out.connect(master);
    o.start(start); lfo.start(start);
    o.stop(start + dur + 0.05); lfo.stop(start + dur + 0.05);
  }

  // niskie buczenie silnika (piła przez filtr dolnoprzepustowy)
  function hum(start, dur, freq, vol) {
    const c = ac();
    const o = c.createOscillator(), f = c.createBiquadFilter(), g = c.createGain();
    o.type = "sawtooth"; o.frequency.value = freq;
    f.type = "lowpass"; f.frequency.value = 240;
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(vol, start + 0.3);
    g.gain.setValueAtTime(vol, start + dur - 0.4);
    g.gain.linearRampToValueAtTime(0, start + dur);
    o.connect(f).connect(g).connect(master);
    o.start(start); o.stop(start + dur + 0.05);
  }

  const N = { C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392, A4: 440, B4: 493.88,
              C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99, A5: 880, B5: 987.77,
              C6: 1046.5, D6: 1174.66, E6: 1318.5, G6: 1567.98, C7: 2093 };

  const api = {
    get enabled() { return enabled; },
    toggle() {
      enabled = !enabled;
      try { localStorage.setItem("sound", enabled ? "on" : "off"); } catch (e) {}
      if (enabled) api.click();
      return enabled;
    },
    unlock() { if (enabled) ac(); },

    click() {
      if (!enabled) return;
      const t = ac().currentTime;
      tone(1400, t, 0.04, { type: "square", vol: 0.06 });
    },

    // tyknięcie bębna; speed 0..1 wpływa lekko na wysokość
    tick(speed = 1) {
      if (!enabled) return;
      const now = performance.now();
      if (now - lastTick < 28) return;
      lastTick = now;
      const t = ac().currentTime;
      noise(t, 0.03, { vol: 0.35, freq: 3500 + speed * 1500, q: 6 });
      tone(900 + speed * 500, t, 0.025, { type: "triangle", vol: 0.08 });
    },

    open() {
      if (!enabled) return;
      const t = ac().currentTime;
      // zatrzask
      noise(t, 0.06, { vol: 0.6, freq: 1200, q: 3 });
      tone(180, t, 0.12, { type: "square", vol: 0.12, slideTo: 90 });
      // świst
      noise(t + 0.05, 0.5, { vol: 0.25, freq: 400, q: 1.2, slideTo: 3000 });
      tone(220, t + 0.05, 0.45, { type: "sawtooth", vol: 0.05, slideTo: 880 });
    },

    land(rarity) {
      if (!enabled) return;
      const t = ac().currentTime;
      const base = { green: N.C5, blue: N.D5, purple: N.E5, red: N.G5, gold: N.A5, ultra: N.C6 }[rarity] || N.C5;
      tone(base, t, 0.18, { type: "triangle", vol: 0.12 });
      noise(t, 0.05, { vol: 0.15, freq: 5000, q: 2 });
    },

    reveal(rarity) {
      if (!enabled) return;
      const c = ac(), t = c.currentTime;
      const seqs = {
        green:  [N.C5, N.E5],
        blue:   [N.C5, N.E5, N.G5],
        purple: [N.C5, N.E5, N.G5, N.C6],
        red:    [N.D5, N.F5, N.A5, N.D6, N.F5 * 2],
      };
      if (rarity === "gold") return api.gold();
      if (rarity === "ultra") return api.ultra();
      (seqs[rarity] || seqs.green).forEach((f, i) => {
        tone(f, t + i * 0.07, 0.35, { type: "triangle", vol: 0.18 });
        tone(f * 2, t + i * 0.07, 0.2, { type: "sine", vol: 0.05 });
      });
      if (rarity === "red") {
        noise(t, 0.6, { vol: 0.2, freq: 6000, q: 0.7, type: "highpass" });
        tone(110, t, 0.5, { type: "sawtooth", vol: 0.1, slideTo: 55 });
      }
    },

    gold() {
      if (!enabled) return;
      const t = ac().currentTime;
      // fanfara
      const melody = [[N.G4, 0], [N.C5, 0.12], [N.E5, 0.24], [N.G5, 0.36], [N.E5, 0.52], [N.G5, 0.62]];
      melody.forEach(([f, d]) => {
        tone(f, t + d, 0.3, { type: "sawtooth", vol: 0.08 });
        tone(f, t + d, 0.3, { type: "square", vol: 0.05 });
      });
      [N.C5, N.E5, N.G5, N.C6].forEach(f => tone(f, t + 0.78, 1.4, { type: "sawtooth", vol: 0.07, attack: 0.02 }));
      tone(65, t + 0.78, 1.2, { type: "sine", vol: 0.35 });
      // dzwoneczki
      for (let i = 0; i < 12; i++) tone(N.C6 * (1 + Math.random()), t + 0.8 + i * 0.07, 0.25, { vol: 0.05 });
      noise(t + 0.78, 1.2, { vol: 0.15, freq: 8000, q: 0.5, type: "highpass" });
    },

    // wariant MLG: trąbka na sprężone powietrze - trzy krótkie "BWA" i długie "BWAAA" (rozstrojony akord piłokształtny
    // przez filtr, z płaską głośnością zamiast wybrzmiewania jak w tone())
    // UFO (wizyta UFO w ekwipunku): przylot - drgający "theremin" schodzący w dół i niski szum silnika
    ufoArrive() {
      if (!enabled) return;
      const c = ac(), t = c.currentTime;
      warble(t, 1.5, 1400, 520, { rate: 7, depth: 60, vol: 0.12 });
      warble(t + 0.05, 1.5, 700, 260, { rate: 7.3, depth: 30, vol: 0.06, type: "triangle" });
      hum(t, 1.6, 62, 0.16);
      noise(t, 1.4, { vol: 0.08, freq: 600, q: 0.7, type: "lowpass", slideTo: 260 });
    },
    // promień: lśniący akord wznoszący się w górę z tremolo + szum "zasysania"
    ufoBeam() {
      if (!enabled) return;
      const c = ac(), t = c.currentTime;
      [1, 1.25, 1.5, 2].forEach((m, i) => warble(t + i * 0.04, 2.4, 260 * m, 900 * m, { rate: 11 + i, depth: 8 * m, vol: 0.05, tremolo: 9 }));
      hum(t, 2.5, 55, 0.12);
      noise(t + 0.2, 2.2, { vol: 0.07, freq: 300, q: 1.5, slideTo: 5200 });
      tone(N.C7, t + 2.15, 0.35, { type: "sine", vol: 0.08 });   // "pyk" - karta w środku
    },
    // odlot: szybki świst w górę z efektem Dopplera
    ufoLeave() {
      if (!enabled) return;
      const c = ac(), t = c.currentTime;
      warble(t, 1.0, 500, 2600, { rate: 16, depth: 90, vol: 0.11 });
      warble(t + 0.08, 0.9, 250, 1300, { rate: 15, depth: 40, vol: 0.05, type: "triangle" });
      noise(t, 0.9, { vol: 0.09, freq: 800, q: 1, slideTo: 6000 });
    },

    airhorn() {
      if (!enabled) return;
      const c = ac(), t = c.currentTime;
      const f = c.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 2600; f.Q.value = 2;
      f.connect(master);
      [[0, 0.15], [0.2, 0.15], [0.4, 0.15], [0.62, 0.75]].forEach(([d, len]) => {
        [349.23, 440, 523.25, 698.46].forEach((hz, i) => {
          const o = c.createOscillator(), g = c.createGain(), s = t + d;
          o.type = "sawtooth";
          o.frequency.setValueAtTime(hz * (i % 2 ? 1.006 : 0.994), s);
          o.frequency.linearRampToValueAtTime(hz * 0.985, s + len);
          g.gain.setValueAtTime(0, s);
          g.gain.linearRampToValueAtTime(0.07, s + 0.02);
          g.gain.setValueAtTime(0.07, s + len - 0.04);
          g.gain.linearRampToValueAtTime(0, s + len);
          o.connect(g).connect(f);
          o.start(s); o.stop(s + len + 0.05);
        });
      });
    },

    ultra(noRise = false) {
      if (!enabled) return;
      const t = ac().currentTime;
      // narastanie
      if (!noRise) {
        tone(110, t, 1.0, { type: "sawtooth", vol: 0.1, slideTo: 880, attack: 0.6 });
        noise(t, 1.0, { vol: 0.25, freq: 300, q: 1, slideTo: 9000 });
      }
      // uderzenie
      const hit = t + (noRise ? 0 : 1.0);
      tone(55, hit, 1.8, { type: "sine", vol: 0.5 });
      noise(hit, 0.4, { vol: 0.5, freq: 200, q: 0.8, type: "lowpass" });
      // akord tęczowy
      [N.C4, N.G4, N.C5, N.E5, N.G5, N.C6, N.E6].forEach((f, i) => {
        tone(f, hit + i * 0.03, 2.2, { type: "sawtooth", vol: 0.05, attack: 0.03 });
        tone(f * 1.005, hit + i * 0.03, 2.2, { type: "triangle", vol: 0.05, attack: 0.03 });
      });
      // arpeggio
      const arp = [N.C6, N.E6, N.G6, N.C7, N.G6, N.E6, N.C6, N.E6, N.G6, N.C7];
      arp.forEach((f, i) => tone(f, hit + 0.2 + i * 0.08, 0.3, { type: "square", vol: 0.04 }));
      noise(hit, 2.0, { vol: 0.12, freq: 9000, q: 0.5, type: "highpass" });
    },

    coin(n = 1) {
      if (!enabled) return;
      const t = ac().currentTime;
      const reps = Math.min(n, 5);
      for (let i = 0; i < reps; i++) {
        const s = t + i * 0.08;
        tone(N.B5, s, 0.08, { type: "square", vol: 0.08 });
        tone(N.E6, s + 0.07, 0.3, { type: "square", vol: 0.08 });
      }
    },

    error() {
      if (!enabled) return;
      const t = ac().currentTime;
      tone(200, t, 0.15, { type: "square", vol: 0.1 });
      tone(150, t + 0.15, 0.25, { type: "square", vol: 0.1 });
    },

    page() {
      if (!enabled) return;
      const t = ac().currentTime;
      noise(t, 0.25, { vol: 0.25, freq: 1500, q: 0.6, slideTo: 600 });
    },
    // narastający dźwięk przed wielkim odsłonięciem
    charge(dur = 1.4, ultra = false) {
      if (!enabled) return;
      const t = ac().currentTime;
      tone(ultra ? 70 : 110, t, dur, { type: "sawtooth", vol: 0.12, slideTo: ultra ? 1400 : 880, attack: dur * 0.8 });
      tone(ultra ? 72 : 112, t, dur, { type: "square", vol: 0.05, slideTo: ultra ? 1420 : 890, attack: dur * 0.8 });
      noise(t, dur, { vol: 0.3, freq: 200, q: 1.5, slideTo: ultra ? 12000 : 7000 });
      // bicie serca
      const beats = Math.floor(dur / 0.25);
      for (let i = 0; i < beats; i++) {
        const s = t + i * dur / beats;
        tone(60, s, 0.12, { type: "sine", vol: 0.25 + 0.3 * i / beats });
      }
    },

    boom(ultra = false) {
      if (!enabled) return;
      const t = ac().currentTime;
      tone(ultra ? 45 : 60, t, ultra ? 2.2 : 1.4, { type: "sine", vol: 0.7, slideTo: 30 });
      noise(t, ultra ? 1.2 : 0.7, { vol: 0.7, freq: 900, q: 0.4, type: "lowpass", slideTo: 80 });
      noise(t, 0.15, { vol: 0.5, freq: 3000, q: 0.5 });
    },

    whoosh() {
      if (!enabled) return;
      const t = ac().currentTime;
      noise(t, 0.6, { vol: 0.35, freq: 300, q: 1, slideTo: 4000 });
    },

    win() {
      if (!enabled) return;
      const t = ac().currentTime;
      [N.C5, N.E5, N.G5, N.C6, N.E6].forEach((f, i) => {
        tone(f, t + i * 0.06, 0.5, { type: "square", vol: 0.07 });
        tone(f, t + i * 0.06, 0.6, { type: "triangle", vol: 0.12 });
      });
      noise(t + 0.3, 0.8, { vol: 0.12, freq: 9000, q: 0.5, type: "highpass" });
    },

    fail() {
      if (!enabled) return;
      const t = ac().currentTime;
      noise(t, 0.35, { vol: 0.6, freq: 2500, q: 0.8 });     // trzask
      noise(t + 0.05, 0.6, { vol: 0.3, freq: 600, q: 0.6, slideTo: 100 });
      [N.E4, N.D4, N.C4 * 0.9].forEach((f, i) => tone(f, t + 0.15 + i * 0.18, 0.4, { type: "sawtooth", vol: 0.08, slideTo: f * 0.85 }));
    },

    cash() {
      if (!enabled) return;
      const t = ac().currentTime;
      noise(t, 0.08, { vol: 0.5, freq: 1800, q: 2 });
      tone(N.E6, t + 0.05, 0.6, { type: "sine", vol: 0.15 });
      tone(N.G6, t + 0.05, 0.6, { type: "sine", vol: 0.1 });
      for (let i = 0; i < 8; i++) tone(N.B5 * (1 + Math.random() * 0.5), t + 0.15 + i * 0.05, 0.15, { type: "square", vol: 0.04 });
    },
    // ciemny, niski dron z biciem serca - początek odsłonięcia tajnej karty
    drone(ms = 3000) {
      if (!enabled) return;
      const t = ac().currentTime, d = ms / 1000;
      tone(41, t, d + 0.5, { type: "sawtooth", vol: 0.08, attack: d * 0.6 });
      tone(41.6, t, d + 0.5, { type: "sine", vol: 0.25, attack: d * 0.5 });
      tone(82, t, d + 0.5, { type: "triangle", vol: 0.06, attack: d * 0.7 });
      noise(t, d, { vol: 0.12, freq: 120, q: 2, type: "lowpass", slideTo: 400 });
      const beats = Math.max(3, Math.floor(d / 0.55));
      for (let i = 0; i < beats; i++) {
        const s = t + i * d / beats;
        tone(55, s, 0.14, { type: "sine", vol: 0.35 + 0.25 * i / beats });
        tone(50, s + 0.16, 0.12, { type: "sine", vol: 0.25 + 0.2 * i / beats });
      }
    },

    // chór + dzwony - wielkie odsłonięcie tajnej karty
    choir() {
      if (!enabled) return;
      const c = ac(), t = c.currentTime;
      const chord = [N.C4, N.G4, N.C5, N.E5, N.G5, N.C6];
      chord.forEach((f, i) => {
        // kilka lekko rozstrojonych głosów = efekt chóru
        [-0.006, 0, 0.006].forEach(det => {
          const o = c.createOscillator(), g = c.createGain(), lfo = c.createOscillator(), lg = c.createGain();
          o.type = i < 2 ? "sawtooth" : "triangle";
          o.frequency.value = f * (1 + det);
          lfo.frequency.value = 5 + Math.random(); lg.gain.value = f * 0.004;
          lfo.connect(lg).connect(o.frequency);
          g.gain.setValueAtTime(0, t);
          g.gain.linearRampToValueAtTime(i < 2 ? 0.03 : 0.045, t + 0.6);
          g.gain.linearRampToValueAtTime(0.03, t + 3);
          g.gain.exponentialRampToValueAtTime(0.0001, t + 5);
          o.connect(g).connect(master);
          o.start(t); lfo.start(t); o.stop(t + 5.1); lfo.stop(t + 5.1);
        });
      });
      // dzwony
      [N.C6, N.G5, N.E6, N.C6 * 2].forEach((f, i) => {
        const s = t + 0.4 + i * 0.55;
        tone(f, s, 2.2, { type: "sine", vol: 0.16 });
        tone(f * 2.76, s, 1.2, { type: "sine", vol: 0.05 });
        tone(f * 5.4, s, 0.6, { type: "sine", vol: 0.02 });
      });
      noise(t, 3, { vol: 0.08, freq: 9000, q: 0.4, type: "highpass" });
    },
  };
  return api;
})();
