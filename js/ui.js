/* =========================================================
 * 바투(Batoo) — 보드 렌더러 (canvas)
 * 히든 돌 표시 규칙:
 *  - isHidden=1인 돌은 기본적으로 그리지 않는다.
 *  - opts.showHiddenFor 색의 히든 돌은 반투명+점선(온라인에서 내 히든).
 *  - opts.tempReveal(스캔 플래시)에 든 돌은 잠깐 강조 표시.
 * ========================================================= */
(function (global) {
  'use strict';

  const { EMPTY, BLACK, WHITE } = global.Batoo;

  class BoardView {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.game = null;
      this.opts = {
        showHiddenFor: null,   // BLACK/WHITE/'all'/null
        tempReveal: new Set(), // 스캔으로 잠깐 보이는 idx
        deadSet: new Set(),    // 사석 표시
        pendingBases: null,    // { color, list:[idx] } 베이스빌드 중
        ghost: null,           // 'stone' | 'hidden' | 'scan' | 'base' | null
        ghostColor: BLACK,
        territory: null,       // Int8Array 소유 집 표시(계가)
        interactive: true,
      };
      this.hover = null;
      this.onClick = null;
      this.onHover = null;

      canvas.addEventListener('mousemove', (e) => {
        const p = this.ptFromEvent(e);
        const changed = !this._samePt(p, this.hover);
        this.hover = p;
        if (changed) { if (this.onHover) this.onHover(p); this.render(); }
      });
      canvas.addEventListener('mouseleave', () => {
        this.hover = null;
        this.render();
      });
      canvas.addEventListener('click', (e) => {
        const p = this.ptFromEvent(e);
        if (p && this.onClick && this.opts.interactive) this.onClick(p);
      });

      if (global.ResizeObserver) {
        new ResizeObserver(() => this.resize()).observe(canvas.parentElement || canvas);
      }
      global.addEventListener('resize', () => this.resize());
    }

    _samePt(a, b) {
      if (!a && !b) return true;
      if (!a || !b) return false;
      return a.x === b.x && a.y === b.y;
    }

    setGame(game) {
      this.game = game;
      this.resize();
    }

    resize() {
      const parent = this.canvas.parentElement;
      if (!parent) return;
      const css = Math.min(parent.clientWidth, parent.clientHeight || parent.clientWidth);
      if (css <= 0) return;
      const dpr = global.devicePixelRatio || 1;
      this.cssSize = css;
      this.canvas.style.width = css + 'px';
      this.canvas.style.height = css + 'px';
      this.canvas.width = Math.round(css * dpr);
      this.canvas.height = Math.round(css * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.layout();
      this.render();
    }

    layout() {
      if (!this.game) return;
      const n = this.game.size;
      // 좌/상단에 좌표 라벨 공간
      this.cell = this.cssSize / (n + 1.4);
      this.ox = this.cell * 1.15;
      this.oy = this.cell * 1.15;
    }

    px(x) { return this.ox + x * this.cell; }
    py(y) { return this.oy + y * this.cell; }

    ptFromEvent(e) {
      if (!this.game) return null;
      const rect = this.canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) * (this.cssSize / rect.width);
      const my = (e.clientY - rect.top) * (this.cssSize / rect.height);
      const x = Math.round((mx - this.ox) / this.cell);
      const y = Math.round((my - this.oy) / this.cell);
      if (!this.game.inBounds(x, y)) return null;
      const dx = mx - this.px(x), dy = my - this.py(y);
      if (dx * dx + dy * dy > (this.cell * 0.48) ** 2) return null;
      return { x, y };
    }

    /* ---------- 렌더링 ---------- */
    render() {
      const g = this.game;
      if (!g || !this.cell) return;
      const ctx = this.ctx;
      const n = g.size;
      const W = this.cssSize;

      // 배경(종이/나무 질감 느낌)
      ctx.clearRect(0, 0, W, W);
      const bg = ctx.createLinearGradient(0, 0, W, W);
      bg.addColorStop(0, '#efe3bd');
      bg.addColorStop(0.5, '#e7d6a8');
      bg.addColorStop(1, '#dcc890');
      ctx.fillStyle = bg;
      this._roundRect(ctx, 2, 2, W - 4, W - 4, 10);
      ctx.fill();
      const vg = ctx.createRadialGradient(W / 2, W / 2, W * 0.2, W / 2, W / 2, W * 0.75);
      vg.addColorStop(0, 'rgba(255,255,255,0.06)');
      vg.addColorStop(1, 'rgba(90,60,20,0.14)');
      ctx.fillStyle = vg;
      this._roundRect(ctx, 2, 2, W - 4, W - 4, 10);
      ctx.fill();
      ctx.strokeStyle = 'rgba(70,50,20,0.5)';
      ctx.lineWidth = 2;
      this._roundRect(ctx, 2, 2, W - 4, W - 4, 10);
      ctx.stroke();

      // 격자
      ctx.strokeStyle = '#5d4a28';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        ctx.moveTo(this.px(0), this.py(i));
        ctx.lineTo(this.px(n - 1), this.py(i));
        ctx.moveTo(this.px(i), this.py(0));
        ctx.lineTo(this.px(i), this.py(n - 1));
      }
      ctx.stroke();
      // 외곽선 두껍게
      ctx.lineWidth = 2;
      ctx.strokeRect(this.px(0), this.py(0), this.cell * (n - 1), this.cell * (n - 1));

      // 좌표 라벨 (열: A~ / 행: 1~, I 포함)
      ctx.fillStyle = '#6b5836';
      ctx.font = `600 ${Math.max(10, this.cell * 0.34)}px 'Segoe UI', sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let x = 0; x < n; x++) {
        ctx.fillText(String.fromCharCode(65 + x), this.px(x), this.oy - this.cell * 0.62);
      }
      for (let y = 0; y < n; y++) {
        ctx.fillText(String(y + 1), this.ox - this.cell * 0.62, this.py(y));
      }

      // 천원(센터마크) — ±화점이 아닐 때만
      const centerI = g.idx((n - 1) / 2, (n - 1) / 2);
      if (!g.plus.has(centerI) && !g.minus.has(centerI) && g.board[centerI] === EMPTY) {
        ctx.fillStyle = '#5d4a28';
        ctx.beginPath();
        ctx.arc(this.px((n - 1) / 2), this.py((n - 1) / 2), this.cell * 0.09, 0, Math.PI * 2);
        ctx.fill();
      }

      // ± 화점 다이아몬드 마커 (활성 상태인 것만 — 돌이 놓이면 소비되어 사라짐)
      for (const i of g.plus) this._drawPointBadge(i, '+');
      for (const i of g.minus) this._drawPointBadge(i, '−');

      // 집 표시(계가)
      if (this.opts.territory) {
        for (let i = 0; i < this.opts.territory.length; i++) {
          const o = this.opts.territory[i];
          if (!o || g.board[i] !== EMPTY) continue;
          const [x, y] = g.xy(i);
          const s = this.cell * 0.22;
          ctx.fillStyle = o === BLACK ? 'rgba(20,20,20,0.75)' : 'rgba(255,255,255,0.92)';
          ctx.strokeStyle = 'rgba(60,45,20,0.6)';
          ctx.lineWidth = 1;
          ctx.fillRect(this.px(x) - s / 2, this.py(y) - s / 2, s, s);
          ctx.strokeRect(this.px(x) - s / 2, this.py(y) - s / 2, s, s);
        }
      }

      // 돌
      for (let i = 0; i < g.board.length; i++) {
        const c = g.board[i];
        if (c === EMPTY) continue;
        if (g.isHidden[i]) {
          const mine = this.opts.showHiddenFor === 'all' || this.opts.showHiddenFor === c;
          const flash = this.opts.tempReveal.has(i);
          if (!mine && !flash) continue; // 안 보임
          this._drawStone(i, c, { hiddenStyle: true, flash });
        } else {
          this._drawStone(i, c, {});
        }
      }

      // 베이스빌드 중 임시 배치
      if (this.opts.pendingBases) {
        for (const i of this.opts.pendingBases.list) {
          this._drawStone(i, this.opts.pendingBases.color, { base: true, pending: true });
        }
      }

      // 마지막 착수 표식
      if (g.lastMove >= 0 && g.board[g.lastMove] !== EMPTY && !g.isHidden[g.lastMove]) {
        const [x, y] = g.xy(g.lastMove);
        ctx.fillStyle = '#e14b3b';
        ctx.beginPath();
        ctx.arc(this.px(x), this.py(y), this.cell * 0.13, 0, Math.PI * 2);
        ctx.fill();
      }

      // 사석 X 표시
      for (const i of this.opts.deadSet) {
        if (g.board[i] === EMPTY) continue;
        const [x, y] = g.xy(i);
        const r = this.cell * 0.28;
        ctx.strokeStyle = '#e14b3b';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(this.px(x) - r, this.py(y) - r);
        ctx.lineTo(this.px(x) + r, this.py(y) + r);
        ctx.moveTo(this.px(x) + r, this.py(y) - r);
        ctx.lineTo(this.px(x) - r, this.py(y) + r);
        ctx.stroke();
      }

      // 호버 고스트
      if (this.hover && this.opts.ghost && this.opts.interactive) {
        this._drawGhost(this.hover, this.opts.ghost, this.opts.ghostColor);
      }
    }

    /* ±화점: 원작처럼 다이아몬드(마름모) 마커 */
    _drawPointBadge(i, glyph) {
      const g = this.game, ctx = this.ctx;
      const [x, y] = g.xy(i);
      const cx = this.px(x), cy = this.py(y);
      // 활성 화점은 정의상 빈 자리지만, 혹시 돌이 있으면(히든 미표시 등) 그리지 않음
      const coveredVisible = g.board[i] !== EMPTY &&
        !(g.isHidden[i] && this.opts.showHiddenFor !== 'all' &&
          this.opts.showHiddenFor !== g.board[i] && !this.opts.tempReveal.has(i));
      if (coveredVisible) return;
      const isPlus = glyph === '+';
      const col = isPlus ? '#c8571f' : '#3e6285';
      const r = this.cell * 0.34;
      const grad = ctx.createLinearGradient(cx, cy - r, cx, cy + r);
      grad.addColorStop(0, isPlus ? '#eb8b45' : '#628cb2');
      grad.addColorStop(1, col);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r, cy);
      ctx.lineTo(cx, cy + r);
      ctx.lineTo(cx - r, cy);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(50,30,10,0.45)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = `800 ${this.cell * 0.4}px 'Segoe UI', sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(glyph, cx, cy + 0.5);
    }

    _drawStone(i, color, o) {
      const g = this.game, ctx = this.ctx;
      const [x, y] = g.xy(i);
      const cx = this.px(x), cy = this.py(y);
      const r = this.cell * 0.46;

      ctx.save();
      if (o.hiddenStyle) ctx.globalAlpha = o.flash ? 0.95 : 0.55;
      if (o.pending) ctx.globalAlpha = 0.9;

      // 그림자
      ctx.beginPath();
      ctx.arc(cx + r * 0.08, cy + r * 0.12, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(40,25,5,0.35)';
      ctx.fill();

      const grad = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.15, cx, cy, r * 1.05);
      if (color === BLACK) {
        grad.addColorStop(0, '#5a5a5e');
        grad.addColorStop(0.5, '#1c1c20');
        grad.addColorStop(1, '#000');
      } else {
        grad.addColorStop(0, '#ffffff');
        grad.addColorStop(0.6, '#f0efe9');
        grad.addColorStop(1, '#c9c6ba');
      }
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = color === BLACK ? 'rgba(0,0,0,0.8)' : 'rgba(120,115,100,0.8)';
      ctx.lineWidth = 1;
      ctx.stroke();

      // 베이스 무늬(소용돌이)
      if (g.isBase[i] || o.base) {
        this._drawSwirl(cx, cy, r, color);
      }

      // 히든 표시(내 것만 보일 때): 점선 링
      if (o.hiddenStyle) {
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = o.flash ? '#38b6ff' : (color === BLACK ? '#9ad0ff' : '#3e78b0');
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, r + 2.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        if (o.flash) {
          ctx.strokeStyle = 'rgba(56,182,255,0.9)';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(cx, cy, r + 6, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    /* 소용돌이 무늬 — 베이스 돌 표시 (방송 스킨: 흑=청록, 백=빨강) */
    _drawSwirl(cx, cy, r, stoneColor) {
      const ctx = this.ctx;
      ctx.save();
      ctx.strokeStyle = stoneColor === BLACK ? 'rgba(64,199,190,0.95)' : 'rgba(196,57,43,0.9)';
      ctx.lineWidth = Math.max(1.5, r * 0.14);
      ctx.lineCap = 'round';
      const turns = 2.4 * Math.PI;
      ctx.beginPath();
      for (let t = 0; t <= turns; t += 0.15) {
        const rr = (t / turns) * r * 0.62;
        const px = cx + rr * Math.cos(t);
        const py = cy + rr * Math.sin(t);
        if (t === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.restore();
    }

    _drawGhost(p, kind, color) {
      const g = this.game, ctx = this.ctx;
      const i = g.idx(p.x, p.y);
      const cx = this.px(p.x), cy = this.py(p.y);
      const r = this.cell * 0.46;

      if (kind === 'scan') {
        ctx.save();
        ctx.strokeStyle = '#1f8fde';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(cx, cy, r * 0.95, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx - r * 1.35, cy); ctx.lineTo(cx - r * 0.55, cy);
        ctx.moveTo(cx + r * 0.55, cy); ctx.lineTo(cx + r * 1.35, cy);
        ctx.moveTo(cx, cy - r * 1.35); ctx.lineTo(cx, cy - r * 0.55);
        ctx.moveTo(cx, cy + r * 0.55); ctx.lineTo(cx, cy + r * 1.35);
        ctx.stroke();
        ctx.restore();
        return;
      }

      // 이미 (보이는) 돌이 있으면 고스트 없음
      const visibleStone = g.board[i] !== EMPTY &&
        (!g.isHidden[i] || this.opts.showHiddenFor === 'all' || this.opts.showHiddenFor === g.board[i]);
      if (visibleStone && kind !== 'dead') return;

      ctx.save();
      ctx.globalAlpha = 0.45;
      const grad = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.2, cx, cy, r);
      if (color === BLACK) { grad.addColorStop(0, '#555'); grad.addColorStop(1, '#000'); }
      else { grad.addColorStop(0, '#fff'); grad.addColorStop(1, '#bbb'); }
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      if (kind === 'hidden') {
        ctx.globalAlpha = 0.9;
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = '#38b6ff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, r + 2, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#38b6ff';
        ctx.font = `800 ${r}px 'Segoe UI', sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('H', cx, cy + 1);
      }
      if (kind === 'base') this._drawSwirl(cx, cy, r, color);
      ctx.restore();
    }

    _roundRect(ctx, x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }
  }

  global.BatooUI = { BoardView };
})(window);
