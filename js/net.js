/* 联机封装。三层传输，逐级兜底：
   1) 加入即走 broker 中继先连上（双方总线一确认就开打，不等打洞）
   2) 背景继续 WebRTC 打洞（PeerJS 主信令 / MQTT 备用信令），打通即无缝升级直连
   3) 中继期间有心跳，对方真正断开 12 秒内检测到；房主慢速重发 offer 持续尝试打洞 */
'use strict';

const Net = (function () {

  let peer = null;
  let conn = null;
  let settled = false;      // 已有可用传输（P2P 先到先得，或降级中继）
  let dead = false;         // destroy 后忽略一切回调
  let mqttSig = null;       // MQTT 会话：信令 + 消息中继共用连接
  let autoRole = null;      // 'host' | 'guest'（自动联机角色）
  let lastRoom = null;      // 最近的房间号（掉线恢复时重拨用）
  let p2pTimer = null;      // P2P 等待超时 → 降级中继
  let hbTimer = null;       // 中继模式心跳
  let lastHb = 0;
  let peerGone = false;     // 心跳超时判对方掉线后置位；对方消息再到达时复活心跳并报重连
  let lastPunch = 0;        // 中继模式下背景打洞的节流
  let relayWanted = false;
  let pendingData = [];     // 连接建立前收到的消息，先缓存
  const handlers = {};

  /* 语音通话状态：信令骑在对局通道上（对局能通语音信令就能通），媒体走独立 RTCPeerConnection */
  let vcall = null;         // 进行中的呼出/已接通（RTCPeerConnection）
  let pendingCall = null;   // 对方呼入，等待接听 { sdp }
  let localStream = null;   // 本机麦克风
  let vAudio = null;        // 播放对方声音的 audio 元素
  let voiceMuted = false;
  let remoteMuted = false;   // 本地静音对方声音（听不到对面）
  let vAnswered = false;    // 呼出已收到应答 / 本机已接听
  let lastVoff = null;      // 最近一次呼出 offer 的 sdp（重发去重用）
  let vRetryTimer = null;   // 语音信令重发定时器
  let vTimeout = null;      // 呼出无人接听超时

  const P2P_WAIT = 10000;   // 信令交换完成后等 P2P 的时间
  const HB_INT = 3000;      // 心跳间隔
  const HB_MAX = 12000;     // 超过这个时间没收到任何消息 → 对方已断

  const _trace = [];
  function tr(evt) {
    _trace.push(String(Date.now() % 100000000) + ' ' + evt);
    if (_trace.length > 300) _trace.shift();
  }

  function on(evt, fn) { handlers[evt] = fn; }
  function emit(evt, data) { if (handlers[evt]) handlers[evt](data); }

  function isWrappedMpc(c) { return !!(mpc && c && c._pc === mpc); }
  function busReady() {
    return !!(mqttSig && mqttSig.mq && !mqttSig.done && mqttSig.mq._opened);
  }
  // 房主当前传输是否为健康直连（中继兜底/掉线状态都需要重新发 offer 等对方接回）
  function hostHealthy() {
    return !!(settled && conn && conn.open && !conn._relay);
  }

  function deliver(d) {
    // 语音信令走对局通道：网络层内部消息，不上抛给对局层
    if (d && typeof d === 'object' && (d.t === 'v-off' || d.t === 'v-ans' || d.t === 'v-end')) {
      onVoiceSignal(d);
      return;
    }
    if (!settled) { pendingData.push(d); return; }
    emit('data', d);
  }

  function flush() {
    const q = pendingData;
    pendingData = [];
    for (let i = 0; i < q.length; i++) emit('data', q[i]);
  }

  // 第一条可用传输获胜：P2P 打开即用；中继模式下后打通的 P2P 可无缝升级
  function fireConnected(c, role) {
    if (dead) return;
    if (settled) {
      if (c === conn) return;
      const healthy = conn && conn.open;
      const lateP2P = healthy && conn._relay && !c._relay;
      if (!healthy || lateP2P) {
        // 旧连接已死（对方掉线后重新加入）或中继期间 P2P 迟到打通
        conn = c;
        clearP2pTimer();
        stopSignaling();
        peerGone = false;
        tr('fire-upgrade role=' + role);
        emit('reconnected', { role: role, peer: (c && c.peer) || 'p2p', upgraded: lateP2P });
        flush();
        return;
      }
      try { c.close(); } catch (e) {}
      return;
    }
    settled = true;
    conn = c;
    clearP2pTimer();
    stopSignaling();
    peerGone = false;
    tr('fire-first role=' + role + ' relay=' + !!(c && c._relay));
    emit('connected', { role: role, peer: (c && c.peer) || 'p2p' });
    flush();
  }

  function setupConn(c, role) {
    // 监听必须先挂上（含接管场景）：对方刷新重连时旧连接已死，新连接会被 fireConnected
    // 接管成 conn，若此时没挂 data 监听，接管后就永远收不到对方消息（c===conn 守卫无处生效）
    c.on('data', function (d) { if (c === conn) deliver(d); });
    c.on('close', function () {
      if (dead) return;
      tr('conn-close settled=' + settled + ' relay=' + !!(conn && conn._relay) + ' same=' + (c === conn));
      if (settled) {
        if (c !== conn || conn._relay) return;
        if (busReady()) { conn = makeRelayWrap(); startHb(); emit('relay'); }
        else emit('closed');
      } else if (busReady()) {
        tryRelay(role);
      } else {
        emit('closed');
      }
    });
    c.on('error', function (e) { if (!dead && (c === conn || !settled)) emit('conn-error', e); });
    if (settled) {
      const healthy = conn && conn.open;
      if (healthy && !(conn._relay && !c._relay)) {
        // 已有健康连接，且不是「中继期间迟到的 P2P」→ 关掉重复连接
        try { c.close(); } catch (e) {}
        return;
      }
      // 旧连接已死（对方重新加入）或中继期 P2P 迟到 → 打开后由 fireConnected 接管
      c.on('open', function () { fireConnected(c, role); });
      return;
    }
    startP2pTimer(role);
    c.on('open', function () { fireConnected(c, role); });
  }

  function stopSignaling() {
    stopSigPublishing();
    if (isWrappedMpc(conn)) {
      // MQTT 信令赢了：保留它的 RTCPeerConnection，关掉 PeerJS
      try { if (peer) peer.destroy(); } catch (e) {}
      peer = null;
    } else {
      // PeerJS 赢了：关掉备用信令建的 RTCPeerConnection
      manualClose();
    }
  }

  /* ===== 中继兜底：P2P 打不通时，对局消息经 MQTT broker 转发 ===== */

  function startP2pTimer(role) {
    if (role) autoRole = role;
    if (p2pTimer || settled) return;
    tr('p2p-timer-start');
    p2pTimer = setTimeout(function () { p2pTimer = null; tr('p2p-timeout'); tryRelay(); }, P2P_WAIT);
  }

  function clearP2pTimer() {
    if (p2pTimer) { clearTimeout(p2pTimer); p2pTimer = null; }
  }

  function tryRelay() {
    if (settled) return;
    if (!busReady()) { relayWanted = true; tr('tryRelay-busnotready'); return; }
    tr('tryRelay-fire');
    relayConnect(autoRole || 'guest');
  }

  function relayConnect(role) {
    if (settled || !busReady()) return;
    tr('relayConnect role=' + role);
    settled = true;
    conn = makeRelayWrap();
    clearP2pTimer();
    peerGone = false;
    startHb();
    emit('connected', { role: role, peer: 'relay', relay: true });
    flush();
  }

  function makeRelayWrap() {
    return {
      peer: 'relay',
      _relay: true,
      get open() { return busReady(); },
      send: function (o) { return busSend(o); },
      close: function () {},
      on: function () {}
    };
  }

  function busSend(o) {
    if (!busReady()) { tr('send-skip nobus ' + (o && o.t)); return false; }
    try {
      tr('send ' + (o && o.t));
      // 带上自己的 sid：broker 会把消息回给发布者本人，收端靠 sid 过滤掉自己发的
      mqttSig.mq.publish(mqttSig.topic + '/d', JSON.stringify({ k: 'm', d: o, sid: mqttSig.sid }));
      return true;
    } catch (e) { tr('send-err ' + e); return false; }
  }

  function startHb() {
    lastHb = Date.now();
    if (hbTimer) return;
    hbTimer = setInterval(function () {
      if (!settled || !conn || !conn._relay) { clearHb(); return; }
      if (busReady()) {
        try { mqttSig.mq.publish(mqttSig.topic + '/d', JSON.stringify({ k: 'hb', sid: mqttSig.sid })); tr('hb-s'); } catch (e) {}
      }
      // 背景慢慢打洞：中继模式下房主周期性重发 offer，打通即自动升级直连
      if (autoRole === 'host' && !hostHealthy() && mqttSig && mqttSig.ensureOffer &&
          Date.now() - lastPunch >= 15000) {
        lastPunch = Date.now();
        tr('bg-punch');
        mqttSig.ensureOffer();
      }
      if (Date.now() - lastHb > HB_MAX) { clearHb(); peerGone = true; tr('hb-timeout age=' + (Date.now() - lastHb)); emit('closed'); }
    }, HB_INT);
  }

  function clearHb() {
    if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
  }

  function watchIce(pc) {
    if (!pc || !pc.addEventListener) return;
    pc.addEventListener('iceconnectionstatechange', function () {
      const s = pc.iceConnectionState;
      tr('ice=' + s);
      // 打洞失败/掉线：已在中继就慢慢重试，不在中继才降级
      if (s === 'failed' || s === 'disconnected') {
        if (settled && conn && conn._relay && autoRole === 'host' &&
            mqttSig && mqttSig.ensureOffer) {
          tr('punch-retry ' + s);
          mqttSig.ensureOffer();
        }
      }
      if (s !== 'failed' || settled) return;
      if (busReady()) relayConnect(autoRole || 'guest');
      else emit('conn-error', new Error('P2P 连接失败'));
    });
  }

  /* ===== PeerJS 主信令 ===== */

  function newPeer(id) {
    if (peer) { try { peer.destroy(); } catch (e) {} peer = null; }
    peer = new Peer(id);
    peer.on('open', function (myId) { emit('open', myId); });
    peer.on('error', function (e) { emit('error', e); });
    peer.on('disconnected', function () {
      try { peer.reconnect(); } catch (e) {}
    });
    return peer;
  }

  // 建房：id 为自定义房间号
  function create(roomId) {
    dead = false;
    settled = false;
    autoRole = 'host';
    lastRoom = roomId;
    pendingData = [];
    startMqttSig(roomId, 'host');
    if (typeof Peer === 'undefined') return;
    const p = newPeer(roomId);
    p.on('connection', function (c) { setupConn(c, 'host'); });
  }

  // 加房
  function join(roomId) {
    dead = false;
    settled = false;
    autoRole = 'guest';
    lastRoom = roomId;
    pendingData = [];
    startMqttSig(roomId, 'guest');
    if (typeof Peer === 'undefined') return;
    const p = newPeer();
    p.on('open', function () {
      if (settled && !(conn && conn._relay)) { try { p.destroy(); } catch (e) {} return; }
      const c = p.connect(roomId, { reliable: true });
      setupConn(c, 'guest');
    });
  }

  function send(obj) {
    if (conn && conn.open) {
      try { conn.send(obj); return true; } catch (e) {}
    }
    // P2P 通道不可用但中继在 → 走中继
    if (conn && !conn._relay && busReady()) return busSend(obj);
    return false;
  }

  function destroy() {
    dead = true;
    voiceCleanup();
    stopMqttSig();
    clearP2pTimer();
    clearHb();
    pendingData = [];
    const c = conn;
    conn = null;
    settled = false;
    manualClose();
    try { if (c) c.close(); } catch (e) {}
    try { if (peer) peer.destroy(); } catch (e) {}
    peer = null;
  }

  function isConnected() { return !!(conn && conn.open); }

  function signalingPending() { return !!(mqttSig && !mqttSig.done && !settled); }

  // 断线后由 main.js 周期调用：重建信令总线 + 客方主动重拨房间
  // （房主掉线重进时以同一房间号重新注册 Peer，等待中的客方重拨即可接上）
  function resume() {
    if (dead || !lastRoom) return;
    tr('resume role=' + autoRole);
    if (!(mqttSig && !mqttSig.done && mqttSig.mq && mqttSig.mq._opened)) {
      startMqttSig(lastRoom, autoRole || 'guest');
    } else if (autoRole === 'host' && mqttSig.ensureOffer) {
      mqttSig.ensureOffer();
    }
    if (autoRole === 'guest' && peer && lastRoom) {
      try {
        const c = peer.connect(lastRoom, { reliable: true });
        setupConn(c, 'guest');
      } catch (e) {}
    }
  }

  /* ===== 备用信令：公共 MQTT broker（WebSocket 直连，无需注册/自建服务器） ===== */

  const BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081/mqtt',
    'wss://test.mosquitto.org:8081/'
  ];

  function stopSigPublishing() {
    if (!mqttSig) return;
    mqttSig.timers.forEach(function (id) { clearInterval(id); });
    mqttSig.timers = [];
  }

  function stopMqttSig() {
    if (!mqttSig) return;
    const st = mqttSig;
    mqttSig = null;
    st.done = true;
    st.timers.forEach(function (id) { clearInterval(id); });
    st.timers = [];
    try { if (st.mq) st.mq.close(); } catch (e) {}
    st.mq = null;
  }

  function startMqttSig(room, role) {
    stopMqttSig();
    if (typeof MiniMQTT === 'undefined' || !room) return;

    const topic = 'xq/v1/' + room;
    const dataTopic = topic + '/d';
    const sid = Math.random().toString(36).slice(2, 10);
    const st = {
      mq: null, topic: topic, sid: sid, timers: [],
      offer: null, answer: null, answering: false, accepted: false, done: false,
      lastOffer: null, lastEnsure: 0, ensuring: false, offerTimer: null, ensureOffer: null
    };
    mqttSig = st;

    const mq = new MiniMQTT({ urls: BROKERS, connectTimeout: 4000 });
    st.mq = mq;
    const pub = function (obj) {
      try { mq.publish(topic, JSON.stringify(obj)); } catch (e) {}
    };
    const publishOffer = function () {
      // 中继模式下也继续发布：供背景打洞的 offer/answer 交换用
      if (st.offer && !st.done && (!settled || (conn && conn._relay))) pub({ k: 'o', sd: st.offer, sid: st.sid });
    };

    mq.onopen = function () {
      if (st.done) return;
      tr('mq-open role=' + role);
      mq.subscribe(topic);
      mq.subscribe(dataTopic);
      if (relayWanted && !settled) { relayWanted = false; relayConnect(autoRole || 'guest'); return; }
      if (settled) {
        // 总线重建后房主仍处于中继/掉线兜底状态 → 补发 offer 等对方接回
        if (role === 'host' && st.ensureOffer) st.ensureOffer();
        return;
      }
      if (role === 'host') {
        // 主：生成连接码，周期发布，等对方应答
        st.ensuring = true;
        manualOffer().then(function (code) {
          st.ensuring = false;
          if (st.done || mqttSig !== st) return;
          st.offer = code;
          publishOffer();
        }).catch(function () { st.ensuring = false; });
        st.timers.push(setInterval(publishOffer, 2500));

        // 兜底重连：对方刷新页面后重进会先「敲门」，此时房主若在中继/掉线状态
        // （对方早已收不到周期 offer），要重新生成 offer、放开应答闸，让对方接回
        st.ensureOffer = function () {
          if (st.done || dead) { tr('ensure-skip done'); return; }
          if (!st.mq || !st.mq._opened) { tr('ensure-skip nobus'); return; }
          if (hostHealthy()) { tr('ensure-skip healthy'); return; }
          if (!settled && (st.offer || st.ensuring)) { tr('ensure-skip inflight'); return; }
          // 'new' 不拦截：TURN 全挂的环境里旧 offer 的 pc 会永远停在 new，
          // 拦了就会让客方敲门永远得不到新 offer（中继兜底模式下无法重连）
          if (mpc && ['checking', 'connected', 'completed'].indexOf(mpc.iceConnectionState) >= 0) {
            tr('ensure-skip mpc=' + mpc.iceConnectionState); return;
          }
          const now = Date.now();
          if (st.ensuring || now - st.lastEnsure < 6000) { tr('ensure-skip throttle'); return; }
          tr('ensure-run');
          st.lastEnsure = now;
          st.ensuring = true;
          manualOffer().then(function (code) {
            st.ensuring = false;
            if (st.done || dead || mqttSig !== st) return;
            st.offer = code;
            st.accepted = false;                           // 放开应答闸：接受新一轮 answer
            pub({ k: 'o', sd: code, sid: st.sid });
            if (!st.offerTimer) {
              st.offerTimer = setInterval(function () {
                if (st.done || hostHealthy()) {
                  clearInterval(st.offerTimer); st.offerTimer = null; return;
                }
                if (st.offer) pub({ k: 'o', sd: st.offer, sid: st.sid });
              }, 2500);
              st.timers.push(st.offerTimer);
            }
          }).catch(function () { st.ensuring = false; });
        };
      } else {
        // 客：先敲门（房主在兜底状态时靠它重新发 offer），应答后周期发布应答码
        pub({ k: 'j', sid: st.sid });
        st.timers.push(setInterval(function () {
          // 中继模式下也继续发：背景打洞靠它触发房主重发 offer / 传应答码
          if (st.done || (settled && !(conn && conn._relay))) return;
          if (st.answer) pub({ k: 'a', sd: st.answer, sid: st.sid });
          else pub({ k: 'j', sid: st.sid });
        }, 2500));
      }
    };

    mq.onmessage = function (t, payload) {
      if (st.done || dead) { if (t === dataTopic) tr('dt-drop ' + (dead ? 'dead' : 'done')); return; }
      let m;
      try { m = JSON.parse(payload); } catch (e) { return; }
      if (t === dataTopic) {
        // 消息中继通道：心跳 + 对局消息（先滤掉自己发出去的回声，否则 lastHb 永远新鲜、
        // 自己的 undo-ok/restart-ok 会被自己再执行一遍）
        if (m && m.k === 'hb') tr(m.sid === st.sid ? 'hb-own' : 'hb-r');
        if (m && m.sid === st.sid) return;
        lastHb = Date.now();
        // 对方掉线被判死后，收到对方消息 = 对方已回来：复活自己的心跳（否则对方等不到
        // 我方 hb 也会超时互判掉线），并向上报重连以清理断线状态/弹窗
        if (peerGone) {
          peerGone = false;
          tr('hb-revive');
          startHb();
          emit('reconnected', { role: autoRole, peer: 'relay' });
        }
        if (m && m.k === 'm' && m.d !== undefined) { tr('recv ' + (m.d && m.d.t)); deliver(m.d); }
        return;
      }
      if (t !== topic) return;
      if (!m || m.sid === st.sid) return;
      if (m.k === 'j') {
        // 客方敲门 = 总线已就位：房主立刻先中继连上（不等打洞），并回 'hi' 让客方也连上
        if (role === 'host') {
          // 房主在线就回 'hi'（含自己处于中继兜底时），让客方不必等周期 offer
          if (!settled || (conn && conn._relay)) pub({ k: 'hi', sid: st.sid });
          if (!settled) relayConnect('host');
          if (st.ensureOffer) { tr('knock'); st.ensureOffer(); }
        }
        return;
      }
      if (m.k === 'hi') {
        // 房主确认在线：客方立即走中继开打，打洞在背景继续
        if (role === 'guest' && !settled) relayConnect('guest');
        return;
      }
      if (typeof m.sd !== 'string') return;
      if (role === 'host' && m.k === 'a' && !st.accepted) {
        tr('ans-recv');
        st.accepted = true;
        manualAccept(m.sd).then(function () { tr('accept-ok'); startP2pTimer('host'); })
          .catch(function (e) {
            // 应答已应用过（stable 上再 setRemote）→ 视为已接受，别让重复应答反复重试
            if (e && String(e).indexOf('wrong state: stable') >= 0) st.accepted = true;
            else st.accepted = false;
            tr('accept-err ' + e);
          });
      } else if (role === 'guest' && m.k === 'o') {
        // 先中继连上（'hi' 丢失时的兜底），打洞照常在背景走
        if (!settled) relayConnect('guest');
        // 直连健康 → 不再理会 offer；同一份 offer 只应答一次；
        // 房主重发新 offer（对方刷新重进后的兜底重连）→ 重新应答
        if (settled && conn && conn.open && !conn._relay) { tr('offer-drop healthy'); return; }
        if (st.answering) { tr('offer-drop answering'); return; }
        if (st.answer && st.lastOffer === m.sd) { tr('offer-drop same'); return; }
        tr('offer-recv');
        st.lastOffer = m.sd;
        st.answering = true;
        manualAnswer(m.sd).then(function (code) {
          st.answering = false;
          st.answer = code;
          startP2pTimer('guest');
          tr('ans-pub');
          pub({ k: 'a', sd: code, sid: st.sid });
        }).catch(function (e) { tr('ans-err ' + e); st.answering = false; st.lastOffer = null; });
      }
    };

    mq.onerror = function () {};
    mq.onclose = function () {
      tr('mq-close settled=' + settled + ' relay=' + !!(conn && conn._relay));
      if (mqttSig === st) st.mq = null;   // 总线已断，允许 resume 重建
      if (mqttSig !== st) return;
      if (settled && conn && conn._relay) { clearHb(); emit('closed'); return; }
      if (!st.done && !settled) stopMqttSig();
    };
    mq.connect();

    // 房间可长时间等待，offer/answer 的周期发布一直持续到连上或销毁
  }

  /* ===== WebRTC：手动直连与 MQTT 备用信令共用 ===== */

  const ICE = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: ['stun:stun.miwifi.com:3478', 'stun:stun.chat.bilibili.com:3478'] },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: ['turn:turn.anyfirewall.com:3478', 'turn:turn.anyfirewall.com:443?transport=tcp'], username: 'guest', credential: 'guest' }
  ];

  // 语音独立 ICE：游戏那套 + PeerJS 公共 TURN（跨网络时多一条中继路，失败率更低；不影响游戏）
  const VICE = ICE.concat([
    { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' }
  ]);

  let mpc = null;   // 手动/备用信令的 RTCPeerConnection
  let mdc = null;   // 对应的 DataChannel

  function enc(o) { return btoa(JSON.stringify(o)); }
  function dec(s) { return JSON.parse(atob(String(s).replace(/\s+/g, ''))); }

  function waitGathering(pc, ms) {
    return new Promise(function (resolve) {
      if (pc.iceGatheringState === 'complete') { resolve(); return; }
      let done = false;
      const finish = function () {
        if (done) return;
        done = true;
        pc.removeEventListener('icegatheringstatechange', onState);
        resolve();
      };
      const onState = function () {
        if (pc.iceGatheringState === 'complete') finish();
      };
      pc.addEventListener('icegatheringstatechange', onState);
      setTimeout(finish, ms || 8000);   // 收集不完也带着已有候选先走
    });
  }

  function attachManual(dc, role) {
    const wrap = {
      peer: 'manual-' + role,
      _pc: mpc,
      get open() { return dc.readyState === 'open'; },
      send: function (o) { if (dc.readyState === 'open') dc.send(JSON.stringify(o)); },
      close: function () { try { dc.close(); } catch (e) {} },
      on: function (evt, fn) {
        if (evt === 'data') {
          dc.addEventListener('message', function (e) {
            try { fn(JSON.parse(e.data)); } catch (err) { fn(e.data); }
          });
        } else {
          dc.addEventListener(evt, fn);
        }
      }
    };
    setupConn(wrap, role);
    if (dc.readyState === 'open') setTimeout(function () { fireConnected(wrap, role); }, 0);
  }

  function manualClose() {
    try { if (mdc) mdc.close(); } catch (e) {}
    try { if (mpc) mpc.close(); } catch (e) {}
    mdc = null; mpc = null;
  }

  // 创建方：生成连接码
  function manualOffer() {
    dead = false;
    manualClose();
    mpc = new RTCPeerConnection({ iceServers: ICE });
    watchIce(mpc);
    mdc = mpc.createDataChannel('xq', { ordered: true });
    return mpc.createOffer()
      .then(function (o) { return mpc.setLocalDescription(o); })
      .then(function () { return waitGathering(mpc); })
      .then(function () {
        if (!mpc || !mpc.localDescription) throw new Error('生成连接码失败');
        return enc({ t: mpc.localDescription.type, s: mpc.localDescription.sdp });
      });
  }

  // 创建方：粘贴/收到应答码并连接
  function manualAccept(code) {
    if (!mpc) return Promise.reject(new Error('请先生成连接码'));
    let d;
    try { d = dec(code); } catch (e) { return Promise.reject(new Error('应答码格式不正确')); }
    return mpc.setRemoteDescription({ type: d.t, sdp: d.s })
      .then(function () { attachManual(mdc, 'host'); });
  }

  // 加入方：粘贴连接码，生成应答码
  // 注意：ondatachannel 要等对方应用应答码、DTLS 握手完成后才触发，
  // 所以这里只负责生成应答码，连接在 ondatachannel 里挂载。
  function manualAnswer(code) {
    dead = false;
    manualClose();
    let d;
    try { d = dec(code); } catch (e) { return Promise.reject(new Error('连接码格式不正确')); }
    if (!d.s || d.s.indexOf('m=application') < 0) {
      return Promise.reject(new Error('连接码无效或已过期'));
    }
    mpc = new RTCPeerConnection({ iceServers: ICE });
    watchIce(mpc);
    mpc.ondatachannel = function (e) {
      mdc = e.channel;
      attachManual(mdc, 'guest');
    };
    return mpc.setRemoteDescription({ type: d.t, sdp: d.s })
      .then(function () { return mpc.createAnswer(); })
      .then(function (a) { return mpc.setLocalDescription(a); })
      .then(function () { return waitGathering(mpc); })
      .then(function () {
        if (!mpc || !mpc.localDescription) throw new Error('生成应答码失败');
        return enc({ t: mpc.localDescription.type, s: mpc.localDescription.sdp });
      });
  }

  /* ===== 语音通话：信令走对局通道（v-off/v-ans/v-end），媒体走独立 RTCPeerConnection ===== */

  // 只要页面安全（https/localhost）且对局通道在，语音信令就能走 → 不再依赖任何云
  function voiceSupported() {
    return !!(window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
      !dead && conn && conn.open);
  }

  // 候选埋点：connectionState failed 后 getStats 里未配对的候选会被清掉（出现 0/0 假象），
  // 这里在采集期就记下真实计数，供失败提示用
  let vStat = null;

  function voiceStatWire(pc) {
    const st = { loc: 0, rel: 0, rem: 0 };
    vStat = st;
    pc.addEventListener('icecandidate', function (e) {
      if (vcall !== pc || !e.candidate || !e.candidate.candidate) return;
      st.loc++;
      if (e.candidate.candidate.indexOf(' typ relay ') >= 0) st.rel++;
    });
  }

  function voiceStatRemote(sdp) {
    if (!vStat) return;
    vStat.rem = String(sdp).split('\n').filter(function (l) { return l.indexOf('a=candidate') === 0; }).length;
  }

  function sendV(o) {
    try { return !!send(o); } catch (e) { return false; }
  }

  function clearVRetry() { if (vRetryTimer) { clearTimeout(vRetryTimer); vRetryTimer = null; } }
  function clearVTimeout() { if (vTimeout) { clearTimeout(vTimeout); vTimeout = null; } }

  // 对局通道/公共 broker 可能丢包：同一份信令在满足 cancel 前每 2.5s 重发一次（至多 times 次）
  function vRetransmit(payload, times, cancel) {
    let n = 0;
    clearVRetry();
    const tick = function () {
      vRetryTimer = null;
      if (cancel() || n >= times) return;
      n++;
      if (!sendV(payload)) return;
      vRetryTimer = setTimeout(tick, 2500);
    };
    vRetryTimer = setTimeout(tick, 2500);
  }

  function abandonOutbound() {
    clearVRetry();
    clearVTimeout();
    const pc = vcall;
    vcall = null;
    vAnswered = false;
    try { if (pc) pc.close(); } catch (e) {}
    stopLocalStream();
  }

  // 收到对方语音信令：v-off 呼出 / v-ans 应答 / v-end 挂断·拒接·忙
  function onVoiceSignal(d) {
    if (dead) return;
    if (d.t === 'v-off') {
      if (typeof d.sdp !== 'string' || !d.sdp) return;
      if (d.sdp === lastVoff) return;                 // 对方重发的同一份 offer，忽略
      if (vcall && vAnswered) { sendV({ t: 'v-end', r: 'busy' }); return; }
      if (vcall && !vAnswered) {
        if (autoRole !== 'host') {
          // 客方撞车让路：放弃自己的呼出，改接听房主的呼叫
          lastVoff = d.sdp;
          abandonOutbound();
          emit('voice', { ev: 'idle', reason: 'glare' });
        } else {
          return;   // 房主呼叫优先：忽略客方的呼出，等自己的被接听
        }
      }
      if (pendingCall) { sendV({ t: 'v-end', r: 'busy' }); return; }
      lastVoff = d.sdp;
      pendingCall = { sdp: d.sdp };
      emit('voice', { ev: 'ring' });
      return;
    }
    if (d.t === 'v-ans') {
      if (!vcall || vAnswered || typeof d.sdp !== 'string' || !d.sdp) return;
      vAnswered = true;
      clearVRetry();
      clearVTimeout();
      const pc = vcall;
      pc.setRemoteDescription({ type: 'answer', sdp: d.sdp })
        .then(function () { voiceStatRemote(d.sdp); })
        .catch(function () {
        if (vcall !== pc) return;
        voiceCleanup();
        emit('voice', { ev: 'idle', reason: 'err', msg: '语音连接失败' });
      });
      return;
    }
    // v-end：来电中 → 关弹窗；呼出/通话中 → 结束（main 端 reason 'closed' 映射为未接听/对方挂断）
    if (pendingCall) {
      pendingCall = null;
      emit('voice', { ev: 'ring-gone' });
      return;
    }
    if (vcall) {
      voiceCleanup();
      emit('voice', { ev: 'idle', reason: 'closed' });
    }
  }

  function stopLocalStream() {
    if (localStream) {
      try { localStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
      localStream = null;
    }
  }

  function playRemote(stream) {
    try {
      if (!vAudio) {
        vAudio = document.createElement('audio');
        vAudio.autoplay = true;
        document.body.appendChild(vAudio);
        // 手势解锁后重试播放（iOS 可能在流到达时仍缺用户手势）
        window.__vAudioPlay = function () {
          if (!vAudio) return;
          const p = vAudio.play();
          if (p && p.catch) p.catch(function () {});
        };
      }
      vAudio.srcObject = stream;
      vAudio.muted = remoteMuted;
      const p = vAudio.play();
      if (p && p.catch) p.catch(function () {});
    } catch (e) { /* 忽略 */ }
  }

  function clearRemote() {
    if (vAudio) { try { vAudio.pause(); } catch (e) {} vAudio.srcObject = null; vAudio.muted = false; }
    remoteMuted = false;
    try { if (window) window.__vAudioPlay = undefined; } catch (e) {}
  }

  function voiceCleanup() {
    clearVRetry();
    clearVTimeout();
    const pc = vcall;
    vcall = null;
    vAnswered = false;
    pendingCall = null;
    try { if (pc) pc.close(); } catch (e) {}
    stopLocalStream();
    clearRemote();
    voiceMuted = false;
  }

  function hookVoicePc(pc) {
    // talking 的判定：远端 track 到达 且 ICE 已连通（两个条件可能任意先后到达）
    // —— ontrack 在 setRemote 阶段就会提前触发，不能一收到就报「通话中」
    let gotTrack = false, iceUp = false, said = false;
    function maybeTalking() {
      if (said || vcall !== pc || !gotTrack || !iceUp) return;
      said = true;
      emit('voice', { ev: 'talking' });
    }
    pc.ontrack = function (e) {
      if (vcall !== pc) return;
      const s = (e.streams && e.streams[0]) || new MediaStream(e.track ? [e.track] : []);
      playRemote(s);
      gotTrack = true;
      maybeTalking();
    };
    pc.onconnectionstatechange = function () {
      if (vcall !== pc) return;
      const st = pc.connectionState;
      if (st === 'connected') {
        iceUp = true;
        maybeTalking();
      } else if (st === 'failed') {
        let p = null;
        try { p = pc.getStats(); } catch (e) {}
        voiceCleanup();
        emitVoiceFail(p);
      } else if (st === 'closed') {
        voiceCleanup();
        emit('voice', { ev: 'idle', reason: 'closed' });
      }
    };
  }

  // 失败提示带上候选对类型（host/srflg/relay），一眼看出是哪条路没打通
  function emitVoiceFail(p) {
    let emitted = false;
    const done = function (msg) {
      if (emitted) return;
      emitted = true;
      tr('voice-fail ' + msg);
      emit('voice', { ev: 'idle', reason: 'err', msg: msg });
    };
    const fallback = '语音连接失败（无可用网络路径）';
    const t = setTimeout(function () { done(fallback); }, 2000);
    if (!p || !p.then) { clearTimeout(t); done(fallback); return; }
    p.then(function (rep) {
      clearTimeout(t);
      try {
        const cand = {};
        let nl = 0, nr = 0, sel = null;
        if (rep && typeof rep.forEach === 'function') {
          rep.forEach(function (r) {
            if (r.type === 'local-candidate') { cand[r.id] = r; nl++; }
            else if (r.type === 'remote-candidate') { cand[r.id] = r; nr++; }
            else if (r.type === 'candidate-pair' && (r.nominated || r.state === 'succeeded')) { if (!sel) sel = r; }
          });
          if (rep.get && rep.get('selectedCandidatePairId')) {
            const s = rep.get(rep.get('selectedCandidatePairId'));
            if (s) sel = s;
          }
        }
        if (sel && cand[sel.localCandidateId] && cand[sel.remoteCandidateId]) {
          done('语音连接失败（' + (cand[sel.localCandidateId].candidateType || '?') + '↔' +
            (cand[sel.remoteCandidateId].candidateType || '?') + '）');
        } else {
          const lc = vStat ? vStat.loc : nl;
          const rc = vStat ? vStat.rem : nr;
          const tail = (vStat && vStat.rel > 0) ? '，含relay ' + vStat.rel : '';
          done('语音连接失败（本地候选' + lc + '、对端候选' + rc + tail + '）');
        }
      } catch (e) { done(fallback); }
    }).catch(function () {
      clearTimeout(t);
      done(fallback);
    });
  }

  function getMic() {
    return navigator.mediaDevices.getUserMedia({ audio: true });
  }

  function voiceStart() {
    if (!voiceSupported()) { emit('voice', { ev: 'err', msg: '当前环境不支持语音通话' }); return; }
    if (pendingCall) { emit('voice', { ev: 'err', msg: '有来电等待接听' }); return; }
    if (vcall || localStream) { emit('voice', { ev: 'err', msg: '已在通话中' }); return; }
    getMic().then(function (s) {
      if (!voiceSupported() || vcall || localStream) {
        try { s.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
        if (vcall) emit('voice', { ev: 'err', msg: '已在通话中' });
        return;
      }
      localStream = s;
      voiceMuted = false;
      const pc = new RTCPeerConnection({ iceServers: VICE, __xqVoice: 1 });
      hookVoicePc(pc);
      voiceStatWire(pc);
      vcall = pc;
      vAnswered = false;
      emit('voice', { ev: 'calling' });
      pc.addTrack(s.getAudioTracks()[0], s);
      pc.createOffer()
        .then(function (o) { return pc.setLocalDescription(o); })
        .then(function () { return waitGathering(pc, 5000); })
        .then(function () {
          if (vcall !== pc || !pc.localDescription) return;
          const sdp = pc.localDescription.sdp;
          if (!sendV({ t: 'v-off', sdp: sdp })) throw new Error('send');
          vRetransmit({ t: 'v-off', sdp: sdp }, 2, function () { return vcall !== pc || vAnswered; });
          clearVTimeout();
          vTimeout = setTimeout(function () {
            vTimeout = null;
            if (vcall === pc && !vAnswered) { voiceCleanup(); emit('voice', { ev: 'idle', reason: 'closed' }); }
          }, 60000);
        })
        .catch(function (e) {
          if (vcall !== pc) return;
          voiceCleanup();
          emit('voice', { ev: 'err', msg: (e && e.message === 'send') ? '连接中断，无法发起通话' : '发起通话失败' });
        });
    }).catch(function (e) {
      emit('voice', {
        ev: 'err',
        msg: (e && e.name === 'NotAllowedError') ? '麦克风权限被拒绝' : '无法打开麦克风'
      });
    });
  }

  function voiceAccept() {
    const offer = pendingCall;
    if (!offer) return;
    if (!voiceSupported() || !navigator.mediaDevices) {
      pendingCall = null;
      sendV({ t: 'v-end', r: 'decline' });
      emit('voice', { ev: 'err', msg: '当前环境不支持语音通话' });
      emit('voice', { ev: 'ring-gone' });
      return;
    }
    getMic().then(function (s) {
      if (pendingCall !== offer) {   // 等待期间已被拒接/挂断
        try { s.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
        return;
      }
      pendingCall = null;
      localStream = s;
      voiceMuted = false;
      const pc = new RTCPeerConnection({ iceServers: VICE, __xqVoice: 1 });
      hookVoicePc(pc);
      voiceStatWire(pc);
      vcall = pc;
      vAnswered = false;
      pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp })
        .then(function () {
          voiceStatRemote(offer.sdp);
          // 必须在 createAnswer 前加音轨，否则 answer 方向变 recvonly，主叫收不到声音
          pc.addTrack(localStream.getAudioTracks()[0], localStream);
          return pc.createAnswer();
        })
        .then(function (a) { return pc.setLocalDescription(a); })
        .then(function () { return waitGathering(pc, 5000); })
        .then(function () {
          if (vcall !== pc || !pc.localDescription) return;
          const sdp = pc.localDescription.sdp;
          if (!sendV({ t: 'v-ans', sdp: sdp })) throw new Error('send');
          vAnswered = true;
          vRetransmit({ t: 'v-ans', sdp: sdp }, 2, function () { return vcall !== pc; });
          // 不要乐观报「通话中」：等 ontrack（媒体真到了）才算接通，否则会先显示通话中再弹连接失败
          emit('voice', { ev: 'calling', silent: true });
        })
        .catch(function () {
          if (vcall !== pc) return;
          voiceCleanup();
          emit('voice', { ev: 'idle', reason: 'err', msg: '接听失败' });
        });
    }).catch(function () {
      // 麦克风拿不到就无法通话：挂掉呼入并提示
      if (pendingCall === offer) pendingCall = null;
      sendV({ t: 'v-end', r: 'decline' });
      emit('voice', { ev: 'ring-gone' });
      emit('voice', { ev: 'err', msg: '麦克风不可用，无法接听' });
    });
  }

  function voiceDecline() {
    if (!pendingCall) return;
    pendingCall = null;
    sendV({ t: 'v-end', r: 'decline' });
    emit('voice', { ev: 'ring-gone' });
  }

  function voiceHangup() {
    const active = !!(vcall || pendingCall || localStream);
    if (!active) return;
    const notify = !!(vcall || pendingCall);
    voiceCleanup();
    if (notify) sendV({ t: 'v-end', r: 'hangup' });
    emit('voice', { ev: 'idle', reason: 'local' });
  }

  function voiceMute() {
    if (!localStream) return false;
    voiceMuted = !voiceMuted;
    localStream.getAudioTracks().forEach(function (t) { t.enabled = !voiceMuted; });
    emit('voice', { ev: 'muted', muted: voiceMuted });
    return voiceMuted;
  }

  // 静音对方：本地不播放对方声音，对方麦克风不受影响
  function voiceMuteRemote() {
    remoteMuted = !remoteMuted;
    if (vAudio) vAudio.muted = remoteMuted;
    emit('voice', { ev: 'remote-muted', muted: remoteMuted });
    return remoteMuted;
  }

  return {
    on: on,
    create: create,
    join: join,
    send: send,
    destroy: destroy,
    isConnected: isConnected,
    signalingPending: signalingPending,
    resume: resume,
    voiceSupported: voiceSupported,
    voiceStart: voiceStart,
    voiceAccept: voiceAccept,
    voiceDecline: voiceDecline,
    voiceHangup: voiceHangup,
    voiceMute: voiceMute,
    voiceMuteRemote: voiceMuteRemote,
    _voiceDebug: function () {
      return {
        role: autoRole,
        answered: vAnswered,
        pending: !!pendingCall,
        local: !!localStream,
        pc: vcall ? {
          cs: vcall.connectionState,
          ice: vcall.iceConnectionState,
          gath: vcall.iceGatheringState,
          sig: vcall.signalingState,
          senders: vcall.getSenders().length,
          recv: vcall.getReceivers().map(function (r) {
            return r.track ? (r.track.readyState + '/' + r.track.muted) : 'none';
          })
        } : null
      };
    },
    _trace: _trace
  };
})();
