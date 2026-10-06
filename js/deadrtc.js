/* 测试专用：把 RTCPeerConnection 的所有 ICE 候选（本机/服务器/中继）全部剥掉，
   模拟 P2P 完全打不通（STUN/TURN 全挂），迫使系统走 broker 中继兜底。
   由 index.html 在 net.js 之前按 ?deadrtc=1 注入。 */
(function () {
  const Orig = window.RTCPeerConnection;
  const realDesc = Object.getOwnPropertyDescriptor(Orig.prototype, 'localDescription').get;
  function strip(sdp) {
    return String(sdp).split('\n').filter(function (l) {
      return l.indexOf('a=candidate') !== 0;
    }).join('\n');
  }
  window.RTCPeerConnection = function (cfg, mc) {
    const pc = new Orig(cfg, mc);
    Object.defineProperty(pc, 'localDescription', {
      get: function () {
        const d = realDesc.call(pc);
        return d ? { type: d.type, sdp: strip(d.sdp) } : null;
      }
    });
    const origSetRemote = pc.setRemoteDescription.bind(pc);
    pc.setRemoteDescription = function (d) {
      return origSetRemote(d && d.sdp ? { type: d.type, sdp: strip(d.sdp) } : d);
    };
    return pc;
  };
  window.RTCPeerConnection.prototype = Orig.prototype;
})();
