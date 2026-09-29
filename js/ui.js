/* 棋盘渲染与交互：SVG 棋盘、棋子定位、点选高亮、音效 */
'use strict';

const UI = (function () {

  let orientation = 'r';          // 'r' 由下往上，'b' 翻转
  let onCellClick = null;
  let board = null, svg = null, marks = null, pieceLayer = null;
  const pieceEls = new Map();     // 棋子对象 -> DOM 元素（引用稳定）
  let lastFxMove = null;          // 防止同一手棋重复播走子动画

  /* ---------- 坐标：棋盘(r,c) <-> 视图坐标(viewBox 10x11) ---------- */
  function T(r, c) {
    return orientation === 'r' ? [c + 1, r + 1] : [8 - c + 1, 9 - r + 1];
  }

  function viewToCell(vx, vy) {
    let c, r;
    if (orientation === 'r') { c = vx - 1; r = vy - 1; }
    else { c = 8 - (vx - 1); r = 9 - (vy - 1); }
    const cc = Math.round(c), rr = Math.round(r);
    const dx = c - cc, dy = r - rr;
    if (dx * dx + dy * dy > 0.30) return null;   // 点太靠外
    if (rr < 0 || rr > 9 || cc < 0 || cc > 8) return null;
    return [rr, cc];
  }

  /* ---------- SVG 棋盘 ---------- */
  const MARK_POINTS = [
    [2, 1], [2, 7], [7, 1], [7, 7],
    [3, 0], [3, 2], [3, 4], [3, 6], [3, 8],
    [6, 0], [6, 2], [6, 4], [6, 6], [6, 8]
  ];

  function buildSvg() {
    const S = 'fill="none" stroke="#7a5a30" stroke-width="0.035" stroke-linecap="square"';
    const parts = [];
    const seg = function (r1, c1, r2, c2) {
      const a = T(r1, c1), b = T(r2, c2);
      parts.push('<line x1="' + a[0] + '" y1="' + a[1] + '" x2="' + b[0] + '" y2="' + b[1] + '" ' + S + '/>');
    };

    for (let r = 0; r < 10; r++) seg(r, 0, r, 8);
    for (let c = 0; c < 9; c++) {
      if (c === 0 || c === 8) seg(0, c, 9, c);
      else { seg(0, c, 4, c); seg(5, c, 9, c); }
    }
    seg(0, 3, 2, 5); seg(0, 5, 2, 3);
    seg(7, 3, 9, 5); seg(7, 5, 9, 3);

    // 炮位 / 兵位 标记（四角折线）
    MARK_POINTS.forEach(function (pt) {
      const r = pt[0], c = pt[1];
      [[-1, -1], [-1, 1], [1, -1], [1, 1]].forEach(function (q) {
        const R = r + q[0], C = c + q[1];
        if (R < 0 || R > 9 || C < 0 || C > 8) return;
        const p1 = T(R, c + q[1] * 0.25);
        const p2 = T(R, C);
        const p3 = T(r + q[0] * 0.25, C);
        parts.push('<polyline points="' +
          p1[0] + ',' + p1[1] + ' ' + p2[0] + ',' + p2[1] + ' ' + p3[0] + ',' + p3[1] +
          '" fill="none" stroke="#7a5a30" stroke-width="0.03"/>');
      });
    });

    // 楚河 汉界
    const t1 = T(4.5, 2), t2 = T(4.5, 6);
    const rot = orientation === 'b';
    const txt = function (p, s) {
      const tr = rot ? ' transform="rotate(180 ' + p[0] + ' ' + p[1] + ')"' : '';
      return '<text x="' + p[0] + '" y="' + p[1] + '"' + tr +
        ' text-anchor="middle" dominant-baseline="central" font-size="0.72"' +
        ' letter-spacing="0.18"' +
        ' font-family="STKaiti,KaiTi,SimSun,serif" fill="#6b4420" opacity="0.9">' + s + '</text>';
    };
    parts.push(txt(t1, '楚 河'));
    parts.push(txt(t2, '汉 界'));

    svg.setAttribute('viewBox', '0 0 10 11');
    svg.innerHTML = parts.join('');
  }

  /* ---------- 音效 ---------- */
  let actx = null;
  function ac() {
    if (!actx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      actx = new AC();
    }
    if (actx.state === 'suspended') actx.resume();
    return actx;
  }
  function beep(freq, dur, type, vol, delay) {
    const ctx = ac();
    if (!ctx) return;
    const t0 = ctx.currentTime + (delay || 0);
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(vol || 0.1, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    o.connect(g); g.connect(ctx.destination);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }
  const sound = {
    move: function () { beep(430, 0.07, 'triangle', 0.16); },
    capture: function () { beep(240, 0.12, 'square', 0.10); beep(180, 0.14, 'triangle', 0.10, 0.05); },
    check: function () { beep(740, 0.09, 'square', 0.12); beep(740, 0.09, 'square', 0.12, 0.16); },
    win: function () { beep(523, 0.12, 'triangle', 0.14); beep(659, 0.12, 'triangle', 0.14, 0.13); beep(784, 0.2, 'triangle', 0.14, 0.26); },
    lose: function () { beep(440, 0.16, 'sawtooth', 0.10); beep(330, 0.24, 'sawtooth', 0.10, 0.17); }
  };

  /* ---------- 初始化 ---------- */
  function init(opts) {
    onCellClick = opts && opts.onCellClick;
    board = document.getElementById('board');
    svg = document.getElementById('boardSvg');
    marks = document.getElementById('marks');
    pieceLayer = document.getElementById('pieces');
    buildSvg();

    board.addEventListener('click', function (e) {
      const rect = board.getBoundingClientRect();
      const vx = (e.clientX - rect.left) / rect.width * 10;
      const vy = (e.clientY - rect.top) / rect.height * 11;
      const cell = viewToCell(vx, vy);
      if (cell && onCellClick) onCellClick(cell[0], cell[1]);
    });

    const fitFont = function () { board.style.fontSize = (board.clientWidth / 18) + 'px'; };
    fitFont();
    if (window.ResizeObserver) new ResizeObserver(fitFont).observe(board);
    else window.addEventListener('resize', fitFont);
  }

  function setOrientation(side) {
    orientation = side;
    buildSvg();
  }

  /* ---------- 渲染 ---------- */
  function posStyle(el, r, c) {
    const p = T(r, c);
    el.style.left = (p[0] / 10 * 100) + '%';
    el.style.top = (p[1] / 11 * 100) + '%';
  }

  function render(state, opts) {
    opts = opts || {};
    const alive = new Set();
    const lm = opts.lastMove;

    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 9; c++) {
        const p = state[r][c];
        if (!p) continue;
        alive.add(p);
        let el = pieceEls.get(p);
        if (!el) {
          el = document.createElement('div');
          el.className = 'piece ' + p.side;
          el.textContent = Rules.NAME[p.side][p.type];
          pieceLayer.appendChild(el);
          pieceEls.set(p, el);
        }
        posStyle(el, r, c);
        const isSel = opts.sel && opts.sel[0] === r && opts.sel[1] === c;
        el.classList.toggle('sel', !!isSel);
        el.classList.toggle('check', opts.checkSide === p.side && p.type === 'K');
        // 走子动画：一手棋只播一次
        if (lm && lm !== lastFxMove && lm.to[0] === r && lm.to[1] === c) {
          el.classList.remove('moving');
          void el.offsetWidth;
          el.classList.add('moving');
          setTimeout(function () { el.classList.remove('moving'); }, 300);
        }
      }
    }
    pieceEls.forEach(function (el, p) {
      if (!alive.has(p)) {
        pieceEls.delete(p);
        // 被吃的棋子：爆裂光效 + 缩小消失
        el.classList.add('dying');
        burstAt(el.style.left, el.style.top);
        setTimeout(function () { el.remove(); }, 300);
      }
    });
    if (lm) lastFxMove = lm;

    renderMarks(state, opts);
  }

  function burstAt(left, top) {
    if (!left) return;
    const b = document.createElement('div');
    b.className = 'mark burst';
    b.style.left = left;
    b.style.top = top;
    marks.appendChild(b);
    setTimeout(function () { b.remove(); }, 450);
  }

  // 将军特效：棋盘中央书法大字 + 红光闪烁
  function fxCheck() {
    const d = document.createElement('div');
    d.className = 'check-fx';
    d.innerHTML = '<span>将 军</span>';
    board.appendChild(d);
    board.classList.add('flash');
    setTimeout(function () { d.remove(); board.classList.remove('flash'); }, 1000);
  }

  // 绝杀特效：金色大字（3字以上棋型缩小字号防换行）
  function fxFinish(text) {
    const d = document.createElement('div');
    const chars = text.replace(/\s/g, '').length;
    d.className = 'check-fx finish' + (chars > 2 ? ' long' : '');
    d.innerHTML = '<span>' + text + '</span>';
    board.appendChild(d);
    board.classList.add('flash');
    setTimeout(function () { d.remove(); board.classList.remove('flash'); }, 1600);
  }

  function mark(cls, r, c) {
    const el = document.createElement('div');
    el.className = 'mark ' + cls;
    posStyle(el, r, c);
    marks.appendChild(el);
  }

  function renderMarks(state, opts) {
    marks.innerHTML = '';
    if (opts.lastMove) {
      mark('last', opts.lastMove.from[0], opts.lastMove.from[1]);
      mark('last', opts.lastMove.to[0], opts.lastMove.to[1]);
    }
    if (opts.sel) {
      mark('square', opts.sel[0], opts.sel[1]);
    }
  }

  function clear() {
    pieceEls.forEach(function (el) { el.remove(); });
    pieceEls.clear();
    marks.innerHTML = '';
    lastFxMove = null;
  }

  return {
    init: init,
    setOrientation: setOrientation,
    render: render,
    clear: clear,
    fxCheck: fxCheck,
    fxFinish: fxFinish,
    sound: sound
  };
})();
