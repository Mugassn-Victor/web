/* MiniMQTT：浏览器内最小 MQTT 3.1.1 客户端（QoS 0），仅依赖 WebSocket。
   用作联机的备用信令通道——公共 broker 无需注册，restricted 网络通常可达。
   支持多端点轮询：连接失败自动尝试下一个。 */
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
  this._pingTimer = null;
  this._tryTimer = null;
  this._connectTimeout = opts.connectTimeout || 5000;
}

MiniMQTT.prototype.connect = function () {
  if (this._closed) return;
  this._idx = 0;
  this._tryNext();
};

MiniMQTT.prototype._tryNext = function () {
  if (this._closed) return;
  if (this._idx >= this.urls.length) {
    this.onerror('所有备用信令地址均连接失败');
    this.onclose();
    return;
  }
  const url = this.urls[this._idx++];
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
    clearTimeout(this._tryTimer);
    try { ws.close(); } catch (e) {}
    this._ws = null;
    this._tryTimer = setTimeout(this._tryNext.bind(this), 200);
  }.bind(this);

  this._tryTimer = setTimeout(fail, this._connectTimeout);

  ws.onopen = function () {
    ws.send(this._buildConnect());
  }.bind(this);

  ws.onerror = function () { fail(); };

  ws.onclose = function () {
    clearTimeout(this._tryTimer);
    if (!this._opened) { fail(); return; }
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
  let off = 0;
  while (off < bytes.length) {
    if (off + 2 > bytes.length) break;
    const type = bytes[off] >> 4;
    let mul = 1, rl = 0, p = off + 1, b;
    do {
      if (p >= bytes.length) return;
      b = bytes[p++];
      rl += (b & 127) * mul;
      mul *= 128;
      if (mul > 128 * 128 * 128 * 128) return;
    } while ((b & 128) !== 0);
    const bodyStart = p, bodyEnd = p + rl;
    if (bodyEnd > bytes.length) break;

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
    } else if (type === 3) {                // PUBLISH (QoS0)
      const tlen = (bytes[bodyStart] << 8) | bytes[bodyStart + 1];
      const topic = this._utf8(bytes.subarray(bodyStart + 2, bodyStart + 2 + tlen));
      const payload = this._utf8(bytes.subarray(bodyStart + 2 + tlen, bodyEnd));
      this.onmessage(topic, payload);
    }
    // SUBACK/PINGRESP 等直接跳过
    off = bodyEnd;
  }
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
  const body = [0, 1].concat(this._u16(t.length), Array.from(t), [0]);
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
  const t = this._bytes(topic);
  const p = this._bytes(payload);
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
  try {
    if (this._ws && this._ws.readyState <= 1) {
      this._ws.send(new Uint8Array([0xe0, 0x00]));   // DISCONNECT
      this._ws.close();
    }
  } catch (e) {}
  this._ws = null;
};
