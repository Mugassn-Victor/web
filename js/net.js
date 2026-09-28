/* PeerJS 封装：房间号即 PeerID，数据走 WebRTC DataChannel */
'use strict';

const Net = (function () {

  let peer = null;
  let conn = null;
  const handlers = {};

  function on(evt, fn) { handlers[evt] = fn; }
  function emit(evt, data) { if (handlers[evt]) handlers[evt](data); }

  function setupConn(c, role) {
    conn = c;
    c.on('open', function () { emit('connected', { role: role, peer: c.peer }); });
    c.on('data', function (d) { emit('data', d); });
    c.on('close', function () { emit('closed'); });
    c.on('error', function (e) { emit('conn-error', e); });
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
    const p = newPeer(roomId);
    p.on('connection', function (c) { setupConn(c, 'host'); });
  }

  // 加房
  function join(roomId) {
    const p = newPeer();
    p.on('open', function () {
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
    try { if (conn) conn.close(); } catch (e) {}
    try { if (peer) peer.destroy(); } catch (e) {}
    conn = null; peer = null;
  }

  function isConnected() { return !!(conn && conn.open); }

  return { on: on, create: create, join: join, send: send, destroy: destroy, isConnected: isConnected };
})();
