/* 联机封装。三层传输，逐级兜底：
   1) WebRTC P2P 直连（PeerJS 主信令 或 MQTT 备用信令交换 SDP）
   2) P2P 打不通（打洞失败/无 TURN）→ 对局消息走 MQTT broker 中继（延迟略高，仍可玩）
   3) 中继期间有心跳，对方真正断开 12 秒内检测到；P2P 迟到打通自动升级回直连 */
'use strict';

const Net = (function () {

  let peer = null;
  let conn = null;
  let settled = false;      // 已有可用传输（P2P 先到先得，或降级中继）
  let dead = false;         // destroy 后忽略一切回调
  let mqttSig = null;       // MQTT 会话：信令 + 消息中继共用连接
  let autoRole = null;      // 'host' | 'guest'（自动联机角色）
  let p2pTimer = null;      // P2P 等待超时 → 降级中继
  let hbTimer = null;       // 中继模式心跳
  let lastHb = 0;
  let relayWanted = false;
  let pendingData = [];     // 连接建立前收到的消息，先缓存
  const handlers = {};

  const P2P_WAIT = 10000;   // 信令交换完成后等 P2P 的时间
  const HB_INT = 3000;      // 心跳间隔
  const HB_MAX = 12000;     // 超过这个时间没收到任何消息 → 对方已断

  function on(evt, fn) { handlers[evt] = fn; }
  function emit(evt, data) { if (handlers[evt]) handlers[evt](data); }

  function isWrappedMpc(c) { return !!(mpc && c && c._pc === mpc); }
  function busReady() {
    return !!(mqttSig && mqttSig.mq && !mqttSig.done && mqttSig.mq._opened);
  }

  function deliver(d) {
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
      if (conn && conn._relay && !c._relay) {   // 中继期间 P2P 迟到打通 → 升级
        stopSigPublishing();
        conn = c;
        return;
      }
      try { c.close(); } catch (e) {}
      return;
    }
    settled = true;
    conn = c;
    clearP2pTimer();
    stopSignaling();
    emit('connected', { role: role, peer: (c && c.peer) || 'p2p' });
    flush();
  }

  function setupConn(c, role) {
    if (settled) {
      // 中继模式下仍接受迟到的 P2P（升级），否则关掉
      if (conn && conn._relay) c.on('open', function () { fireConnected(c, role); });
      else { try { c.close(); } catch (e) {} }
      return;
    }
    startP2pTimer(role);
    c.on('open', function () { fireConnected(c, role); });
    c.on('data', function (d) { if (c === conn) deliver(d); });
    c.on('close', function () {
      if (dead) return;
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
    p2pTimer = setTimeout(function () { p2pTimer = null; tryRelay(); }, P2P_WAIT);
  }

  function clearP2pTimer() {
    if (p2pTimer) { clearTimeout(p2pTimer); p2pTimer = null; }
  }

  function tryRelay() {
    if (settled) return;
    if (!busReady()) { relayWanted = true; return; }
    relayConnect(autoRole || 'guest');
  }

  function relayConnect(role) {
    if (settled || !busReady()) return;
    settled = true;
    conn = makeRelayWrap();
    clearP2pTimer();
    stopSigPublishing();
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
    if (!busReady()) return false;
    try {
      mqttSig.mq.publish(mqttSig.topic + '/d', JSON.stringify({ k: 'm', d: o }));
      return true;
    } catch (e) { return false; }
  }

  function startHb() {
    lastHb = Date.now();
    if (hbTimer) return;
    hbTimer = setInterval(function () {
      if (!settled || !conn || !conn._relay) { clearHb(); return; }
      if (busReady()) {
        try { mqttSig.mq.publish(mqttSig.topic + '/d', JSON.stringify({ k: 'hb' })); } catch (e) {}
      }
      if (Date.now() - lastHb > HB_MAX) { clearHb(); emit('closed'); }
    }, HB_INT);
  }

  function clearHb() {
    if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
  }

  function watchIce(pc) {
    if (!pc || !pc.addEventListener) return;
    pc.addEventListener('iceconnectionstatechange', function () {
      if (pc.iceConnectionState !== 'failed' || settled) return;
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
      offer: null, answer: null, answering: false, accepted: false, done: false
    };
    mqttSig = st;

    const mq = new MiniMQTT({ urls: BROKERS, connectTimeout: 4000 });
    st.mq = mq;
    const pub = function (obj) {
      try { mq.publish(topic, JSON.stringify(obj)); } catch (e) {}
    };
    const publishOffer = function () {
      if (st.offer && !st.done && !settled) pub({ k: 'o', sd: st.offer, sid: st.sid });
    };

    mq.onopen = function () {
      if (st.done) return;
      mq.subscribe(topic);
      mq.subscribe(dataTopic);
      if (relayWanted && !settled) { relayWanted = false; relayConnect(autoRole || 'guest'); return; }
      if (settled) return;
      if (role === 'host') {
        // 主：生成连接码，周期发布，等对方应答
        manualOffer().then(function (code) {
          st.offer = code;
          publishOffer();
        }).catch(function () {});
        st.timers.push(setInterval(publishOffer, 2500));
      } else {
        // 客：应答码生成后周期发布（防止对方晚订阅漏收）
        st.timers.push(setInterval(function () {
          if (st.answer && !st.done && !settled) pub({ k: 'a', sd: st.answer, sid: st.sid });
        }, 2500));
      }
    };

    mq.onmessage = function (t, payload) {
      if (st.done || dead) return;
      let m;
      try { m = JSON.parse(payload); } catch (e) { return; }
      if (t === dataTopic) {
        // 消息中继通道：心跳 + 对局消息
        lastHb = Date.now();
        if (m && m.k === 'm' && m.d !== undefined) deliver(m.d);
        return;
      }
      if (t !== topic) return;
      if (!m || m.sid === st.sid || typeof m.sd !== 'string') return;
      if (role === 'host' && m.k === 'a' && !st.accepted) {
        st.accepted = true;
        manualAccept(m.sd).then(function () { startP2pTimer('host'); })
          .catch(function () { st.accepted = false; });
      } else if (role === 'guest' && m.k === 'o' && !st.answer && !st.answering) {
        st.answering = true;
        manualAnswer(m.sd).then(function (code) {
          st.answering = false;
          st.answer = code;
          startP2pTimer('guest');
          pub({ k: 'a', sd: code, sid: st.sid });
        }).catch(function () { st.answering = false; });
      }
    };

    mq.onerror = function () {};
    mq.onclose = function () {
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

  return {
    on: on,
    create: create,
    join: join,
    send: send,
    destroy: destroy,
    isConnected: isConnected,
    signalingPending: signalingPending
  };
})();
