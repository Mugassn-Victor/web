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
  let beaconWanted = false;  // 房主开局后要广播观战信标
  let peerSid = null;        // 对方的总线 sid（只认它的心跳判活，观战者不算对方）
  let pendingData = [];     // 连接建立前收到的消息，先缓存
  const handlers = {};

  const P2P_WAIT = 10000;   // 信令交换完成后等 P2P 的时间
  const HB_INT = 3000;      // 心跳间隔
  const HB_MAX = 12000;     // 超过这个时间没收到任何消息 → 对方已断
  let inGame = false;       // 房主侧「本房对局进行中」：缺位敲门先问身份，不直接放人
  let awaitRole = false;    // 客方输号加入后等房主定身份：收到 'hi'/'ask' 前不建 Peer、不应答
                            // offer，防止抢在「缺位问身份」之前自动进房（PeerJS 连接比 ask 快）
  const WATCH_TIMEOUT = 10000;   // 观战等房主信标的时限

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
    if (role !== 'watch') startHb();   // 观战没有对端可测活，不发心跳
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

  function busSend(o, mir) {
    if (!busReady()) { tr('send-skip nobus ' + (o && o.t)); return false; }
    try {
      tr('send ' + (o && o.t));
      // 带上自己的 sid：broker 会把消息回给发布者本人，收端靠 sid 过滤掉自己发的
      // mir=1 是直连模式的镜像副本：只给观战者收听，对局方收到会丢弃（他们已从直连拿到）
      const pkt = { k: 'm', d: o, sid: mqttSig.sid };
      if (mir) pkt.mir = 1;
      mqttSig.mq.publish(mqttSig.topic + '/d', JSON.stringify(pkt));
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
    awaitRole = false;
    inGame = false;   // 新建的是空房：清掉上一局残留，否则敲门者会被误问「缺位身份」
    lastRoom = roomId;
    peerSid = null;
    pendingData = [];
    startMqttSig(roomId, 'host');
    if (typeof Peer === 'undefined') return;
    const p = newPeer(roomId);
    p.on('connection', function (c) { setupConn(c, 'host'); });
  }

  // 加房；asPlayer=true 表示对方已明确选择「以对战方加入」
  function join(roomId, asPlayer) {
    dead = false;
    settled = false;
    autoRole = 'guest';
    lastRoom = roomId;
    peerSid = null;
    pendingData = [];
    // 没明确要下棋就先等房主表态（'hi'=正常放行 / 'ask'=缺位先选身份），
    // 期间不建 Peer、不应答 offer，房主的快速通道抢不进来
    awaitRole = !asPlayer;
    startMqttSig(roomId, 'guest', asPlayer ? 'p' : undefined);
    if (!awaitRole) startGuestPeer();
  }

  function startGuestPeer() {
    if (typeof Peer === 'undefined') return;
    const p = newPeer();
    p.on('open', function () {
      if (settled && !(conn && conn._relay)) { try { p.destroy(); } catch (e) {} return; }
      const c = p.connect(lastRoom, { reliable: true });
      setupConn(c, 'guest');
    });
  }

  // 观战：只挂总线收听 + 发言，不建 Peer、不打洞；见房主信标后入房
  function watch(roomId) {
    dead = false;
    settled = false;
    autoRole = 'watch';
    awaitRole = false;
    lastRoom = roomId;
    peerSid = null;
    pendingData = [];
    startMqttSig(roomId, 'watch');
  }

  // 房主开局后广播信标（k:'w'）：观战者靠它确认「房间正在对局」
  function beacon(on) {
    beaconWanted = !!on;
    armBeacon();
  }

  function armBeacon() {
    if (!beaconWanted || !mqttSig || mqttSig.beaconT || !mqttSig.mq) return;
    const st = mqttSig;
    const fire = function () {
      if (st.done || !beaconWanted || mqttSig !== st || !st.mq || !st.mq._opened) return;
      try { st.mq.publish(st.topic, JSON.stringify({ k: 'w', sid: st.sid })); } catch (e) {}
    };
    fire();
    st.beaconT = setInterval(fire, 3000);
  }

  function send(obj) {
    if (conn && conn.open) {
      if (conn._relay) return conn.send(obj);   // 中继/观战：走总线，天然广播给观战者
      let ok = false;
      try { conn.send(obj); ok = true; } catch (e) {}
      if (ok) {
        // 直连通道只到对局双方：镜像一份到总线供观战者收听（对局方收到镜像会丢弃）
        if (autoRole !== 'watch') busSend(obj, true);
        return true;
      }
      // 直连抛错 → 总线兜底投递（不带镜像标记：这条就是真正的投递）
      if (busReady()) return busSend(obj, false);
      return false;
    }
    if (autoRole === 'watch' && busReady()) return busSend(obj, false);
    return false;
  }

  function destroy() {
    dead = true;
    beaconWanted = false;
    awaitRole = false;
    stopMqttSig();
    clearP2pTimer();
    clearHb();
    pendingData = [];
    const c = conn;
    conn = null;
    settled = false;
    peerSid = null;
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
    if (st.beaconT) { clearInterval(st.beaconT); st.beaconT = null; }
    if (st.watchT) { clearTimeout(st.watchT); st.watchT = null; }
    try { if (st.mq) st.mq.close(); } catch (e) {}
    st.mq = null;
  }

  // 由上层（房主）维护：对局进行中 → 缺位时敲门者要先选身份
  function setInGame(b) { inGame = !!b; }

  // 房里是否已有存活的对战客方（第三方敲门要被引导去观战）。
  // 直连看数据通道；中继不能看 conn.open（host 一敲门就 settled，open 只是自家总线
  // 在线），要看「已收到过对方心跳且没超时判死」——没客方时心跳压根不会出现。
  function guestPresent() {
    if (!settled || peerGone) return false;
    if (conn && conn._relay) return !!(peerSid && (Date.now() - lastHb) < HB_MAX);
    return !!(conn && conn.open);
  }

  function startMqttSig(room, role, as) {
    stopMqttSig();
    if (typeof MiniMQTT === 'undefined' || !room) return;

    const topic = 'xq/v1/' + room;
    const dataTopic = topic + '/d';
    const sid = Math.random().toString(36).slice(2, 10);
    const st = {
      mq: null, topic: topic, sid: sid, timers: [],
      offer: null, answer: null, answering: false, accepted: false, done: false,
      lastOffer: null, lastEnsure: 0, ensuring: false, offerTimer: null, ensureOffer: null,
      beaconT: null, watchT: null
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
    // 观战：收到房里任何人的消息即确认房间存在 → 入房
    const watchFound = function () {
      if (st.done || dead) return;
      if (st.watchT) { clearTimeout(st.watchT); st.watchT = null; }
      if (settled) return;
      tr('watch-found');
      relayConnect('watch');
    };

    mq.onopen = function () {
      if (st.done) return;
      tr('mq-open role=' + role);
      mq.subscribe(topic);
      mq.subscribe(dataTopic);
      if (role === 'watch') {
        // 观战：等房主信标（或任何房内消息）确认「房间在开局」，超时放弃
        st.watchT = setTimeout(function () {
          if (st.done || settled || dead) return;
          tr('watch-miss timeout');
          stopMqttSig();
          emit('watch-miss');
        }, WATCH_TIMEOUT);
        return;
      }
      if (beaconWanted) armBeacon();   // 房主（含总线重建后）恢复观战信标
      if (relayWanted && !settled && !awaitRole) { relayWanted = false; relayConnect(autoRole || 'guest'); return; }
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
        // resume=本标签页上局就是这房的客方（刷新重进）：心跳还没超时时房主可能误判
        // 满员，带 resume 就不算满员，落到「缺位问身份」而不是被强制转观战；
        // as='p'：对方已明确选了「以对战方加入」，房主不再弹身份选择
        let resume = false;
        try { resume = sessionStorage.getItem('xqseat') === room; } catch (e) {}
        const knock = function () {
          pub({ k: 'j', sid: st.sid, resume: resume ? 1 : undefined, as: as || undefined });
        };
        knock();
        st.timers.push(setInterval(function () {
          // 中继模式下也继续发：背景打洞靠它触发房主重发 offer / 传应答码
          if (st.done || (settled && !(conn && conn._relay))) return;
          if (st.answer) pub({ k: 'a', sd: st.answer, sid: st.sid });
          else knock();
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
        // 只认对局对方的心跳 sid 来判活：观战者不发心跳，其消息不能顶替对方在线
        if (m && m.k === 'hb') peerSid = m.sid;
        const fromPeer = !peerSid || (m && m.sid === peerSid);
        if (fromPeer) lastHb = Date.now();
        // 对方掉线被判死后，收到对方消息 = 对方已回来：复活自己的心跳（否则对方等不到
        // 我方 hb 也会超时互判掉线），并向上报重连以清理断线状态/弹窗
        if (peerGone && (autoRole === 'watch' || fromPeer)) {
          peerGone = false;
          tr('hb-revive');
          if (autoRole !== 'watch') startHb();
          emit('reconnected', { role: autoRole, peer: 'relay' });
        }
        if (role === 'watch') watchFound();   // 收到房内消息即入房
        if (m && m.mir && autoRole !== 'watch') return;   // 直连镜像只给观战者，对局方丢弃
        if (m && m.k === 'm' && m.d !== undefined) { tr('recv ' + (m.d && m.d.t)); deliver(m.d); }
        return;
      }
      if (t !== topic) return;
      if (!m || m.sid === st.sid) return;
      if (role === 'watch') {
        watchFound();
        // 总线重建后的复活：房主信标也算「对方回来了」（直连房主平时不发心跳）
        if (peerGone && settled) {
          peerGone = false;
          tr('hb-revive-topic');
          emit('reconnected', { role: autoRole, peer: 'relay' });
        }
        return;
      }
      if (m.k === 'j') {
        // 客方敲门 = 总线已就位：房主立刻先中继连上（不等打洞），并回 'hi' 让客方也连上
        if (role === 'host') {
          // 房里已有存活的对战客方 → 回 'full' 让第三方转去观战（老客方带 resume 落到下面）
          if (guestPresent() && !m.resume) {
            tr('knock-full');
            pub({ k: 'full', sid: st.sid });
            return;
          }
          if (inGame && m.as !== 'p') {
            // 对局进行中但缺人：不猜来者是对战方还是观战方，让对方自选身份
            tr('knock-ask');
            pub({ k: 'ask', sid: st.sid });
          } else if (!settled || (conn && conn._relay)) {
            // 房主在线就回 'hi'（含自己处于中继兜底时），让客方不必等周期 offer
            pub({ k: 'hi', sid: st.sid });
          }
          if (!settled) relayConnect('host');
          if (st.ensureOffer) { tr('knock'); st.ensureOffer(); }
        }
        return;
      }
      if (m.k === 'ask') {
        // 对局缺人、房主要求先选身份：停敲门，交给上层弹「加入对战/观战」
        if (role === 'guest' && !settled) {
          tr('room-ask');
          awaitRole = false;
          stopMqttSig();
          emit('room-ask');
        }
        return;
      }
      if (m.k === 'full') {
        // 对局已有双方：停止敲门，交给上层转入观战流程
        if (role === 'guest' && !settled) {
          tr('room-full');
          awaitRole = false;
          stopMqttSig();
          emit('room-full');
        }
        return;
      }
      if (m.k === 'hi') {
        // 房主确认在线（没缺位/已明确要下棋）：此刻才放行 Peer 与 offer，走中继开打
        if (role === 'guest' && !settled) {
          if (awaitRole) { awaitRole = false; startGuestPeer(); }
          relayConnect('guest');
        }
        return;
      }
      if (typeof m.sd !== 'string') return;
      if (awaitRole && role === 'guest') { tr('sd-defer'); return; }   // 等身份期间不碰 offer/answer
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
      if (role === 'watch' && !settled) { stopMqttSig(); emit('watch-miss'); return; }
      if (settled && conn && conn._relay) { clearHb(); peerGone = true; emit('closed'); return; }
      if (!st.done && role === 'host') {
        // 房主掉总线（大厅被踢/对局中直连期断开）：不自愈就永远收不到敲门，
        // 缺位问身份、满员转观战全都无从谈起 → 延迟重建信令
        tr('mq-restart-host settled=' + settled);
        stopMqttSig();
        setTimeout(function () {
          if (!dead && !mqttSig && autoRole === 'host' && lastRoom) startMqttSig(lastRoom, 'host');
        }, 2000);
        return;
      }
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
    watch: watch,
    beacon: beacon,
    send: send,
    destroy: destroy,
    isConnected: isConnected,
    signalingPending: signalingPending,
    resume: resume,
    setInGame: setInGame,
    _trace: _trace
  };
})();
