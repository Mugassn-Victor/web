/* 测试专用：假 PeerJS
   - 注册表放在 window.top（同源 iframe 共享）
   - 信令走顶层窗口消息，数据通道用真实 WebRTC（本机 host 候选即可互通）
   - 模拟 PeerJS 语义：open / connection / error(peer-unavailable, unavailable-id) / DataConnection */
(function () {
  'use strict';
  const topWin = window.top;
  const reg = topWin.__fakePeerReg || (topWin.__fakePeerReg = {});

  function later(fn, ms) { setTimeout(fn, ms || 0); }

  function newPc() { return new RTCPeerConnection({ iceServers: [] }); }

  function waitIce(pc) {
    return new Promise(function (res) {
      if (pc.iceGatheringState === 'complete') { res(); return; }
      let done = false;
      const fin = function () {
        if (done) return;
        done = true;
        pc.removeEventListener('icegatheringstatechange', st);
        res();
      };
      const st = function () { if (pc.iceGatheringState === 'complete') fin(); };
      pc.addEventListener('icegatheringstatechange', st);
      setTimeout(fin, 2500);
    });
  }

  function fire(obj, evt, arg) {
    const hs = obj._handlers && obj._handlers[evt];
    if (hs) hs.slice().forEach(function (fn) { try { fn(arg); } catch (e) { console.error('fakepeer handler err', e); } });
  }

  function Conn(owner, remoteId, pc) {
    this.peer = remoteId;
    this.open = false;
    this._pc = pc;
    this._owner = owner;
    this._handlers = {};
    this._closedFired = false;
    this._dc = null;
  }
  Conn.prototype.on = function (evt, fn) {
    (this._handlers[evt] = this._handlers[evt] || []).push(fn);
    return this;
  };
  Conn.prototype.send = function (o) {
    if (this._dc && this._dc.readyState === 'open') this._dc.send(JSON.stringify(o));
  };
  Conn.prototype.close = function () {
    try { if (this._dc) this._dc.close(); } catch (e) {}
    try { if (this._pc) this._pc.close(); } catch (e) {}
    markClosed(this);
  };
  function markClosed(c) {
    if (c._closedFired) return;
    c._closedFired = true;
    c.open = false;
    fire(c, 'close');
  }
  Conn.prototype._attach = function (dc) {
    const self = this;
    this._dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onopen = function () { self.open = true; fire(self, 'open'); };
    dc.onclose = function () { markClosed(self); };
    dc.onmessage = function (e) {
      let v = e.data;
      try { v = JSON.parse(e.data); } catch (err) {}
      fire(self, 'data', v);
    };
    if (this._pc) {
      this._pc.onconnectionstatechange = function () {
        const s = self._pc.connectionState;
        if (s === 'failed' || s === 'closed') markClosed(self);
      };
    }
    if (dc.readyState === 'open') {
      later(function () { if (!self.open) { self.open = true; fire(self, 'open'); } });
    }
  };

  function Peer(id) {
    const self = this;
    this._handlers = {};
    this._pending = {};          // remoteId -> 发起方等待应答的 Conn
    this.id = id || ('p' + Math.random().toString(36).slice(2, 10));
    if (reg[this.id]) {
      later(function () { fire(self, 'error', { type: 'unavailable-id', message: 'ID 已被占用' }); });
      return;
    }
    reg[this.id] = this;
    later(function () { fire(self, 'open', self.id); });
    this._unload = function () { self.destroy(); };
    window.addEventListener('beforeunload', this._unload);
  }
  Peer.prototype.on = function (evt, fn) {
    (this._handlers[evt] = this._handlers[evt] || []).push(fn);
    return this;
  };
  Peer.prototype.reconnect = function () {};
  Peer.prototype.destroy = function () {
    window.removeEventListener('beforeunload', this._unload);
    if (reg[this.id] === this) delete reg[this.id];
    fire(this, 'close');
  };
  Peer.prototype.connect = function (remoteId) {
    const self = this;
    const pc = newPc();
    const c = new Conn(this, remoteId, pc);
    this._pending[remoteId] = c;
    c._attach(pc.createDataChannel('xq', { ordered: true }));
    if (!reg[remoteId]) {
      later(function () { fire(self, 'error', { type: 'peer-unavailable', message: '对方不在线' }); });
      return c;
    }
    pc.createOffer()
      .then(function (o) { return pc.setLocalDescription(o); })
      .then(function () { return waitIce(pc); })
      .then(function () {
        const target = reg[remoteId];
        if (!target) {
          fire(self, 'error', { type: 'peer-unavailable', message: '对方不在线' });
          return;
        }
        const sdp = pc.localDescription.sdp;
        later(function () { deliver(target, { k: 'offer', from: self.id, sdp: sdp }); });
      })
      .catch(function (e) { fire(self, 'error', { type: 'network', message: String(e) }); });
    return c;
  };

  function deliver(target, m) {
    if (!target || !target._handlers) return;
    if (m.k === 'offer') {
      const pc = newPc();
      const c = new Conn(target, m.from, pc);
      fire(target, 'connection', c);          // PeerJS：收到连接先触发 connection，open 稍后
      pc.ondatachannel = function (e) { c._attach(e.channel); };
      pc.setRemoteDescription({ type: 'offer', sdp: m.sdp })
        .then(function () { return pc.createAnswer(); })
        .then(function (a) { return pc.setLocalDescription(a); })
        .then(function () { return waitIce(pc); })
        .then(function () {
          const src = reg[m.from];
          if (!src) return;
          const sdp = pc.localDescription.sdp;
          later(function () { deliver(src, { k: 'answer', from: target.id, sdp: sdp }); });
        })
        .catch(function () {});
    } else if (m.k === 'answer') {
      const c = target._pending && target._pending[m.from];
      if (!c) return;
      delete target._pending[m.from];
      c._pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }).catch(function () {});
    }
  }

  window.Peer = Peer;
})();
