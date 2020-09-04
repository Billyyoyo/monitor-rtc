const config = require('./config')
const debugModule = require('debug')
const mediasoup = require('mediasoup')
const express = require('express')
const expressWs = require('express-ws')
const https = require('https')
const fs = require('fs')
const os = require('os')
const Logic = require('./logic')
const Action = require('./constants')
const expressLogger = require('./logger').getExpressLogger()
const log = require('./logger').getLogger('logic')
const {getUserBySiteNo, getUserById, getRooms} = require('./dao')

// 多cpu核心负载均衡工作单元
let workers = []

// logic服务模块
let logics = []

// http服务
let expressApp = express()
expressApp.use(expressLogger)
let httpsServer

// http静态资源目录
expressApp.use(express.static(__dirname))

function getPreferenceWorker() {
    let min = null
    workers.forEach(worker => {
        if (min) {
            if (min.appData.balance > worker.appData.balance) {
                min = worker
            }
        } else {
            min = worker
        }
    })
    return min
}

function getRoomByPeerId(peerId) {
    const l = logics.find(l => l.checkExist(peerId))
    return l
}

async function initWorkers() {
    // 工作进程的端口号范围40000-49999
    const coreCount = os.cpus().length
    let ports = parseInt((config.mediasoup.worker.rtcMaxPort - config.mediasoup.worker.rtcMinPort) / coreCount)
    let portStart = config.mediasoup.worker.rtcMinPort
    for (let i = 0; i < coreCount; i++) {
        let worker = await mediasoup.createWorker({
            logLevel: config.mediasoup.worker.logLevel,
            logTags: config.mediasoup.worker.logTags,
            rtcMinPort: portStart + ports * i,
            rtcMaxPort: portStart + ports * (i + 1) - 1,
        })
        worker.appData.balance = 0
        // 工作进程结束将结束主进程
        worker.on('died', () => {
            log.error('mediasoup worker died (this should never happen)')
            process.exit(1)
        })
        workers.push(worker)
    }
}

async function createRooms() {
    let list = await getRooms()
    for (const i in list) {
        const room = list[i]
        let worker = getPreferenceWorker()
        // 所有支持的编解码格式
        const mediaCodecs = config.mediasoup.router.mediaCodecs
        // SFU创建路由
        const router = await worker.createRouter({mediaCodecs})
        worker.appData.balance++
        let logic = new Logic(room.id, router)
        logics.push(logic)
        log.info('create room: ' + room.id + ' name:' + room.name + ' in worker: ' + worker.pid + ' balance: ' + worker.appData.balance)
    }
}

async function main() {
    // start mediasoup
    log.info('starting rtc workers')
    await initWorkers()
    await createRooms()

    // start https server, falling back to http if https fails
    log.info('starting express')
    try {
        const tls = {
            cert: fs.readFileSync(config.sslCrt),
            key: fs.readFileSync(config.sslKey),
        }
        httpsServer = https.createServer(tls, expressApp)
        let wsServer = expressWs(expressApp, httpsServer).app
        wsServer.ws('/sock/:userId/:peerId', async function (ws, req) {
            ws.on('message', function (msg) {
                dispatchWsMsg(ws, ws.peerId, msg)
            })
            ws.on('close', function (ev) {
                if (ws.peerId) {
                    let logic = getRoomByPeerId(ws.peerId)
                    if (logic) {
                        logic.onDisconnected(ws, ws.peerId)
                    }
                }
            })
            // 客户端建立连接
            let user = await getUserById(req.params.userId)
            if (!user) {
                ws.close()
                return
            }
            ws.peerId = req.params.peerId
            let logic = logics.find(l => l.id === user.roomId)
            if (logic) {
                log.info(`user: ${user.name} connect to logic room ${logic.id}`)
                logic.onConnected(ws, user, req.params.peerId).then(r => {
                })
            } else {
                ws.close()
            }
        })
        httpsServer.on('error', (e) => {
            log.error('https server error,', e.message)
        })
        await new Promise((resolve) => {
            httpsServer.listen(config.httpPort, config.httpIp, () => {
                log.info(`server is running and listening on ` +
                    `https://${config.httpIp}:${config.httpPort}`)
                resolve()
            })
        })
    } catch (e) {
        // https启动失败将启动http服务
        log.error('server start up failed: ' + JSON.stringify(e))
        process.kill(1)
    }

}

main()

expressApp.use(express.json({type: '*/*'}))

function dispatchWsMsg(ws, peerId, msg) {
    const obj = JSON.parse(msg)
    let logic = getRoomByPeerId(ws.peerId)
    if (!logic) {
        ws.send({error: 'no room'})
        return
    }
    if (obj.act === Action.HEARTBEAT) { // 心跳检测
        getRoomByPeerId(peerId).onHeartBeat(ws, peerId)
    } else if (obj.act === Action.MESSAGE) {
        getRoomByPeerId(peerId).handleMessage(ws, peerId, obj.data)
    }
}

// --> /signaling/create-rooms
// 创建所有房间
expressApp.post('/signaling/create-rooms', async (req, res) => {
    // 释放每个房间
    logics.forEach((l) => {
        l.release()
    })
    logics.splice(0, logics.length)
    workers.forEach(w => {
        w.appData.balance = 0
    })
    // todo 从项目服务器调用接口  加载项目数据作为房间  目前直接从db中加载
    await createRooms()
    res.send({ret: 0})
})

// --> /signaling/user-info
// 根据用户座位号返回用户信息
expressApp.post('/signaling/user-info', async (req, res) => {
    let {siteNo} = req.body
    if (siteNo) {
        let user = await getUserBySiteNo(siteNo)
        if (user && user.id) {
            res.send(user)
        } else {
            res.send({error: 'no user'})
        }
    } else {
        res.send({error: 'no user'})
    }
})

// --> /signaling/fetch-capabilities
// 客户端启动后首先获取通讯和音视频描述
expressApp.post('/signaling/fetch-capabilities', async (req, res) => {
    const index = Math.round(Math.random() * logics.length)
    let capabilities = await logics[index].handleFetchCapabilities()
    res.send(capabilities)
})

// --> /signaling/create-transport
// 客户端请求创建一个rtc传输连接  direction标识是上行还是下行
expressApp.post('/signaling/create-transport', async (req, res) => {
    let {peerId, direction} = req.body
    let logic = getRoomByPeerId(peerId)
    if (!logic) {
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
    let logic = getRoomByPeerId(peerId)
    if (!logic) {
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
    let logic = getRoomByPeerId(peerId)
    if (!logic) {
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
    let logic = getRoomByPeerId(peerId)
    if (!logic) {
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
    let logic = getRoomByPeerId(peerId)
    if (!logic) {
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
    let logic = getRoomByPeerId(peerId)
    if (!logic) {
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
    let logic = getRoomByPeerId(peerId)
    if (!logic) {
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
    let logic = getRoomByPeerId(peerId)
    if (!logic) {
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
    let logic = getRoomByPeerId(peerId)
    if (!logic) {
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
    let logic = getRoomByPeerId(peerId)
    if (!logic) {
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
    let logic = getRoomByPeerId(peerId)
    if (!logic) {
        res.send({error: 'offline'})
        return
    }
    let result = await logic.handleResumeProducer({peerId, producerId})
    res.send(result)
})
