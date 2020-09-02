import {uuidv4} from "./util";

const Action = {
    HEARTBEAT: 0, // 心跳
    CONNECTED: 1, // 连接成功
    JOIN: 2,    // 某某进入房间
    READY: 3,       // 媒体流准备就绪
    LEAVE: 4,   // 某某离开房间
    MESSAGE: 5,     // 消息
    SUCCESS: 6,     // 发送消息成功回执
}

let self

export class Communicator {
    constructor({onConnected, onErrorOrClose, onJoin, onLeave, onMessage, onSuccess, onReady}) {
        this.peerId = ''
        this.connected = false
        this.lastHeartBeatTs = 0
        this.looper = null
        this.onErrorOrCloseCallback = onErrorOrClose
        this.onConnected = onConnected
        this.onJoin = onJoin
        this.onLeave = onLeave
        this.onMessage = onMessage
        this.onSuccess = onSuccess
        this.onReady = onReady
        self = this
    }

    _onOpen(ev) {
        console.log('websocket connected to server')
    }

    _onClose(ev) {
        console.log('websocket disconnected')
        self.onErrorOrCloseCallback('连接断开')
        self.connected = false
        if (this.looper) {
            clearInterval(this.looper)
        }
    }

    _onError(ev) {
        console.error(ev)
        self.onErrorOrCloseCallback('连接异常')
        self.connected = false
        if (this.looper) {
            clearInterval(this.looper)
        }
    }

    _onMessage(ev) {
        const action = JSON.parse(ev.data)
        if (action.act === Action.CONNECTED) {
            self.connected = true
            self._loop().then(r => {
            })
            self.onConnected(action.data)
            self.lastHeartBeatTs = new Date().getTime()
        } else if (action.act === Action.HEARTBEAT) {
            self.lastHeartBeatTs = new Date().getTime()
        } else if (action.act === Action.JOIN) {
            self.onJoin(action.data)
        } else if (action.act === Action.LEAVE) {
            self.onLeave(action.data)
        } else if (action.act === Action.MESSAGE) {
            self.onMessage(action.data)
        } else if (action.act === Action.SUCCESS) {
            self.onSuccess(action.data)
        } else if (action.act === Action.READY) {
            self.onReady(action.data)
        }
    }

    async _loop() {
        self.looper = setInterval(() => {
            if (self.connected && self.ws) {
                self.ws.send(JSON.stringify({act: Action.HEARTBEAT}))
                let curr = new Date().getTime()
                if (curr - self.lastHeartBeatTs > 15000) {
                    self.ws.close()
                    if (self.looper) {
                        clearInterval(self.looper)
                    }
                }
            }
        }, 5000)
    }

    async send(text) {
        let currTime = new Date().getTime()
        let data = {
            userId: this.userId,
            peerId: this.peerId,
            text: text,
            time: currTime,
            seq: currTime
        }
        let msg = {
            act: Action.MESSAGE,
            data: data
        }
        this.ws.send(JSON.stringify(msg))
    }

    async post(endpoint, data) {
        try {
            let headers = {'Content-Type': 'application/json'},
                body = JSON.stringify({...data, peerId: this.peerId})

            let response = await fetch(
                'https' + window.rtc_url + '/signaling/' + endpoint, {method: 'POST', body, headers}
            )
            return await response.json()
        } catch (e) {
            console.error(e)
            return {error: e}
        }
    }

    disconnect() {
        if (this.ws) {
            this.ws.close()
        }
    }

    connect() {
        this.peerId = uuidv4()
        let url = `wss${window.rtc_url}/sock/${this.userId}/${this.peerId}`
        console.log('start connect to server:' + url)
        this.ws = new WebSocket(url)
        this.ws.onopen = this._onOpen
        this.ws.onclose = this._onClose
        this.ws.onerror = this._onError
        this.ws.onmessage = this._onMessage
    }

    reconnect() {
        this.connected = false
        this.lastHeartBeatTs = 0
        this.looper = null
        this.connect()
    }

    setUserInfo(userId, roomId) {
        this.userId = userId
        this.roomId = roomId
    }
}