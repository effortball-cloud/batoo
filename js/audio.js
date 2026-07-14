/* =========================================================
 * 바투(Batoo) — 사운드 엔진
 *
 * 외부 음원 파일 없이 전부 실시간 합성(Web Audio API) + 음성합성(SpeechSynthesis).
 *  - 저작권 이슈 없음, 오프라인 동작, 다운로드 불필요.
 *  - 로비 BGM: 동양풍 5음계 명상적 루프(전통 바둑 분위기).
 *  - 착수음, 히든 긴장 드론, 스캔 소나, 게임시작 공(gong), 음성 안내.
 *
 * 브라우저 자동재생 정책상 AudioContext는 첫 사용자 제스처에서 시작된다.
 * ========================================================= */
(function (global) {
  'use strict';

  const A = {
    ctx: null, master: null, musicGain: null, sfxGain: null,
    delay: null,
    muted: false,
    lobbyPlaying: false, lobbyTimer: null, drone: [],
    lobbyStyle: 'zen',        // 'zen' | 'arcade' | 'epic'
    styleBus: null,           // 현재 로비 BGM 스타일 전용 출력 버스
    step: 0, chordIdx: 0,
    hiddenNodes: null,
    _noise: null,
    mi: 8,
    voices: [],
  };

  const LOBBY_STYLES = ['zen', 'arcade', 'epic'];

  /* A단조 5음계(A C D E G)를 3옥타브로 펼침 — 명상적 동양풍 */
  const BASE = [220.00, 261.63, 293.66, 329.63, 392.00];
  const SCALE = [];
  for (let oct = -1; oct <= 1; oct++) {
    for (const f of BASE) SCALE.push(f * Math.pow(2, oct));
  }

  function ensure() {
    if (A.ctx) return A.ctx;
    const AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return null;
    try {
      A.ctx = new AC();
    } catch (e) { return null; }

    A.master = A.ctx.createGain();
    A.master.gain.value = A.muted ? 0 : 0.9;
    A.master.connect(A.ctx.destination);

    A.musicGain = A.ctx.createGain();
    A.musicGain.gain.value = 0.42;
    A.musicGain.connect(A.master);

    A.sfxGain = A.ctx.createGain();
    A.sfxGain.gain.value = 0.9;
    A.sfxGain.connect(A.master);

    // 공간감용 피드백 딜레이
    A.delay = A.ctx.createDelay(1.0);
    A.delay.delayTime.value = 0.28;
    const fb = A.ctx.createGain();
    fb.gain.value = 0.33;
    const out = A.ctx.createGain();
    out.gain.value = 0.45;
    A.delay.connect(fb); fb.connect(A.delay);
    A.delay.connect(out); out.connect(A.master);

    return A.ctx;
  }

  function resume() {
    if (A.ctx && A.ctx.state === 'suspended') { try { A.ctx.resume(); } catch (e) {} }
  }

  function noiseBuffer(dur) {
    const ctx = A.ctx;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /* ---------------- 로비 BGM (3가지 스타일) ---------------- */
  function pluck(freq, when, dur, gainVal, toDelay, dest) {
    const ctx = A.ctx;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = freq;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(gainVal, when + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(lp); lp.connect(g);
    g.connect(dest || A.musicGain);
    if (toDelay) g.connect(A.delay);
    o.start(when);
    o.stop(when + dur + 0.05);
  }

  function startLobbyBGM() {
    if (!ensure()) return;
    resume();
    if (A.lobbyPlaying) return;
    A.lobbyPlaying = true;
    // 스타일 전용 버스 — 전환 시 이 버스만 페이드하면 깔끔하게 끊긴다
    A.styleBus = A.ctx.createGain();
    A.styleBus.gain.value = 1;
    A.styleBus.connect(A.musicGain);
    if (A.lobbyStyle === 'arcade') { A.step = 0; arcadeStep(); }
    else if (A.lobbyStyle === 'epic') { A.chordIdx = 0; epicStep(); }
    else startZen();
  }

  /* --- 스타일 1: 고요한 기원 (전통 바둑 명상풍) --- */
  function startZen() {
    const ctx = A.ctx;
    [110, 164.81].forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = 0.0001;
      g.gain.linearRampToValueAtTime(i === 0 ? 0.09 : 0.05, ctx.currentTime + 2);
      o.connect(g); g.connect(A.styleBus);
      o.start();
      A.drone.push({ o, g });
    });
    zenStep();
  }

  function zenStep() {
    if (!A.lobbyPlaying || !A.ctx) return;
    const t = A.ctx.currentTime + 0.05;
    // 부드러운 랜덤 워크
    A.mi = Math.max(2, Math.min(SCALE.length - 2, A.mi + (Math.floor(Math.random() * 5) - 2)));
    if (Math.random() > 0.25) {
      pluck(SCALE[A.mi], t, 1.6, 0.16, true, A.styleBus);
      if (Math.random() > 0.6) pluck(SCALE[Math.max(0, A.mi - 3)], t + 0.02, 1.8, 0.09, true, A.styleBus); // 화음
    }
    A.lobbyTimer = setTimeout(zenStep, 560 + Math.floor(Math.random() * 120));
  }

  /* --- 스타일 2: 아케이드 (8비트 게임 로비풍) --- */
  const AR_STEP_MS = (60 / 132 / 2) * 1000; // 132BPM 8분음표
  const AR_MELODY = [ // A단조 32스텝 게임 루프
    440, 0, 523.25, 587.33, 659.25, 0, 587.33, 523.25,
    440, 0, 392, 440, 523.25, 0, 440, 0,
    349.23, 0, 440, 523.25, 659.25, 0, 523.25, 440,
    392, 440, 392, 329.63, 440, 0, 0, 0,
  ];
  const AR_BASS = [ // Am → F → G → E 진행
    110, 0, 110, 110, 110, 0, 110, 0,
    87.31, 0, 87.31, 87.31, 87.31, 0, 87.31, 0,
    98, 0, 98, 98, 98, 0, 98, 0,
    82.41, 0, 82.41, 82.41, 98, 0, 110, 0,
  ];

  function chip8(freq, when, dur, vol, type) {
    const ctx = A.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(vol, when + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(g); g.connect(A.styleBus);
    o.start(when); o.stop(when + dur + 0.03);
  }

  function hat8(when, vol) {
    const ctx = A.ctx;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(0.04);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 6500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    src.connect(hp); hp.connect(g); g.connect(A.styleBus);
    src.start(when); src.stop(when + 0.06);
  }

  function arcadeStep() {
    if (!A.lobbyPlaying || !A.ctx || !A.styleBus) return;
    const t = A.ctx.currentTime + 0.03;
    const s = A.step % 32;
    if (AR_MELODY[s]) chip8(AR_MELODY[s], t, 0.19, 0.085, 'square');
    if (AR_BASS[s]) chip8(AR_BASS[s], t, 0.2, 0.14, 'triangle');
    if (s % 2 === 0) hat8(t, s % 8 === 4 ? 0.05 : 0.026);
    A.step++;
    A.lobbyTimer = setTimeout(arcadeStep, AR_STEP_MS);
  }

  /* --- 스타일 3: 에픽 타이틀 (웅장한 게임 오프닝풍) --- */
  const EP_CHORDS = [ // Am → F → G → Am(고음)
    [220, 261.63, 329.63, 440],
    [174.61, 220, 261.63, 349.23],
    [196, 246.94, 293.66, 392],
    [220, 261.63, 329.63, 523.25],
  ];
  const EP_LEN = 2.6;

  function epicStep() {
    if (!A.lobbyPlaying || !A.ctx || !A.styleBus) return;
    const ctx = A.ctx;
    const t = ctx.currentTime + 0.05;
    const chord = EP_CHORDS[A.chordIdx % EP_CHORDS.length];
    // 디튠 소투스 패드 (스웰 인/아웃)
    chord.forEach((f) => {
      [0.996, 1.004].forEach((dt) => {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f * dt;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = 850;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.032, t + 0.8);
        g.gain.setValueAtTime(0.032, t + EP_LEN - 0.6);
        g.gain.linearRampToValueAtTime(0.0001, t + EP_LEN + 0.1);
        o.connect(lp); lp.connect(g); g.connect(A.styleBus);
        o.start(t); o.stop(t + EP_LEN + 0.2);
      });
    });
    // 상행 아르페지오
    for (let k = 0; k < 6; k++) {
      const f = chord[k % chord.length] * (k >= chord.length ? 2 : 1);
      pluck(f, t + 0.15 + k * 0.38, 1.1, 0.1, true, A.styleBus);
    }
    // 마디 시작 저음 붐 (팀파니 느낌)
    const b = ctx.createOscillator();
    b.type = 'sine';
    b.frequency.setValueAtTime(chord[0] / 2, t);
    b.frequency.exponentialRampToValueAtTime(chord[0] / 4, t + 0.5);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.16, t);
    bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    b.connect(bg); bg.connect(A.styleBus);
    b.start(t); b.stop(t + 1);
    A.chordIdx++;
    A.lobbyTimer = setTimeout(epicStep, EP_LEN * 1000);
  }

  function stopLobbyBGM() {
    A.lobbyPlaying = false;
    if (A.lobbyTimer) { clearTimeout(A.lobbyTimer); A.lobbyTimer = null; }
    if (!A.ctx) return;
    const now = A.ctx.currentTime;
    A.drone.forEach(({ o, g }) => {
      try {
        g.gain.cancelScheduledValues(now);
        g.gain.setValueAtTime(g.gain.value, now);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);
        o.stop(now + 0.65);
      } catch (e) {}
    });
    A.drone = [];
    // 이미 스케줄된 패드/멜로디 꼬리까지 버스째로 페이드아웃
    const bus = A.styleBus;
    if (bus) {
      try {
        bus.gain.setValueAtTime(bus.gain.value, now);
        bus.gain.linearRampToValueAtTime(0.0001, now + 0.5);
        setTimeout(() => { try { bus.disconnect(); } catch (e) {} }, 800);
      } catch (e) {}
      A.styleBus = null;
    }
  }

  /* ---------------- 착수음(바둑돌 딸깍) ---------------- */
  function stone() {
    if (!ensure()) return;
    resume();
    const ctx = A.ctx, when = ctx.currentTime;
    // 나무 부딪는 잡음 버스트
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(0.05);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1700 + Math.random() * 700;
    bp.Q.value = 6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.55, when);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.07);
    src.connect(bp); bp.connect(g); g.connect(A.sfxGain);
    src.start(when); src.stop(when + 0.1);
    // 몸통 "톡"
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(250 + Math.random() * 40, when);
    o.frequency.exponentialRampToValueAtTime(150, when + 0.06);
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.5, when);
    g2.gain.exponentialRampToValueAtTime(0.001, when + 0.09);
    o.connect(g2); g2.connect(A.sfxGain);
    o.start(when); o.stop(when + 0.11);
  }

  /* ---------------- 저음 임팩트(공/붐) ---------------- */
  function boom(freqStart, gainVal) {
    const ctx = A.ctx, when = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(freqStart, when);
    o.frequency.exponentialRampToValueAtTime(freqStart * 0.5, when + 0.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gainVal, when);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.7);
    o.connect(g); g.connect(A.sfxGain);
    o.start(when); o.stop(when + 0.75);
    // 저역 노이즈 타격
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(0.15);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 200;
    const gn = ctx.createGain();
    gn.gain.setValueAtTime(gainVal * 0.6, when);
    gn.gain.exponentialRampToValueAtTime(0.001, when + 0.25);
    src.connect(lp); lp.connect(gn); gn.connect(A.sfxGain);
    src.start(when); src.stop(when + 0.2);
  }

  /* ---------------- 히든 긴장 드론 ---------------- */
  function hiddenArm() {
    if (!ensure()) return;
    resume();
    if (A.hiddenNodes) return;
    const ctx = A.ctx, when = ctx.currentTime;
    const o1 = ctx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 55;
    const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = 55.6; // 맥놀이
    const o3 = ctx.createOscillator(); o3.type = 'sine';
    o3.frequency.setValueAtTime(110, when);
    o3.frequency.linearRampToValueAtTime(196, when + 8); // 서서히 고조되는 긴장
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(300, when);
    lp.frequency.linearRampToValueAtTime(700, when + 8);
    // 트레몰로
    const trem = ctx.createGain(); trem.gain.value = 0.82;
    const lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 5.2;
    const lfoG = ctx.createGain(); lfoG.gain.value = 0.16;
    lfo.connect(lfoG); lfoG.connect(trem.gain);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.5, when + 1.2); // 서서히 부풀어오름
    o1.connect(lp); o2.connect(lp); o3.connect(lp);
    lp.connect(trem); trem.connect(g); g.connect(A.sfxGain);
    o1.start(); o2.start(); o3.start(); lfo.start();
    boom(70, 0.55); // 시작 타격
    A.hiddenNodes = { nodes: [o1, o2, o3, lfo], g };
  }

  function hiddenStop(resolved) {
    if (!A.hiddenNodes || !A.ctx) return;
    const now = A.ctx.currentTime, h = A.hiddenNodes;
    try {
      h.g.gain.cancelScheduledValues(now);
      h.g.gain.setValueAtTime(h.g.gain.value, now);
      h.g.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
      h.nodes.forEach((o) => { try { o.stop(now + 0.4); } catch (e) {} });
    } catch (e) {}
    A.hiddenNodes = null;
    if (resolved) boom(48, 0.9); // 히든 착수 확정 타격
  }

  /* ---------------- 스캔(소나) ---------------- */
  function scanArm() {
    if (!ensure()) return;
    resume();
    const ctx = A.ctx, when = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(300, when);
    o.frequency.exponentialRampToValueAtTime(1300, when + 0.5); // 전원 인가 스윕
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.22, when + 0.4);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.72);
    o.connect(g); g.connect(A.sfxGain);
    o.start(when); o.stop(when + 0.75);
  }

  function pingTone(when, freq, gainVal) {
    const ctx = A.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(gainVal, when + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.4);
    o.connect(g);
    g.connect(A.sfxGain);
    g.connect(A.delay); // 에코로 소나 느낌
    o.start(when); o.stop(when + 0.45);
  }

  function scanPing(found) {
    if (!ensure()) return;
    resume();
    const when = A.ctx.currentTime;
    pingTone(when, found ? 880 : 520, 0.3);
    // 두 번째 음: 발견 시 상행(성공), 미발견 시 하행(실패)
    pingTone(when + 0.2, found ? 1320 : 400, 0.28);
    if (found) pingTone(when + 0.4, 1760, 0.2);
  }

  /* ---------------- 게임 시작 공(gong) / 승리 차임 ---------------- */
  function gong() {
    if (!ensure()) return;
    resume();
    const ctx = A.ctx, when = ctx.currentTime;
    [1, 2, 2.97, 4.13, 5.4].forEach((mult, idx) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = 196 * mult;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(0.32 / (idx + 1), when + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 2.4);
      o.connect(g); g.connect(A.sfxGain); g.connect(A.delay);
      o.start(when); o.stop(when + 2.5);
    });
  }

  function chime(win) {
    if (!ensure()) return;
    resume();
    const ctx = A.ctx;
    const notes = win ? [392, 493.9, 587.3, 784] : [392, 329.6, 261.6];
    notes.forEach((f, i) => pluck(f, ctx.currentTime + i * 0.16, 1.2, 0.22, true));
  }

  /* ---------------- 음성 안내(SpeechSynthesis) ---------------- */
  function loadVoices() {
    try {
      const ss = global.speechSynthesis;
      if (ss) A.voices = ss.getVoices() || [];
    } catch (e) {}
  }

  function pickVoice(lang) {
    if (!A.voices.length) loadVoices();
    if (!lang) return null;
    const pre = lang.slice(0, 2).toLowerCase();
    return A.voices.find((v) => v.lang && v.lang.toLowerCase().startsWith(pre)) || null;
  }

  function say(text, opts) {
    opts = opts || {};
    try {
      const ss = global.speechSynthesis;
      if (!ss) return;
      if (A.muted) return;
      const u = new SpeechSynthesisUtterance(text);
      u.rate = opts.rate || 1;
      u.pitch = opts.pitch != null ? opts.pitch : 1;
      u.volume = opts.volume != null ? opts.volume : 1;
      if (opts.lang) u.lang = opts.lang;
      const v = pickVoice(opts.lang);
      if (v) u.voice = v;
      if (opts.delay) setTimeout(() => { try { ss.speak(u); } catch (e) {} }, opts.delay);
      else ss.speak(u);
    } catch (e) {}
  }

  /* ---------------- 상위 이벤트 API ---------------- */
  const Audio = {
    lobby() { startLobbyBGM(); },
    stopLobby() { stopLobbyBGM(); },
    setLobbyStyle(id) {
      if (LOBBY_STYLES.indexOf(id) < 0) return;
      A.lobbyStyle = id;
      try { localStorage.setItem('batoo-bgm', id); } catch (e) {}
      if (A.lobbyPlaying) { stopLobbyBGM(); startLobbyBGM(); } // 재생 중이면 즉시 전환
    },
    getLobbyStyle() { return A.lobbyStyle; },
    gameStart() {
      stopLobbyBGM();
      gong();
      say('Game start', { lang: 'en-US', rate: 0.95, pitch: 1.05, delay: 260 });
    },
    stone() { stone(); },
    hiddenArm() { hiddenArm(); },
    hiddenPlaced() { hiddenStop(true); },
    hiddenCancel() { hiddenStop(false); },
    opponentHidden() { if (ensure()) { resume(); boom(90, 0.4); } },
    scanArm() { scanArm(); },
    scanPing(found) { scanPing(!!found); },
    pass() { say('Pass', { lang: 'en-US', rate: 0.95 }); },
    scoring() {
      say('계가를 시작합니다. 죽은 돌을 지정한 뒤 계가를 확정하세요.', { lang: 'ko-KR', rate: 1 });
    },
    result(win) { chime(win); },
    isMuted() { return A.muted; },
    _state() { return { ctx: A.ctx && A.ctx.state, lobby: A.lobbyPlaying, style: A.lobbyStyle, muted: A.muted, hidden: !!A.hiddenNodes }; },
    setMuted(m) {
      A.muted = !!m;
      if (A.master && A.ctx) {
        A.master.gain.setTargetAtTime(A.muted ? 0 : 0.9, A.ctx.currentTime, 0.02);
      }
      if (A.muted) { try { global.speechSynthesis && global.speechSynthesis.cancel(); } catch (e) {} }
      try { localStorage.setItem('batoo-muted', A.muted ? '1' : '0'); } catch (e) {}
      updateBtn();
    },
    toggle() { this.setMuted(!A.muted); },
  };

  function updateBtn() {
    const b = document.getElementById('btn-sound');
    if (b) {
      b.textContent = A.muted ? '🔇' : '🔊';
      b.classList.toggle('muted', A.muted);
      b.title = A.muted ? '소리 켜기' : '소리 끄기';
    }
  }

  /* ---------------- 초기화(첫 제스처에서 오디오 활성) ---------------- */
  function setup() {
    try { A.muted = localStorage.getItem('batoo-muted') === '1'; } catch (e) {}
    try {
      const st = localStorage.getItem('batoo-bgm');
      if (st && LOBBY_STYLES.indexOf(st) >= 0) A.lobbyStyle = st;
    } catch (e) {}
    loadVoices();
    try {
      if (global.speechSynthesis) global.speechSynthesis.onvoiceschanged = loadVoices;
    } catch (e) {}

    const btn = document.getElementById('btn-sound');
    if (btn) btn.addEventListener('click', () => Audio.toggle());
    updateBtn();

    // 첫 사용자 제스처: 오디오 컨텍스트 활성 + (로비면) BGM 시작
    const onFirst = (e) => {
      ensure();
      resume();
      const onLobby = !document.getElementById('screen-lobby').classList.contains('hidden');
      const toStart = e && e.target && e.target.closest && e.target.closest('#btn-start');
      if (onLobby && !toStart && !A.muted) startLobbyBGM();
    };
    document.addEventListener('pointerdown', onFirst, { once: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setup);
  } else {
    setup();
  }

  global.BatooAudio = Audio;
})(window);
