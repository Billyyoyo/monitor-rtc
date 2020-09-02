import {Communicator} from './communicate'
import * as mediasoup from "mediasoup-client"
import {getScreenMedias, getCameraMedias} from '../renderer'
import {CameraParams, ScreenParams} from './config'
import {sleep} from './util'

let cli
let device
let cameraStream
let screenStream

export let callbacks = {
    showTip: (d) => {
    },
    showError: (d) => {
    },
    needReconnect: (d, fn) => {
    },
    memberJoin: (d) => {
    },
    memberLeave: (d) => {
    },
    recvMessage: (d) => {
    },
    onSendSuccess: (d) => {
    },
    onMediaReady: (p, m) => {
    },
    onStreamComming: (p, t, s) => {
    }
}

export let context = {
    members: [],
    recvTransport: null,
    sendTransport: null,
    cameraProducer: null,
    voiceProducer: null,
    screenProducer: null,
    consumers: []
}

// 页面加载完成后初始化函数
export async function main(userId, cbs) {
    callbacks = cbs
    console.log(`starting up ... my userId is ${userId}`)
    try {
        // 检查浏览器是否支持视频通话
        device = new mediasoup.Device()
    } catch (e) {
        if (e.name === 'UnsupportedError') {
            console.error('browser not supported for video calls')
            callbacks.showError('不支持音视频调用')
            return
        } else {
            console.error(e)
            callbacks.showError('设备异常')
            return
        }
    }
    // 初始化通讯
    cli = new Communicator({
        userId,
        onConnected, onErrorOrClose, onJoin, onLeave, onMessage, onSuccess, onReady
    })
    init().then(e => {
    })
    // 当关闭页面的时候调用离开房间指令
    window.addEventListener('unload', () => cli.disconnect())
}

async function init() {
    let routerRtpCapabilities = await cli.post('fetch-capabilities', {})
    console.log('get router capabilities')
    // 用服务端支持的能力加载设备对象
    if (!device.loaded) {
        await device.load({routerRtpCapabilities})
    }
    cli.connect()
}

async function onConnected({members}) {
    callbacks.showTip('连接成功')
    context.members = members
    // 通知UI显示成员列表
    if (context.members) {
        context.members.forEach(member => callbacks.memberJoin(member))
    }
    startRtc()
}

async function onErrorOrClose(tip) {
    // 通知UI显示重连对话框  同时提供一个重连方法
    callbacks.needReconnect(tip, () => {
        cli.reconnect()
    })
    release()
}

async function onJoin({member}) {
    let mm = null,
        index = -1
    context.members.forEach((m, i) => {
        if (m.id === member.id) {
            index = i
        }
    })
    if (index >= 0) {
        callbacks.memberLeave(mm)
        context.members.splice(index, 1)
    }
    context.members.push(member)
    callbacks.memberJoin(member)
}

async function onLeave({peerId}) {
    let mm = null,
        index = -1
    context.members.forEach((m, i) => {
        if (m.id === peerId) {
            index = i
        }
    })
    if (index >= 0) {
        callbacks.memberLeave(mm)
        context.members.splice(index, 1)
    }
}

async function onMessage(msg) {
    callbacks.recvMessage(msg)
}

async function onSuccess(seq) {
    callbacks.onSendSuccess(seq)
}

async function onReady({peerId, mediaTag, mediaInfo}) {
    let member = context.members.find(m => m.id === peerId)
    member.media[mediaTag] = mediaInfo
    callbacks.onMediaReady(peerId, mediaTag)
}

export async function sendTextMessage(text) {
    cli.send(text)
}

async function startRtc() {
    context.sendTransport = await createTransport('send')
    context.recvTransport = await createTransport('recv');
    startCamera().then((e) => {
    })
    startScreen().then((e) => {
    })
}

async function startCamera() {
    console.log('start camera stream')
    cameraStream = await getCameraMedias()
    context.cameraProducer = await context.sendTransport.produce({
        track: cameraStream.getVideoTracks()[0],
        encodings: CameraParams,
        appData: {mediaTag: 'cam-video'}
    });

    // 开始对接麦克风音频流到上行传输对象  并获得一个上行的生产者控制对象
    context.voiceProducer = await context.sendTransport.produce({
        track: cameraStream.getAudioTracks()[0],
        appData: {mediaTag: 'cam-audio'}
    });
    try {
        context.voiceProducer.pause();
    } catch (e) {
        console.error(e);
    }
    // todo 启动了摄像头上传流
}

async function startScreen() {
    console.log('start screen stream');
    screenStream = await getScreenMedias()
    // 对接传输视频流  并获得一个视频流生产者控制对象
    context.screenProducer = await context.sendTransport.produce({
        track: screenStream.getVideoTracks()[0],
        encodings: ScreenParams,
        appData: {mediaTag: 'screen-video'}
    });
    // 当上行生产者结束上传视频流
    context.screenProducer.track.onended = async () => {
        console.log('screen share stopped');
        try {
            // 暂停上传
            await context.screenProducer.pause();
            let {error} = await cli.post('close-producer', {producerId: context.screenProducer.id});
            // 关闭生产者
            await context.screenProducer.close();
            context.screenProducer = null;
            if (error) {
                console.log(error);
            }
        } catch (e) {
            console.error(e);
        }
        // todo 当关闭屏幕共享
    }
    // todo 启动了屏幕上传流
}

export async function pauseVoiceProduce() {
    await pauseProducer(context.voiceProducer)
}

export async function resumeVoiceProduce() {
    await resumeProducer(context.voiceProducer)
}

// 订阅某个端   比如房间中其他人
export async function subscribeToTrack(peerId, mediaTag) {
    console.log('subscribe to track', peerId, mediaTag);
    // 判断是否已经订阅了该peer
    let consumer = findConsumerForTrack(peerId, mediaTag);
    if (consumer) {
        console.log('already have consumer for track', peerId, mediaTag)
        return;
    }
    // 发出下行拉取指令 并获取到消费者的消费参数
    let consumerParameters = await cli.post('recv-track', {
        mediaTag,
        mediaPeerId: peerId,
        rtpCapabilities: device.rtpCapabilities
    });
    console.log('consumer parameters', consumerParameters);
    // 创建消费者通道
    consumer = await context.recvTransport.consume({
        ...consumerParameters,
        appData: {peerId, mediaTag}
    });
    console.log('created new consumer', consumer.id);

    // 轮训等待下行通道连通
    while (context.recvTransport.connectionState !== 'connected') {
        console.log('  transport connstate', context.recvTransport.connectionState);
        await sleep(100);
    }
    // okay, we're ready. let's ask the peer to send us media
    // 通知生产者推送给消费者数据流
    await resumeConsumer(consumer);

    // keep track of all our consumers
    // 保存消费者通道
    context.consumers.push(consumer);

    callbacks.onStreamComming(peerId, mediaTag, new MediaStream([consumer.track.clone()]))
    return consumer
}

// 页面操作 - 取消订阅
export async function unsubscribeFromTrack(peerId, mediaTag) {
    let consumer = findConsumerForTrack(peerId, mediaTag);
    if (!consumer) {
        return;
    }

    console.log('unsubscribe from track', peerId, mediaTag);
    try {
        await closeConsumer(consumer);
    } catch (e) {
        console.error(e);
    }
}

// 创建传输对象（上行or下行）
async function createTransport(direction) {
    console.log(`create ${direction} transport`)

    // 通知服务端执行创建传输对象   并获取到创建传输通道参数
    let transport,
        {transportOptions} = await cli.post('create-transport', {direction})
    console.log('transport options', transportOptions)

    if (direction === 'recv') {
        // 创建接收传输通道
        transport = await device.createRecvTransport(transportOptions)
    } else if (direction === 'send') {
        // 创建发送传输通道
        transport = await device.createSendTransport(transportOptions)
    } else {
        throw new Error(`bad transport 'direction': ${direction}`)
    }

    // 当传输通道已经建立好连接
    transport.on('connect', async ({dtlsParameters}, callback, errback) => {
        console.log('transport connect event', direction)
        // 告诉服务端连接传输通道（udp）
        let {error} = await cli.post('connect-transport', {
            transportId: transportOptions.id,
            dtlsParameters
        })
        if (error) {
            console.log('error connecting transport', direction, error)
            errback()
            return
        }
        callback()
    })

    if (direction === 'send') {
        // 如果是上行， 监听生产事件
        const paused = false
        transport.on('produce', async ({kind, rtpParameters, appData}, callback, errback) => {
            console.log('transport produce event', appData.mediaTag)
            // 告诉服务端开始传输  并获得一个生产者id
            let {error, id} = await cli.post('send-track', {
                transportId: transportOptions.id,
                kind,
                rtpParameters,
                paused,
                appData
            })
            if (error) {
                console.log('error setting up server-side producer', error)
                errback()
                return
            }
            // 告诉本地的传输通道谁是生产者
            callback({id})
        })
    }
    // 传输通道状态改变事件
    transport.on('connectionstatechange', async (state) => {
        console.log(`transport ${transport.id} connectionstatechange ${state}`)
        if (state === 'closed' || state === 'failed' || state === 'disconnected') {
            console.log('transport closed ... leaving the room and resetting')
            callbacks.showError('媒体流传输出错，断开连接')
            // 当连接失败、关闭、断开时 退出房间
            cli.disconnect()
        }
    })

    return transport
}

// 暂停生产通道
async function pauseProducer(producer) {
    if (producer) {
        console.log('pause producer', producer.appData.mediaTag);
        try {
            await cli.post('pause-producer', {producerId: producer.id});
            await producer.pause();
        } catch (e) {
            console.error(e);
        }
    }
}

// 唤醒生产通道
async function resumeProducer(producer) {
    if (producer) {
        console.log('resume producer', producer.appData.mediaTag);
        try {
            await cli.post('resume-producer', {producerId: producer.id});
            await producer.resume();
        } catch (e) {
            console.error(e);
        }
    }
}

// 关闭消费者
async function closeConsumer(consumer) {
    if (!consumer) {
        return;
    }
    console.log('closing consumer', consumer.appData.peerId, consumer.appData.mediaTag);
    try {
        await cli.post('close-consumer', {consumerId: consumer.id});
        await consumer.close();
        context.consumers = context.consumers.filter((c) => c !== consumer);
    } catch (e) {
        console.error(e);
    }
}

// 暂停消费
export async function pauseConsumer(consumer) {
    if (consumer) {
        console.log('pause consumer', consumer.appData.peerId, consumer.appData.mediaTag);
        try {
            // 通知服务端
            await cli.post('pause-consumer', {consumerId: consumer.id});
            // 直接暂停
            await consumer.pause();
        } catch (e) {
            console.error(e);
        }
    }
}

// 唤醒消费
export async function resumeConsumer(consumer) {
    if (consumer) {
        console.log('resume consumer', consumer.appData.peerId, consumer.appData.mediaTag);
        try {
            // 通知服务端
            await cli.post('resume-consumer', {consumerId: consumer.id});
            // 直接唤醒
            await consumer.resume();
        } catch (e) {
            console.error(e);
        }
    }
}

function findConsumerForTrack(peerId, mediaTag) {
    return context.consumers.find((c) => (c.appData.peerId === peerId && c.appData.mediaTag === mediaTag));
}

async function release() {
    try {
        context.recvTransport && await context.recvTransport.close()
        context.sendTransport && await context.sendTransport.close()
    } catch (e) {
        console.error(e)
    }
    context.recvTransport = null
    context.sendTransport = null
    context.cameraProducer = null
    context.voiceProducer = null
    context.screenProducer = null
    cameraStream = null
    screenStream = null
    context.consumers = [];
}