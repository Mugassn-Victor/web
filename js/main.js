/* 流程控制：大厅、对局、消息协议、悔棋/认输/重开 */
'use strict';

(function () {

  const RED = 'r', BLACK = 'b';
  const $ = function (id) { return document.getElementById(id); };

  const App = {
    history: [],        // [{from:[r,c], to:[r,c]}] —— 局面唯一真相
    state: null,        // derive(history)
    mySide: null,
    roomId: null,
    mode: null,         // 'host' | 'guest'
    phase: 'lobby',     // lobby | playing | over
    sel: null,
    targets: [],
    pendingUndo: false,
    pendingRestart: false,
    disconnected: false,
    hostRetries: 0
  };

  /* ================= 工具 ================= */

  function sideName(s) { return s === RED ? '红方' : '黑方'; }

  function randCode() {
    const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < 6; i++) out += cs[Math.floor(Math.random() * cs.length)];
    return out;
  }

  let toastTimer = null;
  function toast(msg, ms) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add('hidden'); }, ms || 2200);
  }

  function modal(title, text, buttons) {
    $('modalTitle').textContent = title;
    $('modalText').textContent = text;
    const box = $('modalBtns');
    box.innerHTML = '';
    buttons.forEach(function (b) {
      const btn = document.createElement('button');
      btn.className = 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : '');
      btn.textContent = b.label;
      btn.onclick = b.onClick;
      box.appendChild(btn);
    });
    $('overlay').classList.remove('hidden');
  }

  function closeModal() {
    $('overlay').classList.add('hidden');
    $('modalBtns').innerHTML = '';
  }

  function banner(msg) {
    const el = $('banner');
    if (!msg) { el.classList.add('hidden'); return; }
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  function lobbyStatus(msg, isErr) {
    const el = $('lobbyStatus');
    el.textContent = msg || '';
    el.classList.toggle('error', !!isErr);
  }

  /* ================= 状态 ================= */

  function currentTurn() { return App.history.length % 2 === 0 ? RED : BLACK; }
  function myTurn() { return App.phase === 'playing' && currentTurn() === App.mySide; }

  function recompute() {
    App.state = Rules.derive(App.history);
    if (!App.state) { App.history = []; App.state = Rules.derive(App.history); }
  }

  function computeLog() {
    let st = Rules.initialState();
    const out = [];
    for (let i = 0; i < App.history.length; i++) {
      const m = App.history[i];
      const p = st[m.from[0]][m.from[1]];
      if (!p) break;
      out.push({ side: p.side, text: Rules.moveText(st, m.from, m.to) });
      st = Rules.applyMove(st, m.from, m.to);
    }
    return out;
  }

  function capturedOf(side) {
    const init = { A: 2, B: 2, N: 2, R: 2, C: 2, P: 5, K: 1 };
    const have = { A: 0, B: 0, N: 0, R: 0, C: 0, P: 0, K: 0 };
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 9; c++) {
        const p = App.state[r][c];
        if (p && p.side === side) have[p.type]++;
      }
    }
    let out = '';
    ['R', 'N', 'B', 'A', 'C', 'P', 'K'].forEach(function (t) {
      const missing = init[t] - have[t];
      for (let i = 0; i < missing; i++) out += Rules.NAME[side][t];
    });
    return out;
  }

  function render() {
    if (!App.state) return;
    const turn = currentTurn();
    const stt = Rules.status(App.state, turn);
    const lastMove = App.history.length ? App.history[App.history.length - 1] : null;

    UI.render(App.state, {
      sel: App.sel,
      targets: App.targets,
      lastMove: lastMove,
      checkSide: stt.check ? turn : null
    });

    // 顶栏
    const tag = $('turnTag');
    if (App.phase === 'over') {
      tag.textContent = '对局结束';
      tag.className = 'turn-tag over';
    } else if (stt.check) {
      tag.textContent = sideName(turn) + '被将军！';
      tag.className = 'turn-tag ' + (turn === RED ? 'red' : 'black');
    } else {
      tag.textContent = sideName(turn) + (turn === App.mySide ? '走棋（你）' : '走棋');
      tag.className = 'turn-tag ' + (turn === RED ? 'red' : 'black');
    }

    // 按钮状态
    const busy = App.disconnected;
    $('btnUndo').disabled = busy || App.phase !== 'playing' || App.pendingUndo ||
      App.history.length < 2 || !myTurn();
    $('btnResign').disabled = busy || App.phase !== 'playing';
    $('btnRestart').disabled = busy || App.phase !== 'over' || App.pendingRestart;

    // 棋谱
    const log = computeLog();
    const ol = $('moveLog');
    ol.innerHTML = '';
    for (let i = 0; i < log.length; i += 2) {
      const li = document.createElement('li');
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = (i / 2 + 1) + '.';
      li.appendChild(num);
      const a = document.createElement('span');
      a.className = log[i].side === RED ? 'mv-r' : 'mv-b';
      a.textContent = log[i].text;
      li.appendChild(a);
      if (log[i + 1]) {
        const b = document.createElement('span');
        b.className = log[i + 1].side === RED ? 'mv-r' : 'mv-b';
        b.textContent = log[i + 1].text;
        li.appendChild(b);
      }
      ol.appendChild(li);
    }
    ol.scrollTop = ol.scrollHeight;

    // 被吃棋子
    const mine = capturedOf(App.mySide);
    const theirs = capturedOf(App.mySide === RED ? BLACK : RED);
    $('capMine').innerHTML = mine ? chars(mine, App.mySide) : '—';
    $('capTheirs').innerHTML = theirs ? chars(theirs, App.mySide === RED ? BLACK : RED) : '—';
  }

  function chars(str, side) {
    return str.split('').map(function (ch) {
      return '<span class="' + side + '">' + ch + '</span>';
    }).join('');
  }

  /* ================= 走棋 ================= */

  function doMove(from, to) {
    const captured = App.state[to[0]][to[1]];
    App.history.push({ from: [from[0], from[1]], to: [to[0], to[1]] });
    App.sel = null;
    App.targets = [];
    recompute();
    finishMove(captured);
  }

  function finishMove(captured) {
    if (captured) UI.sound.capture(); else UI.sound.move();
    const turn = currentTurn();
    const stt = Rules.status(App.state, turn);
    render();
    if (stt.over) { gameOver(stt); return; }
    if (stt.check) {
      UI.sound.check();
      toast('将军！');
    }
  }

  function onCellClick(r, c) {
    if (App.disconnected || App.phase !== 'playing' || !myTurn()) return;
    const st = App.state;
    if (App.sel) {
      for (let i = 0; i < App.targets.length; i++) {
        const t = App.targets[i];
        if (t[0] === r && t[1] === c) {
          Net.send({ t: 'move', from: App.sel, to: [r, c], ply: App.history.length });
          doMove(App.sel, [r, c]);
          return;
        }
      }
    }
    const p = st[r][c];
    if (p && p.side === App.mySide) {
      App.sel = [r, c];
      App.targets = Rules.legalMovesFrom(st, App.mySide, r, c);
    } else {
      App.sel = null;
      App.targets = [];
    }
    render();
  }

  /* ================= 对局结束 ================= */

  function gameOver(stt) {
    App.phase = 'over';
    const loser = currentTurn();
    const winner = stt.winner;
    const reasonMap = {
      checkmate: sideName(loser) + '被将死',
      stalemate: sideName(loser) + '困毙无路',
      king: sideName(loser) + '将帅被擒'
    };
    const reason = reasonMap[stt.reason] || '对局结束';
    render();
    if (winner === App.mySide) UI.sound.win(); else UI.sound.lose();
    modal(winner === App.mySide ? '胜利' : '失败',
      reason + '\n' + sideName(winner) + '获胜',
      [
        { label: '再来一局', primary: true, onClick: function () { closeModal(); requestRestart(); } },
        { label: '返回大厅', onClick: leaveToLobby }
      ]);
  }

  function forceOver(winner, reason) {
    App.phase = 'over';
    render();
    if (winner === App.mySide) UI.sound.win(); else UI.sound.lose();
    modal(winner === App.mySide ? '胜利' : '失败',
      reason + '\n' + sideName(winner) + '获胜',
      [
        { label: '再来一局', primary: true, onClick: function () { closeModal(); requestRestart(); } },
        { label: '返回大厅', onClick: leaveToLobby }
      ]);
  }

  /* ================= 悔棋 / 重开 ================= */

  function requestUndo() {
    if (App.pendingUndo || App.phase !== 'playing' || App.history.length < 2 || !myTurn()) return;
    App.pendingUndo = true;
    Net.send({ t: 'undo-req' });
    render();
    toast('已发送悔棋请求，等待对方同意…');
  }

  function applyUndo() {
    App.history.splice(-2);
    App.sel = null;
    App.targets = [];
    App.pendingUndo = false;
    recompute();
    render();
    toast('悔棋成功');
  }

  function requestRestart() {
    App.pendingRestart = true;
    Net.send({ t: 'restart-req' });
    render();
    toast('已发送再来一局请求…');
  }

  function applyRestart() {
    App.history = [];
    App.sel = null;
    App.targets = [];
    App.pendingRestart = false;
    App.pendingUndo = false;
    App.phase = 'playing';
    recompute();
    closeModal();
    render();
    toast('新对局开始，红方先行');
  }

  /* ================= 消息 ================= */

  function onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'move': {
        if (App.disconnected || App.phase !== 'playing') { Net.send({ t: 'sync-req' }); return; }
        if (msg.ply !== App.history.length) { Net.send({ t: 'sync-req' }); return; }
        if (!App.state || !Rules.isLegal(App.state, currentTurn(), msg.from, msg.to)) {
          Net.send({ t: 'sync-req' });
          return;
        }
        doMove(msg.from, msg.to);
        break;
      }
      case 'sync-req': {
        Net.send({ t: 'sync', hist: App.history });
        break;
      }
      case 'sync': {
        if (!Array.isArray(msg.hist)) return;
        const test = Rules.derive(msg.hist);
        if (!test) return;
        App.history = msg.hist;
        App.sel = null;
        App.targets = [];
        recompute();
        const stt = Rules.status(App.state, currentTurn());
        closeModal();
        if (stt.over) { gameOver(stt); }
        else { App.phase = 'playing'; render(); }
        toast('局面已同步');
        break;
      }
      case 'undo-req': {
        if (App.phase !== 'playing' || App.history.length < 2) {
          Net.send({ t: 'undo-no' });
          return;
        }
        modal('悔棋请求', '对方请求悔棋，是否同意？', [
          {
            label: '同意', primary: true, onClick: function () {
              closeModal();
              Net.send({ t: 'undo-ok' });
              applyUndo();
            }
          },
          {
            label: '拒绝', onClick: function () {
              closeModal();
              Net.send({ t: 'undo-no' });
            }
          }
        ]);
        break;
      }
      case 'undo-ok': {
        applyUndo();
        break;
      }
      case 'undo-no': {
        App.pendingUndo = false;
        render();
        toast('对方拒绝了悔棋');
        break;
      }
      case 'resign': {
        if (App.phase === 'over') return;
        forceOver(App.mySide, '对方认输');
        break;
      }
      case 'restart-req': {
        if (App.pendingRestart) {
          Net.send({ t: 'restart-ok' });
          applyRestart();
          return;
        }
        modal('再来一局', '对方请求重新开局，是否同意？', [
          {
            label: '同意', primary: true, onClick: function () {
              closeModal();
              Net.send({ t: 'restart-ok' });
              applyRestart();
            }
          },
          {
            label: '拒绝', onClick: function () {
              closeModal();
              Net.send({ t: 'restart-no' });
            }
          }
        ]);
        break;
      }
      case 'restart-ok': {
        applyRestart();
        break;
      }
      case 'restart-no': {
        App.pendingRestart = false;
        render();
        toast('对方暂时不想重开');
        break;
      }
    }
  }

  /* ================= 大厅 / 连接 ================= */

  function startGame(side) {
    App.mySide = side;
    App.history = [];
    App.phase = 'playing';
    App.sel = null;
    App.targets = [];
    App.pendingUndo = false;
    App.pendingRestart = false;
    App.disconnected = false;
    recompute();

    $('lobby').classList.add('hidden');
    $('game').classList.remove('hidden');
    $('roomTag').textContent = '房间 ' + App.roomId;
    $('sideTag').textContent = sideName(side) + (side === RED ? '（先手）' : '（后手）');
    const ct = $('connTag');
    ct.textContent = '已连接';
    ct.className = 'tag on';
    banner(null);

    UI.setOrientation(side);
    render();
  }

  function createRoom() {
    if (typeof Peer === 'undefined') {
      lobbyStatus('无法加载联机组件，请检查网络后刷新', true);
      return;
    }
    App.mode = 'host';
    $('btnCreate').disabled = true;
    $('btnJoin').disabled = true;
    lobbyStatus('正在创建房间…');
    App.roomId = randCode();
    App.hostRetries = 0;
    Net.create(App.roomId);
  }

  function joinRoom() {
    if (typeof Peer === 'undefined') {
      lobbyStatus('无法加载联机组件，请检查网络后刷新', true);
      return;
    }
    const val = $('roomInput').value.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,8}$/.test(val)) {
      lobbyStatus('请输入有效的房间号', true);
      return;
    }
    App.mode = 'guest';
    App.roomId = val;
    $('btnCreate').disabled = true;
    $('btnJoin').disabled = true;
    lobbyStatus('正在连接房间 ' + val + '…');
    Net.join(val);
  }

  function backToButtons() {
    $('btnCreate').disabled = false;
    $('btnJoin').disabled = false;
    $('hostPanel').classList.add('hidden');
  }

  function leaveToLobby() {
    Net.destroy();
    location.reload();
  }

  /* ================= 事件绑定 ================= */

  function bind() {
    $('btnCreate').onclick = createRoom;
    $('btnJoin').onclick = joinRoom;
    $('roomInput').addEventListener('input', function (e) {
      e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });
    $('roomInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') joinRoom();
    });

    $('btnCopy').onclick = function () {
      const code = App.roomId || '';
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(function () { toast('房间号已复制'); },
          function () { toast('复制失败，请手动复制'); });
      } else {
        const ta = document.createElement('textarea');
        ta.value = code;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); toast('房间号已复制'); } catch (e) { toast('复制失败'); }
        ta.remove();
      }
    };

    $('btnUndo').onclick = requestUndo;
    $('btnResign').onclick = function () {
      modal('认输', '确定要认输吗？', [
        {
          label: '确定认输', danger: true, onClick: function () {
            closeModal();
            Net.send({ t: 'resign' });
            forceOver(App.mySide === RED ? BLACK : RED, '你方认输');
          }
        },
        { label: '继续对局', primary: true, onClick: closeModal }
      ]);
    };
    $('btnRestart').onclick = function () {
      modal('再来一局', '向对方发送重新开局请求？', [
        { label: '发送请求', primary: true, onClick: function () { closeModal(); requestRestart(); } },
        { label: '取消', onClick: closeModal }
      ]);
    };
    $('btnLeave').onclick = function () {
      modal('退出', '退出当前对局并返回大厅？', [
        { label: '退出', danger: true, onClick: leaveToLobby },
        { label: '留下', primary: true, onClick: closeModal }
      ]);
    };

    window.addEventListener('beforeunload', function () { Net.destroy(); });

    /* --- 网络事件 --- */
    Net.on('open', function (id) {
      if (App.mode === 'host') {
        App.roomId = id;
        $('roomCode').textContent = id;
        $('hostPanel').classList.remove('hidden');
        lobbyStatus('');
      }
    });

    Net.on('connected', function (info) {
      startGame(info.role === 'host' ? RED : BLACK);
    });

    Net.on('data', function (d) {
      if (typeof d === 'string') {
        try { d = JSON.parse(d); } catch (e) { return; }
      }
      onMessage(d);
    });

    Net.on('closed', function () {
      App.disconnected = true;
      const ct = $('connTag');
      ct.textContent = '连接已断开';
      ct.className = 'tag off';
      banner('对方已断线，棋局暂停');
      render();
      modal('连接断开', '对方已离开，无法继续对局', [
        { label: '返回大厅', primary: true, onClick: leaveToLobby }
      ]);
    });

    Net.on('error', function (e) {
      const type = e && e.type;
      if (App.mode === 'host' && type === 'unavailable-id' && App.hostRetries < 3) {
        App.hostRetries++;
        App.roomId = randCode();
        Net.create(App.roomId);
        lobbyStatus('房间号冲突，正在换号…');
        return;
      }
      if (App.mode === 'guest' && type === 'peer-unavailable') {
        lobbyStatus('房间不存在或对方已离开', true);
      } else if (type === 'network' || type === 'server-error' || type === 'socket-error') {
        lobbyStatus('网络错误：无法连接信令服务器', true);
      } else {
        lobbyStatus('连接出错：' + (e && e.message ? e.message : type), true);
      }
      backToButtons();
    });

    Net.on('conn-error', function () {
      toast('连接出现异常');
    });
  }

  /* ================= 启动 ================= */

  function boot() {
    UI.init({ onCellClick: onCellClick });
    bind();
    if (typeof Peer === 'undefined') {
      lobbyStatus('联机组件加载失败（需要联网），请刷新重试', true);
      $('btnCreate').disabled = true;
      $('btnJoin').disabled = true;
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

})();
