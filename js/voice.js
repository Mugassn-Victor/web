'use strict';
/* 语音通话：大厅（房间号 1v1）+ 通话状态机 + 音频引擎。
   传输复用 net.js 三层兜底（broker 中继 → WebRTC 打洞 → TURN）：
   - 直连/TURN：音频帧走 DataChannel（JSON，与棋步同管道）
   - broker 中继：音频帧走同一 Net.send → 自动经总线转发（P2P 打不通也能聊）
   音频格式：16kHz 单声道，优先 Opus（WebCodecs，20ms/帧，~20 帧组一条网络消息），
   浏览器不支持时回退 PCM16 base64。接收端两种消息都认。 */
(function () {
  const $ = function (id) { return document.getElementById(id); };

  const RATE = 16000;
  const BLOCK_MS = 50;
  const BLOCK_SAMPLES = RATE * BLOCK_MS / 1000;   // 800
  const OPUS_FRAME = 320;   // Opus 一帧 20ms @16kHz
  const PREBUF_INIT = 0.15;   // 初始抖动缓冲（秒）
  const PREBUF_MIN = 0.06;    // 稳态下限：健康链路稳态只留 60ms
  const PREBUF_MAX = 0.4;     // 断流补偿封顶：坏链路也最多 +400ms
  const REBUF_STEP = 0.05;    // 每次断流把缓冲抬高的步长（不再固定 +150ms）

  /* ---------- 状态 ---------- */
  const S = {
    mode: '',          // 'host' | 'guest'
    roomId: '',
    linked: false,     // 与对方已连上
    disconnected: false,
    relay: false,      // 当前是否走 broker 中继
    peerMuted: false,
    call: 'idle',      // idle | dialing | ringing | in-call
    callStart: 0,
    micOn: true
  };
  const stats = { sent: 0, recv: 0, dropped: 0, rebased: 0, peak: 0, codec: '' };
  S.stats = stats;
  let lastReqT = 0;   // vc-req 去重窗口（发送端重发的同一次呼叫）
  window.__vc = S;

  /* ---------- 小工具 ---------- */
  let toastTO = null;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    if (toastTO) clearTimeout(toastTO);
    toastTO = setTimeout(function () { el.classList.add('hidden'); }, 2600);
  }
  // 控制消息走 QoS0 中继可能被丢（挂断后对方会卡在通话中）：
  // 立即 + 150ms + 400ms 重发三次，接收端全部幂等（中继丢一两发也不怕）
  function sendCtl(m) {
    [0, 150, 400].forEach(function (delay) {
      setTimeout(function () {
        if (!S.mode) return;
        try { Net.send(m); } catch (e) {}
      }, delay);
    });
  }
  function setStatus(msg, err) {
    const el = $('status');
    el.textContent = msg || '';
    el.className = 'status' + (err ? ' err' : '');
  }
  function showBanner(msg) { const b = $('banner'); b.textContent = msg; b.classList.remove('hidden'); }
  function hideBanner() { $('banner').classList.add('hidden'); }

  /* ---------- 音频上下文 ---------- */
  let ac = null, workletReady = false, playGain = null;
  async function ensureAudio() {
    if (!ac) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('浏览器不支持 WebAudio');
      ac = new AC();
      try {
        await ac.audioWorklet.addModule('js/worklet.js');
        workletReady = true;
      } catch (e) {
        throw new Error('音频采集模块加载失败：' + (e && e.message || e));
      }
    }
    if (ac.state === 'suspended') { try { await ac.resume(); } catch (e) {} }
    if (!playGain) {
      playGain = ac.createGain();
      playGain.connect(ac.destination);
    } else {
      try { playGain.connect(ac.destination); } catch (e) {}
    }
    return ac;
  }
  // 浏览器自动播放策略：第一次用户手势时解锁音频上下文（铃声才响得出来）
  function unlockAudio() {
    ensureAudio().catch(function () {});
    document.removeEventListener('pointerdown', unlockAudio);
    document.removeEventListener('keydown', unlockAudio);
  }
  document.addEventListener('pointerdown', unlockAudio);
  document.addEventListener('keydown', unlockAudio);

  /* ---------- 采集 ---------- */
  let micStream = null, capSrc = null, capNode = null, capMute = null;
  let seq = 0, pend = null;   // pend：中继模式下攒着的半块（凑满 100ms 再发）

  async function startMic() {
    if (!ac) throw new Error('音频上下文未就绪');
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    if (!workletReady) throw new Error('采集模块未就绪');
    capSrc = ac.createMediaStreamSource(micStream);
    capNode = new AudioWorkletNode(ac, 'cap-proc');
    capNode.port.onmessage = function (e) { onCap(e.data.pcm, e.data.sr); };
    capMute = ac.createGain();
    capMute.gain.value = 0;             // 工作图需要连到 destination 才会跑，输出静音防回授
    capSrc.connect(capNode);
    capNode.connect(capMute);
    capMute.connect(ac.destination);
    applyMute();
  }
  function stopMic() {
    if (capNode) { try { capNode.port.onmessage = null; capNode.disconnect(); } catch (e) {} capNode = null; }
    if (capSrc) { try { capSrc.disconnect(); } catch (e) {} capSrc = null; }
    if (capMute) { try { capMute.disconnect(); } catch (e) {} capMute = null; }
    if (micStream) { try { micStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} micStream = null; }
  }
  function applyMute() {
    if (micStream) micStream.getAudioTracks().forEach(function (t) { t.enabled = S.micOn; });
  }

  function onCap(pcm, sr) {
    if (S.call !== 'in-call') return;
    if (!S.micOn) { pend = null; return; }
    let p16;
    try { p16 = resample(pcm, sr, RATE); } catch (e) { return; }
    if (S.relay) {
      // broker 中继（QoS0 公共节点）扛不住 20 帧/秒的速率，实测丢帧率会翻倍：
      // 攒两块 50ms 合成一块 100ms 发（帧率降到 10/秒，与改版前同速率）
      if (pend) { emitBlock(concatF32(pend, p16), BLOCK_MS * 2); pend = null; }
      else pend = p16;
    } else {
      if (pend) { emitBlock(pend, BLOCK_MS); pend = null; }   // 中继→直连切换：把攒着的先发掉
      emitBlock(p16, BLOCK_MS);
    }
  }

  /* ---------- Opus 编解码（WebCodecs；不支持则整体回退 PCM） ---------- */
  let enc = null, encBroken = false, encRem = null, encTs = 0;
  let sendQ = [];            // 已编码待发送的 20ms 包
  let flushIv = null, lastFlushT = 0;
  let dec = null, decBroken = false;

  function initEncoder() {
    if (enc) return true;
    if (encBroken || typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') return false;
    try {
      enc = new AudioEncoder({
        output: function (chunk) {
          try {
            const u8 = new Uint8Array(chunk.byteLength);
            chunk.copyTo(u8);
            sendQ.push(u8);
          } catch (e) {}
        },
        error: function (e) { encBroken = true; enc = null; stats.codec = 'pcm'; stats.codecErr = 'encerr:' + (e && e.message || e); }
      });
      enc.configure({ codec: 'opus', sampleRate: RATE, numberOfChannels: 1, bitrate: 24000 });
      stats.codec = 'opus';
      return true;
    } catch (e) {
      enc = null; encBroken = true; stats.codec = 'pcm';
      stats.codecErr = 'encfg:' + (e && e.message || e);
      return false;
    }
  }

  function emitBlock(f32, ms) {
    if (!initEncoder()) {                 // 回退 PCM（老浏览器/编码器异常）
      if (!stats.codec) stats.codec = 'pcm';
      sendFrame(f32, ms);
      return;
    }
    let buf = encRem && encRem.length ? concatF32(encRem, f32) : f32;
    const nFrames = Math.floor(buf.length / OPUS_FRAME);
    if (!nFrames) { encRem = buf; return; }
    encRem = nFrames * OPUS_FRAME < buf.length ? buf.slice(nFrames * OPUS_FRAME) : null;
    for (let i = 0; i < nFrames; i++) {
      try {
        enc.encode(new AudioData({
          format: 'f32-planar', sampleRate: RATE, numberOfFrames: OPUS_FRAME,
          numberOfChannels: 1, timestamp: encTs,
          data: buf.subarray(i * OPUS_FRAME, (i + 1) * OPUS_FRAME)
        }));
        encTs += 20000;
      } catch (e) {
        encBroken = true;
        try { enc.close(); } catch (e2) {}
        enc = null; stats.codec = 'pcm';
        sendFrame(buf.slice(i * OPUS_FRAME), ms);   // 当前帧起转回 PCM
        return;
      }
    }
  }

  function startFlush() {
    stopFlush();
    lastFlushT = 0;
    flushIv = setInterval(flushOpus, 50);
  }
  function stopFlush() {
    if (flushIv) { clearInterval(flushIv); flushIv = null; }
    sendQ = []; encRem = null;
  }
  function flushOpus() {
    if (!sendQ.length) return;
    const now = Date.now();
    if (S.relay && now - lastFlushT < 95) return;   // 中继：攒到 ~100ms 一发
    lastFlushT = now;
    const chunks = sendQ.splice(0);
    const b64s = [];
    for (let i = 0; i < chunks.length; i++) b64s.push(u8ToB64(chunks[i]));
    if (Net.send({ t: 'vc-o', n: seq++, d: b64s.length * 20, b: b64s })) stats.sent++;
    else stats.dropped++;
  }

  function ensureDecoder() {
    if (dec) return true;
    if (decBroken || typeof AudioDecoder === 'undefined' || typeof EncodedAudioChunk === 'undefined') {
      if (!stats.codecErr) stats.codecErr = 'no-decoder ' + (typeof AudioDecoder) + '/' + (typeof EncodedAudioChunk);
      return false;
    }
    try {
      dec = new AudioDecoder({
        output: function (ad) {
          try {
            const f32 = new Float32Array(ad.numberOfFrames * ad.numberOfChannels);
            ad.copyTo(f32, { format: 'f32', planeIndex: 0 });
            if (ad.numberOfChannels > 1) {              // 混成单声道
              for (let i = 0; i < ad.numberOfFrames; i++) {
                let s = 0;
                for (let c = 0; c < ad.numberOfChannels; c++) s += f32[i * ad.numberOfChannels + c];
                f32[i] = s / ad.numberOfChannels;
              }
            }
            trackPeak(f32);
            scheduleBlk(f32, ad.sampleRate);            // 解码输出速率以 AudioData 为准
          } catch (e) { stats.dropped++; stats.codecErr = 'out:' + (e && e.message || e); }
          try { ad.close(); } catch (e) {}
        },
        error: function (e) {
          decBroken = true; try { dec.close(); } catch (e2) {}
          dec = null;
          stats.codecErr = 'decerr:' + (e && e.message || e);
        }
      });
      dec.configure({ codec: 'opus', sampleRate: RATE, numberOfChannels: 1 });
      return true;
    } catch (e) {
      dec = null; decBroken = true;
      stats.codecErr = 'cfg:' + (e && e.message || e);
      return false;
    }
  }

  function sendFrame(p16, ms) {
    const b64 = floatToB64(p16);
    if (Net.send({ t: 'vc-a', n: seq++, b: b64, d: ms })) stats.sent++;
    else stats.dropped++;
  }
  function concatF32(a, b) {
    const c = new Float32Array(a.length + b.length);
    c.set(a); c.set(b, a.length);
    return c;
  }

  /* ---------- 播放 ---------- */
  let nextT = 0, lastN = -1, playedAny = false;
  let prebuf = PREBUF_INIT, lastUnderrunT = 0, lastShrinkT = 0;

  function trackPeak(f32) {
    let pk = 0;
    for (let i = 0; i < f32.length; i += 8) { const a = f32[i] < 0 ? -f32[i] : f32[i]; if (a > pk) pk = a; }
    if (pk > stats.peak) stats.peak = pk;
  }

  function onAudio(msg) {
    if (S.call === 'idle' || !ac || !playGain) { stats.dropped++; return; }
    const n = msg.n | 0;
    if (lastN >= 0 && n <= lastN) { stats.dropped++; return; }   // 乱序/重复
    let f32;
    try { f32 = b64ToFloat(msg.b); } catch (e) { stats.dropped++; return; }
    const blkSamples = Math.round(RATE * (msg.d === 100 ? 100 : BLOCK_MS) / 1000);
    if (lastN >= 0 && n > lastN + 1) {
      const gap = Math.min(n - lastN - 1, 30);
      scheduleBlk(new Float32Array(gap * blkSamples));        // 丢帧补静音
    }
    lastN = n;
    stats.recv++;
    trackPeak(f32);
    scheduleBlk(f32);
  }

  function onAudioOpus(msg) {
    if (S.call === 'idle' || !ac || !playGain) { stats.dropped++; return; }
    const n = msg.n | 0;
    if (lastN >= 0 && n <= lastN) { stats.dropped++; return; }
    const dms = Math.max(20, msg.d | 0);
    if (lastN >= 0 && n > lastN + 1) {
      const gap = Math.min(n - lastN - 1, 30);
      scheduleBlk(new Float32Array(Math.round(RATE * dms / 1000) * gap));   // 丢消息补静音
    }
    lastN = n;
    stats.recv++;
    if (!ensureDecoder()) { stats.dropped++; return; }
    const arr = Array.isArray(msg.b) ? msg.b : [msg.b];
    for (let i = 0; i < arr.length; i++) {
      try {
        dec.decode(new EncodedAudioChunk({
          type: 'key', data: b64ToU8(arr[i]), timestamp: n * 1000000 + i * 20000
        }));
      } catch (e) { stats.dropped++; }
    }
  }

  function scheduleBlk(f32, srcRate) {
    try {
      const pcm = resample(f32, srcRate || RATE, ac.sampleRate);
      const buf = ac.createBuffer(1, Math.max(1, pcm.length), ac.sampleRate);
      buf.getChannelData(0).set(pcm);
      const src = ac.createBufferSource();
      src.buffer = buf;
      src.connect(playGain);
      const now = ac.currentTime;
      const wall = Date.now();
      // 健康播放 1s 后每秒收缩 15ms：150ms 起步 → 约 6s 后稳到 60ms
      if (playedAny && wall - lastUnderrunT > 1000 && wall - lastShrinkT > 1000 &&
          prebuf > PREBUF_MIN) {
        prebuf = Math.max(PREBUF_MIN, prebuf - 0.015);
        lastShrinkT = wall;
      }
      if (nextT <= now) {                    // 首帧或断流（缓冲空了）→ 重建时间轴
        if (playedAny) {
          prebuf = Math.min(PREBUF_MAX, prebuf + REBUF_STEP);  // 断流：抬高缓冲防连环卡顿
          stats.rebased++;
        } else {
          // 新通话起步：中继抖动大从 150ms 起步，直连无损直接用稳态下限（省掉 6s 收缩）
          prebuf = S.relay ? PREBUF_INIT : PREBUF_MIN;
        }
        nextT = now + prebuf;
        playedAny = true;
        lastUnderrunT = wall;
        lastShrinkT = wall;
      }
      src.start(nextT);
      nextT += buf.duration;
    } catch (e) { stats.dropped++; }
  }

  function resetPlayout() {
    nextT = 0; lastN = -1; playedAny = false;
    prebuf = PREBUF_INIT; lastUnderrunT = 0; lastShrinkT = 0;
  }

  /* ---------- 铃声（WebAudio 振荡器，无音频素材依赖） ---------- */
  let ringTO = null, ringNodes = [], ringAlive = false;
  function ringStop() {
    ringAlive = false;
    if (ringTO) { clearTimeout(ringTO); ringTO = null; }
    ringNodes.forEach(function (n) {
      try { if (n.stop) n.stop(); else n.disconnect(); } catch (e) {}
    });
    ringNodes = [];
  }
  function ringStart(kind) {
    ringStop();
    if (!ac) return;
    ringAlive = true;
    const g = ac.createGain(); g.gain.value = 0; g.connect(ac.destination);
    const freqs = kind === 'dial' ? [450] : [450, 480];
    const oscs = freqs.map(function (f) {
      const o = ac.createOscillator(); o.type = 'sine'; o.frequency.value = f; o.connect(g); o.start();
      return o;
    });
    const onMs = kind === 'dial' ? 1000 : 400, offMs = kind === 'dial' ? 4000 : 400;
    ringNodes = oscs.concat([g]);
    function cycle(isOn) {
      if (!ringAlive) return;
      g.gain.setTargetAtTime(isOn ? 0.10 : 0, ac.currentTime, 0.015);
      ringTO = setTimeout(function () { cycle(!isOn); }, isOn ? onMs : offMs);
    }
    cycle(true);
  }

  /* ---------- 编解码 ---------- */
  function resample(f32, from, to) {
    if (from === to) return f32;
    const ratio = from / to;
    const outN = Math.max(1, Math.floor(f32.length / ratio));
    const out = new Float32Array(outN);
    for (let i = 0; i < outN; i++) {
      const pos = i * ratio, i0 = Math.floor(pos);
      const i1 = i0 + 1 < f32.length ? i0 + 1 : i0;
      const fr = pos - i0;
      out[i] = f32[i0] * (1 - fr) + f32[i1] * fr;
    }
    return out;
  }
  function floatToB64(f32) {
    const u8 = new Uint8Array(f32.length * 2);
    const dv = new DataView(u8.buffer);
    for (let i = 0; i < f32.length; i++) {
      let v = f32[i];
      v = v < -1 ? -1 : (v > 1 ? 1 : v);
      dv.setInt16(i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }
  function b64ToFloat(b64) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const dv = new DataView(u8.buffer);
    const out = new Float32Array(u8.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = dv.getInt16(i << 1, true) / 0x8000;
    return out;
  }
  function u8ToB64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function b64ToU8(b64) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  /* ---------- 通话状态机 ---------- */
  async function startCall() {
    if (S.call === 'in-call') return;   // vc-ans 重发会在 await 让出的间隙并发进来，先闸死
    ringStop();
    S.lastErr = null;
    seq = 0;
    pend = null;
    stats.sent = 0; stats.recv = 0; stats.dropped = 0; stats.rebased = 0; stats.peak = 0;
    stats.codec = '';
    delete stats.codecErr;
    resetPlayout();
    S.call = 'in-call';                 // 状态在第一个 await 之前落地：杜绝双开采集
    S.callStart = Date.now();
    startTimer();
    refresh();
    try {
      await ensureAudio();
      await startMic();
      startFlush();                        // 编码结果按网络节奏发出（直连 50ms / 中继 100ms）
    } catch (e) {
      const msg = '无法开启麦克风：' + (e && e.message || e);
      S.lastErr = String(msg);
      toast(msg);
      stopTimer();
      sendCtl({ t: 'vc-end' });
      S.call = 'idle';
      S.callStart = 0;
      refresh();
    }
  }

  function endCall(reason) {
    stopMic();
    stopFlush();
    ringStop();
    stopTimer();
    if (playGain) { try { playGain.disconnect(); } catch (e) {} playGain = null; }
    resetPlayout();
    S.call = 'idle';
    S.callStart = 0;
    S.micOn = true;
    S.peerMuted = false;
    if (reason) toast(reason);
    refresh();
  }

  let timerIv = null;
  function startTimer() {
    stopTimer();
    $('callTimer').textContent = '00:00';
    timerIv = setInterval(function () {
      const s = Math.floor((Date.now() - S.callStart) / 1000);
      const m = Math.floor(s / 60), ss = s % 60;
      $('callTimer').textContent = (m < 10 ? '0' : '') + m + ':' + (ss < 10 ? '0' : '') + ss;
    }, 500);
  }
  function stopTimer() { if (timerIv) { clearInterval(timerIv); timerIv = null; } }

  /* ---------- 消息路由 ---------- */
  function onMessage(d) {
    if (!d || typeof d !== 'object') return;
    switch (d.t) {
      case 'vc-req':
        if (!S.linked) return;
        if (Date.now() - lastReqT < 1000) break;   // 三次重发里的重复呼叫
        lastReqT = Date.now();
        if (S.call === 'ringing') break;
        if (S.call !== 'idle') { sendCtl({ t: 'vc-busy' }); return; }
        S.call = 'ringing';
        refresh();
        ensureAudio().then(function () { ringStart('ring'); }).catch(function () {});
        break;
      case 'vc-busy':
        if (S.call === 'dialing') { ringStop(); S.call = 'idle'; toast('对方占线'); refresh(); }
        break;
      case 'vc-ans':
        if (S.call === 'dialing') startCall();
        break;
      case 'vc-end':
        if (S.call === 'dialing') { ringStop(); S.call = 'idle'; toast('对方拒绝了通话'); refresh(); }
        else if (S.call === 'ringing') { ringStop(); S.call = 'idle'; refresh(); }
        else if (S.call === 'in-call') endCall('对方挂断了通话');
        break;
      case 'vc-mute':
        S.peerMuted = !!d.on;
        refresh();
        break;
      case 'vc-a':
        onAudio(d);
        break;
      case 'vc-o':
        onAudioOpus(d);
        break;
    }
  }

  /* ---------- 大厅 ---------- */
  // 两端必须落在同一个 broker 上（信令房间不跨 broker）。选路只由房间号推导：
  // 两个实测满速无丢包的 broker（mosquitto/hivemq）按房间号哈希定先后，两端
  // 同房间必得同一顺序；emqx 有 ~10msg/s 限速（实测 11msg/s 丢 8%），恒排末尾
  // 仅作连通性兜底。页面加载时的规范顺序（未被重排过）缓存下来供选路用。
  let brokerCanon = null;
  try { brokerCanon = Net.brokerList().slice(); } catch (e) {}
  function applyBrokerOrder(room) {
    if (!brokerCanon || brokerCanon.length < 2) return;
    const mosq = brokerCanon.filter(function (u) { return u.indexOf('mosquitto') >= 0; });
    const hum = brokerCanon.filter(function (u) { return u.indexOf('hivemq') >= 0; });
    const rest = brokerCanon.filter(function (u) {
      return mosq.indexOf(u) < 0 && hum.indexOf(u) < 0;
    });
    let h = 5381;
    for (let i = 0; i < room.length; i++) h = ((h << 5) + h + room.charCodeAt(i)) >>> 0;
    const order = (h % 2 === 0) ? mosq.concat(hum) : hum.concat(mosq);
    try { Net.setBrokerOrder(order.concat(rest)); } catch (e) {}
  }
  function onCreate() {
    if (S.mode) return;
    const code = String(Math.floor(100000 + Math.random() * 900000));
    S.mode = 'host';
    S.roomId = code;
    $('roomCode').textContent = code;
    $('hostPanel').classList.remove('hidden');
    setStatus('正在建立连接…');
    applyBrokerOrder(code);
    Net.create(code);
    refresh();
  }
  function onJoin() {
    if (S.mode) return;
    const v = ($('roomInput').value || '').trim();
    if (!/^\d{6}$/.test(v)) { setStatus('请输入 6 位数字房间号', true); return; }
    S.mode = 'guest';
    S.roomId = v;
    setStatus('正在连接房间 ' + v + '…');
    applyBrokerOrder(v);
    Net.join(v, true);
    refresh();
  }
  function resetLobby() {
    try { Net.destroy(); } catch (e) {}
    S.mode = ''; S.roomId = ''; S.linked = false;
    $('hostPanel').classList.add('hidden');
    refresh();
  }

  /* ---------- 断线重连（与棋类项目同一套路） ---------- */
  let resumeTimer = null;
  function startResumeRetry() {
    if (resumeTimer) return;
    Net.resume();
    resumeTimer = setInterval(function () {
      if (S.disconnected) Net.resume();
      else stopResumeRetry();
    }, 5000);
  }
  function stopResumeRetry() {
    if (resumeTimer) { clearInterval(resumeTimer); resumeTimer = null; }
  }

  /* ---------- UI 刷新 ---------- */
  function refresh() {
    const busy = !!S.mode;
    $('btnCreate').disabled = busy;
    $('btnJoin').disabled = busy;
    $('roomInput').disabled = busy;

    $('peerCard').classList.toggle('hidden', !S.linked);
    $('btnCall').disabled = !S.linked || S.call !== 'idle';

    $('dialing').classList.toggle('hidden', S.call !== 'dialing');
    $('incoming').classList.toggle('hidden', S.call !== 'ringing');
    $('callCard').classList.toggle('hidden', S.call !== 'in-call');

    $('peerState').textContent = S.linked ? '对方已连接' : (S.mode ? '连接中…' : '对方未加入');
    document.querySelector('.avatar').classList.toggle('live', S.linked);

    $('btnMute').textContent = S.micOn ? '静音' : '取消静音';
    $('callPeer').textContent = S.peerMuted ? '通话中 · 对方已静音' : '通话中';
    updateNetHint();
    updateLinkTag();
  }
  function updateNetHint() {
    if (S.disconnected) { $('netHint').textContent = '连接中断，等待恢复…'; return; }
    let h = S.relay ? '服务器中继（延迟较高）' : 'P2P 直连';
    if (S.peerMuted) h += ' · 对方已静音';
    $('netHint').textContent = h;
  }
  function updateLinkTag() {
    const tag = $('linkTag');
    if (S.disconnected) { tag.textContent = '已断开'; tag.className = 'tag off'; }
    else if (!S.linked) { tag.textContent = S.mode ? '连接中' : '未连接'; tag.className = 'tag'; }
    else if (S.relay) { tag.textContent = '中继'; tag.className = 'tag relay'; }
    else { tag.textContent = '已连接·直连'; tag.className = 'tag on'; }
  }

  // 500ms 轮询：链路徽章 + 通话统计
  setInterval(function () {
    try {
      const d = Net.debugState();
      S.relay = !!(d.settled && d.relay);
    } catch (e) {}
    updateNetHint();
    updateLinkTag();
    if (S.call === 'in-call') {
      $('callStats').textContent = '发送 ' + stats.sent + ' · 接收 ' + stats.recv +
        ' · 重建 ' + stats.rebased + ' · 丢弃 ' + stats.dropped;
    } else {
      $('callStats').textContent = '';
    }
  }, 500);

  /* ---------- Net 事件 ---------- */
  Net.on('connected', function (e) {
    S.relay = !!(e && e.peer === 'relay');   // 首连即拿到真实传输（省掉等下一次 500ms 轮询）
    S.linked = true; S.disconnected = false;
    stopResumeRetry(); hideBanner(); setStatus('');
    toast('已连接对方');
    refresh();
  });
  Net.on('reconnected', function (e) {
    S.relay = !!(e && e.peer === 'relay');   // 升级/降级都会带 peer 信息
    S.linked = true; S.disconnected = false;
    stopResumeRetry(); hideBanner();
    refresh();
  });
  Net.on('relay', function () { S.relay = true; refresh(); });
  Net.on('closed', function () {
    S.disconnected = true;
    if (S.call !== 'idle') endCall('通话中断，等待重连…');
    showBanner('连接中断，等待恢复…');
    startResumeRetry();
    refresh();
  });
  Net.on('conn-error', function (e) {
    setStatus('连接出错：' + (e && (e.message || String(e)) || '未知错误'), true);
  });
  Net.on('room-full', function () {
    setStatus('该房间已有两人，请另建房间', true);
    resetLobby();
  });
  Net.on('error', function () {});
  Net.on('data', function (d) {
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { return; } }
    onMessage(d);
  });
  window.addEventListener('beforeunload', function () { try { Net.destroy(); } catch (e) {} });

  /* ---------- 按钮 ---------- */
  $('btnCreate').onclick = onCreate;
  $('btnJoin').onclick = onJoin;
  $('roomInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') onJoin();
  });
  $('btnCopy').onclick = function () {
    const code = $('roomCode').textContent;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(function () { toast('已复制'); }, function () {});
    } else { toast(code); }
  };
  $('btnCall').onclick = function () {
    if (!S.linked || S.call !== 'idle') return;
    ensureAudio().then(function () {
      S.call = 'dialing';
      refresh();
      sendCtl({ t: 'vc-req' });
      ringStart('dial');
    }).catch(function (e) { toast('无法开启音频：' + (e && e.message || e)); });
  };
  $('btnCancelCall').onclick = function () {
    ringStop();
    S.call = 'idle';
    sendCtl({ t: 'vc-end' });
    refresh();
  };
  $('btnAnswer').onclick = function () {
    if (S.call !== 'ringing') return;
    ringStop();
    sendCtl({ t: 'vc-ans' });
    startCall();
  };
  $('btnReject').onclick = function () {
    if (S.call !== 'ringing') return;
    ringStop();
    sendCtl({ t: 'vc-end' });
    S.call = 'idle';
    refresh();
  };
  $('btnHangup').onclick = function () {
    sendCtl({ t: 'vc-end' });
    endCall('通话已结束');
  };
  $('btnMute').onclick = function () {
    S.micOn = !S.micOn;
    applyMute();
    sendCtl({ t: 'vc-mute', on: !S.micOn });
    refresh();
  };

  refresh();
})();
