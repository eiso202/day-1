(() => {
  const canvas = document.getElementById('stage'), ctx = canvas.getContext('2d');
  const status = document.getElementById('audio-status');
  const W = 1248, H = 2003, COUNT = 21, SAND = '#e7d7b9';
  const frame = { left: 61, right: 1187, top: 737, bottom: 1266 };
  // Three calm D-major registers: no muddy bass strings, with a clear melodic rise.
  const pentatonic = [0, 2, 4, 5, 7, 9, 11];
  const pitches = Array.from({ length: COUNT }, (_, i) => {
    const midi = 50 + pentatonic[i % 7] + Math.floor(i / 7) * 12;
    return 440 * 2 ** ((midi - 69) / 12);
  });
  let scale = 1, offsetX = 0, offsetY = 0, viewW = 0, viewH = 0, dpr = 1;
  let segments = [], nextId = 0, pointer = null, gesture = null, lastTime = 0;
  let audio = null, requestId = 0;
  const active = new Set();
  function segment(voice, y1, y2) {
    return { id: ++nextId, voice, x: voice * W / 20, y1, y2, amp: 0, phase: 0, pluck: .5 };
  }
  function resetStrings() {
    requestId++;
    segments = Array.from({ length: COUNT }, (_, voice) => segment(voice, 0, H));
    canvas.dataset.segments = String(segments.length);
  }
  function triangle() {
    ctx.beginPath(); ctx.moveTo(114, 836); ctx.lineTo(624, 1196); ctx.lineTo(1134, 836); ctx.closePath();
  }
  function visible(x, y) {
    if (x < 0 || x > W || y < 0 || y > H) return false;
    if (x < frame.left || x > frame.right || y < frame.top || y > frame.bottom) return true;
    return y >= 836 && y <= 1196 && Math.abs(x - 624) <= 510 * (1196 - y) / 360;
  }
  function point(e) { return { x: (e.clientX - offsetX) / scale, y: (e.clientY - offsetY) / scale }; }
  function nearest(p) {
    if (!p || !visible(p.x, p.y)) return null;
    let best = null, distance = Math.min(24, 9 / scale);
    for (const s of segments) {
      if (p.y < s.y1 || p.y > s.y2) continue;
      const d = Math.abs(p.x - s.x);
      if (d <= distance) { distance = d; best = s; }
    }
    return best;
  }
  function layout() {
    viewW = innerWidth; viewH = innerHeight;
    dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(viewW * dpr); canvas.height = Math.round(viewH * dpr);
    scale = Math.min(viewW / W, viewH / H);
    offsetX = (viewW - W * scale) / 2; offsetY = (viewH - H * scale) / 2;
    pointer = null; gesture = null;
  }
  function createAudio() {
    if (audio) return audio;
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const master = ac.createGain(); master.gain.value = .6;
    const limiter = ac.createDynamicsCompressor();
    limiter.threshold.value = -12; limiter.knee.value = 8; limiter.ratio.value = 5;
    limiter.attack.value = .003; limiter.release.value = .18;
    master.connect(limiter).connect(ac.destination);
    const room = ac.createConvolver(), impulse = ac.createBuffer(2, ac.sampleRate * 2, ac.sampleRate);
    for (let c = 0; c < 2; c++) {
      const data = impulse.getChannelData(c); let smooth = 0;
      for (let i = 0; i < data.length; i++) {
        smooth = .65 * smooth + .35 * (Math.random() * 2 - 1);
        data[i] = i < ac.sampleRate * .025 ? 0 : smooth * Math.exp(-i / ac.sampleRate * 3.5);
      }
    }
    room.buffer = impulse;
    const wet = ac.createGain(); wet.gain.value = .24;
    room.connect(wet).connect(master);
    audio = { ac, master, room };
    return audio;
  }
  function prepareAudio() {
    const { ac } = createAudio();
    if (ac.state === 'suspended') ac.resume();
    canvas.dataset.audio = 'ready'; status.textContent = '';
    return audio;
  }
  function makePluckedString(ac, hz, seconds, voice) {
    const frames = Math.ceil((seconds + .08) * ac.sampleRate);
    const buffer = ac.createBuffer(1, frames, ac.sampleRate);
    const out = buffer.getChannelData(0);
    const delaySize = Math.max(8, Math.round(ac.sampleRate / hz));
    const delay = new Float32Array(delaySize);
    const brightness = .43 + (voice % 5) * .035;
    const decay = Math.pow(.00035, 1 / Math.max(1, seconds * ac.sampleRate));

    // Short, shaped noise is the pick. Its feedback loop is the string.
    let previous = 0;
    for (let i = 0; i < delaySize; i++) {
      const noise = Math.random() * 2 - 1;
      previous = previous * .8 + noise * .2;
      delay[i] = previous * Math.sin(Math.PI * i / delaySize);
    }
    for (let i = 0, index = 0; i < frames; i++, index = (index + 1) % delaySize) {
      const current = delay[index];
      const following = delay[(index + 1) % delaySize];
      const filtered = current * (1 - brightness) + following * brightness;
      delay[index] = filtered * decay;
      const attack = i < ac.sampleRate * .018 ? 1 + (Math.random() * 2 - 1) * .09 : 1;
      out[i] = current * attack;
    }
    return buffer;
  }
  function pluck(s, y) {
    requestId++;
    s.amp = 22; s.phase = 0; s.pluck = (y - s.y1) / (s.y2 - s.y1);
    prepareAudio();
    const { ac, master, room } = audio, hz = pitches[s.voice];
    const length = (s.y2 - s.y1) / H;
    const duration = .55 + 4.1 * length ** .72, now = ac.currentTime;
    const source = ac.createBufferSource(); source.buffer = makePluckedString(ac, hz, duration, s.voice);
    const gain = ac.createGain(), pan = ac.createStereoPanner(), send = ac.createGain();
    const body = ac.createBiquadFilter(), warmth = ac.createBiquadFilter();
    const resonance = ac.createOscillator(), resonanceGain = ac.createGain();
    pan.pan.value = -.55 + s.voice / 20 * 1.1; send.gain.value = .15 + length * .75;
    body.type = 'peaking'; body.frequency.value = Math.min(1450, 210 + hz * 1.45); body.Q.value = 1.1; body.gain.value = 3.4;
    warmth.type = 'lowpass'; warmth.frequency.value = Math.min(7200, 2200 + hz * 4.2); warmth.Q.value = .55;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(.68, now + .008);
    gain.gain.setValueAtTime(.68, now + duration * .43);
    gain.gain.exponentialRampToValueAtTime(.0001, now + duration);
    source.connect(body).connect(warmth).connect(gain).connect(pan).connect(master); pan.connect(send).connect(room);
    // A very soft fundamental bloom carries the note after the initial pluck.
    resonance.type = 'sine';
    resonance.frequency.setValueAtTime(hz * 1.003, now);
    resonance.frequency.exponentialRampToValueAtTime(hz, now + .16);
    resonanceGain.gain.setValueAtTime(.0001, now);
    resonanceGain.gain.exponentialRampToValueAtTime(.045, now + .035);
    resonanceGain.gain.exponentialRampToValueAtTime(.0001, now + duration * 1.08);
    resonance.connect(resonanceGain).connect(warmth);
    resonance.start(now); resonance.stop(now + duration * 1.1);
    if (active.size >= 20) active.values().next().value.stop();
    active.add(source);
    source.onended = () => { active.delete(source); source.disconnect(); body.disconnect(); warmth.disconnect(); resonance.disconnect(); resonanceGain.disconnect(); gain.disconnect(); pan.disconnect(); send.disconnect(); };
    source.start(now); source.stop(now + duration + .02);
    canvas.dataset.lastPitch = hz.toFixed(3); canvas.dataset.lastDuration = duration.toFixed(3);
    canvas.dataset.plucks = String(Number(canvas.dataset.plucks || 0) + 1);
  }
  function cut(a, b) {
    if (Math.abs(b.x - a.x) < .001) return;
    const result = [];
    for (const s of segments) {
      const t = (s.x - a.x) / (b.x - a.x), y = a.y + (b.y - a.y) * t;
      if (t >= 0 && t <= 1 && y > s.y1 + 14 && y < s.y2 - 14 && visible(s.x, y)) {
        const gap = 8 / scale;
        if (y - gap / 2 - s.y1 > 8) result.push(segment(s.voice, s.y1, y - gap / 2));
        if (s.y2 - y - gap / 2 > 8) result.push(segment(s.voice, y + gap / 2, s.y2));
      } else result.push(s);
    }
    segments = result; canvas.dataset.segments = String(segments.length);
  }
  function strings() {
    const hot = nearest(pointer);
    for (const s of segments) {
      ctx.beginPath(); ctx.strokeStyle = s === hot ? '#c9ae7e' : SAND; ctx.lineWidth = s === hot ? 2.5 : 2;
      const steps = Math.ceil((s.y2 - s.y1) / 12);
      for (let j = 0; j <= steps; j++) {
        const t = j / steps, y = s.y1 + (s.y2 - s.y1) * t;
        const displacement = Math.sin(s.phase) * s.amp * Math.sin(Math.PI * t) * (.4 + .6 * Math.exp(-(((t - s.pluck) * 2.6) ** 2)));
        if (j) ctx.lineTo(s.x + displacement, y); else ctx.moveTo(s.x, y);
      }
      ctx.stroke();
    }
    canvas.style.cursor = gesture?.cutting ? 'crosshair' : hot ? 'pointer' : 'default';
  }
  function text() {
    ctx.fillStyle = 'white'; ctx.textAlign = 'left'; ctx.font = '38px Arial, sans-serif';
    ctx.fillText('EISO', 81, 776); ctx.fillText('DESIGN', 81, 811);
    ctx.textAlign = 'right'; ctx.fillText('2026', 1164, 776); ctx.fillText('09', 1164, 811);
    ctx.textAlign = 'left'; ctx.fillText('VIBE CODING', 89, 1245);
    ctx.textAlign = 'right'; ctx.font = '28px "PingFang SC", sans-serif';
    ctx.fillText('点击拨弦 · 按住拖拽切断 · R重置', 1168, 1244, 390);
    ctx.font = '84px Didot, "Times New Roman", serif'; ctx.textAlign = 'center';
    ctx.fillStyle = 'white'; ctx.fillText('Lines & Chords', 632, 1094, 530);
    ctx.save(); triangle(); ctx.clip(); ctx.fillStyle = SAND;
    ctx.fillText('Lines & Chords', 632, 1094, 530); ctx.restore();
  }
  function draw(time) {
    const dt = Math.min(.05, (time - (lastTime || time)) / 1000); lastTime = time;
    for (const s of segments) { s.phase += dt * 2 * Math.PI * (7 + s.voice * .15); s.amp *= Math.exp(-3.2 * dt); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, viewW, viewH);
    ctx.translate(offsetX, offsetY); ctx.scale(scale, scale);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
    strings();
    ctx.fillStyle = SAND; ctx.fillRect(frame.left, frame.top, frame.right-frame.left, frame.bottom-frame.top);
    triangle(); ctx.fillStyle = 'white'; ctx.fill();
    ctx.save(); triangle(); ctx.clip(); strings(); ctx.restore(); text();
    if (gesture?.cutting) {
      ctx.strokeStyle = '#a08b67'; ctx.lineWidth = 1 / scale; ctx.setLineDash([5 / scale, 6 / scale]);
      ctx.beginPath(); gesture.points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.restore(); requestAnimationFrame(draw);
  }
  canvas.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const p = point(e); if (p.x < 0 || p.x > W || p.y < 0 || p.y > H) return;
    canvas.setPointerCapture(e.pointerId); pointer = p;
    prepareAudio();
    gesture = { points: [p], cutting: false, length: 0 };
  });
  function move(e) {
    const p = point(e); pointer = p; if (!gesture) return;
    const last = gesture.points[gesture.points.length-1];
    if (Math.hypot(p.x-last.x, p.y-last.y) * scale < 2) return;
    gesture.length += Math.hypot(p.x-last.x, p.y-last.y) * scale; gesture.points.push(p);
    if (!gesture.cutting && gesture.length >= 14) {
      gesture.cutting = true;
      for (let i=1; i<gesture.points.length; i++) cut(gesture.points[i-1], gesture.points[i]);
    } else if (gesture.cutting) cut(last, p);
  }
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', e => {
    if (!gesture) return;
    move(e);
    if (!gesture.cutting) { const p = point(e), s = nearest(p); if (s) pluck(s, p.y); }
    gesture = null; if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointercancel', () => { gesture = null; });
  canvas.addEventListener('pointerleave', () => { if (!gesture) pointer = null; });
  window.addEventListener('blur', () => { gesture = null; pointer = null; });
  window.addEventListener('keydown', e => { if (e.key.toLowerCase() === 'r') resetStrings(); });
  window.addEventListener('resize', layout);
  resetStrings(); layout(); requestAnimationFrame(draw);
})();
