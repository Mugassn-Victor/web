/* 测试专用：PeerJS 桩——永不建立连接，迫使系统只走 MQTT 备用信令 */
window.Peer = function (id) {
  const handlers = {};
  this.id = id;
  this.on = function (evt, fn) { handlers[evt] = fn; return this; };
  this.reconnect = function () {};
  this.destroy = function () {};
  this.connect = function () {
    return {
      peer: '',
      open: false,
      on: function () { return this; },
      send: function () {},
      close: function () {}
    };
  };
};
