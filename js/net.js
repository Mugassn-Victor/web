/* 联机封装：PeerJS 主信令 + 公共 MQTT 备用信令（并行竞速，先连上先用），
   数据通道均为 WebRTC DataChannel。手动直连复用同一套 WebRTC 代码。 */
'use strict';

const Net = (function () {

  let peer = null;
  let conn = null;
  let settled = false;      // 已有数据通道连上（先到先得）
  let mqttSig = null;       // 备用信令会话
  const handlers = {};

  function on(evt, fn) { handlers[evt] = fn; }
  function emit(evt, data) { if (handlers[evt]) handlers[evt](data); }

  function isWrappedMpc(c) { return !!(mpc && c && c._pc === mpc); }

  // 第一条连上的通道获胜：停掉所有信令，关掉输家
  function fireConnected(c, role) {
    if (settled) {
      if (c !== conn) { try { c.close(); } catch (e) {} }
      return;
    }
    settled = true;
    conn = c;
    stopSignaling();
    emit('connected', { role: role, peer: (c && c.peer) || 'p2p' });
  }

  function setupConn(c, role) {
    if (settled) { try { c.close(); } catch (e) {} return; }
    c.on('open', function () { fireConnected(c, role); });
    c.on('data', function (d) { if (c === conn) emit('data', d); });
    c.on('close', function () { if (c === conn) emit('closed'); });
    c.on('error', function (e) { if (c === conn) emit('conn-error', e); });
  }

  function stopSignaling() {
    stopMqttSig();
    if (isWrappedMpc(conn)) {
      // MQTT 信令赢了：保留它的 RTCPeerConnection，关掉 PeerJS
      try { if (peer) peer.destroy(); } catch (e) {}
      peer = null;
    } else {
      // PeerJS 赢了：关掉备用信令建的 RTCPeerConnection
      manualClose();
    }
  }

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
    settled = false;
    startMqttSig(roomId, 'host');
    if (typeof Peer === 'undefined') return;
    const p = newPeer(roomId);
    p.on('connection', function (c) { setupConn(c, 'host'); });
  }

  // 加房
  function join(roomId) {
    settled = false;
    startMqttSig(roomId, 'guest');
    if (typeof Peer === 'undefined') return;
    const p = newPeer();
    p.on('open', function () {
      if (settled) { try { p.destroy(); } catch (e) {} return; }
      const c = p.connect(roomId, { reliable: true });
      setupConn(c, 'guest');
    });
  }

  function send(obj) {
    if (conn && conn.open) {
      try { conn.send(obj); return true; } catch (e) { return false; }
    }
    return false;
  }

  function destroy() {
    stopMqttSig();
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
    const sid = Math.random().toString(36).slice(2, 10);
    const st = {
      mq: null, topic: topic, sid: sid, timers: [],
      offer: null, answer: null, answering: false, accepted: false, done: false, age: 0
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
      if (st.done || settled) return;
      mq.subscribe(topic);
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
      if (t !== topic || st.done || settled) return;
      let m;
      try { m = JSON.parse(payload); } catch (e) { return; }
      if (!m || m.sid === st.sid || typeof m.sd !== 'string') return;
      if (role === 'host' && m.k === 'a' && !st.accepted) {
        st.accepted = true;
        manualAccept(m.sd).catch(function () { st.accepted = false; });
      } else if (role === 'guest' && m.k === 'o' && !st.answer && !st.answering) {
        st.answering = true;
        manualAnswer(m.sd).then(function (code) {
          st.answering = false;
          st.answer = code;
          pub({ k: 'a', sd: code, sid: st.sid });
        }).catch(function () { st.answering = false; });
      }
    };

    mq.onerror = function () {};
    mq.onclose = function () {
      if (mqttSig === st && !st.done && !settled) stopMqttSig();
    };
    mq.connect();

    // 45 秒兜底停表，避免一直占用 broker
    st.timers.push(setInterval(function () {
      st.age++;
      if (st.age >= 18) stopMqttSig();
    }, 2500));
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
    if (settled) { try { dc.close(); } catch (e) {} return; }
    setupConn(wrap, role);
    if (dc.readyState === 'open') setTimeout(function () { fireConnected(wrap, role); }, 0);
    if (mpc) {
      mpc.addEventListener('iceconnectionstatechange', function () {
        if (mpc && mpc.iceConnectionState === 'failed' && !settled) {
          emit('conn-error', new Error('P2P 连接失败'));
        }
      });
    }
  }

  function manualClose() {
    try { if (mdc) mdc.close(); } catch (e) {}
    try { if (mpc) mpc.close(); } catch (e) {}
    mdc = null; mpc = null;
  }

  // 创建方：生成连接码
  function manualOffer() {
    manualClose();
    mpc = new RTCPeerConnection({ iceServers: ICE });
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
    manualClose();
    let d;
    try { d = dec(code); } catch (e) { return Promise.reject(new Error('连接码格式不正确')); }
    if (!d.s || d.s.indexOf('m=application') < 0) {
      return Promise.reject(new Error('连接码无效或已过期'));
    }
    mpc = new RTCPeerConnection({ iceServers: ICE });
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
    signalingPending: signalingPending,
    manualOffer: manualOffer,
    manualAccept: manualAccept,
    manualAnswer: manualAnswer
  };
})();
