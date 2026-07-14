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
    hiddenNodes: null,
    _noise: null,
    mi: 8,
    voices: [],
  };

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

  /* ---------------- 로비 BGM ---------------- */
  function pluck(freq, when, dur, gainVal, toDelay) {
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
    g.connect(A.musicGain);
    if (toDelay) g.connect(A.delay);
    o.start(when);
    o.stop(when + dur + 0.05);
  }

  function startLobbyBGM() {
    if (!ensure()) return;
    resume();
    if (A.lobbyPlaying) return;
    A.lobbyPlaying = true;
    // 저음 드론 2개(완전5도)
    const ctx = A.ctx;
    [110, 164.81].forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = 0.0001;
      g.gain.linearRampToValueAtTime(i === 0 ? 0.09 : 0.05, ctx.currentTime + 2);
      o.connect(g); g.connect(A.musicGain);
      o.start();
      A.drone.push({ o, g });
    });
    lobbyStep();
  }

  function lobbyStep() {
    if (!A.lobbyPlaying || !A.ctx) return;
    const t = A.ctx.currentTime + 0.05;
    // 부드러운 랜덤 워크
    A.mi = Math.max(2, Math.min(SCALE.length - 2, A.mi + (Math.floor(Math.random() * 5) - 2)));
    if (Math.random() > 0.25) {
      pluck(SCALE[A.mi], t, 1.6, 0.16, true);
      if (Math.random() > 0.6) pluck(SCALE[Math.max(0, A.mi - 3)], t + 0.02, 1.8, 0.09, true); // 화음
    }
    A.lobbyTimer = setTimeout(lobbyStep, 560 + Math.floor(Math.random() * 120));
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
    _state() { return { ctx: A.ctx && A.ctx.state, lobby: A.lobbyPlaying, muted: A.muted, hidden: !!A.hiddenNodes }; },
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
