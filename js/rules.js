/* 象棋规则引擎：棋盘状态、走法生成、将军/将死判定、棋谱记法 */
'use strict';

const Rules = (function () {

  const RED = 'r';
  const BLACK = 'b';

  const NAME = {
    r: { K: '帅', A: '仕', B: '相', N: '马', R: '车', C: '炮', P: '兵' },
    b: { K: '将', A: '士', B: '象', N: '马', R: '车', C: '炮', P: '卒' }
  };

  const CN = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

  let template = null;
  function buildTemplate() {
    const s = [];
    for (let r = 0; r < 10; r++) s.push(new Array(9).fill(null));
    const back = ['R', 'N', 'B', 'A', 'K', 'A', 'B', 'N', 'R'];
    for (let c = 0; c < 9; c++) {
      s[0][c] = { side: BLACK, type: back[c] };
      s[9][c] = { side: RED, type: back[c] };
    }
    s[2][1] = { side: BLACK, type: 'C' };
    s[2][7] = { side: BLACK, type: 'C' };
    s[7][1] = { side: RED, type: 'C' };
    s[7][7] = { side: RED, type: 'C' };
    for (let c = 0; c < 9; c += 2) {
      s[3][c] = { side: BLACK, type: 'P' };
      s[6][c] = { side: RED, type: 'P' };
    }
    return s;
  }

  // 棋子对象保持引用稳定（UI 依赖其做动画）
  function initialState() {
    if (!template) template = buildTemplate();
    return template.map(function (row) { return row.slice(); });
  }

  function clone(state) {
    return state.map(function (row) { return row.slice(); });
  }

  function inside(r, c) { return r >= 0 && r < 10 && c >= 0 && c < 9; }

  function inPalace(side, r, c) {
    if (c < 3 || c > 5) return false;
    return side === RED ? (r >= 7 && r <= 9) : (r >= 0 && r <= 2);
  }

  // 兵/卒是否已过河（按拥有方视角）
  function crossedRiver(side, r) { return side === RED ? r <= 4 : r >= 5; }
  // 相/象是否在己方半场
  function ownHalf(side, r) { return side === RED ? r >= 5 : r <= 4; }

  function pseudoMoves(state, r, c, piece) {
    const side = piece.side;
    const out = [];
    const add = function (tr, tc) {
      if (!inside(tr, tc)) return;
      const t = state[tr][tc];
      if (t && t.side === side) return;
      out.push([tr, tc]);
    };

    switch (piece.type) {
      case 'K': {
        const d = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (let i = 0; i < d.length; i++) {
          const tr = r + d[i][0], tc = c + d[i][1];
          if (inPalace(side, tr, tc)) add(tr, tc);
        }
        break;
      }
      case 'A': {
        const d = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
        for (let i = 0; i < d.length; i++) {
          const tr = r + d[i][0], tc = c + d[i][1];
          if (inPalace(side, tr, tc)) add(tr, tc);
        }
        break;
      }
      case 'B': {
        const d = [[2, 2], [2, -2], [-2, 2], [-2, -2]];
        for (let i = 0; i < d.length; i++) {
          const tr = r + d[i][0], tc = c + d[i][1];
          if (!inside(tr, tc) || !ownHalf(side, tr)) continue;
          if (state[r + d[i][0] / 2][c + d[i][1] / 2]) continue; // 塞象眼
          add(tr, tc);
        }
        break;
      }
      case 'N': {
        const d = [
          [-2, -1, -1, 0], [-2, 1, -1, 0], [2, -1, 1, 0], [2, 1, 1, 0],
          [-1, -2, 0, -1], [-1, 2, 0, 1], [1, -2, 0, -1], [1, 2, 0, 1]
        ];
        for (let i = 0; i < d.length; i++) {
          const legR = r + d[i][2], legC = c + d[i][3];
          if (!inside(legR, legC) || state[legR][legC]) continue; // 蹩马腿
          add(r + d[i][0], c + d[i][1]);
        }
        break;
      }
      case 'R': {
        const d = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (let i = 0; i < d.length; i++) {
          let tr = r + d[i][0], tc = c + d[i][1];
          while (inside(tr, tc)) {
            const t = state[tr][tc];
            if (!t) { out.push([tr, tc]); }
            else {
              if (t.side !== side) out.push([tr, tc]);
              break;
            }
            tr += d[i][0]; tc += d[i][1];
          }
        }
        break;
      }
      case 'C': {
        const d = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (let i = 0; i < d.length; i++) {
          let tr = r + d[i][0], tc = c + d[i][1];
          let screened = false;
          while (inside(tr, tc)) {
            const t = state[tr][tc];
            if (!screened) {
              if (!t) out.push([tr, tc]);
              else screened = true;
            } else if (t) {
              if (t.side !== side) out.push([tr, tc]);
              break;
            }
            tr += d[i][0]; tc += d[i][1];
          }
        }
        break;
      }
      case 'P': {
        const fwd = side === RED ? -1 : 1;
        add(r + fwd, c);
        if (crossedRiver(side, r)) { add(r, c - 1); add(r, c + 1); }
        break;
      }
    }
    return out;
  }

  function findKing(state, side) {
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 9; c++) {
        const p = state[r][c];
        if (p && p.side === side && p.type === 'K') return [r, c];
      }
    }
    return null;
  }

  // 将帅是否正对（无子相隔）
  function kingsFacing(state) {
    const kr = findKing(state, RED);
    const kb = findKing(state, BLACK);
    if (!kr || !kb || kr[1] !== kb[1]) return false;
    const c = kr[1];
    const lo = Math.min(kr[0], kb[0]);
    const hi = Math.max(kr[0], kb[0]);
    for (let r = lo + 1; r < hi; r++) if (state[r][c]) return false;
    return true;
  }

  // side 方的将是否被攻击（含将帅照面）
  function inCheck(state, side) {
    const k = findKing(state, side);
    if (!k) return true;
    if (kingsFacing(state)) return true;
    const enemy = side === RED ? BLACK : RED;
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 9; c++) {
        const p = state[r][c];
        if (!p || p.side !== enemy) continue;
        const ms = pseudoMoves(state, r, c, p);
        for (let i = 0; i < ms.length; i++) {
          if (ms[i][0] === k[0] && ms[i][1] === k[1]) return true;
        }
      }
    }
    return false;
  }

  function applyMove(state, from, to) {
    const ns = clone(state);
    ns[to[0]][to[1]] = ns[from[0]][from[1]];
    ns[from[0]][from[1]] = null;
    return ns;
  }

  // side 方全部合法走法
  function legalMoves(state, side) {
    const res = [];
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 9; c++) {
        const p = state[r][c];
        if (!p || p.side !== side) continue;
        const ms = pseudoMoves(state, r, c, p);
        for (let i = 0; i < ms.length; i++) {
          const to = ms[i];
          const target = state[to[0]][to[1]];
          if (target && target.type === 'K') continue; // 永不生成吃将走法
          const ns = applyMove(state, [r, c], to);
          if (!inCheck(ns, side)) res.push({ from: [r, c], to: to });
        }
      }
    }
    return res;
  }

  function legalMovesFrom(state, side, r, c) {
    const all = legalMoves(state, side);
    return all.filter(function (m) { return m.from[0] === r && m.from[1] === c; })
              .map(function (m) { return m.to; });
  }

  function isLegal(state, side, from, to) {
    if (!from || !to) return false;
    const ms = legalMovesFrom(state, side, from[0], from[1]);
    for (let i = 0; i < ms.length; i++) {
      if (ms[i][0] === to[0] && ms[i][1] === to[1]) return true;
    }
    return false;
  }

  // 局面状态
  function status(state, sideToMove) {
    const kr = findKing(state, RED);
    const kb = findKing(state, BLACK);
    if (!kr) return { over: true, winner: BLACK, reason: 'king' };
    if (!kb) return { over: true, winner: RED, reason: 'king' };
    const moves = legalMoves(state, sideToMove);
    if (moves.length === 0) {
      const check = inCheck(state, sideToMove);
      return {
        over: true,
        winner: sideToMove === RED ? BLACK : RED,
        reason: check ? 'checkmate' : 'stalemate',
        check: check
      };
    }
    return { over: false, check: inCheck(state, sideToMove) };
  }

  // 由走法历史推导局面（保证双方状态一致）
  function derive(history) {
    let st = initialState();
    for (let i = 0; i < history.length; i++) {
      const m = history[i];
      if (!m || !Array.isArray(m.from) || !Array.isArray(m.to)) return null;
      const fr = m.from[0], fc = m.from[1], tr = m.to[0], tc = m.to[1];
      if (!inside(fr, fc) || !inside(tr, tc)) return null;
      const p = st[fr][fc];
      if (!p) return null;
      if (p.side !== (i % 2 === 0 ? RED : BLACK)) return null;
      const t = st[tr][tc];
      if (t && t.side === p.side) return null;
      st = applyMove(st, m.from, m.to);
    }
    return st;
  }

  // 中国象棋纵线记法：炮二平五 / 马8进7
  function moveText(state, from, to) {
    const p = state[from[0]][from[1]];
    if (!p) return '?';
    const isRed = p.side === RED;
    const file = function (c) { return isRed ? CN[9 - c] : String(c + 1); };
    const name = NAME[p.side][p.type];
    const forward = function () { return isRed ? to[0] < from[0] : to[0] > from[0]; };

    if (from[1] === to[1]) {
      const steps = Math.abs(to[0] - from[0]);
      return name + file(from[1]) + (forward() ? '进' : '退') + (isRed ? CN[steps] : String(steps));
    }
    if (from[0] === to[0]) {
      return name + file(from[1]) + '平' + file(to[1]);
    }
    const verb = forward() ? '进' : '退';
    if (p.type === 'N' || p.type === 'B' || p.type === 'A') {
      return name + file(from[1]) + verb + file(to[1]);
    }
    const steps = Math.abs(to[0] - from[0]);
    return name + file(from[1]) + verb + (isRed ? CN[steps] : String(steps));
  }

  function cellName(r, c) { return (9 - c) + ',' + (9 - r); }

  return {
    RED: RED,
    BLACK: BLACK,
    NAME: NAME,
    initialState: initialState,
    clone: clone,
    pseudoMoves: pseudoMoves,
    legalMoves: legalMoves,
    legalMovesFrom: legalMovesFrom,
    isLegal: isLegal,
    inCheck: inCheck,
    kingsFacing: kingsFacing,
    findKing: findKing,
    applyMove: applyMove,
    status: status,
    derive: derive,
    moveText: moveText,
    cellName: cellName
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Rules;
