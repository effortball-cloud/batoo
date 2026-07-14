/* =========================================================
 * 바투(Batoo) — 핵심 룰 엔진 (DOM 비의존)
 *
 * 바둑 룰 기반 + 바투 특수 룰:
 *  - ±화점: 돌이 놓여 있으면 +5 / -5점. -점은 집으로 계산 안 됨.
 *  - 베이스빌드: 시작 전 각자 3개 비밀 배치, 겹치면 제거 후 그 자리가 -점.
 *    베이스 돌은 5점짜리(잡혀도 5점, 살아 있어도 5점).
 *  - 턴베팅: 높게 베팅한 쪽이 흑+선공, 후공이 베팅값을 점수로 받음.
 *  - 히든: 게임당 1회, 보이지 않는 착수. 잡히거나 잡을 때 공개.
 *    상대가 그 자리에 두려 하면 공개되고 상대는 다른 곳에 둘 수 있음.
 *  - 스캔: 게임당 1회, 한 지점 확인. 성패 무관 상대에게 2점.
 *    찾아도 잠깐 보일 뿐 돌은 계속 히든 상태.
 *  - 착수 1수 = 돌 1점. 동점이면 후공 승.
 * ========================================================= */
(function (global) {
  'use strict';

  const EMPTY = 0, BLACK = 1, WHITE = 2;
  const other = (c) => (c === BLACK ? WHITE : BLACK);

  class BatooGame {
    /**
     * @param {object} opts
     *  - map: BatooMaps 항목 { size, plus:[[x,y]], minus:[[x,y]] }
     *  - baseCount (기본 3), hiddenCount (기본 1), scanCount (기본 1)
     */
    constructor(opts) {
      this.map = opts.map;
      this.size = opts.map.size;
      const n = this.size * this.size;

      this.board = new Uint8Array(n);    // 진실 상태(히든 포함)
      this.isBase = new Uint8Array(n);   // 베이스 돌 여부
      this.isHidden = new Uint8Array(n); // 아직 공개되지 않은 히든 돌 여부

      // ±화점은 "처음 돌을 놓을 때 1회만" 효과가 있고 그 뒤 사라진다(공식 규칙).
      // plus/minus 집합에는 아직 소비되지 않은(활성) 화점만 남는다.
      this.plus = new Set(opts.map.plus.map((p) => this.idx(p[0], p[1])));
      this.minus = new Set(opts.map.minus.map((p) => this.idx(p[0], p[1])));
      this.bonusLog = []; // { i, color, val:+5|-5, hidden } — 획득한 화점 점수 기록

      this.baseCount = opts.baseCount != null ? opts.baseCount : 3;
      this.hiddenQuota = { [BLACK]: opts.hiddenCount != null ? opts.hiddenCount : 1,
                           [WHITE]: opts.hiddenCount != null ? opts.hiddenCount : 1 };
      this.scanQuota = { [BLACK]: opts.scanCount != null ? opts.scanCount : 1,
                         [WHITE]: opts.scanCount != null ? opts.scanCount : 1 };
      this.hiddenUsed = { [BLACK]: 0, [WHITE]: 0 };
      this.scanUsed = { [BLACK]: 0, [WHITE]: 0 };

      // 따냄은 잡힌 쪽의 돌 점수가 사라지는 것으로 반영된다(공식 규칙 — 잡은 쪽 가산 없음).
      this.capturedStones = { [BLACK]: 0, [WHITE]: 0 }; // 따낸 돌 개수(표시용)
      this.scanBonus = { [BLACK]: 0, [WHITE]: 0 };      // 상대의 스캔 사용으로 받은 점수
      this.timePenalty = { [BLACK]: 0, [WHITE]: 0 };    // 초읽기 소진 벌점(누적, 자기 점수에서 차감)
      this.betting = { [BLACK]: 0, [WHITE]: 0 };        // 턴베팅으로 받은 점수(후공만)
      this.bids = null;                                  // { [BLACK]:n, [WHITE]:n } 기록용

      this.firstPlayer = BLACK; // 선공 색 (베팅 후 확정)
      this.turn = BLACK;
      this.passes = 0;
      this.phase = 'base';      // base → betting → play → scoring → over
      this.baseCollisions = [];

      this.hashHistory = [];    // 패(ko) 판정용 보드 해시 이력
      this.moveLog = [];
      this.lastMove = -1;       // 마지막 착수 idx (표식용)
      this.moveCount = 0;
      this.winner = null;
      this.overReason = null;   // 'score' | 'resign'
    }

    /* ---------- 좌표 유틸 ---------- */
    idx(x, y) { return y * this.size + x; }
    xy(i) { return [i % this.size, Math.floor(i / this.size)]; }
    inBounds(x, y) { return x >= 0 && y >= 0 && x < this.size && y < this.size; }
    neighbors(i) {
      const x = i % this.size, y = (i - x) / this.size, out = [];
      if (x > 0) out.push(i - 1);
      if (x < this.size - 1) out.push(i + 1);
      if (y > 0) out.push(i - this.size);
      if (y < this.size - 1) out.push(i + this.size);
      return out;
    }

    /* ---------- 그룹/활로 ---------- */
    group(i) {
      const color = this.board[i];
      const stones = [i];
      const seen = new Set(stones);
      const libs = new Set();
      for (let k = 0; k < stones.length; k++) {
        for (const nb of this.neighbors(stones[k])) {
          if (this.board[nb] === EMPTY) libs.add(nb);
          else if (this.board[nb] === color && !seen.has(nb)) {
            seen.add(nb);
            stones.push(nb);
          }
        }
      }
      return { color, stones, libs };
    }

    /* 히든 돌을 빈칸 취급했을 때의 "보이는" 활로 (자살수 판정용) */
    visibleLibs(stones, enemy) {
      const libs = new Set();
      for (const s of stones) {
        for (const nb of this.neighbors(s)) {
          if (this.board[nb] === EMPTY) libs.add(nb);
          else if (this.board[nb] === enemy && this.isHidden[nb]) libs.add(nb);
        }
      }
      return libs;
    }

    hash() { return this.board.join(''); }

    /* ±화점 1회성 획득 처리. 놓는 순간 점수가 확정되고 화점은 사라진다. */
    _awardPoint(color, i, hidden) {
      let val = 0;
      if (this.plus.has(i)) { val = 5; this.plus.delete(i); }
      else if (this.minus.has(i)) { val = -5; this.minus.delete(i); }
      if (val !== 0) this.bonusLog.push({ i, color, val, hidden: !!hidden });
      return val;
    }

    /* 해당 지점의 히든 돌이 공개될 때, 그 돌이 획득했던 화점 점수도 공개 */
    _unhideBonusAt(i) {
      for (const b of this.bonusLog) if (b.i === i && b.hidden) b.hidden = false;
    }

    /* ---------- 1) 베이스빌드 ---------- */
    /**
     * placements: { [BLACK]: [idx,idx,idx], [WHITE]: [idx,idx,idx] }
     * 겹친 지점은 양쪽 베이스 제거 + 그 자리를 -점으로.
     */
    setBases(placements) {
      if (this.phase !== 'base') throw new Error('bad phase');
      const b = new Set(placements[BLACK]);
      const w = new Set(placements[WHITE]);
      const collisions = [...b].filter((i) => w.has(i));
      for (const i of collisions) {
        b.delete(i); w.delete(i);
        this.minus.add(i);
        this.plus.delete(i);
      }
      for (const i of b) { this.board[i] = BLACK; this.isBase[i] = 1; this._awardPoint(BLACK, i, false); }
      for (const i of w) { this.board[i] = WHITE; this.isBase[i] = 1; this._awardPoint(WHITE, i, false); }
      this.baseCollisions = collisions;
      this.phase = 'betting';
      return collisions;
    }

    /* 턴베팅에서 P2가 이겼을 때 색을 통째로 맞바꾼다 (본게임 전에만) */
    swapColors() {
      if (this.phase === 'play' || this.phase === 'scoring' || this.phase === 'over') {
        throw new Error('cannot swap colors after play started');
      }
      for (let i = 0; i < this.board.length; i++) {
        if (this.board[i] === BLACK) this.board[i] = WHITE;
        else if (this.board[i] === WHITE) this.board[i] = BLACK;
      }
      for (const b of this.bonusLog) b.color = other(b.color);
    }

    /* ---------- 2) 턴베팅 확정 ---------- */
    /**
     * firstColor: 선공 색. winnerBid: 선공이 제시한 베팅값 → 후공이 점수로 받음.
     */
    startPlay(firstColor, winnerBid, bids) {
      if (this.phase !== 'betting') throw new Error('bad phase');
      this.firstPlayer = firstColor;
      this.turn = firstColor;
      this.betting[other(firstColor)] = winnerBid;
      this.bids = bids || null;
      this.phase = 'play';
      this.hashHistory = [this.hash()];
    }

    /* ---------- 3) 착수 ---------- */
    /**
     * 일반 착수. 반환:
     *  { ok:false, reason }
     *  { ok:true, type:'probe', revealed:[i] }  — 상대 히든을 짚음. 턴 유지, 다른 곳에 착수.
     *  { ok:true, type:'move', i, captures:[..], selfCaptured:[..], revealedHidden:[..] }
     */
    tryMove(color, x, y) {
      if (this.phase !== 'play') return { ok: false, reason: 'not-playing' };
      if (this.turn !== color) return { ok: false, reason: 'not-your-turn' };
      const i = this.idx(x, y);
      const occ = this.board[i];
      if (occ !== EMPTY) {
        if (this.isHidden[i] && occ === other(color)) {
          // "찍어보기": 상대 히든 발견 → 영구 공개, 착수는 다시(턴 유지)
          this.isHidden[i] = 0;
          this._unhideBonusAt(i);
          this.moveLog.push({ t: 'probe', color, i });
          return { ok: true, type: 'probe', revealed: [i] };
        }
        return { ok: false, reason: 'occupied' };
      }
      return this._place(color, i, false);
    }

    /**
     * 히든 착수. 게임당 hiddenQuota회.
     * 상대 히든 위를 찍으면 probe로 처리(히든 소모 없음).
     */
    tryHidden(color, x, y) {
      if (this.phase !== 'play') return { ok: false, reason: 'not-playing' };
      if (this.turn !== color) return { ok: false, reason: 'not-your-turn' };
      if (this.hiddenUsed[color] >= this.hiddenQuota[color]) {
        return { ok: false, reason: 'no-hidden-left' };
      }
      const i = this.idx(x, y);
      const occ = this.board[i];
      if (occ !== EMPTY) {
        if (this.isHidden[i] && occ === other(color)) {
          this.isHidden[i] = 0;
          this._unhideBonusAt(i);
          this.moveLog.push({ t: 'probe', color, i });
          return { ok: true, type: 'probe', revealed: [i] };
        }
        return { ok: false, reason: 'occupied' };
      }
      const res = this._place(color, i, true);
      if (res.ok) this.hiddenUsed[color]++;
      return res;
    }

    /**
     * 실제 착수 처리 공통부.
     * hidden=true면 히든 돌로 놓는다. 단, 놓자마자 잡거나 잡히면 즉시 공개된다.
     */
    _place(color, i, hidden) {
      const enemy = other(color);
      const snapBoard = this.board.slice();
      const snapHidden = this.isHidden.slice();
      const snapBase = this.isBase.slice();

      this.board[i] = color;
      if (hidden) this.isHidden[i] = 1;

      // 1) 상대 그룹 포획
      const capSet = new Set();
      for (const nb of this.neighbors(i)) {
        if (this.board[nb] === enemy && !capSet.has(nb)) {
          const g = this.group(nb);
          if (g.libs.size === 0) g.stones.forEach((s) => capSet.add(s));
        }
      }

      const revealedHidden = [];
      let selfCaptured = [];

      if (capSet.size === 0) {
        // 2) 포획이 없으면 자기 그룹 활로 확인
        const own = this.group(i);
        if (own.libs.size === 0) {
          // 히든 돌을 빈칸으로 봤을 때도 활로가 없으면 → 눈에 보이는 자살수 → 불허
          const vis = this.visibleLibs(own.stones, enemy);
          if (vis.size === 0) {
            this.board = snapBoard;
            this.isHidden = snapHidden;
            this.isBase = snapBase;
            return { ok: false, reason: 'suicide' };
          }
          // 상대 히든이 포위를 완성하고 있던 경우 → 착수 즉시 잡힘(히든의 포획 → 공개)
          for (const s of own.stones) {
            for (const nb of this.neighbors(s)) {
              if (this.board[nb] === enemy && this.isHidden[nb]) {
                this.isHidden[nb] = 0;
                revealedHidden.push(nb);
              }
            }
          }
          selfCaptured = own.stones.slice();
        }
      }

      // 3) 패(ko) 검사 — 잡은 뒤 상태로 판단
      const applyCapture = (set, capturer) => {
        let cnt = 0;
        for (const s of set) {
          if (this.isHidden[s]) { this.isHidden[s] = 0; revealedHidden.push(s); }
          this._unhideBonusAt(s); // 잡히며 공개 — 화점 획득 기록도 공개
          cnt++;
          this.board[s] = EMPTY;
          this.isBase[s] = 0;
        }
        this.capturedStones[capturer] += cnt;
      };

      // 포획까지 잠정 적용한 뒤 패 여부를 해시로 확인
      const preCapCnt = { ...this.capturedStones };

      if (capSet.size > 0) applyCapture(capSet, color);
      if (selfCaptured.length > 0) applyCapture(new Set(selfCaptured), enemy);

      const newHash = this.hash();
      const h = this.hashHistory;
      if (h.length >= 2 && newHash === h[h.length - 2]) {
        // 패: 직전 형태 재현 금지 → 전부 되돌림
        this.board = snapBoard;
        this.isHidden = snapHidden;
        this.isBase = snapBase;
        this.capturedStones = preCapCnt;
        return { ok: false, reason: 'ko' };
      }

      // 놓자마자 포획했으면 히든도 즉시 공개
      if (hidden && (capSet.size > 0 || selfCaptured.length > 0)) {
        if (this.isHidden[i]) { this.isHidden[i] = 0; }
        this._unhideBonusAt(i);
        if (!revealedHidden.includes(i) && this.board[i] === color) revealedHidden.push(i);
      }

      // ±화점 1회성 획득 (패 검사 통과 후 확정. 놓자마자 잡혀도 획득은 유지)
      const pointBonus = this._awardPoint(color, i, this.isHidden[i] === 1);

      this.hashHistory.push(newHash);
      this.lastMove = selfCaptured.length > 0 ? -1 : i;
      this.moveCount++;
      this.passes = 0;
      this.turn = enemy;
      this.moveLog.push({ t: hidden ? 'hidden' : 'move', color, i,
                          captures: [...capSet], selfCaptured });
      return {
        ok: true,
        type: hidden ? 'hidden' : 'move',
        i,
        captures: [...capSet],
        selfCaptured,
        revealedHidden,
        pointBonus,
      };
    }

    /* ---------- 스캔 ---------- */
    /**
     * 한 지점을 확인. 성패 무관 상대에게 2점. 턴은 소비하지 않는다.
     * 반환: { ok, found: idx|null }  (found여도 돌은 계속 히든 상태 — UI가 잠깐만 보여줌)
     */
    scan(color, x, y) {
      if (this.phase !== 'play') return { ok: false, reason: 'not-playing' };
      if (this.turn !== color) return { ok: false, reason: 'not-your-turn' };
      if (this.scanUsed[color] >= this.scanQuota[color]) {
        return { ok: false, reason: 'no-scan-left' };
      }
      const i = this.idx(x, y);
      this.scanUsed[color]++;
      this.scanBonus[other(color)] += 2;
      const found = this.board[i] !== EMPTY && this.isHidden[i] === 1 ? i : null;
      this.moveLog.push({ t: 'scan', color, i, found: found != null });
      return { ok: true, found };
    }

    /* ---------- 패스 / 기권 ---------- */
    pass(color) {
      if (this.phase !== 'play') return { ok: false, reason: 'not-playing' };
      if (this.turn !== color) return { ok: false, reason: 'not-your-turn' };
      this.passes++;
      this.turn = other(color);
      this.hashHistory.push(this.hash());
      this.moveLog.push({ t: 'pass', color });
      if (this.passes >= 2) {
        this.phase = 'scoring';
        this.revealAllHidden();
      }
      return { ok: true, scoring: this.phase === 'scoring' };
    }

    resign(color) {
      if (this.phase === 'over') return { ok: false };
      this.phase = 'over';
      this.winner = other(color);
      this.overReason = 'resign';
      return { ok: true, winner: this.winner };
    }

    /* 초읽기 1회 소진: -2점 벌점 */
    consumeByoyomi(color) {
      this.timePenalty[color] += 2;
    }

    /* 초읽기 전부 소진: 시간패 */
    timeLoss(color) {
      if (this.phase === 'over') return { ok: false };
      this.phase = 'over';
      this.winner = other(color);
      this.overReason = 'timeout';
      return { ok: true, winner: this.winner };
    }

    revealAllHidden() {
      for (let i = 0; i < this.isHidden.length; i++) this.isHidden[i] = 0;
      for (const b of this.bonusLog) b.hidden = false;
    }

    /* ---------- 점수 ---------- */
    /**
     * 최종/실시간 점수 계산.
     * @param {Set<number>} deadSet 사석으로 지정된 돌 idx 집합 (계가 시)
     * @param {object} o { live:true } 실시간 표시용 — 집 계산 생략,
     *        히든 돌의 ± 보너스 숨김(위치 유출 방지, 돌 1점은 포함)
     */
    score(deadSet, o) {
      deadSet = deadSet || new Set();
      const opts = o || {};
      const board = this.board.slice();
      const isBase = this.isBase.slice();
      const capCnt = { [BLACK]: this.capturedStones[BLACK], [WHITE]: this.capturedStones[WHITE] };

      // 사석 제거 — 잡힌 쪽의 돌/베이스 점수가 사라지는 것으로 반영(잡은 쪽 가산 없음)
      for (const i of deadSet) {
        const c = board[i];
        if (c === EMPTY) continue;
        capCnt[other(c)]++;
        board[i] = EMPTY;
        isBase[i] = 0;
      }

      // 집 계산 (빈 영역이 한 색으로만 둘러싸인 경우, -점 제외)
      const terr = { [BLACK]: 0, [WHITE]: 0 };
      if (!opts.live) {
        const seen = new Uint8Array(board.length);
        for (let i = 0; i < board.length; i++) {
          if (board[i] !== EMPTY || seen[i]) continue;
          const region = [i];
          seen[i] = 1;
          const borders = new Set();
          for (let k = 0; k < region.length; k++) {
            for (const nb of this.neighbors(region[k])) {
              if (board[nb] === EMPTY) {
                if (!seen[nb]) { seen[nb] = 1; region.push(nb); }
              } else borders.add(board[nb]);
            }
          }
          if (borders.size === 1) {
            const c = borders.values().next().value;
            let pts = 0;
            for (const p of region) if (!this.minus.has(p)) pts++;
            terr[c] += pts;
          }
        }
      }

      const mk = (c) => {
        let stones = 0, bases = 0, plusPts = 0, minusPts = 0;
        for (let i = 0; i < board.length; i++) {
          if (board[i] !== c) continue;
          if (isBase[i]) bases++; else stones++;
        }
        // ±화점은 1회성 획득 기록에서 합산 (히든 돌이 얻은 것은 실시간 표시에서 숨김)
        for (const b of this.bonusLog) {
          if (b.color !== c) continue;
          if (opts.live && b.hidden) continue;
          if (b.val > 0) plusPts++; else minusPts++;
        }
        const total = stones + bases * 5 + plusPts * 5 - minusPts * 5 +
          terr[c] + this.scanBonus[c] + this.betting[c] - this.timePenalty[c];
        return {
          stones, bases, plus: plusPts, minus: minusPts,
          territory: terr[c], captures: capCnt[c],
          scanBonus: this.scanBonus[c], betting: this.betting[c],
          timePenalty: this.timePenalty[c], total,
        };
      };

      const B = mk(BLACK), W = mk(WHITE);
      const second = other(this.firstPlayer);
      let winner;
      if (B.total > W.total) winner = BLACK;
      else if (W.total > B.total) winner = WHITE;
      else winner = second; // 동점 → 후공 승
      return { [BLACK]: B, [WHITE]: W, winner, second, tie: B.total === W.total };
    }

    /* 계가 화면용: 각 빈 점의 집 소유 (0 없음 / BLACK / WHITE) */
    territoryMap(deadSet) {
      deadSet = deadSet || new Set();
      const board = this.board.slice();
      for (const i of deadSet) board[i] = EMPTY;
      const owner = new Int8Array(board.length);
      const seen = new Uint8Array(board.length);
      for (let i = 0; i < board.length; i++) {
        if (board[i] !== EMPTY || seen[i]) continue;
        const region = [i];
        seen[i] = 1;
        const borders = new Set();
        for (let k = 0; k < region.length; k++) {
          for (const nb of this.neighbors(region[k])) {
            if (board[nb] === EMPTY) {
              if (!seen[nb]) { seen[nb] = 1; region.push(nb); }
            } else borders.add(board[nb]);
          }
        }
        if (borders.size === 1) {
          const c = borders.values().next().value;
          for (const p of region) if (!this.minus.has(p)) owner[p] = c;
        }
      }
      return owner;
    }

    /* 계가 단계에서 대국 재개 (성급한 더블 패스 취소) */
    resumePlay() {
      if (this.phase !== 'scoring') return { ok: false };
      this.phase = 'play';
      this.passes = 0;
      return { ok: true };
    }

    finalize(deadSet) {
      const result = this.score(deadSet);
      this.phase = 'over';
      this.winner = result.winner;
      this.overReason = 'score';
      this.finalResult = result;
      return result;
    }
  }

  global.Batoo = { BatooGame, EMPTY, BLACK, WHITE, other };
})(window);
