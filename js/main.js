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
    toast('悔棋成功，退回上一步');
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
    // 再来一局：双方红黑互换
    App.swapped = !App.swapped;
    flipSide();
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
        if (!longer && !diff) return;
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
    App.mySide = App.mySide === RED ? BLACK : RED;
    $('sideTag').textContent = sideName(App.mySide) + (App.mySide === RED ? '（先手）' : '（后手）');
    UI.setOrientation(App.mySide);
  }

  function startGame(side, relay) {
    stopWait();
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
    ct.textContent = relay ? '中继连接' : '已连接';
    ct.className = 'tag on';
    banner(null);

    UI.setOrientation(side);
    render();
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

  function joinRoom() {
    const val = $('roomInput').value.trim();
    if (!/^\d{6}$/.test(val)) {
      lobbyStatus('请输入 6 位数字房间号', true);
      return;
    }
    // 不在浏览器里存房间号：双方线下沟通房间号，直接输号加入
    App.mode = 'guest';
    App.roomId = val;
    $('btnCreate').disabled = true;
    $('btnJoin').disabled = true;
    Net.join(val);
    startJoinCountdown(val);
  }

  function backToButtons() {
    stopWait();
    $('btnCreate').disabled = false;
    $('btnJoin').disabled = false;
    $('hostPanel').classList.add('hidden');
  }

  function leaveToLobby() {
    stopResumeRetry();
    Net.destroy();
    location.reload();
  }

  /* ================= 事件绑定 ================= */

  function bind() {
    $('btnCreate').onclick = function () { createRoom(); };
    $('btnJoin').onclick = joinRoom;
    $('roomInput').addEventListener('input', function (e) {
      e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
    });
    $('roomInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') joinRoom();
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
      startGame(sideForRole(info.role), !!info.relay);
      // 请求棋谱：若对方是进行中的棋局（自己刚重新加入），会同步恢复局面
      Net.send({ t: 'sync-req' });
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

    // 对方重新加入（或直连恢复）：清掉断线状态，继续对局
    Net.on('reconnected', function () {
      const wasOff = App.disconnected;
      App.disconnected = false;
      stopResumeRetry();
      banner(null);
      const ct = $('connTag');
      ct.textContent = '已连接';
      ct.className = 'tag on';
      if ($('modalTitle').textContent === '对方掉线') closeModal();
      render();
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
