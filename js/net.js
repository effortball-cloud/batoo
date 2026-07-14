/* =========================================================
 * 바투(Batoo) — 온라인 멀티플레이 (PeerJS / WebRTC P2P)
 *
 * 서버 없이 PeerJS 공용 시그널링 서버로 1:1 연결한다.
 * - 방장: 방 코드를 만들고 기다림 (peer id = "batoo-<코드>")
 * - 참가자: 방 코드로 접속
 * 양쪽 클라이언트가 같은 결정적 엔진을 돌리고, 입력만 주고받는다.
 * ========================================================= */
(function (global) {
  'use strict';

  const PREFIX = 'batoo-krx-'; // 다른 PeerJS 사용자와 id 충돌 방지용

  function randomCode(len) {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 헷갈리는 문자(I,L,O,0,1) 제외
    let s = '';
    for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  class NetSession {
    constructor() {
      this.peer = null;
      this.conn = null;
      this.isHost = false;
      this.code = null;
      this.handlers = {}; // { open, message, close, error, waiting }
    }

    on(ev, fn) { this.handlers[ev] = fn; return this; }
    _emit(ev, arg) { if (this.handlers[ev]) this.handlers[ev](arg); }

    available() { return typeof global.Peer === 'function'; }

    /* 방 만들기 → 코드 콜백 후 상대 접속 대기 */
    host() {
      if (!this.available()) { this._emit('error', 'PeerJS를 불러오지 못했습니다. 인터넷 연결을 확인하세요.'); return; }
      this.isHost = true;
      this.code = randomCode(5);
      this.peer = new global.Peer(PREFIX + this.code, { debug: 1 });
      this.peer.on('open', () => this._emit('waiting', this.code));
      this.peer.on('connection', (conn) => {
        if (this.conn) { conn.close(); return; } // 1:1만
        this._wire(conn);
      });
      this.peer.on('error', (e) => {
        if (e.type === 'unavailable-id') {
          // 코드 충돌(극히 드묾) → 재시도
          this.peer.destroy();
          this.host();
        } else {
          this._emit('error', this._errMsg(e));
        }
      });
    }

    /* 방 코드로 참가 */
    join(code) {
      if (!this.available()) { this._emit('error', 'PeerJS를 불러오지 못했습니다. 인터넷 연결을 확인하세요.'); return; }
      this.isHost = false;
      this.code = code.trim().toUpperCase();
      this.peer = new global.Peer({ debug: 1 });
      this.peer.on('open', () => {
        const conn = this.peer.connect(PREFIX + this.code, { reliable: true });
        this._wire(conn);
      });
      this.peer.on('error', (e) => this._emit('error', this._errMsg(e)));
    }

    _wire(conn) {
      this.conn = conn;
      conn.on('open', () => this._emit('open'));
      conn.on('data', (d) => {
        let msg = d;
        if (typeof d === 'string') { try { msg = JSON.parse(d); } catch (_) { return; } }
        this._emit('message', msg);
      });
      conn.on('close', () => this._emit('close'));
      conn.on('error', (e) => this._emit('error', this._errMsg(e)));
    }

    send(msg) {
      if (this.conn && this.conn.open) this.conn.send(msg);
    }

    destroy() {
      try { if (this.conn) this.conn.close(); } catch (_) {}
      try { if (this.peer) this.peer.destroy(); } catch (_) {}
      this.conn = null;
      this.peer = null;
    }

    _errMsg(e) {
      const t = e && e.type;
      if (t === 'peer-unavailable') return '해당 코드의 방을 찾을 수 없습니다. 코드를 확인하세요.';
      if (t === 'network' || t === 'disconnected') return '네트워크 연결에 문제가 있습니다.';
      if (t === 'browser-incompatible') return '이 브라우저는 WebRTC를 지원하지 않습니다.';
      return '연결 오류: ' + (e && e.message ? e.message : String(e));
    }
  }

  /* =========================================================
   * LobbyClient — 공개 방 목록(코드 없이 발견)
   *
   * 공개 MQTT 브로커(WebSocket)를 "공유 등록소"로 사용한다.
   *  - 방장: 공개 채널에 {방ID, 이름, 맵}을 주기적으로 방송(하트비트)
   *  - 모두: 채널을 구독해 열린 방 목록을 실시간으로 본다
   *  - 참가자는 목록의 방ID(=PeerJS ID)로 바로 P2P 접속 → 코드 입력 불필요
   * 계정/자체 서버 없이 순수 클라이언트로 동작(정적 호스팅 호환).
   * ========================================================= */
  const LOBBY_TOPIC = 'batoo/lobby/v1';
  // 공용 MQTT-over-WebSocket 브로커 (무료, 계정 불필요). https 페이지에선 wss 필수.
  const LOBBY_BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
  ];

  class LobbyClient {
    constructor() {
      this.client = null;
      this.rooms = new Map();   // id -> { info, last }
      this.onChange = null;
      this.onStatus = null;
      this.myRoomId = null;
      this.hbTimer = null;
      this.expTimer = null;
      this.connected = false;
      this.brokerIdx = 0;
    }

    available() { return typeof global.mqtt !== 'undefined'; }

    connect(handlers) {
      handlers = handlers || {};
      this.onChange = handlers.change || null;
      this.onStatus = handlers.status || null;
      if (!this.available()) {
        this._status('error', 'MQTT 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인하세요.');
        return;
      }
      this._openBroker();
    }

    _openBroker() {
      const url = LOBBY_BROKERS[this.brokerIdx % LOBBY_BROKERS.length];
      this._status('connecting', '로비에 연결하는 중…');
      const cid = 'batoo-' + Math.random().toString(36).slice(2, 10);
      try {
        this.client = global.mqtt.connect(url, {
          clientId: cid, connectTimeout: 8000, reconnectPeriod: 0, clean: true,
        });
      } catch (e) { this._fallback(); return; }

      let settled = false;
      const failTimer = setTimeout(() => { if (!settled) { settled = true; this._fallback(); } }, 9000);

      this.client.on('connect', () => {
        settled = true; clearTimeout(failTimer);
        this.connected = true;
        this.client.subscribe(LOBBY_TOPIC, { qos: 0 }, (err) => {
          if (err) this._status('error', '로비 구독에 실패했습니다.');
          else { this._status('ok', '로비 연결됨'); this._emit(); }
        });
        this._startExpiry();
        // 재접속 시 내 방 재방송
        if (this.myRoomId && this._info) this.announce(this._info);
      });
      this.client.on('message', (topic, payload) => {
        let m; try { m = JSON.parse(payload.toString()); } catch (e) { return; }
        if (m.type === 'room') {
          if (m.id === this.myRoomId) return;      // 내 방은 목록에서 제외
          this.rooms.set(m.id, { info: m, last: Date.now() });
          this._emit();
        } else if (m.type === 'close') {
          if (this.rooms.delete(m.id)) this._emit();
        }
      });
      this.client.on('error', () => { if (!settled) { settled = true; clearTimeout(failTimer); this._fallback(); } });
      this.client.on('close', () => { this.connected = false; });
    }

    _fallback() {
      try { if (this.client) this.client.end(true); } catch (e) {}
      this.client = null;
      this.brokerIdx++;
      if (this.brokerIdx < LOBBY_BROKERS.length) this._openBroker();
      else this._status('error', '공개 로비 서버에 연결하지 못했습니다. 코드방을 이용하거나 잠시 후 다시 시도하세요.');
    }

    _status(kind, msg) { if (this.onStatus) this.onStatus(kind, msg); }
    _emit() { if (this.onChange) this.onChange([...this.rooms.values()].map((r) => r.info)); }

    _startExpiry() {
      if (this.expTimer) return;
      this.expTimer = setInterval(() => {
        const now = Date.now(); let changed = false;
        for (const [id, r] of this.rooms) if (now - r.last > 12000) { this.rooms.delete(id); changed = true; }
        if (changed) this._emit();
      }, 3000);
    }

    /* 내 방을 목록에 올린다(하트비트로 유지). info: {id, name, map, size} */
    announce(info) {
      this.myRoomId = info.id;
      this._info = info;
      const pub = () => {
        if (this.client && this.connected) {
          try { this.client.publish(LOBBY_TOPIC, JSON.stringify({ type: 'room', ...info, ts: Date.now() }), { qos: 0 }); } catch (e) {}
        }
      };
      pub();
      if (this.hbTimer) clearInterval(this.hbTimer);
      this.hbTimer = setInterval(pub, 4000);
    }

    /* 방을 목록에서 내린다(상대가 들어왔거나 취소 시) */
    closeRoom() {
      if (this.client && this.connected && this.myRoomId) {
        try { this.client.publish(LOBBY_TOPIC, JSON.stringify({ type: 'close', id: this.myRoomId }), { qos: 0 }); } catch (e) {}
      }
      if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null; }
      this.myRoomId = null; this._info = null;
    }

    disconnect() {
      this.closeRoom();
      if (this.expTimer) { clearInterval(this.expTimer); this.expTimer = null; }
      this.rooms.clear();
      try { if (this.client) this.client.end(true); } catch (e) {}
      this.client = null; this.connected = false;
    }
  }

  global.BatooNet = { NetSession, LobbyClient };
})(window);
