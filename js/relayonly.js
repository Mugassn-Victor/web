/* 测试专用：把 RTCPeerConnection 变成 relay-only（过滤掉所有非 relay 候选），
   模拟 P2P 打洞不通、TURN 全挂，用来验证 broker 中继兜底 */
(function () {
  const Orig = window.RTCPeerConnection;
  const realDesc = Object.getOwnPropertyDescriptor(Orig.prototype, 'localDescription').get;
  function filt(s) {
    return String(s).split('\n').filter(function (l) {
      if (l.indexOf('a=candidate') !== 0) return true;
      return l.indexOf(' typ relay ') >= 0;
    }).join('\n');
  }
  window.RTCPeerConnection = function (cfg, mc) {
    const pc = new Orig(cfg, mc);
    Object.defineProperty(pc, 'localDescription', {
      get: function () {
        const d = realDesc.call(pc);
        return d ? { type: d.type, sdp: filt(d.sdp) } : null;
      }
    });
    return pc;
  };
  window.RTCPeerConnection.prototype = Orig.prototype;
})();
