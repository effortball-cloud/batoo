/* =========================================================
 * 바투(Batoo) — 앱 상태 머신 / 화면 전환 / 입력 처리
 * 모드:
 *  - hotseat: 한 기기에서 1P/2P 교대 (비밀 단계는 핸드오프 화면으로 가림)
 *  - host/guest: PeerJS 온라인 1:1
 * ========================================================= */
(function () {
  'use strict';

  const { BatooGame, EMPTY, BLACK, WHITE, other } = window.Batoo;
  const { BoardView } = window.BatooUI;
  const { NetSession } = window.BatooNet;
  const MAPS = window.BatooMaps;

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  /* ---------------- 상태 ---------------- */
  const App = {
    mode: 'hotseat',      // hotseat | host | guest
    net: null,
    game: null,
    view: null,
    mapId: 'genesis',
    names: { 1: '플레이어 1', 2: '플레이어 2' },
    myPlayer: null,        // 온라인에서 1(방장)/2(참가자), hotseat이면 null
    playerColor: { 1: BLACK, 2: WHITE },  // 베팅 전 잠정 배정
    stage: 'lobby',        // lobby | base | betting | play | scoring | over
    clickMode: 'move',     // move | hidden | scan
    base: null,            // { current, picks:{1:[],2:[]}, confirmed:{1,2} }
    bet: null,             // { round, bids:{1:null,2:null} }
    deadSet: new Set(),
    scoreConfirmed: { 1: false, 2: false },
    rematchWant: { 1: false, 2: false },
    tempReveal: new Set(),
    clocks: { 1: 0, 2: 0 },
    clockTimer: null,
    byoyomi: null,          // null(무제한) | { sec, periods }
    byo: null,              // { 1:{left,count}, 2:{left,count} } 진행 상태
    _clockTurn: null,
    lobby: null,            // LobbyClient (공개방 목록)
    publicCode: null,       // 내가 만든 공개방 코드
  };

  const colorPlayer = (c) => (App.playerColor[1] === c ? 1 : 2);
  const nameOfColor = (c) => App.names[colorPlayer(c)];
  const isOnline = () => App.mode === 'host' || App.mode === 'guest' || App.mode === 'public';
  const myColor = () => (isOnline() ? App.playerColor[App.myPlayer] : null);
  // 지금 이 기기에서 조작 중인 플레이어 번호
  const actor = () => (isOnline() ? App.myPlayer : colorPlayer(App.game.turn));
  const canAct = () => {
    if (!App.game || App.game.phase !== 'play') return false;
    if (isOnline()) return App.game.turn === myColor();
    return true; // hotseat: 항상 현재 턴 주인이 조작
  };

  /* ---------------- 토스트 ---------------- */
  function toast(msg, kind, ms) {
    const box = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    box.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 350);
    }, ms || 3200);
  }

  function setStatus(msg) { $('#status-msg').textContent = msg; }
  function setPhaseChip(txt) { $('#phase-chip').textContent = txt; }

  /* ---------------- 오버레이 ---------------- */
  function showOverlay(id) { $$('.overlay').forEach((o) => o.classList.remove('show')); if (id) $(id).classList.add('show'); }
  function hideOverlays() { $$('.overlay').forEach((o) => o.classList.remove('show')); }

  function handoff(title, desc, cb) {
    $('#handoff-title').textContent = title;
    $('#handoff-desc').textContent = desc;
    showOverlay('#ov-handoff');
    $('#btn-handoff-ok').onclick = () => { hideOverlays(); cb(); };
  }

  function confirmDialog(msg, cb) {
    $('#confirm-msg').textContent = msg;
    showOverlay('#ov-confirm');
    $('#btn-confirm-yes').onclick = () => { hideOverlays(); cb(true); };
    $('#btn-confirm-no').onclick = () => { hideOverlays(); cb(false); };
  }

  /* ---------------- 로비 ---------------- */
  function initLobby() {
    // 모드 카드
    $$('.mode-card').forEach((card) => {
      card.onclick = () => {
        $$('.mode-card').forEach((c) => c.classList.remove('selected'));
        card.classList.add('selected');
        App.mode = card.dataset.mode;
        const m = App.mode;
        $('#join-row').style.display = m === 'guest' ? 'flex' : 'none';
        $('#name-p2-row').style.display = m === 'hotseat' ? 'flex' : 'none';
        // 맵은 만드는 쪽만 고른다(참가 시엔 방장 맵을 따름)
        $('#map-section').style.display = (m === 'guest') ? 'none' : 'block';
        $('#name-p1-label').textContent = m === 'hotseat' ? '1P 이름' : '내 이름';
        $('#online-public').style.display = m === 'public' ? 'block' : 'none';
        $('#btn-start').style.display = m === 'public' ? 'none' : 'block';
        if (m === 'public') initPublicLobby();
        else teardownPublicLobby();
      };
    });

    // 공개방 버튼
    $('#btn-create-public').onclick = createPublicRoom;
    $('#btn-refresh-public').onclick = () => { if (App.lobby) renderRooms([...App.lobby.rooms.values()].map((r) => r.info)); };

    // 맵 카드
    const mapList = $('#map-list');
    mapList.innerHTML = '';
    Object.values(MAPS).forEach((m) => {
      const el = document.createElement('div');
      el.className = 'map-card' + (m.id === App.mapId ? ' selected' : '');
      el.innerHTML = `<div class="map-name">${m.name}</div>
        <div class="map-size">${m.size}×${m.size}</div>
        <div class="map-desc">${m.desc}</div>
        <div class="map-pts">+점 ${m.plus.length} / −점 ${m.minus.length}</div>`;
      el.onclick = () => {
        App.mapId = m.id;
        $$('.map-card').forEach((c) => c.classList.remove('selected'));
        el.classList.add('selected');
      };
      mapList.appendChild(el);
    });

    // 초읽기 카드
    $$('.byo-card').forEach((card) => {
      card.onclick = () => {
        $$('.byo-card').forEach((c) => c.classList.remove('selected'));
        card.classList.add('selected');
      };
    });

    if (!new NetSession().available()) {
      $('#online-warn').style.display = 'block';
    }

    $('#btn-start').onclick = onLobbyStart;
  }

  function readByoyomi() {
    const byoCard = $('.byo-card.selected');
    const byoSec = byoCard ? parseInt(byoCard.dataset.sec, 10) : 0;
    App.byoyomi = byoSec > 0 ? { sec: byoSec, periods: 3 } : null;
  }

  /* 공통 온라인 핸들러 배선 (호스트/게스트/공개방 공용) */
  function wireNet() {
    App.net = new NetSession();
    App.net
      .on('error', (m) => { toast(m, 'bad', 5000); showLobby(); })
      .on('close', () => { toast('상대와의 연결이 끊어졌습니다.', 'bad', 6000); })
      .on('message', onNetMessage);
  }

  function onLobbyStart() {
    App.names[1] = $('#name-p1').value.trim() || (App.mode === 'hotseat' ? '플레이어 1' : '나');
    App.names[2] = $('#name-p2').value.trim() || '플레이어 2';
    readByoyomi();

    if (App.mode === 'hotseat') {
      startGame();
      return;
    }
    // 온라인
    wireNet();

    if (App.mode === 'host') {
      App.myPlayer = 1;
      App.net.on('waiting', (code) => {
        $('#wait-msg').textContent = '상대가 접속하길 기다리는 중…';
        $('#room-code').textContent = code;
        $('#room-code-row').style.display = 'block';
        showOverlay('#ov-wait');
      });
      App.net.on('open', () => {
        App.net.send({ t: 'hello', name: App.names[1] });
      });
      App.net.host();
    } else {
      const code = $('#join-code').value.trim();
      if (!code) { toast('방 코드를 입력하세요.', 'bad'); return; }
      App.myPlayer = 2;
      App.names[2] = App.names[1]; // 입력 필드는 하나(내 이름) → 참가자는 P2
      App.names[1] = '상대';
      $('#wait-msg').textContent = '방에 접속하는 중…';
      $('#room-code-row').style.display = 'none';
      showOverlay('#ov-wait');
      App.net.on('open', () => {
        App.net.send({ t: 'hello', name: App.names[2] });
      });
      App.net.join(code);
    }
  }

  /* ---------------- 공개방 로비 ---------------- */
  function initPublicLobby() {
    if (App.lobby) return;
    const { LobbyClient } = window.BatooNet;
    App.lobby = new LobbyClient();
    if (!App.lobby.available()) {
      setLobbyStatus('error', 'MQTT 로비 라이브러리를 불러오지 못했습니다. 코드방을 이용하세요.');
      $('#room-list').innerHTML = '<div class="room-empty">공개 로비를 사용할 수 없습니다.</div>';
      return;
    }
    setLobbyStatus('connecting', '로비에 연결하는 중…');
    $('#room-list').innerHTML = '<div class="room-empty">로비에 연결하는 중…</div>';
    App.lobby.connect({
      status: setLobbyStatus,
      change: renderRooms,
    });
  }

  function teardownPublicLobby() {
    if (App.lobby) { App.lobby.disconnect(); App.lobby = null; }
  }

  function setLobbyStatus(kind, msg) {
    const el = $('#lobby-status');
    if (!el) return;
    el.className = 'lobby-status' + (kind === 'ok' ? ' ok' : kind === 'error' ? ' error' : ' connecting');
    el.textContent = msg;
  }

  function renderRooms(rooms) {
    const list = $('#room-list');
    if (!list) return;
    rooms = (rooms || []).slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
    if (!rooms.length) {
      list.innerHTML = '<div class="room-empty">열린 방이 없습니다. 「공개방 만들기」로 방을 열고 상대를 기다려보세요.</div>';
      return;
    }
    list.innerHTML = '';
    rooms.forEach((r) => {
      const mapName = (MAPS[r.map] && MAPS[r.map].name) || r.map || '?';
      const el = document.createElement('div');
      el.className = 'room-item';
      el.innerHTML =
        `<span class="r-host">${escapeHtml(r.name || '익명')}</span>` +
        `<span class="r-meta">${mapName} · ${r.size}×${r.size}</span>` +
        `<span class="r-badge">대기중</span>` +
        `<button class="r-join">참가</button>`;
      el.querySelector('.r-join').onclick = () => joinPublicRoom(r.id, r.name);
      list.appendChild(el);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function createPublicRoom() {
    if (!new NetSession().available()) { toast('PeerJS를 불러오지 못해 온라인 대전을 할 수 없습니다.', 'bad', 5000); return; }
    App.mode = 'public';
    App.myPlayer = 1;
    App.names[1] = $('#name-p1').value.trim() || '나';
    readByoyomi();
    wireNet();
    App.net.on('waiting', (code) => {
      App.publicCode = code;
      if (App.lobby) App.lobby.announce({ id: code, name: App.names[1], map: App.mapId, size: MAPS[App.mapId].size });
      $('#wait-msg').textContent = '공개방을 열었습니다. 상대가 목록에서 참가하길 기다리는 중…';
      $('#room-code').textContent = code;
      $('#room-code-row').style.display = 'block';
      showOverlay('#ov-wait');
    });
    App.net.on('open', () => {
      // 상대 접속 → 방을 목록에서 내림
      if (App.lobby) App.lobby.closeRoom();
      App.net.send({ t: 'hello', name: App.names[1] });
    });
    App.net.host();
  }

  function joinPublicRoom(roomId, hostName) {
    if (!new NetSession().available()) { toast('PeerJS를 불러오지 못해 참가할 수 없습니다.', 'bad', 5000); return; }
    App.mode = 'public';
    App.myPlayer = 2;
    App.names[2] = $('#name-p1').value.trim() || '나';
    App.names[1] = hostName || '상대';
    wireNet();
    $('#wait-msg').textContent = `${App.names[1]}의 방에 접속하는 중…`;
    $('#room-code-row').style.display = 'none';
    showOverlay('#ov-wait');
    App.net.on('open', () => {
      App.net.send({ t: 'hello', name: App.names[2] });
    });
    App.net.join(roomId);
  }

  /* ---------------- 게임 시작 ---------------- */
  function startGame() {
    const map = MAPS[App.mapId];
    App.game = new BatooGame({ map });
    App.playerColor = { 1: BLACK, 2: WHITE };
    App.stage = 'base';
    App.clickMode = 'move';
    App.deadSet = new Set();
    App.tempReveal = new Set();
    App.scoreConfirmed = { 1: false, 2: false };
    App.rematchWant = { 1: false, 2: false };
    App.base = { current: 1, picks: { 1: [], 2: [] }, confirmed: { 1: false, 2: false } };
    App.bet = { round: 1, bids: { 1: null, 2: null } };
    App.clocks = { 1: 0, 2: 0 };
    App._clockTurn = null;
    App.byo = App.byoyomi
      ? { 1: { left: App.byoyomi.periods, count: App.byoyomi.sec },
          2: { left: App.byoyomi.periods, count: App.byoyomi.sec } }
      : null;

    teardownPublicLobby(); // 게임 진입 시 로비 구독 종료
    $('#screen-lobby').classList.add('hidden');
    $('#screen-game').classList.remove('hidden');
    hideOverlays();
    BatooAudio.gameStart();

    if (!App.view) {
      App.view = new BoardView($('#board'));
      App.view.onClick = onBoardClick;
    }
    App.view.opts.showHiddenFor = isOnline() ? myColor() : null;
    App.view.opts.tempReveal = App.tempReveal;
    App.view.opts.deadSet = App.deadSet;
    App.view.opts.territory = null;
    App.view.setGame(App.game);

    startClock();
    enterBasePhase();
  }

  /* ---------------- 1) 베이스빌드 ---------------- */
  function enterBasePhase() {
    setPhaseChip('베이스빌드');
    $('#btn-pass').style.display = 'none';
    $('#btn-resume').style.display = 'none';
    $('#btn-confirm').style.display = 'inline-block';
    updateBaseUI();

    if (App.mode === 'hotseat') {
      handoff(`${App.names[1]}의 베이스빌드`,
        `${App.names[2]}는 화면을 보지 마세요! 몰래 돌 3개를 배치합니다.`,
        () => beginBasePick(1));
    } else {
      beginBasePick(App.myPlayer);
    }
  }

  function beginBasePick(p) {
    App.base.current = p;
    App.view.opts.interactive = true;
    App.view.opts.pendingBases = { color: App.playerColor[p], list: App.base.picks[p] };
    App.view.opts.ghost = 'base';
    App.view.opts.ghostColor = App.playerColor[p];
    setStatus(`${App.names[p]} — 베이스 돌 3개를 몰래 배치하세요 (다시 클릭하면 취소)`);
    updateBaseUI();
    App.view.render();
  }

  function baseClick(pt) {
    const p = App.base.current;
    if (App.base.confirmed[p]) return;
    const i = App.game.idx(pt.x, pt.y);
    const picks = App.base.picks[p];
    const at = picks.indexOf(i);
    if (at >= 0) picks.splice(at, 1);
    else {
      if (picks.length >= App.game.baseCount) { toast(`베이스는 ${App.game.baseCount}개까지입니다.`, 'bad'); return; }
      picks.push(i);
    }
    updateBaseUI();
    App.view.render();
  }

  function updateBaseUI() {
    if (App.stage !== 'base') return;
    const p = App.base.current;
    const nBtn = $('#btn-confirm');
    nBtn.textContent = `베이스 확정 (${App.base.picks[p].length}/${App.game.baseCount})`;
    nBtn.disabled = App.base.picks[p].length !== App.game.baseCount || App.base.confirmed[p];
  }

  function confirmBase() {
    const p = App.base.current;
    if (App.base.picks[p].length !== App.game.baseCount) return;
    App.base.confirmed[p] = true;

    if (App.mode === 'hotseat') {
      App.view.opts.pendingBases = null;
      App.view.render();
      if (p === 1) {
        handoff(`${App.names[2]}의 베이스빌드`,
          `${App.names[1]}는 화면을 보지 마세요! 몰래 돌 3개를 배치합니다.`,
          () => beginBasePick(2));
      } else {
        revealBases();
      }
    } else {
      App.net.send({ t: 'base', list: App.base.picks[App.myPlayer] });
      App.view.opts.pendingBases = { color: myColor(), list: App.base.picks[App.myPlayer] };
      setStatus('상대의 베이스빌드를 기다리는 중…');
      $('#btn-confirm').disabled = true;
      maybeRevealBases();
    }
  }

  function maybeRevealBases() {
    if (App.base.confirmed[1] && App.base.confirmed[2]) revealBases();
  }

  function revealBases() {
    const placement = {};
    placement[App.playerColor[1]] = App.base.picks[1];
    placement[App.playerColor[2]] = App.base.picks[2];
    const collisions = App.game.setBases(placement);
    App.view.opts.pendingBases = null;
    App.view.opts.ghost = null;
    App.view.render();
    if (collisions.length > 0) {
      toast(`베이스 충돌! ${collisions.length}개 지점이 −점으로 변했습니다.`, 'warn', 4500);
    }
    toast('베이스빌드 공개!', 'good');
    enterBettingPhase();
  }

  /* ---------------- 2) 턴베팅 ---------------- */
  function enterBettingPhase() {
    App.stage = 'betting';
    setPhaseChip('턴베팅');
    $('#btn-confirm').style.display = 'none';
    setStatus('필드를 보고 선공을 위해 덤(점수)을 베팅하세요.');

    if (App.mode === 'hotseat') {
      handoff(`${App.names[1]}의 턴베팅`,
        `${App.names[2]}는 화면을 보지 마세요! 선공을 원하는 만큼 베팅합니다.`,
        () => openBetOverlay(1));
    } else {
      openBetOverlay(App.myPlayer);
    }
  }

  function openBetOverlay(p) {
    const range = $('#bet-range');
    range.value = 5;
    $('#bet-value').textContent = '5';
    $('#bet-title').textContent = `${App.names[p]}의 턴베팅` + (App.bet.round > 1 ? ` (재베팅 ${App.bet.round}회차)` : '');
    showOverlay('#ov-bet');
    range.oninput = () => { $('#bet-value').textContent = range.value; };
    $('#btn-bet-ok').onclick = () => {
      const v = parseInt(range.value, 10);
      hideOverlays();
      submitBid(p, v);
    };
  }

  function applyPendingBid() {
    if (App.bet && App.bet.pending && App.bet.pending.round === App.bet.round) {
      App.bet.bids[App.bet.pending.p] = App.bet.pending.v;
      App.bet.pending = null;
    }
  }

  function submitBid(p, v) {
    App.bet.bids[p] = v;
    if (App.mode === 'hotseat') {
      if (p === 1) {
        handoff(`${App.names[2]}의 턴베팅`,
          `${App.names[1]}는 화면을 보지 마세요!`,
          () => openBetOverlay(2));
      } else {
        resolveBets();
      }
    } else {
      App.net.send({ t: 'bid', round: App.bet.round, v });
      setStatus('상대의 베팅을 기다리는 중…');
      applyPendingBid(); // 재베팅 타이밍 차이로 먼저 도착해 있던 상대 베팅 반영
      maybeResolveBets();
    }
  }

  function maybeResolveBets() {
    if (App.bet.bids[1] != null && App.bet.bids[2] != null) resolveBets();
  }

  function resolveBets(randomFirst) {
    const b1 = App.bet.bids[1], b2 = App.bet.bids[2];
    if (b1 === b2 && randomFirst == null) {
      if (App.bet.round === 1) {
        // 동률 → 재베팅
        App.bet.round = 2;
        App.bet.bids = { 1: null, 2: null };
        toast(`베팅 동률(${b1}점)! 재베팅합니다.`, 'warn', 4000);
        if (App.mode === 'hotseat') {
          handoff(`${App.names[1]}의 재베팅`, `${App.names[2]}는 화면을 보지 마세요!`, () => openBetOverlay(1));
        } else {
          openBetOverlay(App.myPlayer);
        }
        return;
      }
      // 재베팅도 동률 → 랜덤 선공 (색은 그대로)
      if (isOnline()) {
        if (App.myPlayer === 1) { // 방장이 권위자로서 결정
          const first = Math.random() < 0.5 ? 1 : 2;
          App.net.send({ t: 'tiebreak', first });
          resolveBets(first);
        }
        // 참가자는 tiebreak 메시지를 기다림
        return;
      }
      randomFirst = Math.random() < 0.5 ? 1 : 2;
      toast('재베팅도 동률! 선공을 무작위로 정합니다. (흑백은 바뀌지 않음)', 'warn', 4500);
    }

    let winner, winnerBid;
    if (randomFirst != null) {
      winner = randomFirst;
      winnerBid = b1; // 동률
    } else {
      winner = b1 > b2 ? 1 : 2;
      winnerBid = Math.max(b1, b2);
      // 베팅 승자가 흑+선공. 잠정 색과 다르면 통째로 스왑.
      if (App.playerColor[winner] !== BLACK) {
        App.game.swapColors();
        App.playerColor = winner === 1 ? { 1: BLACK, 2: WHITE } : { 1: WHITE, 2: BLACK };
      }
    }
    const firstColor = App.playerColor[winner];
    App.game.startPlay(firstColor, winnerBid, { 1: b1, 2: b2 });

    const loser = winner === 1 ? 2 : 1;
    toast(`${App.names[winner]} ${b1 === b2 ? b1 : Math.max(b1, b2)}점 베팅으로 선공(${firstColor === BLACK ? '흑' : '백'})! ` +
      `${App.names[loser]}는 ${winnerBid}점을 받고 시작합니다.`, 'good', 6000);

    enterPlayPhase();
  }

  /* ---------------- 3) 본게임 ---------------- */
  function enterPlayPhase() {
    App.stage = 'play';
    setPhaseChip('대국');
    $('#btn-pass').style.display = 'inline-block';
    $('#btn-confirm').style.display = 'none';
    $('#btn-resume').style.display = 'none';
    App.view.opts.showHiddenFor = isOnline() ? myColor() : null;
    App.view.opts.ghost = 'stone';
    refreshAll();
  }

  function onBoardClick(pt) {
    if (App.stage === 'base') { baseClick(pt); return; }
    if (App.stage === 'scoring') { toggleDead(pt, false); return; }
    if (App.stage !== 'play' || !canAct()) return;

    const color = App.game.turn;
    if (App.clickMode === 'scan') { doScan(color, pt, false); return; }
    if (App.clickMode === 'hidden') { doHidden(color, pt, false); return; }
    doMove(color, pt, false);
  }

  function doMove(color, pt, fromRemote) {
    const r = App.game.tryMove(color, pt.x, pt.y);
    if (!r.ok) { if (!fromRemote) toastIllegal(r.reason); return; }
    if (!fromRemote && isOnline()) App.net.send({ t: 'move', x: pt.x, y: pt.y });
    handleActionResult(r, color, fromRemote);
  }

  function doHidden(color, pt, fromRemote) {
    const r = App.game.tryHidden(color, pt.x, pt.y);
    if (!r.ok) { if (!fromRemote) toastIllegal(r.reason); return; }
    if (!fromRemote && isOnline()) App.net.send({ t: 'hidden', x: pt.x, y: pt.y });
    if (r.type === 'hidden') {
      App.clickMode = 'move';
      App.view.opts.ghost = 'stone';
      if (!fromRemote) BatooAudio.hiddenPlaced(); // 긴장 드론 종료 + 해소 타격
      if (fromRemote) {
        toast('⚠ 상대가 히든을 사용했습니다! 위치는 보이지 않습니다.', 'warn', 5000);
      } else if (isOnline()) {
        toast('히든 착수 완료. 상대에게는 보이지 않습니다.', 'good');
      } else {
        toast('히든 착수 완료 (화면에 표시되지 않습니다. 위치를 기억하세요!)', 'good', 4500);
      }
    }
    handleActionResult(r, color, fromRemote, true);
  }

  function doScan(color, pt, fromRemote) {
    const r = App.game.scan(color, pt.x, pt.y);
    if (!r.ok) { if (!fromRemote) toastIllegal(r.reason); return; }
    if (!fromRemote && isOnline()) App.net.send({ t: 'scan', x: pt.x, y: pt.y });
    App.clickMode = 'move';
    App.view.opts.ghost = 'stone';
    if (!fromRemote) BatooAudio.scanPing(r.found != null);

    if (fromRemote) {
      toast(r.found != null
        ? '⚠ 상대가 스캔으로 내 히든을 확인했습니다! (+2점 획득)'
        : '상대가 스캔을 사용했습니다. (+2점 획득)', 'warn', 5000);
    } else {
      toast(r.found != null ? '스캔 성공! 히든을 찾았습니다. (상대 +2점)' : '스캔 실패… 히든이 없습니다. (상대 +2점)',
        r.found != null ? 'good' : 'bad', 4500);
    }
    // 잠깐 보였다가 사라짐 (기억해야 함)
    if (r.found != null && (!fromRemote || App.mode === 'hotseat')) {
      App.tempReveal.add(r.found);
      App.view.render();
      setTimeout(() => { App.tempReveal.delete(r.found); App.view.render(); }, 2500);
    }
    refreshAll();
  }

  function toastIllegal(reason) {
    const msgs = {
      'occupied': '이미 돌이 있는 자리입니다.',
      'suicide': '자살수는 둘 수 없습니다.',
      'ko': '패! 바로 되따낼 수 없습니다.',
      'not-your-turn': '당신의 차례가 아닙니다.',
      'no-hidden-left': '히든을 이미 사용했습니다.',
      'no-scan-left': '스캔을 이미 사용했습니다.',
      'not-playing': '지금은 착수할 수 없습니다.',
    };
    toast(msgs[reason] || '둘 수 없는 곳입니다.', 'bad');
  }

  function handleActionResult(r, color, fromRemote, wasHidden) {
    if (r.type === 'probe') {
      const probedMine = isOnline() && App.game.board[r.revealed[0]] === myColor();
      if (fromRemote) {
        toast(probedMine ? '⚠ 상대가 내 히든을 발견했습니다!' : '상대가 히든을 발견했습니다!', 'warn', 5000);
      } else {
        toast('히든 발견! 그 자리엔 상대의 히든이 있었습니다. 다른 곳에 착수하세요.', 'warn', 5000);
      }
      refreshAll();
      return;
    }
    // 착수음 (일반 착수, 그리고 내가 둔 히든은 딸깍 / 상대의 히든은 은밀한 저음)
    if (r.type === 'move') BatooAudio.stone();
    else if (r.type === 'hidden') {
      if (fromRemote) BatooAudio.opponentHidden();
      else BatooAudio.stone();
    }

    // 일반/히든 착수 결과
    if (r.captures && r.captures.length > 0) {
      const pts = r.captures.length;
      if (!fromRemote) toast(`${pts}개의 돌을 따냈습니다!`, 'good');
      else toast(`상대가 ${pts}개의 돌을 따냈습니다.`, 'warn');
    }
    if (r.selfCaptured && r.selfCaptured.length > 0) {
      toast(fromRemote
        ? '상대의 착수가 히든에 걸려 그대로 잡혔습니다!'
        : '⚠ 그 자리는 히든에 포위되어 있었습니다! 착수한 돌이 잡혔습니다.', 'bad', 5500);
    }
    if (r.revealedHidden && r.revealedHidden.length > 0 && !wasHidden) {
      toast('히든 돌이 공개되었습니다!', 'warn', 4500);
    }
    // ±화점 획득 알림 (히든 착수의 화점 획득은 위치가 새므로 조용히 처리)
    const bonusVisible = !wasHidden || (isOnline() && !fromRemote);
    if (r.pointBonus && bonusVisible) {
      toast(r.pointBonus > 0 ? '✨ +5점 화점 획득!' : '💥 −5점 화점을 밟았습니다!',
        r.pointBonus > 0 ? 'good' : 'bad', 3500);
    }
    refreshAll();
  }

  /* ---------------- 패스/기권/모드 버튼 ---------------- */
  function doPass(color, fromRemote) {
    const r = App.game.pass(color);
    if (!r.ok) return;
    if (!fromRemote && isOnline()) App.net.send({ t: 'pass' });
    BatooAudio.pass();
    toast(`${nameOfColor(color)} 패스`, '', 2500);
    if (r.scoring) enterScoring();
    refreshAll();
  }

  function enterScoring() {
    App.stage = 'scoring';
    BatooAudio.hiddenCancel();
    setPhaseChip('계가');
    App.deadSet.clear();
    App.scoreConfirmed = { 1: false, 2: false };
    App.view.opts.deadSet = App.deadSet;
    App.view.opts.territory = App.game.territoryMap(App.deadSet);
    App.view.opts.showHiddenFor = 'all'; // 계가 시 모든 히든 공개(엔진에서도 공개됨)
    App.view.opts.ghost = null;
    App.view.opts.interactive = true;    // 양측 모두 사석 지정 가능
    $('#btn-pass').style.display = 'none';
    $('#btn-confirm').style.display = 'inline-block';
    $('#btn-confirm').textContent = '계가 확정';
    $('#btn-confirm').disabled = false;
    $('#btn-resume').style.display = 'inline-block';
    setStatus('죽은 돌(사석)을 클릭해 지정한 뒤 계가를 확정하세요.');
    toast('양측 패스 — 계가로 넘어갑니다. 죽은 돌을 클릭해 지정하세요.', 'good', 5000);
    BatooAudio.scoring();
    refreshAll();
  }

  function toggleDead(pt, fromRemote) {
    if (App.stage !== 'scoring') return;
    const i = App.game.idx(pt.x, pt.y);
    if (App.game.board[i] === EMPTY) return;
    const g = App.game.group(i);
    const isDead = App.deadSet.has(i);
    for (const s of g.stones) {
      if (isDead) App.deadSet.delete(s); else App.deadSet.add(s);
    }
    App.scoreConfirmed = { 1: false, 2: false };
    $('#btn-confirm').disabled = false;
    App.view.opts.territory = App.game.territoryMap(App.deadSet);
    if (!fromRemote && isOnline()) App.net.send({ t: 'dead', x: pt.x, y: pt.y });
    refreshAll();
  }

  function confirmScore() {
    if (App.mode === 'hotseat') { finalizeGame(); return; }
    App.scoreConfirmed[App.myPlayer] = true;
    App.net.send({ t: 'scoreOk' });
    $('#btn-confirm').disabled = true;
    setStatus('상대의 계가 확정을 기다리는 중…');
    maybeFinalize();
  }

  function maybeFinalize() {
    if (App.scoreConfirmed[1] && App.scoreConfirmed[2]) finalizeGame();
  }

  function finalizeGame() {
    const res = App.game.finalize(App.deadSet);
    App.stage = 'over';
    stopClock();
    showResult(res);
  }

  function doResume(fromRemote) {
    const r = App.game.resumePlay();
    if (!r.ok) return;
    if (!fromRemote && isOnline()) App.net.send({ t: 'resume' });
    toast('대국을 재개합니다.', 'good');
    App.view.opts.territory = null;
    App.deadSet.clear();
    enterPlayPhase();
  }

  function doResign(color, fromRemote) {
    const r = App.game.resign(color);
    if (!r.ok) return;
    BatooAudio.hiddenCancel();
    if (!fromRemote && isOnline()) App.net.send({ t: 'resign' });
    App.stage = 'over';
    stopClock();
    showResult(null, color);
  }

  /* ---------------- 결과 ---------------- */
  function showResult(res, loserColor, reason) {
    const box = $('#result-table');
    if (res) {
      const B = res[BLACK], W = res[WHITE];
      const row = (label, b, w) => `<tr><td>${label}</td><td>${b}</td><td>${w}</td></tr>`;
      box.innerHTML = `<table>
        <tr><th></th><th>● ${nameOfColor(BLACK)}</th><th>○ ${nameOfColor(WHITE)}</th></tr>
        ${row('돌', B.stones, W.stones)}
        ${row('베이스 ×5', B.bases * 5, W.bases * 5)}
        ${row('집', B.territory, W.territory)}
        ${row('+점 ×5', '+' + B.plus * 5, '+' + W.plus * 5)}
        ${row('−점 ×5', '−' + B.minus * 5, '−' + W.minus * 5)}
        ${row('턴베팅', B.betting, W.betting)}
        ${row('스캔 보너스', B.scanBonus, W.scanBonus)}
        ${(B.timePenalty || W.timePenalty) ? row('초읽기 벌점', '−' + B.timePenalty, '−' + W.timePenalty) : ''}
        <tr class="total"><td>합계</td><td>${B.total}</td><td>${W.total}</td></tr>
      </table>
      <p class="cap-note">따낸 돌: ● ${B.captures}개 · ○ ${W.captures}개 (따냄은 잡힌 쪽 점수 감소로 반영)</p>
      ${res.tie ? '<p class="tie-note">동점 → 후공 승리!</p>' : ''}`;
      const wName = nameOfColor(res.winner);
      $('#result-winner').textContent =
        `🏆 ${wName} (${res.winner === BLACK ? '흑' : '백'}) 승리!`;
    } else {
      box.innerHTML = '';
      const winner = other(loserColor);
      const how = reason === 'timeout' ? '시간승' : '불계승';
      const why = reason === 'timeout' ? '초읽기 소진(시간패)' : '기권';
      $('#result-winner').textContent =
        `🏆 ${nameOfColor(winner)} (${winner === BLACK ? '흑' : '백'}) ${how}! — ${nameOfColor(loserColor)} ${why}`;
    }
    // 내가 이겼는지 기준으로 차임 (핫시트는 항상 승리 차임)
    const winColor = res ? res.winner : other(loserColor);
    const iWon = !isOnline() || winColor === myColor();
    BatooAudio.result(iWon);
    showOverlay('#ov-result');
  }

  function requestRematch() {
    if (App.mode === 'hotseat') { startGame(); return; }
    App.rematchWant[App.myPlayer] = true;
    App.net.send({ t: 'rematch' });
    $('#btn-rematch').textContent = '상대 수락 대기 중…';
    $('#btn-rematch').disabled = true;
    maybeRematch();
  }

  function maybeRematch() {
    if (App.rematchWant[1] && App.rematchWant[2]) {
      $('#btn-rematch').textContent = '다시하기';
      $('#btn-rematch').disabled = false;
      startGame();
    }
  }

  /* ---------------- 네트워크 수신 ---------------- */
  function onNetMessage(msg) {
    switch (msg.t) {
      case 'hello': {
        const their = App.myPlayer === 1 ? 2 : 1;
        App.names[their] = msg.name || '상대';
        if (App.myPlayer === 1) { // 방장이 설정을 내려주고 게임 시작
          App.net.send({ t: 'config', mapId: App.mapId, byo: App.byoyomi });
          hideOverlays();
          startGame();
        }
        break;
      }
      case 'config': {
        App.mapId = msg.mapId;
        App.byoyomi = msg.byo || null;
        hideOverlays();
        startGame();
        break;
      }
      case 'base': {
        const their = App.myPlayer === 1 ? 2 : 1;
        App.base.picks[their] = msg.list;
        App.base.confirmed[their] = true;
        maybeRevealBases();
        break;
      }
      case 'bid': {
        const their = App.myPlayer === 1 ? 2 : 1;
        if (msg.round === App.bet.round) {
          App.bet.bids[their] = msg.v;
          maybeResolveBets();
        } else {
          // 라운드가 어긋나면 값만 보관 (재베팅 타이밍 차이)
          App.bet.pending = { round: msg.round, v: msg.v, p: their };
        }
        break;
      }
      case 'tiebreak':
        resolveBets(msg.first);
        break;
      case 'move':
        doMove(App.game.turn, { x: msg.x, y: msg.y }, true);
        break;
      case 'hidden':
        doHidden(App.game.turn, { x: msg.x, y: msg.y }, true);
        break;
      case 'scan':
        doScan(App.game.turn, { x: msg.x, y: msg.y }, true);
        break;
      case 'pass':
        doPass(App.game.turn, true);
        break;
      case 'dead':
        toggleDead({ x: msg.x, y: msg.y }, true);
        break;
      case 'scoreOk': {
        const their = App.myPlayer === 1 ? 2 : 1;
        App.scoreConfirmed[their] = true;
        maybeFinalize();
        break;
      }
      case 'resume':
        doResume(true);
        break;
      case 'byo': {
        const turnColor = App.game.turn;
        App.game.consumeByoyomi(turnColor);
        const p = colorPlayer(turnColor);
        if (App.byo) { App.byo[p].left = msg.left; App.byo[p].count = App.byoyomi.sec; }
        toast(`⏱ 상대 초읽기 소진! −2점 (남은 ${msg.left}회)`, 'good', 3500);
        refreshAll();
        break;
      }
      case 'timeloss': {
        const turnColor = App.game.turn;
        App.game.timeLoss(turnColor);
        App.stage = 'over';
        stopClock();
        showResult(null, turnColor, 'timeout');
        break;
      }
      case 'resign': {
        const theirColor = App.playerColor[App.myPlayer === 1 ? 2 : 1];
        doResign(theirColor, true);
        break;
      }
      case 'rematch': {
        const their = App.myPlayer === 1 ? 2 : 1;
        App.rematchWant[their] = true;
        toast('상대가 다시하기를 원합니다.', 'good');
        maybeRematch();
        break;
      }
    }
  }

  /* ---------------- 패널/시계 갱신 ---------------- */
  function refreshAll() {
    const g = App.game;
    if (!g) return;
    // 재베팅 라운드 어긋남 처리
    if (App.bet && App.bet.pending && App.bet.pending.round === App.bet.round) {
      applyPendingBid();
      maybeResolveBets();
    }

    // 초읽기: 턴이 바뀌면 새 차례의 카운트다운 리셋
    if (App.byo && g.phase === 'play' && App._clockTurn !== g.turn) {
      App.byo[colorPlayer(g.turn)].count = App.byoyomi.sec;
      App._clockTurn = g.turn;
    }

    const live = g.phase === 'scoring' || g.phase === 'over'
      ? g.score(App.deadSet)
      : g.score(null, { live: true });

    for (const c of [BLACK, WHITE]) {
      const panel = c === BLACK ? '#panel-black' : '#panel-white';
      const p = colorPlayer(c);
      const s = live[c];
      $(panel + ' .p-name').textContent = App.names[p];
      $(panel + ' .p-score').textContent = s.total;
      $(panel + ' .p-detail').innerHTML =
        `돌 ${s.stones} · 베이스 ${s.bases * 5} · 집 ${s.territory}<br>` +
        `+점 ${s.plus * 5} · −점 ${s.minus * 5} · 따냄 ${s.captures}개<br>` +
        `베팅 ${s.betting} · 스캔 ${s.scanBonus}` +
        (s.timePenalty ? ` · 시간벌점 −${s.timePenalty}` : '');

      const hBtn = $(panel + ' .btn-hidden');
      const sBtn = $(panel + ' .btn-scan');
      const hiddenLeft = g.hiddenQuota[c] - g.hiddenUsed[c];
      const scanLeft = g.scanQuota[c] - g.scanUsed[c];
      hBtn.querySelector('.cnt').textContent = hiddenLeft;
      sBtn.querySelector('.cnt').textContent = scanLeft;
      const isTurnPanel = g.phase === 'play' && g.turn === c;
      const controlsHere = isOnline() ? myColor() === c : true;
      hBtn.disabled = !(isTurnPanel && controlsHere && hiddenLeft > 0);
      sBtn.disabled = !(isTurnPanel && controlsHere && scanLeft > 0);
      hBtn.classList.toggle('armed', App.clickMode === 'hidden' && isTurnPanel);
      sBtn.classList.toggle('armed', App.clickMode === 'scan' && isTurnPanel);

      $(panel).classList.toggle('active', g.phase === 'play' && g.turn === c);
    }

    if (g.phase === 'play') {
      const turnP = colorPlayer(g.turn);
      const mine = !isOnline() || turnP === App.myPlayer;
      setStatus(`${App.names[turnP]} (${g.turn === BLACK ? '흑 ●' : '백 ○'}) 차례` +
        (App.clickMode === 'hidden' ? ' — 히든 착수 위치 선택' :
         App.clickMode === 'scan' ? ' — 스캔할 지점 선택' :
         mine ? '' : ' — 대기 중'));
      App.view.opts.ghostColor = g.turn;
      App.view.opts.ghost = App.clickMode === 'scan' ? 'scan' : App.clickMode === 'hidden' ? 'hidden' : 'stone';
      App.view.opts.interactive = canAct();
    }
    updateClockDisplay();
    App.view.render();
  }

  function fmtClock(sec) {
    const m = Math.floor(sec / 60), s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function startClock() {
    stopClock();
    App.clockTimer = setInterval(() => {
      if (!App.game || App.game.phase !== 'play') return;
      const turnColor = App.game.turn;
      const p = colorPlayer(turnColor);
      App.clocks[p]++;
      if (App.byo) {
        // 온라인에서는 차례인 쪽 클라이언트가 시간 판정의 주체
        const authority = !isOnline() || p === App.myPlayer;
        const b = App.byo[p];
        b.count--;
        if (b.count < 0) {
          if (authority) {
            b.left--;
            if (b.left <= 0) {
              if (isOnline()) App.net.send({ t: 'timeloss' });
              App.game.timeLoss(turnColor);
              App.stage = 'over';
              stopClock();
              showResult(null, turnColor, 'timeout');
              return;
            }
            App.game.consumeByoyomi(turnColor);
            b.count = App.byoyomi.sec;
            toast(`⏱ ${App.names[p]} 초읽기 소진! −2점 (남은 초읽기 ${b.left}회)`, 'warn', 4000);
            if (isOnline()) App.net.send({ t: 'byo', left: b.left });
            refreshAll();
            return;
          }
          b.count = 0; // 원격(차례인 쪽)의 판정을 기다림
        }
      }
      updateClockDisplay();
    }, 1000);
  }

  function updateClockDisplay() {
    if (!App.game) return;
    for (const c of [BLACK, WHITE]) {
      const p = colorPlayer(c);
      const el = $((c === BLACK ? '#panel-black' : '#panel-white') + ' .p-clock');
      if (App.byo) {
        const b = App.byo[p];
        const active = App.game.phase === 'play' && App.game.turn === c;
        el.textContent = active ? `⏱ ${Math.max(0, b.count)}초 · 초읽기 ${b.left}회` : `초읽기 ${b.left}회`;
        el.classList.toggle('urgent', active && b.count <= 5);
      } else {
        el.textContent = fmtClock(App.clocks[p]);
        el.classList.remove('urgent');
      }
    }
  }
  function stopClock() { if (App.clockTimer) { clearInterval(App.clockTimer); App.clockTimer = null; } }

  /* ---------------- 버튼 배선 ---------------- */
  function wireButtons() {
    $$('.btn-hidden').forEach((b) => {
      b.onclick = () => {
        if (!canAct()) return;
        if (App.clickMode === 'hidden') { App.clickMode = 'move'; BatooAudio.hiddenCancel(); refreshAll(); return; }
        const arm = () => { App.clickMode = 'hidden'; BatooAudio.hiddenArm(); refreshAll(); };
        if (App.mode === 'hotseat') {
          confirmDialog('히든 착수: 착수 후에는 화면에 표시되지 않습니다. 상대가 화면을 보고 있지 않은지 확인하세요!', (yes) => { if (yes) arm(); });
        } else arm();
      };
    });
    $$('.btn-scan').forEach((b) => {
      b.onclick = () => {
        if (!canAct()) return;
        if (App.clickMode === 'scan') { App.clickMode = 'move'; refreshAll(); return; }
        if (App.clickMode === 'hidden') BatooAudio.hiddenCancel(); // 히든 대기 중 스캔으로 전환
        confirmDialog('스캔을 사용하면 성공/실패와 관계없이 상대에게 2점을 줍니다. 사용할까요?', (yes) => {
          if (yes) { App.clickMode = 'scan'; BatooAudio.scanArm(); refreshAll(); }
        });
      };
    });
    $('#btn-pass').onclick = () => {
      if (!canAct()) return;
      confirmDialog('패스하시겠습니까? 양측이 연속 패스하면 계가로 넘어갑니다.', (yes) => {
        if (yes) doPass(App.game.turn, false);
      });
    };
    $('#btn-resign').onclick = () => {
      if (App.stage !== 'play' && App.stage !== 'scoring') return;
      const c = isOnline() ? myColor() : App.game.turn;
      confirmDialog(`${nameOfColor(c)} — 정말 기권하시겠습니까?`, (yes) => {
        if (yes) doResign(c, false);
      });
    };
    $('#btn-confirm').onclick = () => {
      if (App.stage === 'base') confirmBase();
      else if (App.stage === 'scoring') confirmScore();
    };
    $('#btn-resume').onclick = () => doResume(false);
    $('#btn-help').onclick = () => showOverlay('#ov-help');
    $('#btn-help-close').onclick = hideOverlays;
    $('#btn-leave').onclick = () => {
      confirmDialog('게임을 나가고 로비로 돌아갈까요?', (yes) => { if (yes) showLobby(); });
    };
    $('#btn-rematch').onclick = requestRematch;
    $('#btn-to-lobby').onclick = showLobby;
    $('#btn-wait-cancel').onclick = showLobby;
    $('#btn-copy-code').onclick = () => {
      const code = $('#room-code').textContent;
      if (navigator.clipboard) navigator.clipboard.writeText(code).then(() => toast('방 코드가 복사되었습니다.', 'good'));
    };
  }

  function showLobby() {
    if (App.net) { App.net.destroy(); App.net = null; }
    stopClock();
    BatooAudio.hiddenCancel();
    App.game = null;
    App.stage = 'lobby';
    hideOverlays();
    $('#screen-game').classList.add('hidden');
    $('#screen-lobby').classList.remove('hidden');
    BatooAudio.lobby();
    // 공개방 모드로 돌아왔으면 로비 목록 다시 연결
    teardownPublicLobby();
    if (App.mode === 'public') initPublicLobby();
  }

  /* ---------------- 초기화 ---------------- */
  window.addEventListener('DOMContentLoaded', () => {
    initLobby();
    wireButtons();
  });

  // 디버그/테스트용 핸들 (콘솔에서 상태 확인)
  window.__batooApp = App;
})();
