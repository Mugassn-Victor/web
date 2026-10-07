/* MiniMQTT：浏览器内最小 MQTT 3.1.1 客户端，仅依赖 WebSocket。
   用作联机的备用信令通道——公共 broker 无需注册，restricted 网络通常可达。
   支持多端点轮询：连接失败自动尝试下一个。
   收包按状态机拼帧：MQTT 包可能被拆在多个 WS 帧里（大音频包尤其常见），
   解析不完的尾部必须留到下一帧——直接丢弃会造成 20~30% 的“离奇丢包”。 */
'use strict';

function MiniMQTT(opts) {
  this.urls = opts.urls || [];
  this.onopen = opts.onopen || function () {};
  this.onmessage = opts.onmessage || function () {};
  this.onerror = opts.onerror || function () {};
  this.onclose = opts.onclose || function () {};
  this._ws = null;
  this._idx = 0;
  this._opened = false;
  this._closed = false;
  this._subs = [];
  this._pend = null;              // 跨 WS 帧的收包残尾
  this._nextPid = 1;              // SUBSCRIBE 用的包标识（规范要求非 0）
  this._pingTimer = null;
  this._tryTimer = null;
  this._connectTimeout = opts.connectTimeout || 5000;
}

MiniMQTT.prototype.connect = function () {
  if (this._closed) return;
  this._idx = 0;
  this._urlTries = 0;
  this._tryNext();
};

MiniMQTT.prototype._tryNext = function () {
  this.tryN = (this.tryN | 0) + 1;         // 诊断计数：第几次尝试连接
  if (this._closed) return;
  if (this._idx >= this.urls.length) {
    this.onerror('所有备用信令地址均连接失败');
    this.onclose();
    return;
  }
  const url = this.urls[this._idx];
  this._pend = null;                      // 换连接从干净的解析状态开始
  let ws;
  try {
    ws = new WebSocket(url, 'mqtt');
  } catch (e) {
    this._tryTimer = setTimeout(this._tryNext.bind(this), 0);
    return;
  }
  this._ws = ws;
  ws.binaryType = 'arraybuffer';

  let settled = false;
  const fail = function () {
    if (settled || this._closed) return;
    settled = true;
    this.failN = (this.failN | 0) + 1;     // 诊断计数：单次尝试失败次数
    clearTimeout(this._tryTimer);
    try { ws.close(); } catch (e) {}
    if (this._ws === ws) this._ws = null;
    // 同一地址先退避重试再换下一个：公共 broker 常有按 IP 的握手限速，
    // 两端若因瞬时限速各奔不同 broker，房间消息互不可见就永远连不上；
    // 固定重试同一地址能让两端最终收敛到同一 broker。
    this._urlTries = (this._urlTries | 0) + 1;
    if (this._urlTries < 3) {
      this._tryTimer = setTimeout(this._tryNext.bind(this), this._urlTries === 1 ? 600 : 1800);
    } else {
      this._urlTries = 0;
      this._idx++;
      this._tryTimer = setTimeout(this._tryNext.bind(this), 200);
    }
  }.bind(this);

  this._tryTimer = setTimeout(fail, this._connectTimeout);

  ws.onopen = function () {
    ws.send(this._buildConnect());
  }.bind(this);

  ws.onerror = function () { fail(); };

  ws.onclose = function () {
    // 未建立就断开：交给 fail 处理。注意顺序——必须先判 !opened 再清定时器：
    // error→close 连发时 fail 已安排了 200ms 重试，先 clearTimeout 会把它杀掉，
    // 而随后的 fail() 又因 settled 直接返回 → 永远卡死（换 broker 循环失效的根源）
    if (!this._opened) { fail(); return; }
    clearTimeout(this._tryTimer);
    if (this._closed) return;
    this._opened = false;
    clearInterval(this._pingTimer);
    this.onclose();
  }.bind(this);

  ws.onmessage = (function (ev) {
    this._feed(new Uint8Array(ev.data));
  }).bind(this);
  this._pendingUrl = url;
};

MiniMQTT.prototype._feed = function (bytes) {
  // 先拼上一帧没解析完的残尾（MQTT 包 ≠ WS 帧边界）
  if (this._pend && this._pend.length) {
    const m = new Uint8Array(this._pend.length + bytes.length);
    m.set(this._pend, 0);
    m.set(bytes, this._pend.length);
    bytes = m;
  }
  let off = 0;
  let incomplete = false;
  while (off < bytes.length) {
    if (off + 2 > bytes.length) { incomplete = true; break; }
    const type = bytes[off] >> 4;
    let mul = 1, rl = 0, p = off + 1, b;
    let hdrTrunc = false;
    do {
      if (p >= bytes.length) { hdrTrunc = true; break; }   // 变长头都被拆了：留到下一帧
      b = bytes[p++];
      rl += (b & 127) * mul;
      mul *= 128;
      if (mul > 128 * 128 * 128 * 128) { this._pend = null; return; }   // 畸形流：全丢重来
    } while ((b & 128) !== 0);
    if (hdrTrunc) { incomplete = true; break; }
    const bodyStart = p, bodyEnd = p + rl;
    if (bodyEnd > bytes.length) { incomplete = true; break; }           // 包体没到齐：留到下一帧

    if (type === 2) {                       // CONNACK
      const rc = bytes[bodyStart + 1];
      if (rc !== 0) {
        this.onerror('信令拒绝连接 rc=' + rc);
        try { this._ws.close(); } catch (e) {}
        this._opened = false;
      } else if (!this._opened) {
        this._opened = true;
        clearTimeout(this._tryTimer);
        for (let i = 0; i < this._subs.length; i++) this._sendSub(this._subs[i]);
        this._pingTimer = setInterval(this._ping.bind(this), 25000);
        this.onopen();
      }
    } else if (type === 3) {                // PUBLISH（订阅均为 QoS0，正常不会带 pid）
      this.rxN = (this.rxN | 0) + 1;        // 诊断计数：实际收到的包数
      const tlen = (bytes[bodyStart] << 8) | bytes[bodyStart + 1];
      const topic = this._utf8(bytes.subarray(bodyStart + 2, bodyStart + 2 + tlen));
      // 0xBE/0xBF 开头 = 二进制音频帧（UTF-8 解码会毁掉字节）；其余按 JSON 文本走
      const raw = bytes.subarray(bodyStart + 2 + tlen, bodyEnd);
      const payload = (raw.length && (raw[0] === 0xbe || raw[0] === 0xbf))
        ? raw.slice() : this._utf8(raw);
      this.onmessage(topic, payload);
    }
    // SUBACK/PINGRESP 等直接跳过
    off = bodyEnd;
  }
  this._pend = incomplete ? bytes.slice(off) : null;
};

MiniMQTT.prototype._utf8 = function (u8) {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(u8);
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return s;
};

MiniMQTT.prototype._bytes = function (s) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
  const out = [];
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xff);
  return new Uint8Array(out);
};

MiniMQTT.prototype._u16 = function (n) { return [(n >> 8) & 0xff, n & 0xff]; };

MiniMQTT.prototype._rl = function (n) {
  const out = [];
  do {
    let d = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) d |= 128;
    out.push(d);
  } while (n > 0);
  return out;
};

MiniMQTT.prototype._pkt = function (header, bodyArr) {
  return new Uint8Array([header].concat(this._rl(bodyArr.length), bodyArr));
};

MiniMQTT.prototype._buildConnect = function () {
  const name = this._bytes('MQTT');
  const id = this._bytes('xq' + Math.random().toString(36).slice(2, 10));
  const body = []
    .concat(this._u16(name.length), Array.from(name))
    .concat([4, 0x02])                 // level 4, clean session
    .concat(this._u16(60))             // keepalive 60s
    .concat(this._u16(id.length), Array.from(id));
  return this._pkt(0x10, body);
};

MiniMQTT.prototype._sendSub = function (topic) {
  const t = this._bytes(topic);
  // SUBSCRIBE 的包标识规范上必须非 0（有的 broker 会拒绝 0）：取自统一计数器
  let pid = this._nextPid++;
  if (this._nextPid >= 65536) this._nextPid = 1;
  const body = this._u16(pid).concat(this._u16(t.length), Array.from(t), [0]);
  this._send(this._pkt(0x82, body));
};

MiniMQTT.prototype._ping = function () {
  this._send(new Uint8Array([0xc0, 0x00]));
};

MiniMQTT.prototype._send = function (u8) {
  try { if (this._ws && this._ws.readyState === 1) this._ws.send(u8); } catch (e) {}
};

MiniMQTT.prototype.subscribe = function (topic) {
  if (this._subs.indexOf(topic) < 0) this._subs.push(topic);
  if (this._opened) this._sendSub(topic);
};

MiniMQTT.prototype.publish = function (topic, payload, retain) {
  this.txN = (this.txN | 0) + 1;           // 诊断计数：实际发出的包数
  const t = this._bytes(topic);
  const p = (payload instanceof Uint8Array) ? payload : this._bytes(payload);   // 二进制载荷直通
  const body = this._u16(t.length).concat(Array.from(t), Array.from(p));
  // header 0x30 = PUBLISH QoS0，retain 位 0x01
  this._send(this._pkt(0x30 + (retain ? 1 : 0), body));
};

MiniMQTT.prototype.close = function () {
  if (this._closed) return;
  this._closed = true;
  clearTimeout(this._tryTimer);
  clearInterval(this._pingTimer);
  this._opened = false;
  this._pend = null;
  try {
    if (this._ws && this._ws.readyState <= 1) {
      this._ws.send(new Uint8Array([0xe0, 0x00]));   // DISCONNECT
      this._ws.close();
    }
  } catch (e) {}
  this._ws = null;
};
