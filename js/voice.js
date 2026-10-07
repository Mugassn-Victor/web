'use strict';
/* 语音通话：大厅（房间号 1v1）+ 通话状态机 + 音频引擎。
   传输复用 net.js 三层兜底（broker 中继 → WebRTC 打洞 → TURN）：
   - 直连/TURN：音频帧走 DataChannel 二进制帧（控制信令仍 JSON）
   - broker 中继：二进制帧包成 [0xBF][sid][帧] 走总线（跳过 JSON+base64，省 40% 字节）
   音频格式：48kHz 单声道全带，优先 Opus（WebCodecs，20ms/帧），浏览器不支持时
   回退 PCM16。接收端两种都认。 */
(function () {
  const $ = function (id) { return document.getElementById(id); };

  const RATE = 48000;          // 48kHz 全带：浏览器采集/播放原生多为 48k，采集→编码→解码→播放全程零重采样
  const BLOCK_MS = 50;
  const BLOCK_SAMPLES = RATE * BLOCK_MS / 1000;
  const OPUS_FRAME = RATE * 20 / 1000;   // Opus 一帧 20ms（48k = 960 采样）
  const PREBUF_INIT = 0.15;   // 初始抖动缓冲（秒）
  const PREBUF_MIN = 0.06;    // 中继稳态下限：QoS0 公共 broker 抖动实测 ~50ms，留 60ms
  const PREBUF_MIN_D = 0.03;  // 直连稳态下限：直连实测抖动 ~3ms，压到 30ms（比中继省 30ms 耳机延迟）
  const PREBUF_MAX = 0.4;     // 断流补偿封顶：坏链路也最多 +400ms
  const REBUF_STEP = 0.05;    // 每次断流把缓冲抬高的步长（不再固定 +150ms）
  const DTX_TH = 0.012;       // 静音门限（NS/AGC 后底噪典型 <0.01，语音 RMS ~0.1+）
  const SPK_TH = 0.02;        // 「正在说话」判定门限（收端帧峰值/本端 RMS，高于底噪）
  const SPK_HOLD = 600;       // 说话高亮保持窗口（ms，覆盖 500ms UI 轮询的采样间隔）

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
    micOn: true,
    rtt: null,         // 实测链路延迟 ms（Net.debugState().rtt 快照，未测得为 null）
    mesh: 0,           // 多人房已打通的两两 P2P 通道数（Net.debugState().mesh）
    pn: 0              // 在场表里的其他成员数（Net.debugState().pn）
  };
  const stats = { sent: 0, recv: 0, dropped: 0, rebased: 0, peak: 0, codec: '', e2e: 0, dtxMs: 0 };
  S.stats = stats;
  let lastReqT = 0;   // vc-req 去重窗口（发送端重发的同一次呼叫）
  let lastReqKey = '';   // 去重按 sid+cid 认：只吸同一呼叫者的三次重发，不吞新成员的拨打
  let dialSeq = 0, callCid = 0;   // 当前呼叫 id：拨号自增赋值、响铃取对端 req 的 cid；
  // vc-ans/busy/end 只受理当前呼叫的（上一通的重发/迟到消息跨不了窗，防串线）
  let callSid = '';   // 当前来电者 sid（响铃中别人打入 → 回占线）
  let roster = {};     // 房内成员 sid → {nick, st, mute, last}（vc-pres 周期维护）
  let spkEnd = {};     // sid → 最近一次「在说话」的时间戳（收端帧峰值 + 本端 RMS）
  let multiMode = false;   // 房间 ≥3 人（Net.setMulti 已锁中继）
  S.nick = '';
  window.__vc = S;
  // 语音房不设两人上限：敲门一律放行（多人房由 vc-pres 组织，见 roster/sweepRoster）
  try { Net.setOpenRoom(true); } catch (e) {}

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
  // 加密仅限 vc-mute：建立/挂断关键信令（vc-req/ans/end）在轮换窗口里必然短暂无钥，
  // 包进去会把呼叫流程打死（实测回归）；音频正文本就单独 E2E（vc-k/vc-kreq 永远明文）
  function sendCtl(m) {
    if (!m.sid) {                       // 统一带上本端 sid：收端靠它归属消息（vc-end 挂断级联等）
      try { const s = Net.mySid && Net.mySid(); if (s) m.sid = s; } catch (e) {}
    }
    const doSend = audioKey && m.t === 'vc-mute';
    [0, 150, 400].forEach(function (delay) {
      setTimeout(function () {
        if (!S.mode) return;
        try {
          if (doSend) {
            const bytes = new TextEncoder().encode(JSON.stringify(m));
            encBlob(bytes).then(function (ct) {
              try { Net.send({ t: 'vc-x', b: u8ToB64(ct) }); } catch (e) {}
            }).catch(function () {});
            return;
          }
          Net.send(m);
        } catch (e) {}
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
      playGain.connect(ac.destination);   // 只在创建时连接一次（重复 connect 是回音排查项之一）
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
  let seq = 0, pend = null, callGen = 0;   // pend：中继模式下攒着的半块（凑满 100ms 再发）；callGen：代次，防上一通的排队帧混进新一通
  let dtxOn = false, dtxRun = 0;           // 应用层 DTX：连续静音≥250ms 停发（典型通话省 40~60% 带宽）

  async function startMic() {
    if (!ac) throw new Error('音频上下文未就绪');
    if (capNode) return;                  // 响铃/拨号期间已预启：startCall 直接复用，不再等权限
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    // 诊断：浏览器实际生效的回声消除参数（回音问题排查依据，读 track 设置而非请求值）
    try {
      const tr_ = micStream.getAudioTracks()[0].getSettings();
      Net._trace.push('mic aec=' + tr_.echoCancellation + ' ns=' + tr_.noiseSuppression + ' agc=' + tr_.autoGainControl);
    } catch (e) {}
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

  function rmsOf(f32) {
    let s = 0;
    for (let i = 0; i < f32.length; i += 8) s += f32[i] * f32[i];
    return Math.sqrt(s / Math.ceil(f32.length / 8));
  }
  function onCap(pcm, sr) {
    if (S.call !== 'in-call') return;
    if (!S.micOn) { pend = null; return; }
    let p16;
    try { p16 = resample(pcm, sr, RATE); } catch (e) { return; }
    const rms = rmsOf(p16);
    if (rms > SPK_TH) spkEnd[mySid() || 'me'] = Date.now();   // 本端说话高亮（静音时 mic disabled，天然不亮）
    // DTX：连续 5 块（250ms）低于门限 → 停发，语音回来立即复发。
    // 接收端不需改动：长静音期播放缓冲自然耗尽，下一帧按断流重建时间轴即可对齐
    if (rms > DTX_TH) {
      dtxOn = false; dtxRun = 0;
    } else if (!dtxOn && ++dtxRun >= 5) {
      dtxOn = true; dtxRun = 0; pend = null;   // 进入 DTX：丢弃半块，别把静音尾巴发出去
    }
    if (dtxOn) { stats.dtxMs += BLOCK_MS; return; }
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
  let brCheck = 0, brCur = 32000;   // 自适应码率：按接收侧丢包率 5s 一档 32k/24k/16k
  function adaptBitrate() {
    if (!enc || encBroken || S.call !== 'in-call') return;
    const now = Date.now();
    if (now - brCheck < 5000) return;
    brCheck = now;
    const tot = stats.recv + stats.dropped;
    const loss = tot > 0 ? stats.dropped / tot : 0;   // 收侧丢包率（链路健康度的就近代用指标）
    const want = loss > 0.05 ? 16000 : (loss > 0.02 ? 24000 : 32000);
    if (want === brCur) return;
    brCur = want;
    try { enc.configure({ codec: 'opus', sampleRate: RATE, numberOfChannels: 1, bitrate: want }); } catch (e) {}
  }
  let decoders = {};         // sid → AudioDecoder（多人房每路独立解码，输出按 sid 归属播放时间轴）
  let decBroken = false;

  function initEncoder() {
    if (enc) { stats.codec = 'opus'; return true; }   // 同页第二通起复用实例：startCall 清过
                                                       // codec=''，这里必须回填，否则统计永远空
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
      enc.configure({ codec: 'opus', sampleRate: RATE, numberOfChannels: 1, bitrate: 32000 });
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
    flushIv = setInterval(flushOpus, 25);   // 直连 25ms 一发（中继仍由 flushOpus 内 95ms 门限攒到 100ms）
  }
  function stopFlush() {
    if (flushIv) { clearInterval(flushIv); flushIv = null; }
    sendQ = []; encRem = null;
  }
  function flushOpus() {
    adaptBitrate();                       // 每 25ms tick 检查一次（内部 5s 节流）
    if (!sendQ.length) return;
    const now = Date.now();
    if (S.relay && now - lastFlushT < 95) return;   // 中继：攒到 ~100ms 一发
    lastFlushT = now;
    const chunks = sendQ.splice(0);
    const d = chunks.length * 20;
    const gen = callGen;
    queueSend(function () {
      if (gen !== callGen || S.call !== 'in-call') return;
      const n = seq++;
      const plain = packChunks(chunks);
      if (audioKey) {
        return encBlob(plain).then(function (ct) {
          if (Net.send(binFrame(2, true, n, d, ct))) stats.sent++;
          else stats.dropped++;
        });
      }
      if (Net.send(binFrame(2, false, n, d, plain))) stats.sent++;
      else stats.dropped++;
    });
  }

  function ensureDecoder(sid) {
    if (decoders[sid]) return decoders[sid];
    if (decBroken || typeof AudioDecoder === 'undefined' || typeof EncodedAudioChunk === 'undefined') {
      if (!stats.codecErr) stats.codecErr = 'no-decoder ' + (typeof AudioDecoder) + '/' + (typeof EncodedAudioChunk);
      return null;
    }
    try {
      const d = new AudioDecoder({
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
            trackPeak(f32, sid);
            scheduleBlk(f32, ad.sampleRate, sid);       // 解码输出速率以 AudioData 为准
          } catch (e) { stats.dropped++; stats.codecErr = 'out:' + (e && e.message || e); }
          try { ad.close(); } catch (e) {}
        },
        error: function (e) {
          decBroken = true; try { d.close(); } catch (e2) {}
          delete decoders[sid];
          stats.codecErr = 'decerr:' + (e && e.message || e);
        }
      });
      d.configure({ codec: 'opus', sampleRate: RATE, numberOfChannels: 1 });
      decoders[sid] = d;
      return d;
    } catch (e) {
      decBroken = true;
      stats.codecErr = 'cfg:' + (e && e.message || e);
      return null;
    }
  }

  function sendFrame(p16, ms) {
    const gen = callGen;
    queueSend(function () {
      if (gen !== callGen || S.call !== 'in-call') return;
      const n = seq++;
      const plain = f32ToU8(p16);
      if (audioKey) {
        return encBlob(plain).then(function (ct) {
          if (Net.send(binFrame(1, true, n, ms, ct))) stats.sent++;
          else stats.dropped++;
        });
      }
      if (Net.send(binFrame(1, false, n, ms, plain))) stats.sent++;
      else stats.dropped++;
    });
  }
  function concatF32(a, b) {
    const c = new Float32Array(a.length + b.length);
    c.set(a); c.set(b, a.length);
    return c;
  }

  /* ---------- 播放（按 sid 分路：直连帧=对端总线 sid，中继帧=信封 sid，多房每路独立时间轴） ---------- */
  let playStates = {};   // sid → {nextT, lastN, playedAny, prebuf, lastUnderrunT, lastShrinkT}
  let staleUntil = 0;   // 回前台后清 OS 积压 backlog 的时间窗（过期帧只计数不播）

  function psid(sid) {
    let p = playStates[sid];
    if (!p) p = playStates[sid] = { nextT: 0, lastN: -1, playedAny: false, prebuf: PREBUF_INIT, lastUnderrunT: 0, lastShrinkT: 0 };
    return p;
  }

  function trackPeak(f32, sid) {
    let pk = 0;
    for (let i = 0; i < f32.length; i += 8) { const a = f32[i] < 0 ? -f32[i] : f32[i]; if (a > pk) pk = a; }
    if (pk > stats.peak) stats.peak = pk;
    if (sid && pk > SPK_TH) spkEnd[sid] = Date.now();   // 收端「对方正在说话」高亮
  }

  function onAudio(msg) {
    if (S.call === 'idle' || !ac || !playGain) { stats.dropped++; return; }
    const key = msg.sid || 'p2p';
    S.frameSid = key;
    const p = psid(key);
    const n = msg.n | 0;
    if (p.lastN >= 0 && n <= p.lastN) { stats.dropped++; return; }   // 乱序/重复
    if (Date.now() < staleUntil) { p.lastN = n; stats.dropped++; return; }   // 回前台 flush 的过期帧
    const blkSamples = Math.round(RATE * (msg.d === 100 ? 100 : BLOCK_MS) / 1000);
    if (p.lastN >= 0 && n > p.lastN + 1) {
      const gap = Math.min(n - p.lastN - 1, 30);
      scheduleBlk(new Float32Array(gap * blkSamples), undefined, key);   // 丢帧补静音（同步：只依赖 n/d）
    }
    p.lastN = n;
    stats.recv++;
    const b = msg.b, enc = !!msg.enc;        // b = Uint8Array（二进制帧直通）
    queuePlay(async function () {                            // 解密→出声按到达顺序串行
      let f32;
      if (enc) {
        const pt = await openBlob(b, true);                  // 无钥/解不开 → vc-kreq 自愈，弃帧
        if (!pt) { stats.decFail = (stats.decFail | 0) + 1; return; }
        f32 = u8ToF32(pt);
      } else {
        f32 = u8ToF32(b);
      }
      trackPeak(f32, key);
      scheduleBlk(f32, undefined, key);
    });
  }

  function onAudioOpus(msg) {
    if (S.call === 'idle' || !ac || !playGain) { stats.dropped++; return; }
    const key = msg.sid || 'p2p';
    S.frameSid = key;
    const p = psid(key);
    const n = msg.n | 0;
    if (p.lastN >= 0 && n <= p.lastN) { stats.dropped++; return; }
    if (Date.now() < staleUntil) { p.lastN = n; stats.dropped++; return; }   // 回前台 flush 的过期帧
    const dms = Math.max(20, msg.d | 0);
    if (p.lastN >= 0 && n > p.lastN + 1) {
      const gap = Math.min(n - p.lastN - 1, 30);
      scheduleBlk(new Float32Array(Math.round(RATE * dms / 1000) * gap), undefined, key);   // 丢消息补静音
    }
    p.lastN = n;
    stats.recv++;
    const b = msg.b, enc = !!msg.enc;        // b = Uint8Array（二进制帧直通）
    queuePlay(async function () {
      const dd = ensureDecoder(key);
      if (!dd) return;
      let arr;
      if (enc) {
        const pt = await openBlob(b, true);                  // 无钥/解不开 → vc-kreq 自愈，弃帧
        if (!pt) { stats.decFail = (stats.decFail | 0) + 1; return; }
        arr = unpackChunks(pt);
      } else {
        arr = unpackChunks(b);
      }
      for (let i = 0; i < arr.length; i++) {
        try {
          dd.decode(new EncodedAudioChunk({
            type: 'key', data: arr[i], timestamp: n * 1000000 + i * 20000
          }));
        } catch (e) { stats.dropped++; }
      }
    });
  }

  function scheduleBlk(f32, srcRate, sid) {
    try {
      const key = sid || 'p2p';
      const p = psid(key);
      const pcm = resample(f32, srcRate || RATE, ac.sampleRate);
      const buf = ac.createBuffer(1, Math.max(1, pcm.length), ac.sampleRate);
      buf.getChannelData(0).set(pcm);
      const src = ac.createBufferSource();
      src.buffer = buf;
      src.connect(playGain);
      const now = ac.currentTime;
      const wall = Date.now();
      // 健康播放 1s 后每秒收缩 15ms：150ms 起步 → 约 6s 后稳到 60ms
      if (p.playedAny && wall - p.lastUnderrunT > 1000 && wall - p.lastShrinkT > 1000 &&
          p.prebuf > (S.relay ? PREBUF_MIN : PREBUF_MIN_D)) {
        p.prebuf = Math.max(S.relay ? PREBUF_MIN : PREBUF_MIN_D, p.prebuf - 0.015);
        p.lastShrinkT = wall;
      }
      if (p.nextT <= now) {                  // 首帧或断流（缓冲空了）→ 重建时间轴
        if (p.playedAny) {
          p.prebuf = Math.min(PREBUF_MAX, p.prebuf + REBUF_STEP);   // 断流：抬高缓冲防连环卡顿
          stats.rebased++;
        } else {
          // 新通话起步：中继抖动大从 150ms 起步，直连无损直接用 30ms 稳态下限（省掉 6s 收缩）
          p.prebuf = S.relay ? PREBUF_INIT : PREBUF_MIN_D;
        }
        p.nextT = now + p.prebuf;
        p.playedAny = true;
        p.lastUnderrunT = wall;
        p.lastShrinkT = wall;
      }
      src.start(p.nextT);
      p.nextT += buf.duration;
    } catch (e) { stats.dropped++; }
  }

  function resetPlayout() {
    playStates = {};
  }

  /* ---------- 铃声（WebAudio 振荡器，无音频素材依赖） ---------- */
  let ringTO = null, ringNodes = [], ringAlive = false;
  function ringStop() {
    ringAlive = false;
    if (ringTO) { clearTimeout(ringTO); ringTO = null; }
    try { if (navigator.vibrate) navigator.vibrate(0); } catch (e) {}
    ringNodes.forEach(function (n) {
      try { if (n.stop) n.stop(); else n.disconnect(); } catch (e) {}
    });
    ringNodes = [];
  }
  // 通话中防息屏（移动端）：息屏会挂起 AudioContext/后台限流；不支持或被拒则静默
  let wakeLock = null;
  function requestWake() {
    if (!('wakeLock' in navigator) || !navigator.wakeLock) return;
    try {
      const p = navigator.wakeLock.request('screen');
      if (p && p.then) p.then(function (l) { wakeLock = l; }, function () {});
    } catch (e) {}
  }
  function releaseWake() {
    if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
  }
  function ringStart(kind) {
    ringStop();
    if (!ac) return;
    if (kind !== 'dial') {                   // 来电振动（桌面无振动 API 则静默）
      try { if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 300]); } catch (e) {}
    }
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
  function f32ToU8(f32) {
    const u8 = new Uint8Array(f32.length * 2);
    const dv = new DataView(u8.buffer);
    for (let i = 0; i < f32.length; i++) {
      let v = f32[i];
      v = v < -1 ? -1 : (v > 1 ? 1 : v);
      dv.setInt16(i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
    return u8;
  }
  function u8ToF32(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
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

  /* ---------- 端到端加密（音频帧 AES-GCM，密钥 = 双方 ECDH，broker 只见密文） ----------
     公钥经 QoS0 + 三连重发的 vc-k 交换；「对方发没发公钥」本身就是能力协商：
     任一侧无 WebCrypto → 对侧收不到公钥 → 两侧一致地降级明文，不会出现
     一侧加密一侧明文的半开状态。房间号不参与密钥（topic 明文可见，派生即泄）。 */
  let ecdhPair = null, myPk = null, pkSent = false, peerPk = null;
  let myGen = 0, peerGen = -1;             // 密钥代次：每通轮换 myGen++，等对方同代才成钥
  let audioKey = null, keyP = null, deriveP = null;
  let lastKreqT = 0;                       // vc-kreq 节流（音频帧反复解不开时最多 1 次/秒）
  let pks = {};                            // sid → {pk, g}：vc-k 携带发送方 sid（多人房按人分钥）
  let derivePs = {};                       // sid → 派生 promise 缓存（仅用于 vc-rk 包装）
  let roomKey = null, roomKeyRaw = null;   // 多人房房间密钥：音频统一用它（对密钥只做分发包装）
  let rkSent = {};                         // sid → 已分发的 roomKeyRaw（防重发风暴）
  const subtleOk = !!(window.crypto && crypto.subtle && window.TextEncoder);

  function initCrypto() {
    ecdhPair = null; myPk = null; pkSent = false; peerPk = null;
    myGen = 0; peerGen = -1;
    audioKey = null; keyP = null; deriveP = null;
    pks = {}; derivePs = {};
    roomKey = null; roomKeyRaw = null; rkSent = {};
    if (subtleOk) ensureKeyPair();
  }
  function ensureKeyPair(renew) {
    if (renew) { keyP = null; ecdhPair = null; myPk = null; derivePs = {}; }   // 轮换：作废旧密钥对与按人派生缓存
    if (keyP) return keyP;
    if (!subtleOk) { keyP = Promise.resolve(null); return keyP; }
    keyP = crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey'])
      .then(function (kp) {
        ecdhPair = kp;
        return crypto.subtle.exportKey('raw', kp.publicKey);
      })
      .then(function (raw) { myPk = u8ToB64(new Uint8Array(raw)); return myPk; })
      .catch(function () { myPk = null; return null; });
    return keyP;
  }
  function deriveAudioKey() {
    if (audioKey) return Promise.resolve(audioKey);
    if (!subtleOk || !ecdhPair || !peerPk) return Promise.resolve(null);
    if (peerGen !== myGen) return Promise.resolve(null);   // 代次必须严格相等：错配派生出的
                                                           // 密钥两边永远对不上（只有死锁）
    if (!deriveP) {
      deriveP = crypto.subtle.importKey('raw', b64ToU8(peerPk),
          { name: 'ECDH', namedCurve: 'P-256' }, false, [])
        .then(function (pub) {
          return crypto.subtle.deriveKey({ name: 'ECDH', public: pub }, ecdhPair.privateKey,
            { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        })
        .then(function (k) { audioKey = k; return k; })
        .catch(function () { audioKey = null; deriveP = null; return null; });  // 失败可重试
    }
    return deriveP;
  }
  function sendPk() {
    if (pkSent || !myPk || !S.mode) return;
    pkSent = true;
    sendCtl({ t: 'vc-k', pk: myPk, g: myGen });
  }
  function sendPkReq() {                    // 音频解不开/无钥 → 请求对端重发公钥（自愈）
    const now = Date.now();
    if (now - lastKreqT < 1000) return;
    lastKreqT = now;
    sendCtl({ t: 'vc-kreq' });
  }
  // 解密入口：明文直通；加密帧无钥/解不开 → 发 vc-kreq 自愈后返回 null（帧丢弃）
  async function openBlob(b, enc) {
    if (!enc) return b;
    if (!audioKey) { sendPkReq(); return null; }
    try { return await decBlob(b); } catch (e) { sendPkReq(); return null; }
  }
  async function awaitAudioKey(ms) {
    try { await ensureKeyPair(); } catch (e) {}
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {        // 轮换后等对方同代 vc-k（代次不够时 derive 立即返回 null）
      await deriveAudioKey();
      if (audioKey) return audioKey;
      await new Promise(function (r) { setTimeout(r, 50); });
    }
    return audioKey;                       // 超时 → 明文降级，通话中 vc-kreq 到达后可升回
  }
  async function encK(key, u8) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, u8));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv, 0); out.set(ct, 12);
    return out;
  }
  async function decK(key, u8) {
    if (u8.length < 12 + 16) throw new Error('enc-short');
    return new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: u8.subarray(0, 12) }, key, u8.subarray(12)));
  }
  async function encBlob(u8) { return encK(audioKey, u8); }
  async function decBlob(u8) { return decK(audioKey, u8); }

  /* ---- 多人房房间密钥（vc-rk）：房主随机生成 32B，用与每人各自的 ECDH 对密钥
     包装后广播分发（只有 to 指定者能拆开）；全员 audioKey 换成房间密钥后，
     一帧加密所有人可解，broker/其他成员只见密文。两人房不用（保持每通轮换的对密钥）。 */
  async function useRoomKey() {
    if (!roomKey) return false;
    audioKey = roomKey;
    return true;
  }
  function derivePairFor(sid) {           // 与 sid 指定成员的对密钥（只用于包装/拆 vc-rk）
    const ent = pks[sid];
    if (!subtleOk || !ent || !ent.pk || !ecdhPair) return Promise.resolve(null);
    if (derivePs[sid] && derivePs[sid].pk === ent.pk) return derivePs[sid].p;
    const p = crypto.subtle.importKey('raw', b64ToU8(ent.pk),
        { name: 'ECDH', namedCurve: 'P-256' }, false, [])
      .then(function (pub) {
        return crypto.subtle.deriveKey({ name: 'ECDH', public: pub }, ecdhPair.privateKey,
          { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      })
      .catch(function () { return null; });
    derivePs[sid] = { pk: ent.pk, p: p };
    return p;
  }
  function maybeGenRoomKey() {           // 仅房主、仅多人房
    if (!subtleOk || roomKeyRaw || S.mode !== 'host') return;
    const raw = crypto.getRandomValues(new Uint8Array(32));
    roomKeyRaw = u8ToB64(raw);
    crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
      .then(function (k) { roomKey = k; audioKey = k; stats.e2e = 1; })
      .catch(function () { roomKeyRaw = null; });
    for (const s in roster) maybeSendRoomKey(s);
  }
  async function maybeSendRoomKey(sid, force) {
    if (!subtleOk || !roomKeyRaw || !sid || S.mode !== 'host') return;
    if (force) delete rkSent[sid];
    if (rkSent[sid] === roomKeyRaw) return;
    const pair = await derivePairFor(sid);
    if (!pair) return;
    try {
      const ct = await encK(pair, b64ToU8(roomKeyRaw));
      Net.send({ t: 'vc-rk', to: sid, from: mySid(), b: u8ToB64(ct) });
      rkSent[sid] = roomKeyRaw;
    } catch (e) {}
  }
  // 多个 20ms opus 包打成一包：每包 2 字节长度前缀 + 数据，整包一次加解密
  function packChunks(chunks) {
    let total = 0;
    for (let i = 0; i < chunks.length; i++) total += 2 + chunks[i].length;
    const out = new Uint8Array(total);
    let off = 0;
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      out[off++] = c.length >> 8; out[off++] = c.length & 0xff;
      out.set(c, off); off += c.length;
    }
    return out;
  }
  function unpackChunks(u8) {
    const out = [];
    let off = 0;
    while (off + 2 <= u8.length) {
      const len = (u8[off] << 8) | u8[off + 1]; off += 2;
      if (off + len > u8.length) break;
      out.push(u8.subarray(off, off + len)); off += len;
    }
    return out;
  }
  // 发送序列化：seq++、加密、Net.send 全在链内，杜绝并发 flush 的乱序/竞态
  let sendChain = Promise.resolve();
  function queueSend(task) {
    sendChain = sendChain.then(task).catch(function () { stats.dropped++; });
  }
  // 接收序列化：解密→解码按到达顺序串行（去重/补静音仍在同步段，见 onAudio*）
  let rxChain = Promise.resolve();
  function queuePlay(task) {
    rxChain = rxChain.then(task).catch(function () { stats.dropped++; });
  }
  // 二进制音频帧：[0xBE][type][flags|bit0=enc][d u16be][n u32be][payload]
  // type: 1=PCM16 块，2=opus 打包；payload 明文或 iv||ct（GCM）。JSON+base64 仅用于控制信令
  function binFrame(type, enc, n, d, payload) {
    const out = new Uint8Array(9 + payload.length);
    out[0] = 0xbe; out[1] = type; out[2] = enc ? 1 : 0;
    out[3] = (d >> 8) & 0xff; out[4] = d & 0xff;
    out[5] = (n >>> 24) & 0xff; out[6] = (n >>> 16) & 0xff;
    out[7] = (n >>> 8) & 0xff; out[8] = n & 0xff;
    out.set(payload, 9);
    return out;
  }

  /* ---------- 通话状态机 ---------- */
  async function startCall() {
    try { Net._trace.push((Date.now() % 100000000) + ' vc-startCall'); } catch (e) {}
    if (S.call === 'in-call') return;   // vc-ans 重发会在 await 让出的间隙并发进来，先闸死
    ringStop();
    S.lastErr = null;
    seq = 0;
    pend = null;
    encRem = null; encTs = 0; sendQ = [];   // 上一通的编码残量/待发包不带进新通
    encBroken = false;                      // 上一通的编码器故障给新通一次重试机会
    callGen++;
    dtxOn = false; dtxRun = 0;
    brCheck = 0; brCur = 32000;
    stats.sent = 0; stats.recv = 0; stats.dropped = 0; stats.rebased = 0; stats.peak = 0;
    stats.codec = '';
    stats.dtxMs = 0;
    delete stats.codecErr;
    resetPlayout();
    S.call = 'in-call';                 // 状态在第一个 await 之前落地：杜绝双开采集
    S.callStart = Date.now();
    startTimer();
    requestWake();                       // 通话期间保持亮屏
    refresh();
    try {
      await ensureAudio();
      // 每通轮换：新 ECDH 密钥对 + 作废旧派生；对方同代 vc-k 到达才成钥（vc-kreq 自愈兜底）
      audioKey = null; deriveP = null;
      myGen++;
      await ensureKeyPair(true);
      pkSent = false; sendPk();         // 新公钥三连发出（vc-k 永不明文加密，见 sendCtl）
      // 多人房优先用房间密钥（已由房主 vc-rk 分发，通常即时就绪）；
      // 否则等 ECDH 对密钥（通常 ms 级；超时→明文降级）
      if (!(await useRoomKey())) await awaitAudioKey(1500);
      stats.e2e = audioKey ? 1 : 0;     // 诊断：本通是否端到端加密（0=明文降级）
      await startMic();
      ringStop();                       // 双保险：封杀 await 间隙里才落地的晚到铃声
      startFlush();                     // 编码结果按网络节奏发出（直连 50ms / 中继 100ms）
    } catch (e) {
      const msg = '无法开启麦克风：' + (e && e.message || e);
      S.lastErr = String(msg);
      toast(msg);
      stopTimer();
      stopMic();
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
    releaseWake();
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
      case 'vc-req': {
        if (!S.linked) return;
        const rk = (d.sid || '?') + ':' + (d.cid | 0);
        if (Date.now() - lastReqT < 1000 && rk === lastReqKey) break;   // 同一呼叫者的三次重发（0/150/400ms）
        lastReqT = Date.now();
        lastReqKey = rk;
        if (S.call === 'ringing') {
          // 已有来电在响：当前来电者是重发 → 忽略；别人打入 → 占线回执
          // （新成员拨打通话中/响铃中/拨打中的人，都该收到「对方占线」）
          if (d.sid && callSid && d.sid !== callSid) sendCtl({ t: 'vc-busy', cid: d.cid | 0 });
          return;
        }
        if (S.call !== 'idle') { sendCtl({ t: 'vc-busy', cid: d.cid | 0 }); return; }
        S.call = 'ringing';
        callCid = d.cid | 0;
        callSid = d.sid || '';
        refresh();
        // 竞态：铃声要等 AudioContext/worklet 就绪才起，慢手机上用户可能已经接听
        // （btnAnswer 的 ringStop 跑在前面停了个空）——不加状态闸，晚到的铃声会
        // 整个通话期间一直响，而闭麦只是关麦克风、根本管不到本地振荡器
        ensureAudio().then(function () {
          if (S.call === 'ringing') ringStart('ring');
          // 响铃期间就把麦克风权限/采集备好（权限弹窗与振铃并行），接听瞬间即可出声
          startMic().catch(function () {});
        }).catch(function () {});
        break;
      }
      case 'vc-busy':
        if (d.cid && d.cid !== callCid) break;   // 上一通的迟到占线回执
        if (S.call === 'dialing') {
          ringStop(); stopMic(); S.call = 'idle'; toast('对方占线');
          // 占线撤销：我这一呼可能把房里空闲者拉响了铃，占线就得替我解铃
          // （bc=1：只解响铃，cid 跨端会撞号，不能误伤通话中/拨号中的人）
          sendCtl({ t: 'vc-end', cid: callCid, bc: 1 });
          refresh();
        }
        break;
      case 'vc-ans':
        try { Net._trace.push((Date.now() % 100000000) + ' vc-ans-recv'); } catch (e) {}
        if (d.cid && d.cid !== callCid) break;   // 上一通的迟到应答
        if (S.call === 'dialing') startCall();
        break;
      case 'vc-end':
        if (d.cid && d.cid !== callCid) break;   // 陈旧挂断（上一通的重发）：不受理
        if (d.bc && S.call !== 'ringing') break;   // 占线撤销只解铃，不打扰拨号/通话
        if (S.call === 'dialing') { ringStop(); stopMic(); S.call = 'idle'; toast('对方拒绝了通话'); refresh(); }
        else if (S.call === 'ringing') { ringStop(); stopMic(); S.call = 'idle'; refresh(); }
        else if (S.call === 'in-call') {
          // 多人房：挂断只下线自己。房里还有别人在通话 → 不整体收线；
          // 两人房（或已无人）→ 与原先一致，直接收线
          if (d.sid && callOthers(d.sid) > 0) {
            try { Net._trace.push((Date.now() % 100000000) + ' vc-end keep-others'); } catch (e) {}
            toast('有人挂断了通话');
          } else {
            endCall('对方挂断了通话');
          }
        }
        break;
      case 'vc-mute':
        S.peerMuted = !!d.on;
        refresh();
        break;
      case 'vc-pres':                     // 成员在线通告：昵称 + 通话状态（多人房的花名册）
        if (!d.sid || d.sid === mySid()) break;
        roster[d.sid] = {
          nick: String(d.nick || '成员').slice(0, 12),
          st: d.st || 'idle',
          mute: !!d.mute,
          last: Date.now()
        };
        if (S.mode === 'host' && multiMode) maybeSendRoomKey(d.sid);   // 新成员补发房间钥匙
        sweepRoster();
        break;
      case 'vc-k':
        if (!d.pk) break;
        if (d.sid) pks[d.sid] = { pk: d.pk, g: (d.g | 0) };
        if (d.pk !== peerPk || (d.g | 0) !== peerGen) {   // 首把/对端轮换 → 作废旧派生重来
          peerPk = d.pk; peerGen = (d.g | 0);
          deriveP = null;
          // 多人房音频钥 = 房间密钥，不能被对密钥交换打翻（对密钥只用于 vc-rk 包装）
          if (!roomKey) audioKey = null;
        }
        ensureKeyPair().then(function () {
          sendPk();
          if (S.mode === 'host' && multiMode && d.sid) maybeSendRoomKey(d.sid);
          return deriveAudioKey();
        }, function () {});
        break;
      case 'vc-kreq':                       // 对端音频解不开 → 重发当前公钥（不轮换只重发）
        pkSent = false; sendPk();
        if (S.mode === 'host' && multiMode && d.sid) maybeSendRoomKey(d.sid, true);   // 房间钥匙一并补发
        break;
      case 'vc-rk':                         // 房主分发的多人房房间密钥（用与我的对密钥包装）
        (async function () {
          if (!subtleOk || !d.b || !d.from) return;
          if (d.to && d.to !== mySid()) return;           // 不是发给我的（广播里别人那份）
          try {
            const pair = await derivePairFor(d.from);
            if (!pair) return;
            const raw = await decK(pair, b64ToU8(d.b));
            if (raw.length !== 32) return;
            const k = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
            roomKeyRaw = u8ToB64(raw);
            roomKey = k; audioKey = k;                     // 全员统一切到房间密钥
            stats.e2e = 1;
            try { Net._trace.push((Date.now() % 100000000) + ' vc-rk ok'); } catch (e) {}
          } catch (e) {}
        })();
        break;
      case 'vc-x':                          // 加密控制消息（sendCtl 有钥时整体 GCM）
        (async function () {
          if (!d.b) return;
          const pt = await openBlob(b64ToU8(d.b), true);
          if (!pt) return;
          try { onMessage(JSON.parse(new TextDecoder().decode(pt))); } catch (e) {}
        })();
        break;
    }
  }

  /* ---------- 大厅 ---------- */
  // 两端必须落在同一个 broker 上（信令房间不跨 broker）。选路只由房间号推导：
  // net.js 的 PRIMARY_GROUPS 定义主力组（实测满速无丢包），按房间号哈希在组间
  // 轮转定序、组内按配置顺序，两端同房间必得同一顺序；不在组里的（限速 emqx 等）
  // 恒排末尾仅作连通性兜底。页面加载时的规范顺序缓存下来供选路用。
  let brokerCanon = null;
  try { brokerCanon = Net.brokerList().slice(); } catch (e) {}
  function applyBrokerOrder(room) {
    if (!brokerCanon || !brokerCanon.length) return;
    let groups = [];
    try { groups = Net.brokerPrimaryGroups(); } catch (e) {}
    groups = (groups || []).filter(function (g) { return g && g.length; });
    if (!groups.length) return;
    let h = 5381;
    for (let i = 0; i < room.length; i++) h = ((h << 5) + h + room.charCodeAt(i)) >>> 0;
    const rot = h % groups.length;   // 房间号 → 组间轮转（两端一致）
    const order = [];
    for (let i = 0; i < groups.length; i++) {
      groups[(i + rot) % groups.length].forEach(function (u) {
        if (order.indexOf(u) < 0 && brokerCanon.indexOf(u) >= 0) order.push(u);
      });
    }
    brokerCanon.forEach(function (u) { if (order.indexOf(u) < 0) order.push(u); });
    try { Net.setBrokerOrder(order); } catch (e) {}
  }

  /* ---------- 昵称 / 花名册 / 在线通告（vc-pres） ---------- */
  function mySid() { try { return Net.mySid && Net.mySid(); } catch (e) { return null; } }
  function nickVal() { return String(($('nickInput').value || '')).trim().slice(0, 12); }
  function clearRoster() {
    roster = {};
    multiMode = false;
    spkEnd = {};
  }
  function sendPres() {
    if (!S.mode) return;
    const sid = mySid();
    if (!sid) return;
    try {
      Net.send({ t: 'vc-pres', sid: sid, nick: S.nick, st: S.call, mute: !S.micOn });
    } catch (e) {}
  }
  let presIv = null;
  function startPres() {
    if (presIv) return;
    presIv = setInterval(function () { sendPres(); sweepRoster(); }, 2500);
    sendPres();
  }
  function stopPres() { if (presIv) { clearInterval(presIv); presIv = null; } }
  // 花名册清扫：成员 9s 无通告视为离开（2.5s 周期 ×3 次未见）；
  // 除自己外 ≥2 人 → 多人房（Net.setMulti 锁中继），回到 ≤1 人 → 恢复两人打洞
  function sweepRoster() {
    const now = Date.now();
    let n = 0;
    for (const k in roster) {
      if (now - roster[k].last > 9000) delete roster[k];
      else n++;
    }
    const want = n >= 2;
    if (want !== multiMode) {
      multiMode = want;
      try { Net.setMulti(want); } catch (e) {}
      try { Net._trace.push((Date.now() % 100000000) + ' vc-multi=' + (want ? 1 : 0) + ' n=' + n); } catch (e) {}
      if (want && S.mode === 'host') maybeGenRoomKey();
      sendPres();                       // 切换传输后立刻同步（对端靠它尽快看到全员名单）
    }
    renderRoster();
  }
  // 除自己/指定 sid 外，花名册里还在通话中的人数（vc-end 挂断级联判定）
  function callOthers(excludeSid) {
    let n = 0;
    for (const k in roster) {
      if (k === excludeSid) continue;
      if (roster[k].st === 'in-call') n++;
    }
    return n;
  }
  function escHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function renderRoster() {
    const box = $('rosterCard'), list = $('rosterList');
    if (!box || !list) return;
    if (!S.mode) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const now = Date.now();
    const me = mySid() || 'me';
    const rows = [{ sid: me, nick: S.nick || '我', self: true, st: S.call }];
    for (const k in roster) rows.push({ sid: k, nick: roster[k].nick, self: false, st: roster[k].st });
    S.rosterN = rows.length;
    S.spkIds = Object.keys(spkEnd).join(',');
    S.selfId = me;
    S.ka = audioKey ? (roomKey && audioKey === roomKey ? 2 : 1) : 0;   // 0无钥 1对密钥 2房间密钥
    S.kr = roomKey ? 1 : 0;
    let html = '';
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const spk = now - (spkEnd[r.sid] || 0) < SPK_HOLD;
      html += '<li data-sid="' + escHtml(r.sid) + '"' + (spk ? ' class="spk"' : '') + '>' +
        '<span class="dot"></span><span class="rnick">' + escHtml(r.nick) + (r.self ? '（我）' : '') + '</span>' +
        '<span class="rst">' + (r.st === 'in-call' ? '通话中' : (r.st === 'ringing' ? '响铃中' : '')) + '</span></li>';
    }
    list.innerHTML = html;
  }

  function onCreate() {
    if (S.mode) return;
    if (!nickVal()) { setStatus('请先输入昵称', true); return; }
    const code = String(Math.floor(100000 + Math.random() * 900000));
    S.nick = nickVal();
    try { localStorage.setItem('xqn', S.nick); } catch (e) {}
    S.mode = 'host';
    S.roomId = code;
    $('roomCode').textContent = code;
    $('hostPanel').classList.remove('hidden');
    setStatus('正在建立连接…');
    clearRoster();
    initCrypto();
    applyBrokerOrder(code);
    Net.create(code);
    startPres();
    refresh();
  }
  function onJoin() {
    if (S.mode) return;
    const v = ($('roomInput').value || '').trim();
    if (!/^\d{6}$/.test(v)) { setStatus('请输入 6 位数字房间号', true); return; }
    if (!nickVal()) { setStatus('请先输入昵称', true); return; }
    S.nick = nickVal();
    try { localStorage.setItem('xqn', S.nick); } catch (e) {}
    S.mode = 'guest';
    S.roomId = v;
    setStatus('正在连接房间 ' + v + '…');
    clearRoster();
    initCrypto();
    applyBrokerOrder(v);
    Net.join(v, true);
    startPres();
    refresh();
  }
  function resetLobby() {
    try { Net.destroy(); } catch (e) {}
    stopMic();
    stopPres();
    clearRoster();
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
    $('lobbyCard').classList.toggle('hidden', !!S.mode);   // 入房即离大厅：两个视图不再上下叠放
    $('btnCall').disabled = !S.linked || S.call !== 'idle';
    const hw = $('hostWaiting');
    if (hw && S.mode === 'host') hw.textContent = S.linked ? '已连接，可邀请更多人' : '等待对方加入…';

    $('dialing').classList.toggle('hidden', S.call !== 'dialing');
    $('incoming').classList.toggle('hidden', S.call !== 'ringing');
    $('callCard').classList.toggle('hidden', S.call !== 'in-call');

    $('peerState').textContent = S.linked ? '对方已连接' : (S.mode ? '连接中…' : '对方未加入');
    document.querySelector('.avatar').classList.toggle('live', S.linked);

    $('btnMute').textContent = S.micOn ? '静音' : '取消静音';
    $('callPeer').textContent = S.peerMuted ? '通话中 · 对方已静音' : '通话中';
    updateNetHint();
    updateLinkTag();
    renderRoster();
    sendPres();                 // 状态变化（接通/挂断/静音/入房）即刻同步给房内成员
  }
  function updateNetHint() {
    if (S.disconnected) { $('netHint').textContent = '连接中断，等待恢复…'; return; }
    let h;
    if (!S.relay) h = 'P2P 直连';                             // 两人房：唯一通道就是直连
    else if (S.mesh > 0 && S.mesh >= S.pn) h = 'P2P 直连 · 多人';  // 混合网状：全员两两打通
    else if (S.mesh > 0) h = 'P2P×' + S.mesh + ' · 中继兜底';      // 部分对打通，其余走总线
    else h = '服务器中继';
    if (S.rtt) h += ' · 延迟 ' + S.rtt + 'ms';   // 实测往返时延（hb 时间戳回声，见 net.js rttEma）
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

  // 500ms 轮询：链路徽章 + 实测延迟 + 通话统计 + 花名册（说话高亮靠它刷新）
  setInterval(function () {
    try {
      const d = Net.debugState();
      S.relay = !!(d.settled && d.relay);
      S.rtt = d.rtt || null;
      S.mesh = d.mesh | 0;
      S.pn = d.pn | 0;
    } catch (e) {}
    updateNetHint();
    updateLinkTag();
    renderRoster();
    if (S.call === 'in-call') {
      const tot = stats.recv + stats.dropped;      // 质量徽章：收侧丢包率的就近代用指标
      const loss = tot > 0 ? stats.dropped / tot : 0;
      const q = loss < 0.02 ? '优' : (loss < 0.10 ? '良' : '差');
      $('callStats').textContent = '发送 ' + stats.sent + ' · 接收 ' + stats.recv +
        ' · 重建 ' + stats.rebased + ' · 丢弃 ' + stats.dropped + ' · 质量 ' + q;
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
    ensureKeyPair().then(function () { sendPk(); }, function () {});   // 链路就绪即交换 ECDH 公钥
    refresh();
  });
  Net.on('reconnected', function (e) {
    S.relay = !!(e && e.peer === 'relay');   // 升级/降级都会带 peer 信息
    S.linked = true; S.disconnected = false;
    stopResumeRetry(); hideBanner();
    ensureKeyPair().then(function () { sendPk(); }, function () {});
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
  Net.on('frame', function (u8, sid) {       // 二进制音频帧分发（见 binFrame 布局）；sid=发送方归属
    if (!u8 || u8.length < 9 || u8[0] !== 0xbe) return;
    const type = u8[1], enc = !!(u8[2] & 1);
    const d = (u8[3] << 8) | u8[4];
    const n = ((u8[5] << 24) | (u8[6] << 16) | (u8[7] << 8) | u8[8]) >>> 0;
    const b = u8.subarray(9);
    if (type === 1) onAudio({ n: n, d: d, enc: enc, b: b, sid: sid });
    else if (type === 2) onAudioOpus({ n: n, d: d, enc: enc, b: b, sid: sid });
  });
  window.addEventListener('beforeunload', function () { try { Net.destroy(); } catch (e) {} });
  // 移动端锁屏/切后台：AudioContext 被挂起（采集、播放、铃声全停），OS 还会攒下一堆
  // 过期音频帧。回前台：显式 resume（含响铃中的铃声）、作废播放时间轴（下一帧按断流
  // 重建并抬 prebuf）、250ms 窗口内 flush 掉过期 backlog 只计数不播
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    if (ac && ac.state === 'suspended') {
      try { const p = ac.resume(); if (p && p.catch) p.catch(function () {}); } catch (e) {}
    }
    if (S.call === 'in-call') {
      for (const k in playStates) playStates[k].nextT = 0;   // 各路播放时间轴作废（下一帧按断流重建）
      staleUntil = Date.now() + 250;
      requestWake();                     // wakeLock 在隐藏时被系统释放，回前台重新申请
    }
  });

  /* ---------- 按钮 ---------- */
  try { $('nickInput').value = localStorage.getItem('xqn') || ''; } catch (e) {}   // 昵称记忆
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
    S.call = 'dialing';                // 同步落地：vc-ans 秒回/用户秒取消都不会被状态闸挡住
    callCid = ++dialSeq;               // 本次呼叫 id（对端响铃时记下，回执/挂断按 id 对表）
    refresh();
    sendCtl({ t: 'vc-req', cid: callCid });
    ensureAudio().then(function () {
      if (S.call === 'dialing') ringStart('dial');   // 等待期间可能已接通/取消
      startMic().catch(function () {});              // 拨号即请求权限，接听瞬间已就绪
    }).catch(function (e) { toast('无法开启音频：' + (e && e.message || e)); });
  };
  $('btnCancelCall').onclick = function () {
    ringStop();
    stopMic();
    S.call = 'idle';
    sendCtl({ t: 'vc-end', cid: callCid });
    refresh();
  };
  $('btnAnswer').onclick = function () {
    try { Net._trace.push((Date.now() % 100000000) + ' btnAnswer state=' + S.call); } catch (e) {}
    if (S.call !== 'ringing') return;
    ringStop();
    sendCtl({ t: 'vc-ans', cid: callCid });
    startCall();
  };
  $('btnReject').onclick = function () {
    if (S.call !== 'ringing') return;
    ringStop();
    stopMic();
    sendCtl({ t: 'vc-end', cid: callCid });
    S.call = 'idle';
    refresh();
  };
  $('btnHangup').onclick = function () {
    sendCtl({ t: 'vc-end', cid: callCid });
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
