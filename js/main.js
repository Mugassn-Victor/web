/* 流程控制：大厅、对局、消息协议、悔棋/认输/重开 */
'use strict';

(function () {

  const RED = 'r', BLACK = 'b';
  const $ = function (id) { return document.getElementById(id); };

  const App = {
    history: [],        // [{from:[r,c], to:[r,c]}] —— 局面唯一真相
    state: null,        // derive(history)
    mySide: null,
    swapped: false,      // 再来一局后红黑是否已互换（刷新页面后由 sync 标记恢复）
    roomId: null,
    mode: null,         // 'host' | 'guest' | 'watch'
    watch: false,       // 观战模式：只读棋盘，可聊天/语音
    watchNick: '',      // 观战昵称：每次进房前现填，不存本机
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
    let out = '';
    for (let i = 0; i < 6; i++) out += Math.floor(Math.random() * 10);
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

  function copyText(text, okMsg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(okMsg || '已复制'); },
        function () { toast('复制失败，请手动全选复制'); });
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast(okMsg || '已复制'); } catch (e) { toast('复制失败'); }
      ta.remove();
    }
  }

  /* ================= 状态 ================= */

  function currentTurn() { return App.history.length % 2 === 0 ? RED : BLACK; }
  function myTurn() { return App.phase === 'playing' && currentTurn() === App.mySide; }

  function recompute() {
    App.state = Rules.derive(App.history);
    if (!App.state) { App.history = []; App.state = Rules.derive(App.history); }
  }

  function render() {
    if (!App.state) return;
    const turn = currentTurn();
    const stt = Rules.status(App.state, turn);
    const lastMove = App.history.length ? App.history[App.history.length - 1] : null;

    UI.render(App.state, {
      sel: App.sel,
      lastMove: lastMove,
      checkSide: stt.check ? turn : null,
      mySide: App.mySide
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
      App.history.length < 1;
    $('btnResign').disabled = busy || App.phase !== 'playing';
    $('btnRestart').disabled = busy || App.phase !== 'over' || App.pendingRestart;
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
      UI.fxCheck();
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
    Net.setInGame(false);
    const loser = currentTurn();
    const winner = stt.winner;
    const pattern = (stt.reason === 'checkmate' || stt.reason === 'stalemate')
      ? (Rules.matePattern(App.state, loser) || (stt.reason === 'checkmate' ? '绝杀' : '困毙'))
      : '';
    const reasonMap = {
      checkmate: pattern && pattern !== '绝杀'
        ? sideName(loser) + '被' + pattern + '绝杀'
        : sideName(loser) + '被将死',
      stalemate: sideName(loser) + '困毙无路',
      king: sideName(loser) + '将帅被擒'
    };
    const reason = reasonMap[stt.reason] || '对局结束';
    render();
    if (App.watch) {
      // 观战：没有胜负感，只报结果
      const show = function () {
        modal('对局结束', reason + '\n' + sideName(winner) + '获胜',
          [{ label: '返回大厅', onClick: leaveToLobby }]);
      };
      if (stt.reason === 'checkmate') { UI.fxFinish((pattern || '绝杀').replace(/、/g, ' ').split('').join(' ')); setTimeout(show, 800); }
      else if (stt.reason === 'stalemate') { UI.fxFinish('困 毙'); setTimeout(show, 800); }
      else show();
      return;
    }
    if (winner === App.mySide) UI.sound.win(); else UI.sound.lose();
    const showModal = function () {
      modal(winner === App.mySide ? '胜利' : '失败',
        reason + '\n' + sideName(winner) + '获胜',
        [
          { label: '再来一局', primary: true, onClick: function () { closeModal(); requestRestart(); } },
          { label: '返回大厅', onClick: leaveToLobby }
        ]);
    };
    if (stt.reason === 'checkmate') {
      UI.fxFinish(pattern.replace(/、/g, ' ').split('').join(' '));
      setTimeout(showModal, 800);
    } else if (stt.reason === 'stalemate') {
      UI.fxFinish('困 毙');
      setTimeout(showModal, 800);
    } else {
      showModal();
    }
  }

  function forceOver(winner, reason) {
    App.phase = 'over';
    Net.setInGame(false);
    render();
    if (App.watch) {
      modal('对局结束', reason + '\n' + sideName(winner) + '获胜',
        [{ label: '返回大厅', onClick: leaveToLobby }]);
      return;
    }
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
    // 退一步：无论轮到谁、无论谁发起，对方同意后棋盘退回上一手
    if (App.pendingUndo || App.phase !== 'playing' || App.history.length < 1) return;
    App.pendingUndo = true;
    Net.send({ t: 'undo-req' });
    render();
    toast('已发送悔棋请求，等待对方同意…');
  }

  function applyUndo() {
    App.history.splice(-1);
    App.sel = null;
    App.targets = [];
    App.pendingUndo = false;
    recompute();
    render();
    if (!App.watch) toast('悔棋成功，退回上一步');
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
    Net.setInGame(true);
    // 再来一局：双方红黑互换
    App.swapped = !App.swapped;
    flipSide();
    recompute();
    closeModal();
    render();
    toast('新对局开始，红方先行');
  }

  /* ================= 消息 ================= */

  // 观战方只处理这些：悔棋/重开请求类弹窗不打扰观众（走棋与同步照常收）
  const WATCH_OK = ['move', 'sync', 'chat', 'vmsg', 'vak', 'undo-ok', 'restart-ok', 'resign', 'watch-in'];

  function onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (App.watch && WATCH_OK.indexOf(msg.t) < 0) return;
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
        Net.send({ t: 'sync', hist: App.history, swap: App.swapped });
        break;
      }
      case 'sync': {
        if (!Array.isArray(msg.hist)) return;
        const test = Rules.derive(msg.hist);
        if (!test) return;
        // 刷新重进后按对方棋谱带的互换标记恢复自己这一方（先应用再判长短，空棋谱也要能恢复）
        if (typeof msg.swap === 'boolean' && msg.swap !== App.swapped) {
          App.swapped = msg.swap;
          if (App.mySide === RED || App.mySide === BLACK) { flipSide(); if (App.state) render(); }
        }
        // 只接受更长（或不同）的棋谱：防止重新加入时空棋谱覆盖对方的进行中棋局
        const longer = msg.hist.length > App.history.length;
        const diff = msg.hist.length === App.history.length &&
          JSON.stringify(msg.hist) !== JSON.stringify(App.history);
        if (!longer && !diff && !App.watch) return;
        App.history = msg.hist;
        App.sel = null;
        App.targets = [];
        recompute();
        const stt = Rules.status(App.state, currentTurn());
        closeModal();
        if (stt.over) { gameOver(stt); }
        else { App.phase = 'playing'; Net.setInGame(true); render(); }
        toast('局面已同步');
        break;
      }
      case 'undo-req': {
        if (App.phase !== 'playing' || App.history.length < 1) {
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
        if (App.watch) {
          const loser = (msg.sd === RED || msg.sd === BLACK) ? msg.sd : currentTurn();
          forceOver(loser === RED ? BLACK : RED, sideName(loser) + '认输');
          return;
        }
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
      case 'chat': {
        if (typeof msg.m === 'string' && msg.m) {
          const e = { x: 't', s: 'them', sd: msg.sd, m: msg.m, ts: Date.now() };
          if (typeof msg.nm === 'string' && msg.nm) e.nm = msg.nm;
          chatAppend(e, false);
        }
        break;
      }
      case 'watch-in': {
        // 有观战者进入 → 对局双方聊天区出一条系统提示
        const wn = (typeof msg.nm === 'string' && msg.nm) ? String(msg.nm).slice(0, 12) : '';
        chatAppend({ x: 's', m: '观战者' + (wn ? '「' + wn + '」' : '') + '进入房间', ts: Date.now() }, false);
        break;
      }
      case 'vmsg': {
        if (typeof msg.b === 'string' && msg.b) {
          Net.send({ t: 'vak', id: msg.id });   // 先确认（尽力而为，对方超时会重发）
          recvVoiceMsg(msg);
        }
        break;
      }
      case 'vak': {
        const w = vmsgWait[msg.id];
        if (w) {
          clearTimeout(w.t);
          delete vmsgWait[msg.id];
          vmsgSetState(msg.id, '');
          if (pttState === 'sending') setPttState('idle');
          toast('语音已发送');
        }
        break;
      }
    }
  }

  /* ================= 大厅 / 连接 ================= */

  /* --- 断线后周期重连：等对方重新加入，或自己这边自动恢复 --- */
  let resumeTimer = null;
  function startResumeRetry() {
    if (resumeTimer) return;
    Net.resume();
    resumeTimer = setInterval(function () {
      if (App.disconnected) Net.resume();
      else stopResumeRetry();
    }, 5000);
  }
  function stopResumeRetry() {
    if (resumeTimer) { clearInterval(resumeTimer); resumeTimer = null; }
  }

  function sideForRole(role) {
    const base = role === 'host' ? RED : BLACK;
    if (!App.swapped) return base;
    return base === RED ? BLACK : RED;
  }

  function flipSide() {
    if (App.watch) return;   // 观战方没有自己的红黑
    App.mySide = App.mySide === RED ? BLACK : RED;
    $('sideTag').textContent = sideName(App.mySide) + (App.mySide === RED ? '（先手）' : '（后手）');
    UI.setOrientation(App.mySide);
  }

  function startGame(side, relay) {
    stopWait();
    App.mySide = App.watch ? null : side;
    App.history = [];
    App.phase = 'playing';
    Net.setInGame(true);
    App.sel = null;
    App.targets = [];
    App.pendingUndo = false;
    App.pendingRestart = false;
    App.disconnected = false;
    recompute();

    $('lobby').classList.add('hidden');
    $('game').classList.remove('hidden');
    $('roomTag').textContent = '房间 ' + App.roomId;
    if (App.watch) {
      $('sideTag').textContent = '观战';
      $('btnUndo').classList.add('hidden');
      $('btnResign').classList.add('hidden');
      $('btnRestart').classList.add('hidden');
    } else {
      $('sideTag').textContent = sideName(side) + (side === RED ? '（先手）' : '（后手）');
      $('btnUndo').classList.remove('hidden');
      $('btnResign').classList.remove('hidden');
      $('btnRestart').classList.remove('hidden');
    }
    const ct = $('connTag');
    ct.textContent = App.watch ? '观战' : (relay ? '中继连接' : '直连连接');
    ct.className = 'tag on';
    banner(null);

    UI.setOrientation(App.watch ? RED : side);
    render();
    // 房主开局后才开观战信标：观战者进不到还没开打的房间
    if (App.mode === 'host') Net.beacon(true);
    refreshVoice();
  }

  /* --- 加入房间倒计时 --- */
  const JOIN_TIMEOUT = 45;   // 秒：覆盖最坏情况（多个 broker 逐个超时 + P2P 等待 10s）
  let waitTimer = null;
  let waitLeft = 0;

  function stopWait() {
    if (waitTimer) { clearInterval(waitTimer); waitTimer = null; }
  }

  function startJoinCountdown(roomId) {
    stopWait();
    waitLeft = JOIN_TIMEOUT;
    lobbyStatus('正在连接房间 ' + roomId + '…（剩余 ' + waitLeft + ' 秒）');
    waitTimer = setInterval(function () {
      if (App.phase !== 'lobby') { stopWait(); return; }
      waitLeft--;
      if (waitLeft <= 0) {
        stopWait();
        if (Net.isConnected()) return;
        // 一直没人应答：可能是房主重新输号恢复 → 用这个号自己建房继续
        Net.destroy();
        createRoom(roomId, true);
        lobbyStatus('无人应答，已用此号为你建房，等待对手加入…');
        return;
      }
      lobbyStatus('正在连接房间 ' + roomId + '…（剩余 ' + waitLeft + ' 秒）');
    }, 1000);
  }

  function createRoom(code, recovering) {
    stopWait();   // 兜底建房时停掉加入倒计时，别让它覆盖建房提示
    App.mode = 'host';
    App.recovering = !!recovering;
    fullHint = null;
    askRoom = null;
    $('nickRow').classList.add('hidden');
    $('roleRow').classList.add('hidden');
    $('btnCreate').disabled = true;
    $('btnJoin').disabled = true;
    App.roomId = code || randCode();
    App.hostRetries = 0;
    // 房间号本地生成，不依赖信令服务器回传，立即显示
    $('roomCode').textContent = App.roomId;
    $('hostPanel').classList.remove('hidden');
    lobbyStatus('');
    Net.create(App.roomId);
  }

  let fullHint = null;   // 上次「房间已有对战双方」的房号：填了昵称点加入即转观战
  let askRoom = null;    // 上次「对局进行中但缺人」的房号：回来的人要自选身份

  function joinRoom(forcePlayer) {
    const val = $('roomInput').value.trim();
    if (!/^\d{6}$/.test(val)) {
      lobbyStatus('请输入 6 位数字房间号', true);
      return;
    }
    // 满员房间：没昵称先提示，有昵称直接转观战（不再有单独的观战按钮）
    const nick = ($('nickInput').value || '').trim().slice(0, 12);
    if (fullHint === val) {
      if (!nick) { promptNick(); return; }
      startWatch(val, nick);
      return;
    }
    // 缺位身份选择态：点「加入对战」或直接点「加入房间」都算明确要下棋（as='p'）
    const asP = forcePlayer === true || askRoom === val;
    askRoom = null;
    // 不在浏览器里存房间号：双方线下沟通房间号，直接输号加入
    App.mode = 'guest';
    App.roomId = val;
    $('btnCreate').disabled = true;
    $('btnJoin').disabled = true;
    $('nickRow').classList.add('hidden');
    $('roleRow').classList.add('hidden');
    Net.join(val, asP);
    startJoinCountdown(val);
  }

  // 满员房间已确认：给出昵称提示，让对方填昵称后再点加入
  function promptNick() {
    stopWait();
    $('btnCreate').disabled = false;
    $('btnJoin').disabled = false;
    $('roleRow').classList.add('hidden');
    $('nickRow').classList.remove('hidden');
    lobbyStatus('该房间已有对战双方，输入昵称后点「加入房间」即可观战');
    $('nickInput').focus();
  }

  // 缺位身份选择里点了「观战」：昵称是门槛
  function watchChoice() {
    const val = $('roomInput').value.trim();
    if (!/^\d{6}$/.test(val)) {
      lobbyStatus('请输入 6 位数字房间号', true);
      return;
    }
    const nick = ($('nickInput').value || '').trim().slice(0, 12);
    if (!nick) {
      lobbyStatus('观战需先输入昵称', true);
      $('nickInput').focus();
      return;
    }
    startWatch(val, nick);
  }

  function startWatch(val, nick) {
    App.mode = 'watch';
    App.roomId = val;
    App.watchNick = nick;
    fullHint = null;
    askRoom = null;
    $('btnCreate').disabled = true;
    $('btnJoin').disabled = true;
    $('nickRow').classList.add('hidden');
    $('roleRow').classList.add('hidden');
    Net.watch(val);
    startWatchCountdown(val);
  }

  // 观战倒计时（不自动建房：观战只进正在对局的房间）
  function startWatchCountdown(roomId) {
    stopWait();
    waitLeft = 15;
    lobbyStatus('正在进入观战 ' + roomId + '…（剩余 ' + waitLeft + ' 秒）');
    waitTimer = setInterval(function () {
      if (App.phase !== 'lobby') { stopWait(); return; }
      if (Net.isConnected()) { stopWait(); lobbyStatus(''); return; }
      waitLeft--;
      if (waitLeft <= 0) {
        stopWait();
        Net.destroy();
        backToButtons();
        lobbyStatus('观战连接超时：请确认房间号，且对局已经开始', true);
        return;
      }
      lobbyStatus('正在进入观战 ' + roomId + '…（剩余 ' + waitLeft + ' 秒）');
    }, 1000);
  }

  function backToButtons() {
    stopWait();
    $('btnCreate').disabled = false;
    $('btnJoin').disabled = false;
    $('nickInput').disabled = false;
    $('nickRow').classList.add('hidden');
    $('roleRow').classList.add('hidden');
    $('hostPanel').classList.add('hidden');
  }

  function leaveToLobby() {
    stopResumeRetry();
    Net.destroy();
    location.reload();
  }

  /* ================= 语音消息：按住说话 ================= */
  // 录音 → base64 骑对局通道发给对方 → 对方回 ACK 确认；不依赖 WebRTC 媒体与任何云

  const PTT_MAX = 15000;   // 单条最长 15 秒，到点自动停
  const PTT_MIN = 400;     // 短于 0.4 秒视为误触，不发送
  const PTT_ACK = 3000;    // 等 ACK 超时，超时重发一次

  let pttStream = null;    // 麦克风流
  let pttRec = null;       // 进行中的 MediaRecorder
  let pttHeld = false;     // 按键是否按住
  let pttStart = 0;
  let pttTickT = null;     // 录音秒数刷新
  let pttMaxT = null;      // 15 秒封顶
  let pttState = 'idle';   // idle | recording | sending
  let vmsgSeq = 0;
  const vmsgWait = {};     // 发送中等 ACK 的条目 k → { t, n }
  const vmsgSeen = [];     // 收过的 k（防重发重复渲染）

  function pttSupported() {
    return !!(window.isSecureContext && navigator.mediaDevices &&
      navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  }

  function refreshVoice() {
    const btn = $('btnVoice');
    if (btn) btn.disabled = !(pttSupported() && Net.isConnected());
  }

  function setPttState(s) {
    pttState = s;
    const st = $('voiceState'), btn = $('btnVoice');
    if (st) st.textContent = (s === 'recording') ? '录音中…' : (s === 'sending') ? '发送中…' : '';
    if (btn) {
      btn.textContent = (s === 'recording') ? '松开发送' : '按住说话';
      btn.classList.toggle('rec', s === 'recording');
    }
    refreshVoice();
  }

  function pttTick() {
    const st = $('voiceState');
    if (st && pttState === 'recording') {
      st.textContent = '录音中 ' + ((Date.now() - pttStart) / 1000).toFixed(1) + '″';
    }
  }

  function pttPickMime() {
    const list = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    if (window.MediaRecorder.isTypeSupported) {
      for (let i = 0; i < list.length; i++) {
        if (MediaRecorder.isTypeSupported(list[i])) return list[i];
      }
    }
    return '';
  }

  function pttDown() {
    if (pttHeld || pttState !== 'idle' || !pttSupported()) return;
    pttHeld = true;
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (s) {
      if (!pttHeld || pttState !== 'idle') {   // 松手太快，gUM 才返回 → 不录
        s.getTracks().forEach(function (t) { t.stop(); });
        return;
      }
      let rec;
      try {
        const mime = pttPickMime();
        rec = mime ? new MediaRecorder(s, { mimeType: mime, audioBitsPerSecond: 16000 }) : new MediaRecorder(s);
      } catch (err) {
        s.getTracks().forEach(function (t) { t.stop(); });
        pttHeld = false;
        toast('此浏览器不支持语音录制');
        return;
      }
      pttStream = s;
      pttRec = rec;
      const chunks = [];
      rec.ondataavailable = function (ev) { if (ev.data && ev.data.size) chunks.push(ev.data); };
      rec.onstop = function () { pttDone(rec, chunks); };
      pttStart = Date.now();
      setPttState('recording');
      rec.start();
      pttTickT = setInterval(pttTick, 200);
      pttMaxT = setTimeout(pttUp, PTT_MAX);
      if (navigator.vibrate) { try { navigator.vibrate(20); } catch (err) {} }
    }).catch(function () {
      pttHeld = false;
      toast('无法打开麦克风（权限被拒绝？）');
    });
  }

  function pttUp() {
    if (!pttHeld) return;
    pttHeld = false;
    if (pttTickT) { clearInterval(pttTickT); pttTickT = null; }
    if (pttMaxT) { clearTimeout(pttMaxT); pttMaxT = null; }
    const rec = pttRec;
    if (rec && rec.state !== 'inactive') { try { rec.stop(); } catch (e) {} }
    if (!rec) setPttState('idle');   // gUM 还没返回就没录上
  }

  function pttDone(rec, chunks) {
    const dur = Date.now() - pttStart;
    if (pttStream) { try { pttStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} }
    pttStream = null;
    if (pttRec === rec) pttRec = null;
    setPttState('idle');
    if (dur < PTT_MIN) { toast('说话时间太短'); return; }
    const blob = new Blob(chunks, { type: (rec.mimeType || '').split(';')[0] || 'audio/webm' });
    if (!blob.size) { toast('录音失败，请重试'); return; }
    sendVoiceMsg(blob, dur);
  }

  function blobToB64(blob, cb) {
    const fr = new FileReader();
    fr.onload = function () {
      const u = new Uint8Array(fr.result);
      let s = '';
      for (let i = 0; i < u.length; i += 0x8000) {
        s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
      }
      try { cb(btoa(s)); } catch (e) { cb(null); }
    };
    fr.onerror = function () { cb(null); };
    fr.readAsArrayBuffer(blob);
  }

  function sendVoiceMsg(blob, dur) {
    if (!Net.isConnected()) { toast('连接断开，语音未发送'); return; }
    setPttState('sending');
    blobToB64(blob, function (b64) {
      if (!b64) { setPttState('idle'); toast('录音读取失败'); return; }
      const id = (Date.now() % 1e9) + '.' + (++vmsgSeq);
      const sd = App.watch ? 'w' : App.mySide;
      const entry = { x: 'v', s: 'me', sd: sd, id: id, b: b64, mt: blob.type, d: Math.round(dur), ts: Date.now(), st: 's' };
      if (App.watch && App.watchNick) entry.nm = App.watchNick;
      chatAppend(entry, false);
      const payload = { t: 'vmsg', id: id, d: entry.d, m: blob.type, b: b64, sd: sd };
      if (entry.nm) payload.nm = entry.nm;
      sendWithAck(id, payload, 0);
    });
  }

  function sendWithAck(id, payload, n) {
    if (!Net.send(payload)) { vmsgSetState(id, 'x'); vmsgFail(); return; }
    const w = { n: n };
    w.t = setTimeout(function () {
      delete vmsgWait[id];
      if (w.n < 1) sendWithAck(id, payload, 1);
      else { vmsgSetState(id, 'x'); vmsgFail(); }
    }, PTT_ACK);
    vmsgWait[id] = w;
  }

  function vmsgFail() {
    setPttState('idle');
    toast('语音发送失败');
  }

  function b64ToBlob(b64, mt) {
    try {
      const bin = atob(b64);
      const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return new Blob([u], { type: mt || 'application/octet-stream' });
    } catch (e) { return null; }
  }

  /* ---- 聊天记录：全局只留一份存档，永远只有最近 5 条，开新房把旧的顶掉 ---- */
  let chatKey = null;
  let chatRoom = null;
  let chatHist = [];
  const CHAT_MAX = 5;   // 只留最近 5 条，旧的被新的覆盖（文字语音合计）

  function chatStoreWrite() {
    if (!chatKey || !chatRoom) return;
    let arr = chatHist;
    for (let i = 0; i < 8 && arr.length; i++) {
      try {
        localStorage.setItem(chatKey, JSON.stringify({ room: chatRoom, a: arr }));
        if (arr !== chatHist) { chatHist = arr; renderChatLog(); }
        return;
      } catch (e) {
        // 空间不够：先挤掉最旧的语音条目（体积大）
        let idx = 0;
        for (let j = 0; j < arr.length; j++) { if (arr[j].x === 'v') { idx = j; break; } }
        arr = arr.slice(idx + 1);
      }
    }
  }

  function chatLoad(room) {
    let a = [];
    try {
      const s = chatKey ? localStorage.getItem(chatKey) : null;
      if (s) {
        const o = JSON.parse(s);
        // 只有同一个房间才恢复；换了房间就地删掉（开新房顶掉旧的）
        if (o && typeof o === 'object' && !Array.isArray(o) && o.room === room && Array.isArray(o.a)) {
          a = o.a;
        } else if (chatKey) {
          localStorage.removeItem(chatKey);
        }
      }
    } catch (e) { a = []; }
    if (a.length > CHAT_MAX) a = a.slice(-CHAT_MAX);
    for (let i = 0; i < a.length; i++) {
      if (a[i] && a[i].st === 's') a[i].st = 'x';   // 上次没等到 ACK 的条目 → 标为发送失败
    }
    chatHist = a;
    renderChatLog();
  }

  function chatAppend(e, fresh) {
    chatHist.push(e);
    const box = $('chatLog');
    if (box) {
      box.classList.remove('hidden');
      while (chatHist.length > CHAT_MAX) {
        const old = chatHist.shift();
        const fr = box.firstChild;
        if (fr && fr._url) { try { URL.revokeObjectURL(fr._url); } catch (er) {} }
        if (fr) box.removeChild(fr);
        if (old && old.x === 'v' && old.id) {
          const j = vmsgSeen.indexOf(old.id);
          if (j >= 0) vmsgSeen.splice(j, 1);
        }
      }
      box.appendChild(chatRow(e, fresh));
      box.scrollTop = box.scrollHeight;
    } else {
      while (chatHist.length > CHAT_MAX) chatHist.shift();
    }
    chatStoreWrite();
  }

  function renderChatLog() {
    const box = $('chatLog');
    if (!box) return;
    while (box.firstChild) {
      const fr = box.firstChild;
      if (fr._url) { try { URL.revokeObjectURL(fr._url); } catch (e) {} }
      box.removeChild(fr);
    }
    if (!chatHist.length) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    for (let i = 0; i < chatHist.length; i++) box.appendChild(chatRow(chatHist[i], false));
    box.scrollTop = box.scrollHeight;
  }

  function chatTime(ts) {
    const d = new Date(ts || Date.now());
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // 消息署名：对局方按「黑方/红方」显示，观战方直接显示昵称（没昵称兜底「观战」）
  function sdLabel(sd) {
    if (sd === 'r') return '红方: ';
    if (sd === 'b') return '黑方: ';
    if (sd === 'w') return '观战: ';
    return null;
  }

  function labelOf(e) {
    if (e.sd === 'w' && e.nm) return e.nm + ': ';
    return sdLabel(e.sd) || ((e.s === 'me') ? '我: ' : '对方: ');
  }

  function chatRow(e, fresh) {
    const row = document.createElement('div');
    row.className = (e.x === 'v') ? 'vmsg' : (e.x === 's' ? 'msg sys' : 'msg');
    if (e.id) row.setAttribute('data-id', e.id);
    if (e.x === 's') {
      // 系统行（如「观战者进入」）：无署名，只一句提示
      const sp = document.createElement('span');
      sp.className = 'sys';
      sp.textContent = e.m || '';
      row.appendChild(sp);
      const ts0 = document.createElement('span');
      ts0.className = 'ts';
      ts0.textContent = chatTime(e.ts);
      row.appendChild(ts0);
      return row;
    }
    const from = document.createElement('span');
    from.className = 'from';
    from.textContent = labelOf(e);
    row.appendChild(from);
    if (e.x === 'v') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'vmsg-play';
      btn.textContent = '▶';
      const dur = document.createElement('span');
      dur.className = 'vmsg-dur';
      dur.textContent = Math.max(1, Math.round((e.d || 0) / 1000)) + '″';
      row.appendChild(btn);
      row.appendChild(dur);
      if (e.st) {
        const st = document.createElement('span');
        st.className = 'vmsg-st';
        st.textContent = (e.st === 'x') ? '发送失败' : '发送中…';
        row.appendChild(st);
      }
      let audio = null;
      function ensure() {
        if (!audio) {
          const blob = b64ToBlob(e.b, e.mt);
          if (!blob) return null;
          row._url = URL.createObjectURL(blob);
          window.__vmsgLast = { bytes: blob.size, d: e.d || 0, m: e.mt };
          audio = new Audio(row._url);
          window.__vmsgAudio = audio;
          audio.onended = function () { btn.textContent = '▶'; window.__vmsgPlaying = false; };
        }
        return audio;
      }
      function play() {
        const a = ensure();
        if (!a) return;
        const p = a.play();
        if (p && p.then) {
          p.then(function () { btn.textContent = '■'; window.__vmsgPlaying = true; })
            .catch(function () { btn.textContent = '点此播放'; window.__vmsgPlaying = false; });
        } else { btn.textContent = '■'; window.__vmsgPlaying = true; }
      }
      btn.onclick = function () {
        const a = ensure();
        if (!a) return;
        if (a.paused) play();
        else { a.pause(); btn.textContent = '▶'; window.__vmsgPlaying = false; }
      };
      // 只有刚收到的新消息尝试自动播放；历史条目一律等用户点
      if (fresh && e.s === 'them') {
        if (!window.__vmsgPlaying) play(); else btn.textContent = '▶';
      }
    } else {
      const tx = document.createElement('span');
      tx.className = 'txt';
      tx.textContent = e.m || '';
      row.appendChild(tx);
    }
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = chatTime(e.ts);
    row.appendChild(ts);
    return row;
  }

  function vmsgSetState(id, st) {
    for (let i = 0; i < chatHist.length; i++) {
      const e = chatHist[i];
      if (e.x === 'v' && e.id === id) { e.st = st || ''; break; }
    }
    const box = $('chatLog');
    const row = box ? box.querySelector('[data-id="' + id + '"]') : null;
    if (row) {
      let sp = row.querySelector('.vmsg-st');
      if (!st) { if (sp && sp.parentNode) sp.parentNode.removeChild(sp); }
      else {
        if (!sp) {
          sp = document.createElement('span');
          sp.className = 'vmsg-st';
          const tsel = row.querySelector('.ts');
          row.insertBefore(sp, tsel || null);
        }
        sp.textContent = (st === 'x') ? '发送失败' : '发送中…';
      }
    }
    chatStoreWrite();
  }

  function recvVoiceMsg(msg) {
    const id = msg.id;
    if (!id || !msg.b) return;
    if (vmsgSeen.indexOf(id) >= 0) return;   // 重发造成的重复：ACK 已回，不再入账
    for (let i = 0; i < chatHist.length; i++) {
      const e = chatHist[i];
      if (e.x === 'v' && e.id === id) { vmsgSeen.push(id); return; }   // 存档里已有
    }
    vmsgSeen.push(id);
    if (vmsgSeen.length > 30) vmsgSeen.shift();
    const e = { x: 'v', s: 'them', sd: msg.sd, id: id, b: msg.b, mt: msg.m, d: msg.d || 0, ts: Date.now(), st: '' };
    if (typeof msg.nm === 'string' && msg.nm) e.nm = msg.nm;
    chatAppend(e, true);
  }

  function renderBgm(on) {
    const els = document.querySelectorAll('.btnBgm');
    for (let i = 0; i < els.length; i++) els[i].textContent = on ? '关音乐' : '开音乐';
  }


  /* ================= 事件绑定 ================= */

  function bind() {
    $('btnCreate').onclick = function () { createRoom(); };
    $('btnJoin').onclick = function () { joinRoom(); };
    $('btnAsPlayer').onclick = function () { joinRoom(true); };
    $('btnAsWatch').onclick = function () { watchChoice(); };
    $('roomInput').addEventListener('input', function (e) {
      e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
      const v = e.target.value;
      if (fullHint !== v) fullHint = null;   // 换房号：作废上次满员/缺位提示
      if (askRoom !== v) askRoom = null;
      if (!fullHint && !askRoom) {
        $('nickRow').classList.add('hidden');
        $('roleRow').classList.add('hidden');
      } else if (fullHint) {
        $('roleRow').classList.add('hidden');
      }
    });
    $('roomInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') joinRoom();
    });
    $('nickInput').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      if (askRoom === $('roomInput').value.trim()) watchChoice();
      else joinRoom();
    });

    $('btnCopy').onclick = function () {
      copyText(App.roomId || '', '房间号已复制');
    };

    $('btnUndo').onclick = requestUndo;
    $('btnResign').onclick = function () {
      modal('认输', '确定要认输吗？', [
        {
          label: '确定认输', danger: true, onClick: function () {
            closeModal();
            Net.send({ t: 'resign', sd: App.mySide });
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

    // 聊天：发给对方、双方进历史记录（不弹窗），本地存档刷新后还在
    function sendChat() {
      const inp = $('chatInput');
      const m = (inp.value || '').trim().slice(0, 40);
      if (!m) return;
      if (App.phase !== 'playing') { toast('对局开始后才能发送'); return; }
      inp.value = '';
      const sd = App.watch ? 'w' : App.mySide;
      const msg = { t: 'chat', m: m, sd: sd };
      const entry = { x: 't', s: 'me', sd: sd, m: m, ts: Date.now() };
      if (App.watch && App.watchNick) { msg.nm = App.watchNick; entry.nm = App.watchNick; }
      Net.send(msg);
      chatAppend(entry, false);
    }
    $('btnSend').onclick = sendChat;
    $('chatInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') sendChat();
    });

    // 按住说话：按下开录、松开发送；键盘 Space/Enter 等价
    const vbtn = $('btnVoice');
    if (vbtn) {
      vbtn.addEventListener('pointerdown', function (e) { e.preventDefault(); pttDown(); });
      vbtn.addEventListener('keydown', function (e) {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); pttDown(); }
      });
      vbtn.addEventListener('keyup', function (e) {
        if (e.key === ' ' || e.key === 'Enter') pttUp();
      });
      window.addEventListener('pointerup', pttUp);
      window.addEventListener('pointercancel', pttUp);
      window.addEventListener('blur', pttUp);
      refreshVoice();
    }

    // 背景音乐开关（大厅与对局面板各一个，共享 class）
    const bgmBtns = document.querySelectorAll('.btnBgm');
    for (let i = 0; i < bgmBtns.length; i++) {
      bgmBtns[i].onclick = function () { renderBgm(UI.bgmToggle()); };
    }
    renderBgm(UI.bgmOn());

    window.addEventListener('beforeunload', function () { Net.destroy(); });

    /* --- 网络事件 --- */
    Net.on('open', function (id) {
      if (App.mode === 'host') {
        App.roomId = id;
        $('roomCode').textContent = id;
        $('hostPanel').classList.remove('hidden');
        lobbyStatus('');
      }
      refreshVoice();
    });

    Net.on('connected', function (info) {
      // 全局一份存档：顺手清掉旧版按房间分的钥匙，永远只有 xqchat 一个键
      try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const k = localStorage.key(i);
          if (k && k.indexOf('xqchat') === 0 && k !== 'xqchat') localStorage.removeItem(k);
        }
      } catch (e) { }
      chatKey = 'xqchat';
      chatRoom = App.roomId || '';
      chatLoad(chatRoom);
      App.watch = info.role === 'watch';
      // 本标签页上局是这房的客方 → 记下（刷新重进带 resume，满员也放行不被误转观战）
      if (info.role === 'guest') {
        try { sessionStorage.setItem('xqseat', App.roomId || ''); } catch (e) {}
      }
      startGame(App.watch ? RED : sideForRole(info.role), !!info.relay);
      refreshVoice();
      // 请求棋谱：若对方是进行中的棋局（自己刚重新加入），会同步恢复局面
      Net.send({ t: 'sync-req' });
      // 有观战者进房：对局双方聊天区各出一条系统提示
      if (App.watch) Net.send({ t: 'watch-in', nm: App.watchNick || '' });
      // 公共 broker 是 QoS0，sync-req 偶发丢失会让棋谱永远空着 → 恢复前重试
      let tries = 0;
      const iv = setInterval(function () {
        if (App.history.length > 0 || ++tries > 3) { clearInterval(iv); return; }
        Net.send({ t: 'sync-req' });
      }, 2000);
    });

    // P2P 打不通 → 已切到 broker 中继，对局继续
    Net.on('relay', function () {
      const ct = $('connTag');
      ct.textContent = '中继连接';
      ct.className = 'tag on';
      toast('点对点直连不通，已切换服务器中继，对局继续');
    });

    Net.on('data', function (d) {
      if (typeof d === 'string') {
        try { d = JSON.parse(d); } catch (e) { return; }
      }
      onMessage(d);
    });

    Net.on('closed', function () {
      if (App.phase === 'lobby') {
        lobbyStatus('连接中断，请重试', true);
        backToButtons();
        return;
      }
      App.disconnected = true;
      const ct = $('connTag');
      ct.textContent = '连接已断开';
      ct.className = 'tag off';
      if (App.watch) {
        banner('观战连接中断，等待恢复…');
        render();
        startResumeRetry();
        return;
      }
      banner('对方掉线，棋局暂停，等待重新连线…');
      render();
      startResumeRetry();
      if (App.phase !== 'over') {
        modal('对方掉线', '对方离开了对局页面。对方重新进入同一房间号后，棋局会自动恢复。', [
          { label: '等待重连', primary: true, onClick: closeModal },
          { label: '返回大厅', onClick: leaveToLobby }
        ]);
      }
    });

    // 观战没找到房间（未开局/不存在）；对局中则按掉线处理继续等
    Net.on('watch-miss', function () {
      if (App.phase === 'lobby') {
        stopWait();
        Net.destroy();
        backToButtons();
        lobbyStatus('该房间未开局或不存在（观战需对局进行中）', true);
        return;
      }
      App.disconnected = true;
      banner('观战连接中断，等待恢复…');
      render();
      startResumeRetry();
    });

    // 加入的房间已有对战双方 → 自动转观战：有昵称直接进，没昵称弹昵称提示
    Net.on('room-full', function () {
      if (App.phase !== 'lobby' || App.mode !== 'guest') return;
      stopWait();
      Net.destroy();
      fullHint = App.roomId;
      askRoom = null;
      const nick = ($('nickInput').value || '').trim().slice(0, 12);
      if (nick) { startWatch(App.roomId, nick); return; }
      promptNick();
    });

    // 对局进行中但缺人 → 房主要求先自选身份：[加入对战] / [观战(填昵称)]
    Net.on('room-ask', function () {
      if (App.phase !== 'lobby' || App.mode !== 'guest') return;
      stopWait();
      Net.destroy();
      fullHint = null;
      askRoom = App.roomId;
      $('btnCreate').disabled = false;
      $('btnJoin').disabled = false;
      $('roleRow').classList.remove('hidden');
      $('nickRow').classList.remove('hidden');
      lobbyStatus('该房间正在对局且有一方掉线：点「加入对战」继续，或填昵称后点「观战」');
    });

    // 对方重新加入（或直连恢复）：清掉断线状态，继续对局
    Net.on('reconnected', function (info) {
      const wasOff = App.disconnected;
      App.disconnected = false;
      stopResumeRetry();
      banner(null);
      const ct = $('connTag');
      ct.textContent = App.watch ? '观战' : ((info && info.peer === 'relay') ? '中继连接' : '直连连接');
      ct.className = 'tag on';
      if ($('modalTitle').textContent === '对方掉线') closeModal();
      render();
      if (App.watch) {
        if (wasOff) toast('观战连接已恢复');
        Net.send({ t: 'sync-req' });   // 观战断线期间可能错过走棋 → 重新拉棋谱
        return;
      }
      toast(wasOff ? '对方已重新连线，对局继续' : '点对点直连已恢复');
      // 主动推棋谱：对方可能刚重新进入页面，其 sync-req 可能早于通道就绪被丢弃
      if (App.history.length) Net.send({ t: 'sync', hist: App.history, swap: App.swapped });
    });

    Net.on('error', function (e) {
      const type = e && e.type;
      if (App.mode === 'host' && type === 'unavailable-id' && App.recovering) {
        // 该号已有一个活着的房间（旧会话未释放）→ 不卡住，直接改以客方身份加入，进局后同步恢复棋谱
        App.recovering = false;
        App.mode = 'guest';
        Net.destroy();
        $('hostPanel').classList.add('hidden');
        $('roomCode').textContent = '------';
        Net.join(App.roomId);
        startJoinCountdown(App.roomId);
        return;
      }
      if (App.mode === 'host' && type === 'unavailable-id' && App.hostRetries < 3) {
        App.hostRetries++;
        App.roomId = randCode();
        $('roomCode').textContent = App.roomId;
        Net.create(App.roomId);
        lobbyStatus('房间号冲突，正在换号…');
        return;
      }
      if (App.phase !== 'lobby') return;   // 对局中出错交给断线重连机制，不打断棋局
      if (App.mode === 'guest' && type === 'peer-unavailable') {
        // 没人开这个房 → 自动用该号建房（房主掉线重进，或抢先开局）
        Net.destroy();
        createRoom(App.roomId, true);
        lobbyStatus('房间无人应答，已用此号为你建房，等待对手加入…');
        return;
      }
      // 主信令报错但备用信令还在尝试：继续等，不打断
      if (Net.signalingPending()) {
        lobbyStatus('主信令不通，正在尝试备用信令…');
        return;
      }
      if (type === 'network' || type === 'server-error' || type === 'socket-error') {
        lobbyStatus('网络错误：无法连接信令服务器', true);
      } else {
        lobbyStatus('连接出错：' + (e && e.message ? e.message : type), true);
      }
      backToButtons();
    });

    Net.on('conn-error', function (e) {
      if (App.phase === 'lobby') {
        lobbyStatus('点对点连接失败：' + (e && e.message ? e.message : 'NAT 打洞不通') +
          '，系统会自动尝试服务器中继', true);
      } else {
        toast('连接出现异常');
      }
    });
  }

  /* ================= 启动 ================= */

  function boot() {
    UI.init({ onCellClick: onCellClick });
    bind();
    if (typeof Peer === 'undefined' && typeof MiniMQTT === 'undefined') {
      lobbyStatus('联机组件加载失败（需要联网），请刷新重试', true);
    }
    // 测试钩子：E2E 通过 window.App 读取对局状态
    window.App = App;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

})();
