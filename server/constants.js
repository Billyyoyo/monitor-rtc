const Action = {
    HEARTBEAT: 0, // 心跳
    CONNECTED: 1, // 连接成功
    JOIN: 2,    // 某某进入房间
    READY: 3,       // 媒体流准备就绪
    LEAVE: 4,   // 某某离开房间
    MESSAGE: 5,     // 消息
    SUCCESS: 6,     // 发送消息成功回执
}

module.exports = Action