const config = require('./config')
const debugModule = require('debug')
const mediasoup = require('mediasoup')
const express = require('express')
var expressWs = require('express-ws')
const https = require('https')
const fs = require('fs')
const Logic = require('./logic')
const Action = require('./constants')

// logic服务模块
let logic

// http服务
let expressApp = express()
let httpsServer

const log = debugModule('demo-app')
const warn = debugModule('demo-app:WARN')
const err = debugModule('demo-app:ERROR')

// http静态资源目录
expressApp.use(express.static(__dirname))

async function main() {
    // start mediasoup
    log('starting mediasoup')
    logic = await startMediasoup()

    // start https server, falling back to http if https fails
    log('starting express')
    try {
        const tls = {
            cert: fs.readFileSync(config.sslCrt),
            key: fs.readFileSync(config.sslKey),
        }
        httpsServer = https.createServer(tls, expressApp)
        let wsServer = expressWs(expressApp, httpsServer).app
        wsServer.ws('/sock/:userId/:peerId', function (ws, req) {
            ws.on('message', function (msg) {
                dispatchWsMsg(ws, req.params.peerId, msg)
            })
            ws.on('close', function (ev) {
                logic.onDisconnected(ws, req.params.peerId)
            })
            logic.onConnected(ws, req.params.userId, req.params.peerId)
        })
        httpsServer.on('error', (e) => {
            err('https server error,', e.message)
        })
        await new Promise((resolve) => {
            httpsServer.listen(config.httpPort, config.httpIp, () => {
                log(`server is running and listening on ` +
                    `https://${config.httpIp}:${config.httpPort}`)
                resolve()
            })
        })
    } catch (e) {
        // https启动失败将启动http服务
        err('server start up failed: ' + JSON.stringify(e))
        process.kill(1)
    }

}

main()


//
// 启动mediasoup服务 仅一个工作进程
//
async function startMediasoup() {
    logic = new Logic()
    // 工作进程的端口号范围40000-49999
    let worker = await mediasoup.createWorker({
        logLevel: config.mediasoup.worker.logLevel,
        logTags: config.mediasoup.worker.logTags,
        rtcMinPort: config.mediasoup.worker.rtcMinPort,
        rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
    })

    // 工作进程结束将结束主进程
    worker.on('died', () => {
        err('mediasoup worker died (this should never happen)')
        process.exit(1)
    })

    // 所有支持的编解码格式
    const mediaCodecs = config.mediasoup.router.mediaCodecs

    // SFU创建路由
    const router = await worker.createRouter({mediaCodecs})

    logic.setRouter(router)

    return logic
}

//
// -- our minimal signaling is just http polling --
//

// parse every request body for json, no matter the content-type. this
// lets us use sendBeacon or fetch interchangeably to POST to
// signaling endpoints. (sendBeacon can't set the Content-Type header)
//
expressApp.use(express.json({type: '*/*'}))

function dispatchWsMsg(ws, peerId, msg) {
    const obj = JSON.parse(msg)
    if (obj.act === Action.HEARTBEAT) { // 心跳检测
        logic.onHeartBeat(ws, peerId)
    } else if (obj.act === Action.MESSAGE) {
        logic.handleMessage(ws, peerId, obj.data)
    }
}

// --> /signaling/fetch-capabilities
// 客户端启动后首先获取通讯和音视频描述
expressApp.post('/signaling/fetch-capabilities', async (req, res) => {
    let capabilities = await logic.handleFetchCapabilities()
    res.send(capabilities)
})

// --> /signaling/create-transport
// 客户端请求创建一个rtc传输连接  direction标识是上行还是下行
expressApp.post('/signaling/create-transport', async (req, res) => {
    let {peerId, direction} = req.body
    if (!logic.checkExist(peerId)) {
        res.send({error: 'offline'})
        return
    }
    const result = await logic.handleCreateTransport(peerId, direction)
    res.send(result)
})

// --> /signaling/connect-transport
// 创建后自然要连接传输组件
expressApp.post('/signaling/connect-transport', async (req, res) => {
    let {peerId, transportId, dtlsParameters} = req.body
    if (!logic.checkExist(peerId)) {
        res.send({error: 'offline'})
        return
    }
    const result = await logic.handleConnectTransport({peerId, transportId, dtlsParameters})
    res.send(result)
})

// --> /signaling/close-transport
// 关闭传输
expressApp.post('/signaling/close-transport', async (req, res) => {
    let {peerId, transportId} = req.body
    if (!logic.checkExist(peerId)) {
        res.send({error: 'offline'})
        return
    }
    const result = await logic.handleCloseTransport({peerId, transportId})
    res.send(result)
})

// --> /signaling/close-producer
// 关闭生产者
expressApp.post('/signaling/close-producer', async (req, res) => {
    let {peerId, producerId} = req.body
    if (!logic.checkExist(peerId)) {
        res.send({error: 'offline'})
        return
    }
    let result = await logic.handleCloseProducer({peerId, producerId})
    res.send(result)
})

// --> /signaling/send-track
// 当客户端创建一个传输通道后，会监听该传输通道的生产者建立，再调用该接口获取生产者id
expressApp.post('/signaling/send-track', async (req, res) => {
    // 取出req中的传输信息
    let {peerId, transportId, kind, rtpParameters, paused = false, appData} = req.body
    if (!logic.checkExist(peerId)) {
        res.send({error: 'offline'})
        return
    }
    let result = await logic.handleSendTrack({peerId, transportId, kind, rtpParameters, paused, appData})
    res.send(result)
})

// --> /signaling/recv-track
// 请求接收流 创建消费者
expressApp.post('/signaling/recv-track', async (req, res) => {
    // 获取请求者的rtc和媒体信息  mediapeerid是 订阅某个生产者的连接id
    let {peerId, mediaPeerId, mediaTag, rtpCapabilities} = req.body
    if (!logic.checkExist(peerId)) {
        res.send({error: 'offline'})
        return
    }
    let result = await logic.handleRecvTrack({peerId, mediaPeerId, mediaTag, rtpCapabilities})
    res.send(result)
})

// --> /signaling/pause-consumer
// 暂停消费
expressApp.post('/signaling/pause-consumer', async (req, res) => {
    let {peerId, consumerId} = req.body
    if (!logic.checkExist(peerId)) {
        res.send({error: 'offline'})
        return
    }
    let result = await logic.handlePauseConsumer({peerId, consumerId})
    res.send(result)
})

// --> /signaling/resume-consumer
// 重新唤醒消费   等于一个播放暂停/继续 按钮
expressApp.post('/signaling/resume-consumer', async (req, res) => {
    let {peerId, consumerId} = req.body
    if (!logic.checkExist(peerId)) {
        res.send({error: 'offline'})
        return
    }
    let result = await logic.handleResumeConsumer({peerId, consumerId})
    res.send(result)
})

// --> /signalign/close-consumer
// 关闭消费者
expressApp.post('/signaling/close-consumer', async (req, res) => {
    let {peerId, consumerId} = req.body
    if (!logic.checkExist(peerId)) {
        res.send({error: 'offline'})
        return
    }
    let result = await logic.handleCloseConsumer({peerId, consumerId})
    res.send(result)
})

// --> /signaling/pause-producer
// 生产者暂停
expressApp.post('/signaling/pause-producer', async (req, res) => {
    let {peerId, producerId} = req.body
    if (!logic.checkExist(peerId)) {
        res.send({error: 'offline'})
        return
    }
    let result = await logic.handlePauseProducer({peerId, producerId})
    res.send(result)
})

// --> /signaling/resume-producer
// 生产者唤醒
expressApp.post('/signaling/resume-producer', async (req, res) => {
    let {peerId, producerId} = req.body
    if (!logic.checkExist(peerId)) {
        res.send({error: 'offline'})
        return
    }
    let result = await logic.handleResumeProducer({peerId, producerId})
    res.send(result)
})
