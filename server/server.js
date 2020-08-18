const config = require('./config');
const debugModule = require('debug');
const mediasoup = require('mediasoup');
const express = require('express');
const https = require('https');
const fs = require('fs');
const {getPort} = require('./port')
const FFmpeg = require('./ffmpeg')

// http服务
const expressApp = express();
let httpsServer;

const log = debugModule('demo-app');
const warn = debugModule('demo-app:WARN');
const err = debugModule('demo-app:ERROR');

// one mediasoup worker and router
// audioLevelObserver ： 用于检测声音的大小， 通过C++检测音频声音返回应用层，通过Observer接收并展示音频大小
let worker, router, audioLevelObserver;


//
// 只有一个房间，
//
const roomState = {
    peers: {}, // 房间连接的所有端
    activeSpeaker: {producerId: null, volume: null, peerId: null}, // todo 难道是直播模式  那fuck off了
    transports: {}, // todo
    producers: [],  // 分享视频或音频流的生产者
    consumers: [],   // 订阅流的端
    ports: [],
}
//
// for each peer that connects, we keep a table of peers and what
// tracks are being sent and received. we also need to know the last
// time we saw the peer, so that we can disconnect clients that have
// network issues.
//
// for this simple demo, each client polls the server at 1hz, and we
// just send this roomState.peers data structure as our answer to each
// poll request.
//
// [peerId] : {
//   joinTs: <ms timestamp>
//   lastSeenTs: <ms timestamp>
//   media: {
//     [mediaTag] : {
//       paused: <bool>
//       encodings: []
//     }
//   },
//   stats: {
//     producers: {
//       [producerId]: {
//         ...(selected producer stats)
//       }
//     consumers: {
//       [consumerId]: { ...(selected consumer stats) }
//     }
//   }
//   consumerLayers: {
//     [consumerId]:
//         currentLayer,
//         clientSelectedLayer,
//       }
//     }
//   }
// }
//
// we also send information about the active speaker, as tracked by
// our audioLevelObserver.
//
// internally, we keep lists of transports, producers, and
// consumers. whenever we create a transport, producer, or consumer,
// we save the remote peerId in the object's `appData`. for producers
// and consumers we also keep track of the client-side "media tag", to
// correlate tracks.
//

//
// our http server needs to send 'index.html' and 'client-bundle.js'.
// might as well just send everything in this directory ...
//
// http静态资源目录
expressApp.use(express.static(__dirname));

async function main() {
    // start mediasoup
    console.log('starting mediasoup');
    ({worker, router, audioLevelObserver} = await startMediasoup());

    // start https server, falling back to http if https fails
    console.log('starting express');
    try {
        const tls = {
            cert: fs.readFileSync(config.sslCrt),
            key: fs.readFileSync(config.sslKey),
        };
        httpsServer = https.createServer(tls, expressApp);
        httpsServer.on('error', (e) => {
            console.error('https server error,', e.message);
        });
        await new Promise((resolve) => {
            httpsServer.listen(config.httpPort, config.httpIp, () => {
                console.log(`server is running and listening on ` +
                    `https://${config.httpIp}:${config.httpPort}`);
                resolve();
            });
        });
    } catch (e) {
        // https启动失败将启动http服务
        if (e.code === 'ENOENT') {
            console.error('no certificates found (check config.js)');
            console.error('  could not start https server ... trying http');
        } else {
            err('could not start https server', e);
        }
        expressApp.listen(config.httpPort, config.httpIp, () => {
            console.log(`http server listening on port ${config.httpPort}`);
        });
    }

    // periodically clean up peers that disconnected without sending us
    // a final "beacon"
    // 每隔一秒执行检查房间所有连接的同步状态，如果同步时间超时15秒将其关闭
    setInterval(() => {
        let now = Date.now();
        Object.entries(roomState.peers).forEach(([id, p]) => {
            if ((now - p.lastSeenTs) > config.httpPeerStale) {
                warn(`removing stale peer ${id}`);
                closePeer(id);
            }
        });
    }, 1000);

    // periodically update video stats we're sending to peers
    // 每3秒更新视频播放状态 比如视频参数等
    setInterval(updatePeerStats, 3000);
}

main();


//
// 启动mediasoup服务 仅一个工作进程
//
async function startMediasoup() {
    // 工作进程的端口号范围40000-49999
    let worker = await mediasoup.createWorker({
        logLevel: config.mediasoup.worker.logLevel,
        logTags: config.mediasoup.worker.logTags,
        rtcMinPort: config.mediasoup.worker.rtcMinPort,
        rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
    });

    // 工作进程结束将结束主进程
    worker.on('died', () => {
        console.error('mediasoup worker died (this should never happen)');
        process.exit(1);
    });

    // 所有支持的编解码格式
    const mediaCodecs = config.mediasoup.router.mediaCodecs;

    // SFU创建路由
    const router = await worker.createRouter({mediaCodecs});

    // audioLevelObserver for signaling active speaker todo what means?
    const audioLevelObserver = await router.createAudioLevelObserver({
        interval: 800
    });
    // 当有人说话时 会触发volumes事件 该事件包含声音大小和谁发声了 此时将说话者设置为房间的当前发言者
    audioLevelObserver.on('volumes', (volumes) => {
        const {producer, volume} = volumes[0];
        log('audio-level volumes event', producer.appData.peerId, volume);
        roomState.activeSpeaker.producerId = producer.id;
        roomState.activeSpeaker.volume = volume;
        roomState.activeSpeaker.peerId = producer.appData.peerId;
    });
    audioLevelObserver.on('silence', () => {
        log('audio-level silence event');
        roomState.activeSpeaker.producerId = null;
        roomState.activeSpeaker.volume = null;
        roomState.activeSpeaker.peerId = null;
    });

    return {worker, router, audioLevelObserver};
}

//
// -- our minimal signaling is just http polling --
//

// parse every request body for json, no matter the content-type. this
// lets us use sendBeacon or fetch interchangeably to POST to
// signaling endpoints. (sendBeacon can't set the Content-Type header)
//
expressApp.use(express.json({type: '*/*'}));

// --> /signaling/sync
// https链接方式  并非长连接
// client polling endpoint. send back our 'peers' data structure and 'activeSpeaker' info
// 客户端同步连接信息，保持状态
//
expressApp.post('/signaling/sync', async (req, res) => {
    let {peerId} = req.body;
    try {
        // make sure this peer is connected. if we've disconnected the
        // peer because of a network outage we want the peer to know that
        // happened, when/if it returns
        // 如果调用者没有连接 返回错误
        if (!roomState.peers[peerId]) {
            throw new Error('not connected');
        }

        // update our most-recently-seem timestamp -- we're not stale!
        // 更新客户端的最后同步时间
        roomState.peers[peerId].lastSeenTs = Date.now();

        // 返回所有的连接端和已激活的发言者   看上去是一对多的模式
        res.send({
            peers: roomState.peers,
            activeSpeaker: roomState.activeSpeaker
        });
    } catch (e) {
        console.error(e.message);
        res.send({error: e.message});
    }
});

// --> /signaling/join-as-new-peer
//
// adds the peer to the roomState data structure and creates a
// transport that the peer will use for receiving media. returns
// router rtpCapabilities for mediasoup-client device initialization
// 新的连接请求
expressApp.post('/signaling/join-as-new-peer', async (req, res) => {
    try {
        let {peerId} = req.body,
            now = Date.now();
        log('join-as-new-peer', peerId);

        // 将连接加入连接端列表
        roomState.peers[peerId] = {
            joinTs: now,
            lastSeenTs: now,
            media: {},
            consumerLayers: {},
            stats: {},
            process: null,

        };
        // 返回rtp有哪些功能
        res.send({routerRtpCapabilities: router.rtpCapabilities});
    } catch (e) {
        console.error('error in /signaling/join-as-new-peer', e);
        res.send({error: e});
    }
});

// --> /signaling/leave
//
// removes the peer from the roomState data structure and and closes
// all associated mediasoup objects
// 连接端断开连接
expressApp.post('/signaling/leave', async (req, res) => {
    try {
        let {peerId} = req.body;
        log('leave', peerId);
        // 踢出连接端信息
        await closePeer(peerId);
        res.send({left: true});
    } catch (e) {
        console.error('error in /signaling/leave', e);
        res.send({error: e});
    }
});

// 关闭连接
function closePeer(peerId) {
    log('closing peer', peerId);
    stopRecord(peerId);
    for (let [id, transport] of Object.entries(roomState.transports)) {
        // 找到所有跟该连接端关联的传输组件
        if (transport.appData.peerId === peerId) {
            closeTransport(transport);
        }
    }
    delete roomState.peers[peerId];
}

// 生产者和消费者依靠transport传输组件关联起来的  所以关闭连接的时候必须关闭这个组件
async function closeTransport(transport) {
    try {
        log('closing transport', transport.id, transport.appData);

        // our producer and consumer event handlers will take care of
        // calling closeProducer() and closeConsumer() on all the producers
        // and consumers associated with this transport
        await transport.close();

        // so all we need to do, after we call transport.close(), is update
        // our roomState data structure
        delete roomState.transports[transport.id];
    } catch (e) {
        err(e);
    }
}

// 关闭生产者
async function closeProducer(producer) {
    log('closing producer', producer.id, producer.appData);
    try {
        await producer.close();

        // remove this producer from our roomState.producers list
        // 从生产者列表中删除
        roomState.producers = roomState.producers
            .filter((p) => p.id !== producer.id);

        // remove this track's info from our roomState...mediaTag bookkeeping
        // 从连接信息中的媒体列表中删除 todo 这里只有一个，到底是音频还是视频
        if (roomState.peers[producer.appData.peerId]) {
            delete (roomState.peers[producer.appData.peerId]
                .media[producer.appData.mediaTag]);
        }
    } catch (e) {
        err(e);
    }
}

// 关闭消费者
async function closeConsumer(consumer) {
    log('closing consumer', consumer.id, consumer.appData);
    await consumer.close();

    // remove this consumer from our roomState.consumers list
    // 从消费者列表中删除
    roomState.consumers = roomState.consumers.filter((c) => c.id !== consumer.id);

    // remove layer info from from our roomState...consumerLayers bookkeeping
    if (roomState.peers[consumer.appData.peerId]) {
        delete roomState.peers[consumer.appData.peerId].consumerLayers[consumer.id];
    }
}

function getProducerById(pid) {
    const ps = roomState.producers.filter(p => p.id === pid)
    if (ps.length > 0) {
        return ps[0]
    }
}

function getConsumerById(cid) {
    const cs = roomState.consumers.filter(c => c.id === cid)
    if (cs.length > 0) {
        return cs[0]
    }
}

// --> /signaling/create-transport
//
// create a mediasoup transport object and send back info needed
// to create a transport object on the client side
// 客户端请求创建一个rtc传输连接  direction标识是上行还是下行
expressApp.post('/signaling/create-transport', async (req, res) => {
    try {
        let {peerId, direction} = req.body;
        log('create-transport', peerId, direction);

        // 创建传输对象
        let transport = await createWebRtcTransport({peerId, direction});
        // 将传输对象加入列表
        roomState.transports[transport.id] = transport;
        // if (direction === 'send') {
        //     await createPlainRtcTransport(transport)
        // }

        // 将传输id，ice信息等返回客户端
        let {id, iceParameters, iceCandidates, dtlsParameters} = transport;
        res.send({
            transportOptions: {id, iceParameters, iceCandidates, dtlsParameters}
        });
    } catch (e) {
        console.error('error in /signaling/create-transport', e);
        res.send({error: e});
    }
});

// 由router创建传输rtc对象
async function createWebRtcTransport({peerId, direction}) {
    // 获取rtc监听ip列表，和视频的bitrate
    const {
        listenIps,
        initialAvailableOutgoingBitrate
    } = config.mediasoup.webRtcTransport;

    const transport = await router.createWebRtcTransport({
        listenIps: listenIps,
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        initialAvailableOutgoingBitrate: initialAvailableOutgoingBitrate,
        appData: {peerId, clientDirection: direction}  // 负载数据
    });

    return transport;
}

async function createPlainRtcTransport(producer) {
    const transport = await router.createPlainRtpTransport(config.mediasoup.plainRtpTransport)
    roomState.transports[transport.id] = transport;

    const remoteRtpPort = await getPort();
    roomState.ports.push(remoteRtpPort);

    let remoteRtcpPort;
    if (!config.mediasoup.plainRtpTransport.rtcpMux) {
        remoteRtcpPort = await getPort();
        roomState.ports.push(remoteRtcpPort);
    }
    await transport.connect({
        ip: '127.0.0.1',
        port: remoteRtpPort,
        rtcpPort: remoteRtcpPort
    });

    const codecs = [];
    const routerCodec = router.rtpCapabilities.codecs.find(
        codec => codec.kind === producer.kind
    );
    codecs.push(routerCodec);

    const rtpCapabilities = {
        codecs,
        rtcpFeedback: []
    };

    const rtpConsumer = await transport.consume({
        producerId: producer.id,
        rtpCapabilities,
        paused: true
    });
    roomState.consumers.push(rtpConsumer);

    return {
        remoteRtpPort,
        remoteRtcpPort,
        localRtcpPort: transport.rtcpTuple ? transport.rtcpTuple.localPort : undefined,
        rtpCapabilities,
        rtpParameters: rtpConsumer.rtpParameters,
        consumerId: rtpConsumer.id,
    };
}

expressApp.post('/signaling/start-record', async (req, res) => {
    let {peerId, transportId, audioProducerId, videoProducerId} = req.body
    await startRecord(peerId, transportId, videoProducerId, audioProducerId)
    res.send({
        transportOptions: {result: 'success'}
    });
});

async function startRecord(peerId, transportId, videoProducerId, audioProducerId) {
    let peer = roomState.peers[peerId]
    let videoProducer = getProducerById(videoProducerId)
    let audioProducer = getProducerById(audioProducerId)
    let transport = roomState[transportId]
    let recordInfo = {};

    recordInfo['video'] = await createPlainRtcTransport(videoProducer);
    recordInfo['audio'] = await createPlainRtcTransport(audioProducer);

    recordInfo.fileName = Date.now().toString();

    peer.process = new FFmpeg(recordInfo);

    setTimeout(() => {
        getConsumerById(recordInfo['video'].consumerId).resume()
        getConsumerById(recordInfo['audio'].consumerId).resume()
    }, 1000)
}

function stopRecord(peerId) {
    const peer = roomState.peers[peerId]
    if(peer){
        if (peer.process){
            peer.process.kill();
            peer.process = undefined;
        }
    }
}

// --> /signaling/connect-transport
//
// called from inside a client's `transport.on('connect')` event handler.
// 创建后自然要连接传输组件
//
expressApp.post('/signaling/connect-transport', async (req, res) => {
    try {
        let {peerId, transportId, dtlsParameters} = req.body,
            transport = roomState.transports[transportId];
        // 如果该传输id没在服务端注册，返回错误
        if (!transport) {
            err(`connect-transport: server-side transport ${transportId} not found`);
            res.send({error: `server-side transport ${transportId} not found`});
            return;
        }

        log('connect-transport', peerId, transport.appData);

        // dtls其实就是UDP连接信息，tls加持  这里开始进行udp连接  同时返回客户端连接建立成功
        await transport.connect({dtlsParameters});
        res.send({connected: true});
    } catch (e) {
        console.error('error in /signaling/connect-transport', e);
        res.send({error: e});
    }
});

// --> /signaling/close-transport
//
// called by a client that wants to close a single transport (for
// example, a client that is no longer sending any media).
// 关闭传输
expressApp.post('/signaling/close-transport', async (req, res) => {
    try {
        let {peerId, transportId} = req.body,
            transport = roomState.transports[transportId];

        if (!transport) {
            err(`close-transport: server-side transport ${transportId} not found`);
            res.send({error: `server-side transport ${transportId} not found`});
            return;
        }

        log('close-transport', peerId, transport.appData);
        // 注销传输对象
        await closeTransport(transport);
        res.send({closed: true});
    } catch (e) {
        console.error('error in /signaling/close-transport', e);
        res.send({error: e.message});
    }
});

// --> /signaling/close-producer
//
// called by a client that is no longer sending a specific track
// 关闭生产者
expressApp.post('/signaling/close-producer', async (req, res) => {
    try {
        let {peerId, producerId} = req.body,
            producer = roomState.producers.find((p) => p.id === producerId);

        if (!producer) {
            err(`close-producer: server-side producer ${producerId} not found`);
            res.send({error: `server-side producer ${producerId} not found`});
            return;
        }

        log('close-producer', peerId, producer.appData);

        await closeProducer(producer);
        res.send({closed: true});
    } catch (e) {
        console.error(e);
        res.send({error: e.message});
    }
});

// --> /signaling/send-track
// called from inside a client's `transport.on('produce')` event handler.
// todo 看上去是开始发送数据 难道调用者是发送端
expressApp.post('/signaling/send-track', async (req, res) => {
    try {
        // 取出req中的传输信息
        let {peerId, transportId, kind, rtpParameters, paused = false, appData} = req.body;
        let transport = roomState.transports[transportId];

        if (!transport) {
            err(`send-track: server-side transport ${transportId} not found`);
            res.send({error: `server-side transport ${transportId} not found`});
            return;
        }

        // 创建流的生产对象
        let producer = await transport.produce({
            kind,
            rtpParameters,
            paused,
            appData: {...appData, peerId, transportId}
        });

        // if our associated transport closes, close ourself, too
        // 当传输对象关闭时 关闭生产者
        producer.on('transportclose', () => {
            log('producer\'s transport closed', producer.id);
            closeProducer(producer);
        });

        // monitor audio level of this producer. we call addProducer() here,
        // but we don't ever need to call removeProducer() because the core
        // AudioLevelObserver code automatically removes closed producers
        // 如果生产者类型是音频   直接加入声音监听
        if (producer.kind === 'audio') {
            audioLevelObserver.addProducer({producerId: producer.id});
        }

        // 注册生产者
        roomState.producers.push(producer);
        roomState.peers[peerId].media[appData.mediaTag] = {
            paused,
            encodings: rtpParameters.encodings
        };

        // 返回生产者的id
        res.send({id: producer.id});
    } catch (e) {
    }
});

// --> /signaling/recv-track
//
// create a mediasoup consumer object, hook it up to a producer here
// on the server side, and send back info needed to create a consumer
// object on the client side. always start consumers paused. client
// will request media to resume when the connection completes
// 请求接收流 创建消费者
expressApp.post('/signaling/recv-track', async (req, res) => {
    try {
        // 获取请求者的rtc和媒体信息 todo mediapeerid是 订阅某个生产者的连接id
        let {peerId, mediaPeerId, mediaTag, rtpCapabilities} = req.body;

        let producer = roomState.producers.find(
            (p) => p.appData.mediaTag === mediaTag &&
                p.appData.peerId === mediaPeerId
        );

        // 如果生产者已注销 返回错误
        if (!producer) {
            let msg = 'server-side producer for ' +
                `${mediaPeerId}:${mediaTag} not found`;
            err('recv-track: ' + msg);
            res.send({error: msg});
            return;
        }

        // 判断是否能对生产者进行订阅  否则返回错误
        if (!router.canConsume({producerId: producer.id, rtpCapabilities})) {
            let msg = `client cannot consume ${mediaPeerId}:${mediaTag}`;
            err(`recv-track: ${peerId} ${msg}`);
            res.send({error: msg});
            return;
        }

        // 找到传输对象 （/create-transport 这个接口调用中创建的transport对象）
        let transport = Object.values(roomState.transports).find((t) =>
            t.appData.peerId === peerId && t.appData.clientDirection === 'recv'
        );

        // 不能跳过创建传输这个流程
        if (!transport) {
            let msg = `server-side recv transport for ${peerId} not found`;
            err('recv-track: ' + msg);
            res.send({error: msg});
            return;
        }

        // 创建消费者
        let consumer = await transport.consume({
            producerId: producer.id,
            rtpCapabilities,
            paused: true, // see note above about always starting paused
            appData: {peerId, mediaPeerId, mediaTag}
        });

        // need both 'transportclose' and 'producerclose' event handlers,
        // to make sure we close and clean up consumers in all
        // circumstances
        // 必须处理2个事件  一个是传输关闭事件和生产者关闭事件   这2个事件发生后关闭消费者
        consumer.on('transportclose', () => {
            log(`consumer's transport closed`, consumer.id);
            closeConsumer(consumer);
        });
        consumer.on('producerclose', () => {
            log(`consumer's producer closed`, consumer.id);
            closeConsumer(consumer);
        });

        // stick this consumer in our list of consumers to keep track of,
        // and create a data structure to track the client-relevant state
        // of this consumer
        // 注册消费者
        roomState.consumers.push(consumer);
        roomState.peers[peerId].consumerLayers[consumer.id] = {
            currentLayer: null,
            clientSelectedLayer: null
        };

        // update above data structure when layer changes. todo 什么鬼东西
        consumer.on('layerschange', (layers) => {
            log(`consumer layerschange ${mediaPeerId}->${peerId}`, mediaTag, layers);
            if (roomState.peers[peerId] &&
                roomState.peers[peerId].consumerLayers[consumer.id]) {
                roomState.peers[peerId].consumerLayers[consumer.id]
                    .currentLayer = layers && layers.spatialLayer;
            }
        });

        // 重要的数据是返回消费者id和类型，rtp参数
        res.send({
            producerId: producer.id,
            id: consumer.id,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
            type: consumer.type,
            producerPaused: consumer.producerPaused
        });
    } catch (e) {
        console.error('error in /signaling/recv-track', e);
        res.send({error: e});
    }
});

// --> /signaling/pause-consumer
//
// called to pause receiving a track for a specific client
// 暂停消费
expressApp.post('/signaling/pause-consumer', async (req, res) => {
    try {
        let {peerId, consumerId} = req.body,
            consumer = roomState.consumers.find((c) => c.id === consumerId);

        if (!consumer) {
            err(`pause-consumer: server-side consumer ${consumerId} not found`);
            res.send({error: `server-side producer ${consumerId} not found`});
            return;
        }

        log('pause-consumer', consumer.appData);
        // 居然还能暂停   什么鬼    为了保持消费状态吗？
        await consumer.pause();

        res.send({paused: true});
    } catch (e) {
        console.error('error in /signaling/pause-consumer', e);
        res.send({error: e});
    }
});

// --> /signaling/resume-consumer
//
// called to resume receiving a track for a specific client
// 重新唤醒消费   等于一个播放暂停/继续 按钮
expressApp.post('/signaling/resume-consumer', async (req, res) => {
    try {
        let {peerId, consumerId} = req.body,
            consumer = roomState.consumers.find((c) => c.id === consumerId);

        if (!consumer) {
            err(`pause-consumer: server-side consumer ${consumerId} not found`);
            res.send({error: `server-side consumer ${consumerId} not found`});
            return;
        }

        log('resume-consumer', consumer.appData);

        await consumer.resume();

        res.send({resumed: true});
    } catch (e) {
        console.error('error in /signaling/resume-consumer', e);
        res.send({error: e});
    }
});

// --> /signalign/close-consumer
//
// called to stop receiving a track for a specific client. close and
// clean up consumer object
// 关闭消费者
expressApp.post('/signaling/close-consumer', async (req, res) => {
    try {
        let {peerId, consumerId} = req.body,
            consumer = roomState.consumers.find((c) => c.id === consumerId);

        if (!consumer) {
            err(`close-consumer: server-side consumer ${consumerId} not found`);
            res.send({error: `server-side consumer ${consumerId} not found`});
            return;
        }

        // 注销消费者
        await closeConsumer(consumer);

        res.send({closed: true});
    } catch (e) {
        console.error('error in /signaling/close-consumer', e);
        res.send({error: e});
    }
});

// --> /signaling/consumer-set-layers
//
// called to set the largest spatial layer that a specific client wants to receive
//
expressApp.post('/signaling/consumer-set-layers', async (req, res) => {
    try {
        let {peerId, consumerId, spatialLayer} = req.body,
            consumer = roomState.consumers.find((c) => c.id === consumerId);

        if (!consumer) {
            err(`consumer-set-layers: server-side consumer ${consumerId} not found`);
            res.send({error: `server-side consumer ${consumerId} not found`});
            return;
        }

        log('consumer-set-layers', spatialLayer, consumer.appData);

        await consumer.setPreferredLayers({spatialLayer});

        res.send({layersSet: true});
    } catch (e) {
        console.error('error in /signaling/consumer-set-layers', e);
        res.send({error: e});
    }
});

// --> /signaling/pause-producer
//
// called to stop sending a track from a specific client
// 生产者暂停
expressApp.post('/signaling/pause-producer', async (req, res) => {
    try {
        let {peerId, producerId} = req.body,
            producer = roomState.producers.find((p) => p.id === producerId);

        if (!producer) {
            err(`pause-producer: server-side producer ${producerId} not found`);
            res.send({error: `server-side producer ${producerId} not found`});
            return;
        }

        log('pause-producer', producer.appData);

        await producer.pause();

        roomState.peers[peerId].media[producer.appData.mediaTag].paused = true;

        res.send({paused: true});
    } catch (e) {
        console.error('error in /signaling/pause-producer', e);
        res.send({error: e});
    }
});

// --> /signaling/resume-producer
//
// called to resume sending a track from a specific client
// 生产者唤醒
expressApp.post('/signaling/resume-producer', async (req, res) => {
    try {
        let {peerId, producerId} = req.body,
            producer = roomState.producers.find((p) => p.id === producerId);

        if (!producer) {
            err(`resume-producer: server-side producer ${producerId} not found`);
            res.send({error: `server-side producer ${producerId} not found`});
            return;
        }

        log('resume-producer', producer.appData);

        await producer.resume();

        roomState.peers[peerId].media[producer.appData.mediaTag].paused = false;

        res.send({resumed: true});
    } catch (e) {
        console.error('error in /signaling/resume-producer', e);
        res.send({error: e});
    }
});

//
// stats
//
async function updatePeerStats() {
    // 遍历所有流的生产者
    for (let producer of roomState.producers) {
        // todo 不处理音频流
        if (producer.kind !== 'video') {
            continue;
        }
        try {
            let stats = await producer.getStats(),
                peerId = producer.appData.peerId;
            roomState.peers[peerId].stats[producer.id] = stats.map((s) => ({
                bitrate: s.bitrate,
                fractionLost: s.fractionLost,
                jitter: s.jitter,
                score: s.score,
                rid: s.rid
            }));
        } catch (e) {
            warn('error while updating producer stats', e);
        }
    }

    // 遍历所有消费者
    for (let consumer of roomState.consumers) {
        try {
            let stats = (await consumer.getStats())
                    .find((s) => s.type === 'outbound-rtp'),
                peerId = consumer.appData.peerId;
            if (!stats || !roomState.peers[peerId]) {
                continue;
            }
            roomState.peers[peerId].stats[consumer.id] = {
                bitrate: stats.bitrate,
                fractionLost: stats.fractionLost,
                score: stats.score
            }
        } catch (e) {
            warn('error while updating consumer stats', e);
        }
    }
}
