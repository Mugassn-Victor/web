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
  let lastAs = null;        // 最近加入时的身份标记 'p'（客方总线重建敲门时带上）
  let p2pTimer = null;      // P2P 等待超时 → 降级中继
  let hbTimer = null;       // 中继模式心跳
  let lastHb = 0;
  let peerGone = false;     // 心跳超时判对方掉线后置位；对方消息再到达时复活心跳并报重连
  let lastPunch = 0;        // 中继模式下背景打洞的节流
  let punchDelay = 2500;    // 打洞退避：2.5s→5s→8s 封顶，打通后复位
  let relayWanted = false;
  let beaconWanted = false;  // 房主开局后要广播观战信标
  let peerSid = null;        // 对方的总线 sid（只认它的心跳判活，观战者不算对方）
  let dcSid = null;          // 直连通道对端的总线 sid（帧归属用：bus peerSid 会被第三方心跳拨动）
  let pendingData = [];     // 连接建立前收到的消息，先缓存
  let multiMode = false;     // 房间 ≥3 人：主通道锁总线；同时按需建立两两 mesh 直连（混合网状）
  let openRoom = false;      // 语音房：不设两人上限（敲门永远放行，不回 full/ask）
  let rttEma = 0;            // 链路往返时延：hb 带时间戳、对端回声，EMA 平滑
  /* ===== 多人 mesh（混合网状）：能打通的对走点对点，打不通的对继续走总线 =====
     主通道 conn 在多人房恒为总线 wrap（控制消息全走它广播，保证全员必达）；
     meshConns[sid] 是与单个成员的点对点数据通道，音频帧优先走它。只要还有
     成员没打通（或成员在场表未收齐），音频同时走总线兜底（收端按帧序号去重）。 */
  const meshConns = {};      // sid -> 点对点通道（manual wrap：每对一条 RTCPeerConnection）
  const meshPC = {};         // sid -> {pc, dc?, role:'off'|'ans', oid, t}（mesh 信令在途状态）
  const meshTry =  {};       // sid -> 下次允许发起连接的时间戳（拨号节流 6s）
  const meshLast = {};       // sid -> 最近从该通道收到数据的时间（半开判死用）
  const pids = {};           // sid -> 对端 peerjs id（总线消息捎带学习，拨号用）
  const pidToSid = {};       // 反查：peerjs id -> sid（入站连接认领对端用）
  const peers = {};          // sid -> 最近出现在总线上的时间（成员在场表，9s 过期）
  const MESH_RETRY = 6000;   // mesh 拨号重试间隔
  const mx = { d: 0, mp: 0, mr: 0, ap: 0, ar: 0, ac: 0, er: 0 };   // mesh 信令诊断计数
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
  function emit(evt, data, extra) { if (handlers[evt]) handlers[evt](data, extra); }   // extra=帧归属 sid（仅 frame 用）

  // RTT 采样：对端 hbr 带回我方 hb 的发送时刻（30s 外的陈旧值丢弃），EMA 平滑
  function rttSample(t) {
    const dt = Date.now() - t;
    if (dt > 0 && dt < 30000) rttEma = rttEma ? (rttEma * 0.75 + dt * 0.25) : dt;
  }

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

  /* ===== mesh 成员在场表 + 点对点通道管理 ===== */

  // 成员在场记录：总线任意消息（信令/心跳/控制）都捎带学习 sid 与 peerjs id。
  // 在场表是音频「走不走总线」的判据——还有成员没进表或没打通就必须广播兜底
  function notePeer(sid, pid, now) {
    if (!sid || (mqttSig && sid === mqttSig.sid)) return;
    peers[sid] = now || Date.now();
    if (pid && pids[sid] !== pid) { pids[sid] = pid; pidToSid[pid] = sid; }
  }

  // 是否全员点对点打通（peers 为空视为未知 → 必须走总线）
  function fullMesh() {
    const sids = Object.keys(peers);
    if (!sids.length) return false;
    for (let i = 0; i < sids.length; i++) {
      const c = meshConns[sids[i]];
      if (!c || !c.open) return false;
    }
    return true;
  }

  function openMeshCount() {
    let n = 0;
    const sids = Object.keys(meshConns);
    for (let i = 0; i < sids.length; i++) { const c = meshConns[sids[i]]; if (c && c.open) n++; }
    return n;
  }

  // 入站/出站通道按 sid 认领入册；同对已有通道时按「sid 小的一方发起」收敛
  //（两边用同一判据且互补 → 必然收敛到同一条，杜绝双通道双倍音频）
  function promoteMesh(sid, c) {
    if (!sid || !c) return;
    const old = meshConns[sid];
    if (old && old !== c) {
      if (!old.open) {
        try { old.close(); } catch (e) {}
      } else {
        const my = (mqttSig && mqttSig.sid) || '';
        const keepMine = (my < sid) === !!c._dialed;
        const keepOld = (my < sid) === !!old._dialed;
        if (keepOld && !keepMine) { try { c.close(); } catch (e) {} return; }
        if (!keepOld && !keepMine) { try { old.close(); } catch (e) {} }   // 同向双拨（防御）：留新的
        else if (keepMine) { try { old.close(); } catch (e) {} }
      }
    }
    if (meshConns[sid] === c) return;
    meshConns[sid] = c;
    c._sid = sid;
    tr('mesh-promote ' + sid + ' dialed=' + (c._dialed ? 1 : 0));
  }

  function dropMesh(sid, c) {
    if (sid && meshConns[sid] === c) {
      delete meshConns[sid];
      tr('mesh-drop ' + sid);
    }
    if (sid) { meshLast[sid] = 0; meshTry[sid] = Date.now() + MESH_RETRY; }
  }

  // 把一条点对点通道收编为 mesh：挂数据/生命周期监听、开放即互发心跳认领 sid
  function meshAdopt(c, hintSid, dialed) {
    if (!c || c._relay || c._mesh || dead) return;
    c._mesh = true;
    c._dialed = !!dialed;
    let sid = hintSid || null;
    if (!sid && c.peer && pidToSid[c.peer]) sid = pidToSid[c.peer];
    let fixed = false;
    const attr = function (s) {
      if (!s || (mqttSig && s === mqttSig.sid)) return;
      if (fixed) return;
      if (sid && s !== sid) return;
      sid = s; fixed = true; c._sid = s;
      promoteMesh(s, c);
    };
    c.on('data', function (d) {
      if (dead) return;
      // 二进制帧判断必须在最前：ArrayBuffer/Uint8Array 的 typeof 也是 'object'，
      // 放在对象分支后面会被当成控制消息吞掉（mesh 音频全丢的根因）
      const b = d instanceof Uint8Array ? d : (d instanceof ArrayBuffer ? new Uint8Array(d) : null);
      if (b) {
        if (!c._sid) { mx.fns = (mx.fns | 0) + 1; tr('mesh-frame-nosid'); return; }   // 抢在心跳认领前：丢帧由预缓冲吸收
        mx.frx = (mx.frx | 0) + 1;
        meshLast[sid || c._sid] = Date.now();
        emit('frame', b, c._sid);
        return;
      }
      if (d && typeof d === 'object') {
        if (d.k === 'hb') {
          if (d.sid) attr(d.sid);
          if (sid) meshLast[sid] = Date.now();
          if (d.t) { try { c.send({ k: 'hbr', t: d.t, sid: (mqttSig && mqttSig.sid) || undefined }); } catch (e) {} }
          return;
        }
        if (d.k === 'hbr') {
          if (d.sid) attr(d.sid);
          if (sid) meshLast[sid] = Date.now();
          if (d.t) rttSample(d.t);
          return;
        }
        // 非心跳的控制消息：正常多人房控制走总线广播，这里收到只可能是
        // 「本端已回两人房、对端还停在多人态」的过渡窗口 → 交付，防丢
        if (sid) meshLast[sid] = Date.now();
        deliver(d);
        return;
      }
    });
    c.on('close', function () { dropMesh(c._sid || sid, c); });
    c.on('error', function () { try { c.close(); } catch (e) {} dropMesh(c._sid || sid, c); });
    const kick = function () {
      if (dead) return;
      tr('mesh-open ' + (sid || c.peer || '?') + ' dialed=' + (dialed ? 1 : 0));
      attr(sid || (c.peer && pidToSid[c.peer]) || null);
      if (sid) { meshLast[sid] = Date.now(); meshTry[sid] = 0; }
      try { c.send({ k: 'hb', sid: (mqttSig && mqttSig.sid) || undefined, t: Date.now() }); } catch (e) {}
      meshTryAll();
    };
    if (hintSid) attr(hintSid);   // 手动信令收发双方都确切知道对端 sid：立即认领
    if (c.open) setTimeout(kick, 0);
    else c.on('open', kick);
  }

  // 对每个在场成员发起 mesh 拨号（仅 sid 小的一方发起 offer，防双方对撞；
  // 信令走总线 sig topic 的 to 寻址 —— 本应用无 PeerJS，P2P 全靠手动 SDP 交换）
  function maybeMesh(targetSid) {
    if (!multiMode || dead || autoRole === 'watch') return;
    if (!targetSid || (mqttSig && targetSid === mqttSig.sid)) return;
    if (meshConns[targetSid] && meshConns[targetSid].open) return;
    if (meshPC[targetSid]) return;                // 信令在途：等开通道，超时由 sweepMesh 清理
    const now = Date.now();
    if (meshTry[targetSid] && now < meshTry[targetSid]) return;
    if (!(mqttSig && mqttSig.sid < targetSid)) return;
    if (!mqttSig || !mqttSig.mq || !mqttSig.mq._opened) return;
    meshTry[targetSid] = now + MESH_RETRY;
    mx.d++;
    tr('mesh-dial ' + targetSid);
    meshDial(targetSid);
  }

  function meshTryAll() {
    if (!multiMode || dead) return;
    const sids = Object.keys(peers);
    for (let i = 0; i < sids.length; i++) maybeMesh(sids[i]);
  }

  // 半开/静默死链判死：超过 HB_MAX 没动静 → 关掉回退总线（下一帧自动恢复广播）
  function sweepMesh() {
    const now = Date.now();
    const sids = Object.keys(peers);
    for (let i = 0; i < sids.length; i++) if (now - peers[sids[i]] > 9000) delete peers[sids[i]];
    const ms = Object.keys(meshConns);
    for (let i = 0; i < ms.length; i++) {
      const s = ms[i], c = meshConns[s];
      if (!c) continue;
      if (meshLast[s] && now - meshLast[s] > HB_MAX) {
        tr('mesh-timeout ' + s);
        try { c.close(); } catch (e) {}
        dropMesh(s, c);
      }
    }
    // 信令挂起超时（答案丢失 / 通道未开且 ICE 静默停在 new）：连同已收编的
    // 未打开通道一并清理，否则 meshPC/meshConns 互相死锁、永不再拨
    const ps = Object.keys(meshPC);
    for (let i = 0; i < ps.length; i++) {
      const s = ps[i], e = meshPC[s];
      const mc = meshConns[s];
      if (e && !(mc && mc.open) && now - e.t > 15000) {
        tr('mesh-pc-timeout ' + s);
        if (mc) { try { mc.close(); } catch (er) {} dropMesh(s, mc); }
        try { if (e.dc) e.dc.close(); } catch (er) {}
        try { if (e.pc) e.pc.close(); } catch (er) {}
        delete meshPC[s];
        meshTry[s] = now + MESH_RETRY;
      }
    }
  }

  function closeAllMesh() {
    const ms = Object.keys(meshConns);
    for (let i = 0; i < ms.length; i++) {
      const c = meshConns[ms[i]];
      try { if (c) c.close(); } catch (e) {}
      delete meshConns[ms[i]];
      meshLast[ms[i]] = 0;
    }
    const ps = Object.keys(meshPC);
    for (let i = 0; i < ps.length; i++) {
      const e = meshPC[ps[i]];
      try { if (e && e.dc) e.dc.close(); } catch (er) {}
      try { if (e && e.pc) e.pc.close(); } catch (er) {}
      delete meshPC[ps[i]];
    }
  }

  /* ---- mesh 手动信令：SDP 经 sig topic 以 to:sid 寻址交换（每对一条 RTCPeerConnection） ---- */

  function sigPub(o) {
    if (!mqttSig || !mqttSig.mq || !mqttSig.mq._opened) return;
    try { mqttSig.mq.publish(mqttSig.topic, JSON.stringify(o)); } catch (e) {}
  }

  function watchMeshIce(sid, pc) {
    if (!pc || !pc.addEventListener) return;
    pc.addEventListener('iceconnectionstatechange', function () {
      const s = pc.iceConnectionState;
      if (s !== 'failed') return;   // disconnected 常为暂态：留给 mesh 心跳判死
      tr('mesh-ice-fail ' + sid);
      const ent = meshPC[sid];
      if (ent && ent.pc === pc) { delete meshPC[sid]; meshTry[sid] = Date.now() + MESH_RETRY; }
      try { pc.close(); } catch (e) {}
      dropMesh(sid, meshConns[sid]);
    });
  }

  // 发起方：独立 PC + DC，offer 打包发给目标 sid（只有自己被 accept 后通道才开）
  function meshDial(targetSid) {
    const pc = new RTCPeerConnection({ iceServers: ICE });
    const dc = pc.createDataChannel('xq', { ordered: true });
    dc.binaryType = 'arraybuffer';
    const oid = Math.random().toString(36).slice(2, 8);
    const ent = { pc: pc, dc: dc, role: 'off', oid: oid, t: Date.now() };
    meshPC[targetSid] = ent;
    watchMeshIce(targetSid, pc);
    const fail = function (e) {
      tr('mesh-dial-err ' + e);
      mx.er++;
      if (meshPC[targetSid] === ent) delete meshPC[targetSid];
      try { dc.close(); } catch (er) {}
      try { pc.close(); } catch (er) {}
      meshTry[targetSid] = Date.now() + MESH_RETRY;
      dropMesh(targetSid, meshConns[targetSid]);
    };
    pc.createOffer()
      .then(function (o) { return pc.setLocalDescription(o); })
      .then(function () { return waitGathering(pc, 1500); })
      .then(function () {
        if (meshPC[targetSid] !== ent || !pc.localDescription) return;
        const w = mkManualWrap(dc, pc, 'host');
        meshAdopt(w, targetSid, true);   // 先挂监听等 open（answer 应用 + ICE + DTLS 后触发）
        sigPub({ k: 'mo', to: targetSid, sid: mqttSig.sid, oid: oid,
                 sd: enc({ t: pc.localDescription.type, s: pc.localDescription.sdp }) });
        mx.mp++;
        tr('mesh-mo-pub ' + targetSid);
      })
      .catch(fail);
  }

  // 收 offer（应答方）/ 收 answer（发起方）。to 寻址 + sid 对比防对撞：
  // 只有「sid 较小方发出的 offer」被受理，与本端在途的反向拨号必然收敛到同一条
  function onMeshSdp(m) {
    if (!multiMode || dead || autoRole === 'watch') return;
    if (!m || m.to !== (mqttSig && mqttSig.sid) || !m.sid) return;
    const fromSid = m.sid;
    if (m.k === 'mo') {
      mx.mr++;
      if (mqttSig.sid < fromSid) { tr('mesh-mo-ignore ' + fromSid); return; }   // 本端才是发起方
      const ex = meshPC[fromSid];
      if (ex) {
        try { if (ex.dc) ex.dc.close(); } catch (er) {}
        try { if (ex.pc) ex.pc.close(); } catch (er) {}
        delete meshPC[fromSid];
      }
      let d; try { d = dec(m.sd); } catch (e) { tr('mesh-mo-bad'); return; }
      if (!d.s || d.s.indexOf('m=application') < 0) return;
      const pc = new RTCPeerConnection({ iceServers: ICE });
      const ent = { pc: pc, role: 'ans', oid: m.oid || null, t: Date.now() };
      meshPC[fromSid] = ent;
      watchMeshIce(fromSid, pc);
      pc.ondatachannel = function (e) {
        tr('mesh-dc-in ' + fromSid);
        const w = mkManualWrap(e.channel, pc, 'guest');
        meshAdopt(w, fromSid, false);
      };
      pc.setRemoteDescription({ type: d.t, sdp: d.s })
        .then(function () { return pc.createAnswer(); })
        .then(function (a) { return pc.setLocalDescription(a); })
        .then(function () { return waitGathering(pc, 1000); })
        .then(function () {
          if (meshPC[fromSid] !== ent || !pc.localDescription) return;
          sigPub({ k: 'ma', to: fromSid, sid: mqttSig.sid, oid: ent.oid,
                   sd: enc({ t: pc.localDescription.type, s: pc.localDescription.sdp }) });
          mx.ap++;
          tr('mesh-ma-pub ' + fromSid);
        })
        .catch(function (e) {
          tr('mesh-ma-err ' + e);
          mx.er++;
          if (meshPC[fromSid] === ent) delete meshPC[fromSid];
          try { pc.close(); } catch (er) {}
        });
      return;
    }
    if (m.k === 'ma') {
      mx.ar++;
      const ent = meshPC[fromSid];
      if (!ent || ent.role !== 'off') { tr('mesh-ma-nopair'); return; }
      if (m.oid && ent.oid && m.oid !== ent.oid) { tr('mesh-ma-stale'); return; }
      if (ent.answering) return;
      ent.answering = true;
      let d; try { d = dec(m.sd); } catch (e) { ent.answering = false; return; }
      ent.pc.setRemoteDescription({ type: d.t, sdp: d.s })
        .then(function () { mx.ac++; tr('mesh-acc ' + fromSid); })
        .catch(function (e) { ent.answering = false; mx.er++; tr('mesh-acc-err ' + e); });
    }
  }

  // 第一条可用传输获胜：P2P 打开即用；中继模式下后打通的 P2P 可无缝升级
  function fireConnected(c, role) {
    if (dead) return;
    if (multiMode && c && !c._relay) {
      // 多人房：迟到/过渡的直连通道不当主通道（主通道恒为总线 wrap），
      // 转收编为与该成员的 mesh 点对点链路——音频帧的低延迟通路
      if (c._mesh) return;
      meshAdopt(c, null, false);
      return;
    }
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
        if (autoRole !== 'watch') startHb();   // 直连也要测活，半开才判得出来
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
    if (autoRole !== 'watch') startHb();   // 直连也要测活，半开才判得出来
    tr('fire-first role=' + role + ' relay=' + !!(c && c._relay));
    emit('connected', { role: role, peer: (c && c.peer) || 'p2p' });
    flush();
  }

  function setupConn(c, role) {
    // 多人房里的点对点通道（入站或过渡窗口建立）→ 直接收编为 mesh，不进主通道竞选
    if (multiMode && c && !c._relay && !c._mesh) { meshAdopt(c, null, false); return; }
    // 监听必须先挂上（含接管场景）：对方刷新重连时旧连接已死，新连接会被 fireConnected
    // 接管成 conn，若此时没挂 data 监听，接管后就永远收不到对方消息（c===conn 守卫无处生效）
    c.on('data', function (d) {
      if (c !== conn) return;
      // 直连心跳/来包 = 对方活着：刷新判活计时；判死后收到即复活上报重连
      const isHb = !!(d && typeof d === 'object' && d.k === 'hb');
      if (isHb && d.sid) { peerSid = d.sid; dcSid = d.sid; }
      if (!isHb) tr('recv-d');
      lastHb = Date.now();
      if (peerGone) {
        peerGone = false;
        tr('hb-revive-p2p');
        startHb();
        emit('reconnected', { role: autoRole, peer: 'p2p' });
      }
      if (d instanceof ArrayBuffer || d instanceof Uint8Array) {   // 二进制音频帧
        emit('frame', d instanceof Uint8Array ? d : new Uint8Array(d), dcSid || undefined);
        return;
      }
      if (isHb) {
        // 带时间戳的心跳 → 立即回声（直连 RTT 探针；带 sid 供对端认领帧归属）
        if (d.t) { try { c.send({ k: 'hbr', t: d.t, sid: (mqttSig && mqttSig.sid) || undefined }); } catch (e) {} }
        return;
      }
      if (d && d.k === 'hbr') { if (d.t) rttSample(d.t); return; }
      deliver(d);
    });
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
      if (o instanceof Uint8Array) {
        // 二进制音频帧：[0xBF][sidLen][sid ascii][0xBE 帧...]（JSON 装字节要再 base64，白烧 33%）
        tr('sendB');
        const sid = mqttSig.sid;
        const env = new Uint8Array(2 + sid.length + o.length);
        env[0] = 0xbf; env[1] = sid.length;
        for (let i = 0; i < sid.length; i++) env[2 + i] = sid.charCodeAt(i) & 0xff;
        env.set(o, 2 + sid.length);
        mqttSig.mq.publish(mqttSig.topic + '/d', env);
        return true;
      }
      tr('send ' + (o && o.t));
      // 带上自己的 sid：broker 会把消息回给发布者本人，收端靠 sid 过滤掉自己发的
      // pid 捎带自己的 peerjs id：mesh 拨号要按 sid→pid 认目标（收端 notePeer 学习）
      // mir=1 是直连模式的镜像副本：只给观战者收听，对局方收到会丢弃（他们已从直连拿到）
      const pkt = { k: 'm', d: o, sid: mqttSig.sid, pid: (peer && peer.id) || undefined };
      if (mir) pkt.mir = 1;
      mqttSig.mq.publish(mqttSig.topic + '/d', JSON.stringify(pkt));
      return true;
    } catch (e) { tr('send-err ' + e); return false; }
  }

  function sendHb() {
    const t = Date.now();
    // mesh 点对点通道逐条测活（半开通道不触发事件，只有回音判得出死活）
    const ms = Object.keys(meshConns);
    for (let i = 0; i < ms.length; i++) {
      const mc = meshConns[ms[i]];
      if (mc && mc.open) {
        try { mc.send({ k: 'hb', sid: (mqttSig && mqttSig.sid) || undefined, t: t }); } catch (e) {}
      }
    }
    if (!conn) return;
    if (conn._relay) {
      if (busReady()) {
        try { mqttSig.mq.publish(mqttSig.topic + '/d', JSON.stringify({ k: 'hb', sid: mqttSig.sid, t: t, pid: (peer && peer.id) || undefined })); tr('hb-s'); } catch (e) {}
      }
    } else if (conn.open) {
      // 直连也要测活：半开通道不会触发任何事件，收不到回音只有靠它判死
      try { conn.send({ k: 'hb', sid: (mqttSig && mqttSig.sid) || undefined, t: t }); tr('hb-p'); } catch (e) {}
    } else if (busReady()) {
      // 直连已不可用但总线还在：心跳改走总线，对方一收到就会把双方切回中继
      try { mqttSig.mq.publish(mqttSig.topic + '/d', JSON.stringify({ k: 'hb', sid: mqttSig.sid, t: t, pid: (peer && peer.id) || undefined })); tr('hb-b'); } catch (e) {}
    }
  }

  function startHb() {
    lastHb = Date.now();
    if (hbTimer) return;
    sendHb();                             // 立即打一发：链路刚建立就拿到首个 RTT 样本（延迟显示不用等 3s）
    hbTimer = setInterval(function () {
      if (!settled || !conn || autoRole === 'watch') { clearHb(); return; }
      sendHb();
      if (multiMode) { sweepMesh(); meshTryAll(); }   // mesh：过期清理 + 未打通的按节流重试
      // 背景慢慢打洞：中继模式下房主周期性重发 offer，打通即自动升级直连。
      // 指数退避 2.5s→5s→8s 封顶（首轮从 5s 提前到 2.5s，收敛更快），打通后复位。
      // 多人房不打洞（全员锁中继），回到两人房才恢复
      if (autoRole === 'host' && !multiMode && !hostHealthy() && mqttSig && mqttSig.ensureOffer &&
          Date.now() - lastPunch >= punchDelay) {
        lastPunch = Date.now();
        punchDelay = Math.min(8000, punchDelay * 2);
        tr('bg-punch d=' + punchDelay);
        mqttSig.ensureOffer();
      } else if (autoRole === 'host' && hostHealthy() && punchDelay !== 2500) {
        punchDelay = 2500;   // 已打通：下次降级从 2.5s 快速重新收敛
      }
      if (Date.now() - lastHb > HB_MAX) {
        clearHb();
        // 已经判死过就不再重复上报（resume 会重启心跳，重复 emit 会让弹窗反复弹出）
        if (!peerGone) {
          peerGone = true;
          tr('hb-timeout age=' + (Date.now() - lastHb));
          emit('closed');
        }
      }
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
    peer.on('open', function (myId) {
      emit('open', myId);
      // 多人房重建 Peer 后立刻发心跳捎带自己的 peerjs id，让对端尽快学到拨号目标
      if (multiMode) sendHb();
    });
    peer.on('error', function (e) { emit('error', e); });
    peer.on('disconnected', function () {
      try { peer.reconnect(); } catch (e) {}
    });
    // 入站连接统一入口：两人房进主通道竞选；多人房在 setupConn 里收编为 mesh
    peer.on('connection', function (c) { setupConn(c, autoRole || 'guest'); });
    return peer;
  }

  // 建房：id 为自定义房间号
  function create(roomId) {
    dead = false;
    settled = false;
    autoRole = 'host';
    awaitRole = false;
    inGame = false;   // 新建的是空房：清掉上一局残留，否则敲门者会被误问「缺位身份」
    multiMode = false;
    lastRoom = roomId;
    lastAs = null;
    peerSid = null;
    dcSid = null;
    pendingData = [];
    closeAllMesh();
    startMqttSig(roomId, 'host');
    if (typeof Peer === 'undefined') return;
    newPeer(roomId);   // 入站连接监听挂在 newPeer 里（与客方统一）
  }

  // 加房；asPlayer=true 表示对方已明确选择「以对战方加入」
  function join(roomId, asPlayer) {
    dead = false;
    settled = false;
    autoRole = 'guest';
    multiMode = false;
    lastRoom = roomId;
    lastAs = asPlayer ? 'p' : null;
    peerSid = null;
    dcSid = null;
    pendingData = [];
    closeAllMesh();
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
    lastAs = null;
    peerSid = null;
    pendingData = [];
    closeAllMesh();
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
    // 多人房音频帧：优先走各成员的 mesh 点对点通道（低延迟、不烧 broker）；
    // 只要还有成员没打通（或在场表没收齐）就同时走总线广播兜底（收端按帧序号去重）
    if (multiMode && obj instanceof Uint8Array) {
      let sent = false;
      const sids = Object.keys(meshConns);
      for (let i = 0; i < sids.length; i++) {
        const mc = meshConns[sids[i]];
        if (mc && mc.open) { try { mc.send(obj); sent = true; } catch (e) {} }
      }
      if (sent && fullMesh()) return true;
      if (busReady()) return busSend(obj, false) || sent;
      return sent;
    }
    if (conn && conn.open) {
      if (conn._relay) return conn.send(obj);   // 中继/观战：走总线，天然广播给观战者
      if (obj && obj.t) tr('send ' + obj.t);    // 直连控制消息入 trace（心跳/二进制帧不记）
      let ok = false;
      try { conn.send(obj); ok = true; } catch (e) {}
      if (ok) {
        // 语音App没有观战者：不镜像到总线（音频帧约 10 帧/秒，镜像会白烧 broker 流量）
        return true;
      }
      // 直连抛错 → 总线兜底投递（不带镜像标记：这条就是真正的投递）
      if (busReady()) return busSend(obj, false);
      return false;
    }
    // 直连半开/已关但总线还在：不兜底的话消息会静默丢失，对方永远收不到
    if (busReady()) return busSend(obj, false);
    return false;
  }

  function destroy() {
    dead = true;
    beaconWanted = false;
    awaitRole = false;
    multiMode = false;
    stopMqttSig();
    clearP2pTimer();
    clearHb();
    pendingData = [];
    closeAllMesh();
    for (const k in peers) delete peers[k];
    for (const k in pids) delete pids[k];
    for (const k in pidToSid) delete pidToSid[k];
    for (const k in meshTry) delete meshTry[k];
    const c = conn;
    conn = null;
    settled = false;
    peerSid = null;
    dcSid = null;
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
    // 中继判死时本地心跳已被清掉：不重启就只能干等对方先发，双方都判死
    // 会互相等死（哪怕总线早已恢复也永远停在「对方掉线」）→ 重连轮询里把
    // 心跳拉起，对方一收到即可互相复活并上报重连
    //
    // 直连已死/半开（长时间掉线后 close 事件迟迟不来）：总线明明可用却守着
    // 一条走不出去的通道，心跳与回包全部黑洞 → 传输切回中继并按判死处理，
    // 收到对方消息即复活上报重连；客方补敲门、房主重发 offer 叫醒还在旧
    // 直连里干等的对方
    if (settled && autoRole !== 'watch' && busReady() &&
        (!conn || !conn.open || (peerGone && !conn._relay))) {
      const old = conn;
      conn = makeRelayWrap();
      tr('resume-relay');
      emit('relay');
      try { if (old && old.close) old.close(); } catch (e) {}
      peerGone = true;
      startHb();
      if (mqttSig && !mqttSig.done) {
        if (mqttSig.knock) mqttSig.knock();
        else if (mqttSig.ensureOffer) mqttSig.ensureOffer();
      }
    } else if (settled && conn && conn._relay && autoRole !== 'watch') {
      startHb();
    }
    if (autoRole === 'guest' && peer && lastRoom) {
      try {
        const c = peer.connect(lastRoom, { reliable: true });
        setupConn(c, 'guest');
      } catch (e) {}
    }
  }

  /* ===== 备用信令：公共 MQTT broker（WebSocket 直连，无需注册/自建服务器） ===== */
  // BROKERS：mqttmini 连接失败时的轮询顺序（连通性兜底）。
  // PRIMARY_GROUPS：主力组——上层按房间号哈希在「组间」轮转定序、组内按列表顺序
  // 连接，不在任何组里的条目恒排末尾。换生产 broker 只改这两个列表（上层选路
  // 不再关心主机名）：主力放组内，限速/不稳定的放组外垫底。

  let BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081/mqtt',
    'wss://test.mosquitto.org:8081/'
  ];
  const PRIMARY_GROUPS = [
    ['wss://test.mosquitto.org:8081/mqtt', 'wss://test.mosquitto.org:8081/'],
    ['wss://broker.hivemq.com:8884/mqtt']
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

  // 多人房开关（由语音层按 vc-pres 人数调用）：
  // 开 → 主通道降回总线（控制消息全员广播）+ 按需建立两两 mesh 直连（音频帧低延迟通路）
  // 关 → 回到两人房：关掉全部 mesh 通道，房主重新发 offer，直连按原有流程升级回来
  function setMulti(on) {
    on = !!on;
    if (on === multiMode) return;
    multiMode = on;
    tr('multi=' + (on ? 1 : 0));
    if (on) {
      if (settled && conn && !conn._relay && busReady()) {
        const old = conn;
        conn = makeRelayWrap();
        emit('relay');
        try { old.close(); } catch (e) {}
        peerGone = false;
        startHb();
      }
      sendHb();      // 顺带触发一轮 mesh 心跳
      meshTryAll();  // 在场表里已知的成员立即开拨（6s 节流兜底重试）
    } else {
      closeAllMesh();   // 回两人房：mesh 通道全部关闭，走原有两人直连升级流程
      if (autoRole === 'host' && settled && mqttSig && mqttSig.ensureOffer) mqttSig.ensureOffer();
    }
  }

  // 房里是否已有存活的对战客方（第三方敲门要被引导去观战）。
  // 直连看数据通道；中继不能看 conn.open（host 一敲门就 settled，open 只是自家总线
  // 在线），要看「已收到过对方心跳且没超时判死」——没客方时心跳压根不会出现。
  function guestPresent() {
    if (!settled || peerGone) return false;
    if (conn && conn._relay) return !!(peerSid && (Date.now() - lastHb) < HB_MAX);
    return !!(conn && conn.open);
  }

  let dlvN = 0, dAllN = 0, dOwnN = 0, sigN = 0, badN = 0;   // 诊断计数

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
    // offer/answer 配对：每轮 offer 带唯一 oid，应答回显它。房主只认当前轮的应答——
    // 否则上一轮的陈旧应答会被 setRemote 到新 PC 上，ICE/DTLS 永远起不来，ensure 每
    // 4s 重建一次形成 conn-close 循环（P2P 卡死不升级的根因）
    const mkOid = function () { return Math.random().toString(36).slice(2, 8); };
    const publishOffer = function () {
      // 中继模式下也继续发布：供背景打洞的 offer/answer 交换用（多人房除外：全员锁中继）
      if (multiMode) return;
      if (st.offer && !st.done && (!settled || (conn && conn._relay))) pub({ k: 'o', sd: st.offer, sid: st.sid, oid: st.lastOid });
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
          st.lastOid = mkOid();
          publishOffer();
        }).catch(function () { st.ensuring = false; });
        // 信令周期 3s（原 1s）：首轮 offer/敲门都是即时发的、应答也是事件驱动，
        // 周期只负责丢包重试/重连兜底；通话中信标+应答+offer 叠加音频 ~10/s ≈ 11/s，
        // 压到 mosquitto ~15/s 限速以下（1s 周期时拨号瞬间 ~16/s，中继送达 ~94%）
        st.timers.push(setInterval(publishOffer, 3000));

        // 兜底重连：对方刷新页面后重进会先「敲门」，此时房主若在中继/掉线状态
        // （对方早已收不到周期 offer），要重新生成 offer、放开应答闸，让对方接回
        st.ensureOffer = function () {
          if (st.done || dead) { tr('ensure-skip done'); return; }
          if (multiMode) { tr('ensure-skip multi'); return; }
          if (!st.mq || !st.mq._opened) { tr('ensure-skip nobus'); return; }
          if (hostHealthy()) { tr('ensure-skip healthy'); return; }
          if (!settled && (st.offer || st.ensuring)) { tr('ensure-skip inflight'); return; }
          const now = Date.now();
          // 通道已打开 = 真健康；否则握手 4s 内（new/checking/connected 起步阶段）不打断，
          // 超 4s 还没通（ICE 卡 checking、或 ICE 连上但 DTLS/通道死活不开）→ 放行重建重试
          if (mpc && mdc && mdc.readyState === 'open') { tr('ensure-skip dc-open'); return; }
          if (mpc && now - mpcSince < 4000) {
            tr('ensure-skip mpc=' + mpc.iceConnectionState); return;
          }
          if (st.ensuring || now - st.lastEnsure < 2500) { tr('ensure-skip throttle'); return; }
          tr('ensure-run');
          st.lastEnsure = now;
          st.ensuring = true;
          manualOffer().then(function (code) {
            st.ensuring = false;
            if (st.done || dead || mqttSig !== st) return;
            st.offer = code;
            st.lastOid = mkOid();
            st.accepted = false;                           // 放开应答闸：接受新一轮 answer
            pub({ k: 'o', sd: code, sid: st.sid, oid: st.lastOid });
            if (!st.offerTimer) {
              st.offerTimer = setInterval(function () {
                if (st.done || hostHealthy()) {
                  clearInterval(st.offerTimer); st.offerTimer = null; return;
                }
                if (st.offer) pub({ k: 'o', sd: st.offer, sid: st.sid, oid: st.lastOid });
              }, 3000);
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
        st.knock = knock;   // 重连轮询切换传输后要靠它重新叫门
        knock();
        st.timers.push(setInterval(function () {
          // 中继模式下也继续发：背景打洞靠它触发房主重发 offer / 传应答码
          if (st.done || (settled && !(conn && conn._relay))) return;
          if (st.answer) pub({ k: 'a', sd: st.answer, sid: st.sid, oid: st.answerOid });
          else knock();
        }, 3000));   // 与房主 offer 同步降频（见 publishOffer 处注释）
      }
    };

    mq.onmessage = function (t, payload) {
      if (st.done || dead) { if (t === dataTopic) tr('dt-drop ' + (dead ? 'dead' : 'done')); return; }
      if (payload instanceof Uint8Array) {          // 二进制音频中继包 [0xBF][sidLen][sid][帧]
        if (t !== dataTopic) return;
        dAllN++;
        if (payload.length < 4 || payload[0] !== 0xbf) { badN++; return; }
        const sl = payload[1];
        let sid = '';
        for (let i = 0; i < sl; i++) sid += String.fromCharCode(payload[2 + i]);
        notePeer(sid);                              // 帧即人证：收帧即知该成员在场
        if (sid === st.sid) { dOwnN++; return; }    // broker 回给发布者本人的回声
        const fromPeerF = !peerSid || sid === peerSid;
        if (fromPeerF) lastHb = Date.now();         // 收到对方音频帧 = 对方活着
        if (peerGone && autoRole !== 'watch' && fromPeerF) {
          peerGone = false;
          tr('hb-revive');
          startHb();
          emit('reconnected', { role: autoRole, peer: 'relay' });
        }
        const frame = payload.subarray(2 + sl);
        if (frame.length < 9 || frame[0] !== 0xbe) { badN++; return; }
        dlvN++;
        emit('frame', frame, sid);
        return;
      }
      let m;
      try { m = JSON.parse(payload); } catch (e) { badN++; return; }
      if (m && m.sid) notePeer(m.sid, m.pid);   // 信令/心跳/控制任一消息都学习在场 + peerjs id
      if (t === dataTopic) {
        dAllN++;
        // 消息中继通道：心跳 + 对局消息（先滤掉自己发出去的回声，否则 lastHb 永远新鲜、
        // 自己的 undo-ok/restart-ok 会被自己再执行一遍）
        if (m && m.k === 'hb') tr(m.sid === st.sid ? 'hb-own' : 'hb-r');
        if (m && m.sid === st.sid) { dOwnN++; return; }
        if (m && m.k === 'hbr') { if (m.t) rttSample(m.t); return; }
        if (m && m.k === 'hb') {
          peerSid = m.sid;
          // 带时间戳的心跳 → 立即回声（中继 RTT 探针；多房全员回，采样者按 t 认领）
          if (m.t) { try { mq.publish(dataTopic, JSON.stringify({ k: 'hbr', sid: st.sid, t: m.t, pid: (peer && peer.id) || undefined })); } catch (e) {} }
        }
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
        // 对方只在走总线时才发总线心跳：收到它 = 对方已放弃直连（多半直连已死）
        // → 自己也切回总线，否则对方后续的回包走的是自己听不见的通道。
        // 必须只认心跳：直连下 send() 会镜像一份对局消息到总线，对方发来的
        // 镜像/sync 包不是「放弃直连」的信号，误切会让刚打通的直连立刻塌回中继
        if (fromPeer && m && m.k === 'hb' && settled && autoRole !== 'watch' && conn && !conn._relay && busReady()) {
          const old = conn;
          conn = makeRelayWrap();
          tr('demote-relay');
          emit('relay');
          try { old.close(); } catch (e) {}
          startHb();
        }
        if (role === 'watch') watchFound();   // 收到房内消息即入房
        // 直连镜像：观战者靠它收听；对局方仅当自己的直连还健康时才丢弃
        // （自己走中继/直连已死/已判死时，正本可能根本没送到 → 镜像成了唯一副本）
        if (m && m.mir && autoRole !== 'watch' &&
            conn && !conn._relay && conn.open && !peerGone) return;
        if (m && m.k === 'm' && m.d !== undefined) { dlvN++; tr('recv ' + (m.d && m.d.t)); deliver(m.d); }
        return;
      }
      if (t !== topic) return;
      sigN++;
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
      if (m.k === 'mo' || m.k === 'ma') { onMeshSdp(m); return; }   // 多人 mesh 的 SDP 交换（to 寻址）
      if (m.k === 'j') {
        // 客方敲门 = 总线已就位：房主立刻先中继连上（不等打洞），并回 'hi' 让客方也连上
        if (role === 'host') {
          // 房里已有存活的对战客方 → 回 'full' 让第三方转去观战（老客方带 resume 落到下面）。
          // openRoom（语音房）不设两人上限：多人房靠 vc-pres 组织，敲门一律放行
          if (!openRoom && guestPresent() && !m.resume) {
            tr('knock-full');
            pub({ k: 'full', sid: st.sid });
            return;
          }
          // 客方带 resume 敲门 = 它断线后重进：自己多半还停在（半开的）旧直连上，
          // 不先切回总线，'hi' 发不出去、回包也全掉进死通道 → 对方只能干等超时
          if (m.resume && settled && conn && conn.open && !conn._relay) {
            const old = conn;
            conn = makeRelayWrap();
            tr('knock-relay');
            emit('relay');
            try { old.close(); } catch (e) {}
            startHb();
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
      if (role === 'host' && m.k === 'a') {
        // 陈旧应答配对闸：只认当前轮 offer 的应答（oid 缺失=旧版，放行保兼容）
        if (m.oid && st.lastOid && m.oid !== st.lastOid) { tr('ans-drop stale'); return; }
        if (!st.accepted) {
          tr('ans-recv');
          st.accepted = true;
          manualAccept(m.sd).then(function () { tr('accept-ok'); startP2pTimer('host'); })
            .catch(function (e) {
              // 应答已应用过（stable 上再 setRemote）→ 视为已接受，别让重复应答反复重试
              if (e && String(e).indexOf('wrong state: stable') >= 0) st.accepted = true;
              else st.accepted = false;
              tr('accept-err ' + e);
            });
        }
      } else if (role === 'guest' && m.k === 'o') {
        // 多人房不接 offer（全员锁中继，只有两人房才打洞升级）
        if (multiMode) { tr('offer-skip multi'); return; }
        // 先中继连上（'hi' 丢失时的兜底），打洞照常在背景走
        if (!settled) relayConnect('guest');
        // 直连健康 → 不再理会 offer；同一份 offer 只应答一次；
        // 房主重发新 offer（对方刷新重进后的兜底重连）→ 重新应答
        if (settled && conn && conn.open && !conn._relay) { tr('offer-drop healthy'); return; }
        if (st.answering) { tr('offer-drop answering'); return; }
        if (st.answer && st.lastOffer === m.sd) { tr('offer-drop same'); return; }
        tr('offer-recv');
        st.lastOffer = m.sd;
        st.answerOid = m.oid || null;      // 回显当前 offer 的配对 id，供房主过滤陈旧应答
        st.answering = true;
        manualAnswer(m.sd).then(function (code) {
          st.answering = false;
          st.answer = code;
          startP2pTimer('guest');
          tr('ans-pub');
          pub({ k: 'a', sd: code, sid: st.sid, oid: st.answerOid });
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
      if (!st.done) {
        // 客方掉总线（首连全败/加入中断/已入局的直连态）：只停不建会永远卡在
        // 加入倒计时里，直连态下不重建则之后一旦直连也死就再无兜底通道 →
        // 与房主对称延迟重建信令（身份标记一并带上，敲门才不会被误判成观战）
        tr('mq-restart-guest settled=' + settled);
        stopMqttSig();
        setTimeout(function () {
          if (!dead && !mqttSig && autoRole === 'guest' && lastRoom) {
            startMqttSig(lastRoom, 'guest', lastAs);
          }
        }, 2000);
      }
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
  let mpcSince = 0; // mpc 建立时间：4s 内算正常握手，超时才允许重建（防卡死）

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
      // 收集不完也带着已有候选先走：语音要把 P2P 升级从 ~8s 压到 ~2-3s，
      // 静网/同机场景 host 候选几十毫秒就齐，STUN/TURN 不通时不再空等
      setTimeout(finish, ms || 1500);
    });
  }

  function mkManualWrap(dc, pc, role) {
    dc.binaryType = 'arraybuffer';   // 二进制音频帧以 ArrayBuffer 落地（默认 Blob 异步不可用）
    return {
      peer: 'manual-' + role,
      _pc: pc,
      get open() { return dc.readyState === 'open'; },
      send: function (o) {
        if (dc.readyState !== 'open') return;
        dc.send(o instanceof Uint8Array ? o : JSON.stringify(o));
      },
      close: function () { try { dc.close(); } catch (e) {} },
      on: function (evt, fn) {
        if (evt === 'data') {
          dc.addEventListener('message', function (e) {
            if (typeof e.data !== 'string') { fn(e.data); return; }   // 二进制帧直通
            try { fn(JSON.parse(e.data)); } catch (err) { fn(e.data); }
          });
        } else {
          dc.addEventListener(evt, fn);
        }
      }
    };
  }

  function attachManual(dc, role) {
    const wrap = mkManualWrap(dc, mpc, role);
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
    mpcSince = Date.now();
    watchIce(mpc);
    mdc = mpc.createDataChannel('xq', { ordered: true });
    mdc.binaryType = 'arraybuffer';
    return mpc.createOffer()
      .then(function (o) { return mpc.setLocalDescription(o); })
      .then(function () { return waitGathering(mpc, 1500); })
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
    mpcSince = Date.now();
    watchIce(mpc);
    mpc.ondatachannel = function (e) {
      mdc = e.channel;
      mdc.binaryType = 'arraybuffer';
      attachManual(mdc, 'guest');
    };
    return mpc.setRemoteDescription({ type: d.t, sdp: d.s })
      .then(function () { return mpc.createAnswer(); })
      .then(function (a) { return mpc.setLocalDescription(a); })
      .then(function () { return waitGathering(mpc, 1000); })
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
    // 多人房/语音房钩子 + 本端总线 sid（vc-pres/加密信封都靠它标身份）
    mySid: function () { return mqttSig ? mqttSig.sid : null; },
    setMulti: setMulti,
    setOpenRoom: function (b) { openRoom = !!b; },
    // broker 选路：上层按房间号哈希从 PRIMARY_GROUPS 推导确定性顺序（两端一致）
    brokerList: function () { return BROKERS.slice(); },
    brokerPrimaryGroups: function () {
      return PRIMARY_GROUPS.map(function (g) { return g.slice(); });
    },
    setBrokerOrder: function (arr) {
      if (!arr || !arr.length) return;
      const keep = BROKERS.filter(function (u) { return arr.indexOf(u) < 0; });
      BROKERS = arr.concat(keep);
    },
    // 测试钩子：E2E 读取传输状态（直连/中继/总线/判死）
    debugState: function () {
      return {
        settled: settled,
        relay: !!(conn && conn._relay),
        open: !!(conn && conn.open),
        peerGone: peerGone,
        bus: busReady(),
        rtt: rttEma ? Math.round(rttEma) : null,
        multi: multiMode,
        dc: dcSid,
        psid: peerSid,
        // 诊断：分层计数（MQTT 收包 / net 交付 / 当前 broker / 残包缓冲）
        mqrx: (mqttSig && mqttSig.mq) ? (mqttSig.mq.rxN | 0) : -1,
        mqtx: (mqttSig && mqttSig.mq) ? (mqttSig.mq.txN | 0) : -1,
        mqurl: (mqttSig && mqttSig.mq) ? (mqttSig.mq._pendingUrl || '') : '',
        mqu: (mqttSig && mqttSig.mq && mqttSig.mq._pend) ? mqttSig.mq._pend.length : 0,
        mqtry: (mqttSig && mqttSig.mq) ? ((mqttSig.mq.tryN | 0) + '/' + (mqttSig.mq.failN | 0) + '/' + (mqttSig.mq._idx || 0) + '/' + (mqttSig.mq._opened ? 1 : 0) + '/' + (mqttSig.mq._tryTimer ? 1 : 0) + '/' + (mqttSig.mq._closed ? 1 : 0)) : '',
        da: dAllN, own: dOwnN, sig: sigN, bad: badN,
        dlv: dlvN,
        // 多人 mesh：已打通的点对点通道数 / 在场表成员数（不含自己）/ 信令计数
        mesh: openMeshCount(),
        pn: Object.keys(peers).length,
        mx: mx
      };
    },
    _trace: _trace
  };
})();
