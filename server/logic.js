const config = require('./config');
const {getPort} = require('./port')
const debugModule = require('debug');
const FFmpeg = require('./ffmpeg')
const {getClientAddress} = require('./utils');
const Action = require('./constants')
const log = require('./logger').getLogger('logic')

module.exports = class Logic {
    constructor(id, router) {
        this.id = id
        this.router = router
        this.peers = {} // 所有客户端
        this.transports = {} // 所有传输通道
        this.producers = [] // 分享视频或音频流的生产者
        this.consumers = []   // 订阅流的消费端
        this.ports = [] // 所有已使用端口
        this._looper = this._loop()
    }

    async onConnected(ws, user, peerId) {
        Object.entries(this.peers).forEach(([id, p]) => {
            if (p.userId === user.id) {
                log.info(`kick off uid: ${p.userId}, pid: ${id}`);
                if (p.conn) {
                    try {
                        p.conn.close()
                    } catch (e) {
                        log.error(`close websocket failed: ${e}`)
                        this._kickoff(p).then(r => {
                        })
                    }
                } else {
                    this._kickoff(p).then(r => {
                    })
                }
            }
        });
        log.info('peerId: ' + peerId + ' connected to server')
        const now = Date.now();
        this.peers[peerId] = {
            id: peerId,
            userId: user.id,
            roomId: user.roomId,
            name: user.name,
            admin: user.isAdmin,
            joinTs: now,
            lastSeenTs: now,
            media: {},
            consumerLayers: {},
            stats: {},
            process: null,
            conn: ws,
        };
        // 客户端返回房间其他客户端
        let members = this._getMembers()
        members = members.map(m => {
            return {
                id: m.id,
                userId: m.userId,
                roomId: m.roomId,
                name: m.name,
                admin: m.admin,
                media: m.media,
                stats: m.stats
            }
        })
        this._sendMsg(ws, Action.CONNECTED, {
            members: members
        })
        // 通知其他成员该用户进入房间
        this._notifyJoin(this.peers[peerId]).then(r => {
        })
    }

    onDisconnected(ws, peerId) {
        log.info('peerId: ' + peerId + ' disconnected')
        this._notifyLeave(peerId)
        let peer = this.peers[peerId]
        if (peer) {
            peer.conn = null
            if (peer) {
                this._kickoff(peer).then(r => {
                })
            }
        }
    }

    onHeartBeat(ws, peerId) {
        let peer = this.peers[peerId];
        peer.lastSeenTs = Date.now();
        this._sendMsg(ws, Action.HEARTBEAT, null)
    }

    // 关闭连接
    async _kickoff(peer) {
        try {
            if (!peer) return
            log.info('kickoff', peer.id);
            // 踢出连接端信息
            // 找到所有跟该连接端关联的传输组件
            log.info('closing peer', peer.id);
            this._stopRecord(peer.id);
            for (let [id, transport] of Object.entries(this.transports)) {
                // 从房间中删除
                if (transport.appData.peerId === peer.id) {
                    this._closeTransport(transport).then(r => {
                    });
                }
            }
            delete this.peers[peer.id];
        } catch (e) {
            log.error(`error in /signaling/leave, ${e}`);
        }
    }

    // 接收IM消息  文字、语音、图片
    handleMessage(ws, peerId, msg) {
        const peer = this.peers[peerId]
        if (!peer) return
        // todo consistent the message in db
        // 持久化后得到一个新的msg，将发送标识seq放入新msg后返回给客户端
        // 消息持久化后可以返回用户一个发送成功回执
        this._sendMsg(ws, Action.SUCCESS, msg.seq)
        this._broadcastMessage(Action.MESSAGE, msg, peerId).then(r => {
        })
    }

    // 通知其他客户端有人加入
    async _notifyJoin(peer) {
        const member = {
            id: peer.id,
            userId: peer.userId,
            roomId: peer.roomId,
            name: peer.name,
            admin: peer.admin,
            media: peer.media,
            stats: peer.stats
        }
        this._broadcastMessage(Action.JOIN, {member: member}, peer.id)
    }

    // 通知其他客户端有人离开
    _notifyLeave(peerId) {
        const p = {peerId: peerId}
        this._broadcastMessage(Action.LEAVE, p, peerId).then(r => {
        })
    }

    // 通知房间所有客户端媒体流开始传输
    async _notifyMediaBegin(peerId, mediaTag, mediaInfo) {
        let peer = this.peers[peerId]
        // 不管任何媒体流（摄像头、屏幕、麦克风）准备就绪，都通知房间所有人，由客户端决定订阅
        this._broadcastMessage(Action.READY, {
            peerId: peerId,
            mediaTag: mediaTag,
            mediaInfo: mediaInfo
        })
    }

    async handleFetchCapabilities() {
        return this.router.rtpCapabilities
    }

    async handleCreateTransport(peerId, direction) {
        try {
            log.info('create-transport', peerId, direction);
            // 创建传输对象
            let transport = await this._createWebRtcTransport({peerId, direction});
            // 将传输对象加入列表
            this.transports[transport.id] = transport;
            // 将传输id，ice信息等返回客户端
            let {id, iceParameters, iceCandidates, dtlsParameters} = transport;
            return {
                transportOptions: {id, iceParameters, iceCandidates, dtlsParameters}
            };
        } catch (e) {
            log.error(`error in /signaling/create-transport ${e}`);
            return {error: e};
        }
    }

    async handleConnectTransport({peerId, transportId, dtlsParameters}) {
        try {
            let transport = this.transports[transportId];
            // 如果该传输id没在服务端注册，返回错误
            if (!transport) {
                log.error(`connect-transport: server-side transport ${transportId} not found`);
                return {error: `server-side transport ${transportId} not found`};
            }
            log.info('connect-transport', peerId, transport.appData);
            // dtls其实就是UDP连接信息，tls加持  这里开始进行udp连接  同时返回客户端连接建立成功
            await transport.connect({dtlsParameters});
            return {connected: true};
        } catch (e) {
            log.error(`error in /signaling/connect-transport ${e}`);
            return {error: e};
        }
    }

    async handleCloseTransport({peerId, transportId}) {
        try {
            let transport = this.transports[transportId];

            if (!transport) {
                log.error(`close-transport: server-side transport ${transportId} not found`);
                return {error: `server-side transport ${transportId} not found`};
            }

            log.info(`close-transport id: ${peerId} data: ${transport.appData}`);
            // 注销传输对象
            await this._closeTransport(transport);
            return {closed: true};
        } catch (e) {
            log.error(`error in /signaling/close-transport ${e}`);
            return {error: e.message};
        }
    }

    async handleResumeProducer({peerId, producerId}) {
        try {
            let producer = this.producers.find((p) => p.id === producerId);
            if (!producer) {
                log.error(`resume-producer: server-side producer ${producerId} not found`);
                return {error: `server-side producer ${producerId} not found`};
            }
            log.info(`resume-producer id: ${peerId}, data: ${producer.appData}`);
            await producer.resume();
            this.peers[peerId].media[producer.appData.mediaTag].paused = false;
            return {resumed: true};
        } catch (e) {
            log.error(`error in /signaling/resume-producer ${e}`);
            return {error: e};
        }
    }

    async handlePauseProducer({peerId, producerId}) {
        try {
            let producer = this.producers.find((p) => p.id === producerId);
            if (!producer) {
                log.error(`pause-producer: server-side producer ${producerId} not found`);
                return {error: `server-side producer ${producerId} not found`};
            }
            log.info(`pause-producer id: ${peerId} data: ${producer.appData}`);
            await producer.pause();
            this.peers[peerId].media[producer.appData.mediaTag].paused = true;
            return {paused: true};
        } catch (e) {
            log.error(`error in /signaling/pause-producer ${e}`);
            return {error: e};
        }
    }

    async handleCloseProducer({peerId, producerId}) {
        try {
            let producer = this.producers.find((p) => p.id === producerId);
            if (!producer) {
                log.error(`close-producer: server-side producer ${producerId} not found`);
                return {error: `server-side producer ${producerId} not found`};
            }
            log.info('close-producer', peerId, producer.appData);
            await this._closeProducer(producer);
            return {closed: true};
        } catch (e) {
            log.error(`handleCloseProducer exception: ${e}`);
            return {error: e.message};
        }
    }

    async handleSendTrack({peerId, transportId, kind, rtpParameters, paused, appData}) {
        try {
            let transport = this.transports[transportId];

            if (!transport) {
                log.error(`send-track: server-side transport ${transportId} not found`);
                return {error: `server-side transport ${transportId} not found`};
            }

            // 创建流的生产对象
            let producer = await transport.produce({
                kind,
                rtpParameters,
                paused,
                appData: {...appData, peerId, transportId}
            });

            // 当传输对象关闭时 关闭生产者
            producer.on('transportclose', () => {
                log.info(`producer\'s transport closed ${producer.id}`);
                this._closeProducer(producer);
            });

            // 如果生产者类型是音频   直接加入声音监听
            if (producer.kind === 'audio') {
                // todo 暂不处理音频的可视化
                // audioLevelObserver.addProducer({producerId: producer.id});
            }

            // 注册生产者
            this.producers.push(producer);
            let peer = this.peers[peerId]
            let mediaInfo = {
                paused,
                encodings: rtpParameters.encodings,
                producerId: producer.id
            }
            peer.media[appData.mediaTag] = mediaInfo;

            this._notifyMediaBegin(peerId, appData.mediaTag, mediaInfo)

            // 判断是否开始录制
            if (peer.media.hasOwnProperty('screen-video') && peer.media.hasOwnProperty('cam-audio')) {
                let screenProducerId = peer.media['screen-video'].producerId
                let audioProducerId = peer.media['cam-audio'].producerId
                this._startRecord(peerId, screenProducerId, audioProducerId)
            }

            // 返回生产者的id
            return {id: producer.id};
        } catch (e) {
            log.error(`handleSendTrack exception: ${e}`);
            return {error: e.message};
        }
    }

    async handleRecvTrack({peerId, mediaPeerId, mediaTag, rtpCapabilities}) {
        try {
            let producer = this.producers.find(
                (p) => p.appData.mediaTag === mediaTag &&
                    p.appData.peerId === mediaPeerId
            );

            // 如果生产者已注销 返回错误
            if (!producer) {
                let msg = 'server-side producer for ' +
                    `${mediaPeerId}:${mediaTag} not found`;
                log.error('recv-track: ' + msg);
                return {error: msg};
            }

            // 判断是否能对生产者进行订阅  否则返回错误
            if (!this.router.canConsume({producerId: producer.id, rtpCapabilities})) {
                let msg = `client cannot consume ${mediaPeerId}:${mediaTag}`;
                log.error(`recv-track: ${peerId} ${msg}`);
                return {error: msg};
            }

            // 找到传输对象 （/create-transport 这个接口调用中创建的transport对象）
            let transport = Object.values(this.transports).find((t) =>
                t.appData.peerId === peerId && t.appData.clientDirection === 'recv'
            );

            // 不能跳过创建传输这个流程
            if (!transport) {
                let msg = `server-side recv transport for ${peerId} not found`;
                log.error('recv-track: ' + msg);
                return {error: msg};
            }

            // 创建消费者
            let consumer = await transport.consume({
                producerId: producer.id,
                rtpCapabilities,
                paused: true, // see note above about always starting paused
                appData: {peerId, mediaPeerId, mediaTag}
            });

            // 注册消费者
            this.consumers.push(consumer);
            this.peers[peerId].consumerLayers[consumer.id] = {
                currentLayer: null,
                clientSelectedLayer: null
            };
            // 必须处理2个事件  一个是传输关闭事件和生产者关闭事件   这2个事件发生后关闭消费者
            this._onConsumerEvent(peerId, consumer);

            // 重要的数据是返回消费者id和类型，rtp参数
            return {
                producerId: producer.id,
                id: consumer.id,
                kind: consumer.kind,
                rtpParameters: consumer.rtpParameters,
                type: consumer.type,
                producerPaused: consumer.producerPaused
            };
        } catch (e) {
            log.error(`error in /signaling/recv-track ${e}`);
            return {error: e};
        }
    }

    async handleResumeConsumer({peerId, consumerId}) {
        try {
            let consumer = this.consumers.find((c) => c.id === consumerId);
            if (!consumer) {
                log.error(`pause-consumer: server-side consumer ${consumerId} not found`);
                return {error: `server-side consumer ${consumerId} not found`};
            }
            log.info('resume-consumer', consumer.appData);
            await consumer.resume();
            return {resumed: true};
        } catch (e) {
            log.error(`error in /signaling/resume-consumer ${e}`);
            return {error: e};
        }
    }

    async handleCloseConsumer({peerId, consumerId}) {
        try {
            let consumer = this.consumers.find((c) => c.id === consumerId);
            if (!consumer) {
                log.error(`close-consumer: server-side consumer ${consumerId} not found`);
                return {error: `server-side consumer ${consumerId} not found`};
            }
            // 注销消费者
            await this._closeConsumer(consumer);
            return {closed: true};
        } catch (e) {
            log.error(`error in /signaling/close-consumer ${e}`);
            return {error: e};
        }
    }

    async handlePauseConsumer({peerId, consumerId}) {
        try {
            let consumer = this.consumers.find((c) => c.id === consumerId);
            if (!consumer) {
                log.error(`pause-consumer: server-side consumer ${consumerId} not found`);
                return {error: `server-side producer ${consumerId} not found`};
            }

            log.info(`pause-consumer id: ${peerId}, data: ${consumer.appData}`);
            // 居然还能暂停   什么鬼    为了保持消费状态吗？
            await consumer.pause();

            return {paused: true};
        } catch (e) {
            log.error(`error in /signaling/pause-consumer ${e}`);
            return {error: e};
        }
    }

    // 每3秒更新视频播放状态 比如视频参数等
    _loop() {
        // 每隔一秒执行检查房间所有连接的同步状态，如果同步时间超时15秒将其关闭
        return setInterval(async () => {
            // 遍历所有连接客户端
            let now = Date.now();
            Object.entries(this.peers).forEach(([id, p]) => {
                if ((now - p.lastSeenTs) > config.httpPeerStale) {
                    log.warn(`removing stale peer ${id}`);
                    if (p.conn) {
                        try {
                            p.conn.close()
                        } catch (e) {
                            log.error(`close websocket in loop exception ${e}`)
                            this._kickoff(p)
                        }
                    } else {
                        this._kickoff(p)
                    }
                }
            });
        }, 3000);
    }

    // 生产者和消费者依靠transport传输组件关联起来的  所以关闭连接的时候必须关闭这个组件
    async _closeTransport(transport) {
        try {
            log.info('closing transport', transport.id, transport.appData);
            await transport.close();
            delete this.transports[transport.id];
        } catch (e) {
            log.error(`closeTransport exception: ${e}`)
        }
    }

    // 关闭生产者
    async _closeProducer(producer) {
        log.info('closing producer', producer.id, producer.appData);
        try {
            await producer.close();
            // 从生产者列表中删除
            this.producers = this.producers
                .filter((p) => p.id !== producer.id);
            // 从连接信息中的媒体列表中删除 根据producer参数确定是音频还是视频
            if (this.peers[producer.appData.peerId]) {
                delete (this.peers[producer.appData.peerId]
                    .media[producer.appData.mediaTag]);
            }
        } catch (e) {
            log.error(`closeProducer exception: ${e}`)
        }
    }

// 关闭消费者
    async _closeConsumer(consumer) {
        log.info('closing consumer', consumer.id, consumer.appData);
        await consumer.close();
        // 从消费者列表中删除
        this.consumers = this.consumers.filter((c) => c.id !== consumer.id);
        if (this.peers[consumer.appData.peerId]) {
            delete this.peers[consumer.appData.peerId].consumerLayers[consumer.id];
        }
    }

    _getProducerById(pid) {
        const ps = this.producers.filter(p => p.id === pid)
        if (ps.length > 0) {
            return ps[0]
        }
    }

    _getConsumerById(cid) {
        const cs = this.consumers.filter(c => c.id === cid)
        if (cs.length > 0) {
            return cs[0]
        }
    }

    // 由router创建传输rtc对象
    async _createWebRtcTransport({peerId, direction}) {
        // 获取rtc监听ip列表，和视频的bitrate
        const {
            listenIps,
            initialAvailableOutgoingBitrate
        } = config.mediasoup.webRtcTransport;

        const transport = await this.router.createWebRtcTransport({
            listenIps: listenIps,
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
            initialAvailableOutgoingBitrate: initialAvailableOutgoingBitrate,
            appData: {peerId, clientDirection: direction}  // 负载数据
        });

        return transport;
    }

    async _createPlainRtcTransport(producer) {
        const transport = await this.router.createPlainRtpTransport(config.mediasoup.plainRtpTransport)
        this.transports[transport.id] = transport;

        const remoteRtpPort = await getPort();
        this.ports.push(remoteRtpPort);

        let remoteRtcpPort;
        if (!config.mediasoup.plainRtpTransport.rtcpMux) {
            remoteRtcpPort = await getPort();
            this.ports.push(remoteRtcpPort);
        }
        await transport.connect({
            ip: '127.0.0.1',
            port: remoteRtpPort,
            rtcpPort: remoteRtcpPort
        });

        const codecs = [];
        const routerCodec = this.router.rtpCapabilities.codecs.find(
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
        this._onConsumerEvent('', rtpConsumer)
        this.consumers.push(rtpConsumer);

        return {
            remoteRtpPort,
            remoteRtcpPort,
            localRtcpPort: transport.rtcpTuple ? transport.rtcpTuple.localPort : undefined,
            rtpCapabilities,
            rtpParameters: rtpConsumer.rtpParameters,
            consumerId: rtpConsumer.id,
        };
    }

    _onConsumerEvent(peerId, consumer) {
        consumer.on('transportclose', () => {
            log.info(`consumer's transport closed`, consumer.id);
            this._closeConsumer(consumer).then(r => {
            });
        });
        consumer.on('producerclose', () => {
            log.info(`consumer's producer closed`, consumer.id);
            this._closeConsumer(consumer).then(r => {
            });
        });
        if (peerId) {
            consumer.on('layerschange', (layers) => {
                if (this.peers[peerId] &&
                    this.peers[peerId].consumerLayers[consumer.id]) {
                    this.peers[peerId].consumerLayers[consumer.id]
                        .currentLayer = layers && layers.spatialLayer;
                }
            });
        }
    }

    async _startRecord(peerId, videoProducerId, audioProducerId) {
        setTimeout(async () => {
            let peer = this.peers[peerId]
            let videoProducer = this._getProducerById(videoProducerId)
            let audioProducer = this._getProducerById(audioProducerId)
            let recordInfo = {};

            recordInfo['video'] = await this._createPlainRtcTransport(videoProducer);
            recordInfo['audio'] = await this._createPlainRtcTransport(audioProducer);

            recordInfo.fileName = Date.now().toString();

            peer.process = new FFmpeg(recordInfo);

            this._getConsumerById(recordInfo['video'].consumerId).resume()
            this._getConsumerById(recordInfo['audio'].consumerId).resume()
        }, 1000)
    }

    _stopRecord(peerId) {
        const peer = this.peers[peerId]
        if (peer) {
            if (peer.process) {
                peer.process.kill();
                peer.process = undefined;
            }
        }
    }

    _sendMsg(ws, act, data) {
        const action = {
            act: act,
            data: data
        }
        ws.send(JSON.stringify(action))
    }

    _getMembers() {
        let members = Object.entries(this.peers).map(([id, p]) => {
            return p
        })
        return members
    }

    async _broadcastMessage(act, data, excluded) {
        this._getMembers()
            .forEach(m => {
                excluded = excluded || '-';
                if (m.id !== excluded) {
                    this._sendMsg(m.conn, act, data)
                }
            })
    }

    checkExist(peerId) {
        return this.peers.hasOwnProperty(peerId)
    }

    release() {
        if (this._looper) {
            clearInterval(this._looper)
            this._looper = null
        }
        for (let peerId in this.peers) {
            let peer = this.peers[peerId]
            this._kickoff(peer)
        }
        this.router.close()
    }

}
