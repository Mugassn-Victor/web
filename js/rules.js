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

  // ===== 绝杀棋型识别（sideToMove = 被将死方） =====
  // 同时符合多个棋型时全部收集（去重），按典型度顺序用「、」连接；一个都不匹配则返回「绝杀」
  function matePattern(state, sideToMove) {
    const st = status(state, sideToMove);
    if (!st.over) return null;
    if (st.reason === 'stalemate') return '困毙';
    if (st.reason !== 'checkmate') return '绝杀';

    const loser = sideToMove;
    const winner = loser === RED ? BLACK : RED;
    const k = findKing(state, loser);
    if (!k) return '绝杀';
    const kr = k[0], kc = k[1];
    const dir = loser === BLACK ? 1 : -1;
    const cornerRows = loser === BLACK ? [0, 2] : [7, 9];
    const backRow = loser === BLACK ? 0 : 9;
    const pawnRow = loser === BLACK ? 3 : 6;
    const fishRow = loser === BLACK ? 2 : 7;

    const matches = [];
    function hit(name) { if (matches.indexOf(name) < 0) matches.push(name); }
    function done() { return matches.length ? matches.join('、') : '绝杀'; }

    function attacksKing(p, r, c) {
      const ms = pseudoMoves(state, r, c, p);
      for (let i = 0; i < ms.length; i++) {
        if (ms[i][0] === kr && ms[i][1] === kc) return true;
      }
      return false;
    }

    // 攻方照将子清单（将帅照面单独计）
    const checkers = [];
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 9; c++) {
        const p = state[r][c];
        if (p && p.side === winner && attacksKing(p, r, c)) checkers.push({ p: p, r: r, c: c });
      }
    }
    const facing = kingsFacing(state);
    if (checkers.length + (facing ? 1 : 0) >= 2) hit('双将');
    if (facing) hit('对面笑');
    if (!checkers.length) return done();

    // 马是否参与（将军或控制将门）
    function nInRole(r, c) {
      const p = state[r][c];
      if (attacksKing(p, r, c)) return true;
      const d = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      const ms = pseudoMoves(state, r, c, p);
      for (let i = 0; i < 4; i++) {
        const qr = kr + d[i][0], qc = kc + d[i][1];
        if (!inPalace(loser, qr, qc)) continue;
        for (let j = 0; j < ms.length; j++) {
          if (ms[j][0] === qr && ms[j][1] === qc) return true;
        }
      }
      return false;
    }
    function anyOwnN(cond) {
      for (let r = 0; r < 10; r++) {
        for (let c = 0; c < 9; c++) {
          const p = state[r][c];
          if (p && p.side === winner && p.type === 'N' && cond(r, c)) return true;
        }
      }
      return false;
    }

    let hasRChecker = false;

    // 逐个照将子识别子力型棋型（炮型 / 铁门栓 / 双车错）
    for (let ci = 0; ci < checkers.length; ci++) {
      const ch = checkers[ci];
      const type = ch.p.type;
      if (type === 'R') hasRChecker = true;

      // 炮型：按唯一炮架性质区分
      if (type === 'C') {
        const dr = Math.sign(kr - ch.r), dc = Math.sign(kc - ch.c);
        if (dr === 0 || dc === 0) {
          let screen = null, cnt = 0;
          let r = ch.r + dr, c = ch.c + dc;
          while (r !== kr || c !== kc) {
            const p = state[r][c];
            if (p) { screen = p; cnt++; }
            r += dr; c += dc;
          }
          if (cnt === 1 && screen) {
            if (screen.side === winner && screen.type === 'N') hit('马后炮');
            if (screen.side === winner && screen.type === 'C') hit('重炮');
            if (screen.side === loser) hit('闷宫');
          }
        }
      }

      // 铁门栓：车/兵贴身封锁将门 + 中线炮或借帅力
      if ((type === 'R' || type === 'P') && Math.abs(kr - ch.r) + Math.abs(kc - ch.c) === 1) {
        let cannon = false;
        for (let r = 0; r < 10; r++) {
          const p = state[r][kc];
          if (p && p.side === winner && p.type === 'C') { cannon = true; break; }
        }
        let kingPower = false;
        const wk = findKing(state, winner);
        if (wk && wk[1] === ch.c) {
          const lo = Math.min(wk[0], ch.r), hi = Math.max(wk[0], ch.r);
          kingPower = true;
          for (let r = lo + 1; r < hi; r++) {
            if (state[r][ch.c]) { kingPower = false; break; }
          }
        }
        if (cannon || kingPower) hit('铁门栓');
      }

      // 双车错：另一车控将门纵横线
      if (type === 'R') {
        for (let r = 0; r < 10; r++) {
          for (let c = 0; c < 9; c++) {
            const p = state[r][c];
            if (p && p !== ch.p && p.side === winner && p.type === 'R' && (r === kr || c === kc)) hit('双车错');
          }
        }
      }
    }

    // 马位配合类
    if (anyOwnN(function (r, c) {
      return cornerRows.indexOf(r) >= 0 && (c === 3 || c === 5) &&
        (attacksKing(state[r][c], r, c) ||
          (Math.abs(r - kr) === 2 && Math.abs(c - kc) === 2 && nInRole(r, c)));
    })) hit('八角马');
    if (anyOwnN(function (r, c) {
      return r === kr + dir && Math.abs(c - kc) === 2 && attacksKing(state[r][c], r, c);
    })) hit('卧槽马');
    if (anyOwnN(function (r, c) {
      return r === pawnRow && (c === 2 || c === 6) && nInRole(r, c);
    })) hit('侧面虎');
    if (hasRChecker && anyOwnN(function (r, c) {
      return Math.abs(r - kr) === 2 && Math.abs(c - kc) === 2 && nInRole(r, c);
    })) hit('列马车');
    if (anyOwnN(function (r, c) {
      return r === fishRow && (c === 2 || c === 6) && nInRole(r, c);
    })) hit('钓鱼马');

    // 双炮配合类
    const cannons = [];
    let hasR = false;
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 9; c++) {
        const p = state[r][c];
        if (p && p.side === winner && p.type === 'C') cannons.push({ r: r, c: c });
        if (p && p.side === winner && p.type === 'R') hasR = true;
      }
    }
    if (cannons.length >= 2) {
      let aligned = false;
      for (let i = 0; i < cannons.length && !aligned; i++) {
        for (let j = i + 1; j < cannons.length; j++) {
          if (cannons[i].r === cannons[j].r || cannons[i].c === cannons[j].c) { aligned = true; break; }
        }
      }
      if (aligned && hasR) hit('夹车炮');
      let bottom = false, onFile = false;
      for (let i = 0; i < cannons.length; i++) {
        if (cannons[i].r === backRow) bottom = true;
        if (cannons[i].c === kc) onFile = true;
      }
      if (bottom && onFile) hit('天地炮');
    }

    // 闷杀：将的退路被己方棋子堵死
    const d4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let blockedOwn = 0;
    for (let i = 0; i < d4.length; i++) {
      const qr = kr + d4[i][0], qc = kc + d4[i][1];
      if (!inPalace(loser, qr, qc)) continue;
      const p = state[qr][qc];
      if (p && p.side === loser) blockedOwn++;
    }
    if (blockedOwn >= 3) hit('闷杀');

    return done();
  }

  // ===== 无根棋子：被对方「真能」吃、且己方「真能」吃回才算有根 =====
  // 吃与回都要求走完后自己不被将军（含将帅照面）—— 钉死的假攻、假根一律不算
  function canCapture(state, bySide, tr, tc) {
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 9; c++) {
        const p = state[r][c];
        if (!p || p.side !== bySide) continue;
        const ms = pseudoMoves(state, r, c, p);
        let can = false;
        for (let i = 0; i < ms.length; i++) {
          if (ms[i][0] === tr && ms[i][1] === tc) { can = true; break; }
        }
        if (!can) continue;
        const ns = clone(state);
        ns[tr][tc] = ns[r][c];
        ns[r][c] = null;
        if (!inCheck(ns, bySide)) return true;
      }
    }
    return false;
  }

  // 将/帅能否吃回照将子（在照将子的落点上吃掉它）
  function kingDefended(state, side) {
    const k = findKing(state, side);
    if (!k) return false;
    const enemy = side === RED ? BLACK : RED;
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 9; c++) {
        const p = state[r][c];
        if (!p || p.side !== enemy) continue;
        const ms = pseudoMoves(state, r, c, p);
        for (let i = 0; i < ms.length; i++) {
          if (ms[i][0] === k[0] && ms[i][1] === k[1]) {
            if (canCapture(state, side, r, c)) return true;
          }
        }
      }
    }
    return false;
  }

  // 伪攻击预筛（省得每格都做合法性检验）
  function attackSet(state, bySide) {
    const s = new Set();
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 9; c++) {
        const p = state[r][c];
        if (!p || p.side !== bySide) continue;
        const ms = pseudoMoves(state, r, c, p);
        for (let i = 0; i < ms.length; i++) s.add(ms[i][0] * 9 + ms[i][1]);
      }
    }
    return s;
  }

  // 返回 { r: [[r,c]…], b: [[r,c]…] } —— 无根被攻的棋子（供红/绿高亮）
  function hanging(state) {
    const res = { r: [], b: [] };
    const sides = [RED, BLACK];
    for (let si = 0; si < 2; si++) {
      const side = sides[si];
      const enemy = side === RED ? BLACK : RED;
      const eAtk = attackSet(state, enemy);
      for (let r = 0; r < 10; r++) {
        for (let c = 0; c < 9; c++) {
          const p = state[r][c];
          if (!p || p.side !== side) continue;
          if (p.type === 'K') {
            // 将/帅：被将军（含照面，与 .check 同口径）且无法吃回照将子 → 无根
            if (inCheck(state, side) && !kingDefended(state, side)) res[side].push([r, c]);
            continue;
          }
          if (!eAtk.has(r * 9 + c)) continue;
          if (!canCapture(state, enemy, r, c)) continue;   // 钉死的攻方吃不到
          // 换成敌方假子站上该格，己方能否合法吃回（钉死/照面假根剔除）
          const dummy = { side: enemy, type: 'P' };
          const bd = clone(state);
          bd[r][c] = dummy;
          if (!canCapture(bd, side, r, c)) res[side].push([r, c]);
        }
      }
    }
    return res;
  }

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
    cellName: cellName,
    matePattern: matePattern,
    hanging: hanging
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Rules;
