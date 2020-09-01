// import * as config from './config';
import * as mediasoup from 'mediasoup-client';
import deepEqual from 'deep-equal';
import {getScreenMedias} from '../renderer-record'

//
// export all the references we use internally to manage call state,
// to make it easy to tinker from the js console. for example:
//
//   `Client.camVideoProducer.paused`
// 随机生成一个peerid
export let myPeerId;
export let myRoomId;
// 全局变量
export let device,
    joined,
    localCam,
    localScreen,
    recvTransport,
    sendTransport,
    camVideoProducer,
    camAudioProducer,
    screenVideoProducer,
    screenAudioProducer,
    currentActiveSpeaker = {},
    lastPollSyncData = {},
    consumers = [],
    pollingInterval;

export let joinCallback, // status joined true/false
    roomStateCallback,
    cameraStateCallback, // 1start 0stop
    screenStateCallback; // 1start 0stop

//
// entry point -- called by document.body.onload
//
// 页面加载完成后初始化函数
export async function main() {
    console.log(`starting up ... my peerId is ${myPeerId}`);
    try {
        // 检查浏览器是否支持视频通话
        device = new mediasoup.Device();
    } catch (e) {
        if (e.name === 'UnsupportedError') {
            console.error('browser not supported for video calls');
            return;
        } else {
            console.error(e);
        }
    }

    // use sendBeacon to tell the server we're disconnecting when
    // the page unloads
    // 当关闭页面的时候调用离开房间指令
    window.addEventListener('unload', () => sig('leave', {}, true));
}

//
// meeting control actions
//
// 加入房间
export async function joinRoom(peerId, roomId, userName, roomName, isAdmin) {
    if (joined) {
        return;
    }
    myPeerId = peerId;
    myRoomId = roomId;
    console.log('join room');
    try {
        // signal that we're a new peer and initialize our
        // mediasoup-client device, if this is our first time connecting
        // 调用加入指令，获取rtc支持的能力
        let {routerRtpCapabilities} = await sig('join-as-new-peer', {
            roomId: myRoomId,
            userName: userName,
            roomName: roomName,
            isAdmin: isAdmin
        });
        // 用服务端支持的能力加载设备对象
        if (!device.loaded) {
            await device.load({routerRtpCapabilities});
        }
        joined = true;
        if (joinCallback) {
            joinCallback(joined)
        }
    } catch (e) {
        console.error(e);
        return;
    }

    // super-simple signaling: let's poll at 1-second intervals
    // 每秒发送浏览器同步指令  保持在线状态
    pollingInterval = setInterval(async () => {
        let {error} = await pollAndUpdate();
        if (error) {
            clearInterval(pollingInterval);
            console.log(error);
        }
    }, 1000);
}

// 页面点击上传摄像头视频流
export async function sendCameraStreams() {
    console.log('send camera streams');

    // make sure we've joined the room and started our camera. these
    // functions don't do anything if they've already been called this
    // session
    // 前提是已经加入房间 并 开启了摄像头
    await joinRoom();
    await startCamera();

    // create a transport for outgoing media, if we don't already have one
    // 创建一个上行的传输对象
    if (!sendTransport) {
        sendTransport = await createTransport('send');
    }

    // start sending video. the transport logic will initiate a
    // signaling conversation with the server to set up an outbound rtp
    // stream for the camera video track. our createTransport() function
    // includes logic to tell the server to start the stream in a paused
    // state, if the checkbox in our UI is unchecked. so as soon as we
    // have a client-side camVideoProducer object, we need to set it to
    // paused as appropriate, too.
    // 开始对接摄像头视频流到上行传输对象  并获得一个上行的生产者控制对象
    camVideoProducer = await sendTransport.produce({
        track: localCam.getVideoTracks()[0],
        encodings: camEncodings(),
        appData: {mediaTag: 'cam-video'}
    });

    // same thing for audio, but we can use our already-created
    // 开始对接麦克风音频流到上行传输对象  并获得一个上行的生产者控制对象
    camAudioProducer = await sendTransport.produce({
        track: localCam.getAudioTracks()[0],
        appData: {mediaTag: 'cam-audio'}
    });

    if (cameraStateCallback) {
        cameraStateCallback(1);
    }
}

// 页面点击分享屏幕视频流
export async function startScreenshare() {
    console.log('start screen share');

    // make sure we've joined the room and that we have a sending
    // transport
    // 前提是加入房间
    await joinRoom();
    // 创建上行传输通道
    if (!sendTransport) {
        sendTransport = await createTransport('send');
    }

    // get a screen share track
    // 从浏览器的屏幕插件获取屏幕视频流
    localScreen = await getScreenMedias();
    if (!localScreen) {
        console.log('can\'t get screen capture media from electron')
        return
    }
    // create a producer for video
    // 对接传输视频流  并获得一个视频流生产者控制对象
    screenVideoProducer = await sendTransport.produce({
        track: localScreen.getVideoTracks()[0],
        encodings: screenshareEncodings(),
        appData: {mediaTag: 'screen-video'}
    });

    // create a producer for audio, if we have it
    // 对接传输音频流  并获得一个音频流生产者控制对象
    if (localScreen.getAudioTracks().length) {
        screenAudioProducer = await sendTransport.produce({
            track: localScreen.getAudioTracks()[0],
            appData: {mediaTag: 'screen-audio'}
        });
    }

    // handler for screen share stopped event (triggered by the
    // browser's built-in screen sharing ui)
    // 当上行生产者结束上传视频流
    screenVideoProducer.track.onended = async () => {
        console.log('screen share stopped');
        try {
            // 暂停上传
            await screenVideoProducer.pause();
            let {error} = await sig('close-producer',
                {producerId: screenVideoProducer.id});
            // 关闭生产者
            await screenVideoProducer.close();
            screenVideoProducer = null;
            if (error) {
                console.log(error);
            }
            // 同时关闭音频流的生产者
            if (screenAudioProducer) {
                let {error} = await sig('close-producer',
                    {producerId: screenAudioProducer.id});
                await screenAudioProducer.close();
                screenAudioProducer = null;
                if (error) {
                    console.log(error);
                }
            }
        } catch (e) {
            console.error(e);
        }
        if (screenStateCallback) {
            screenStateCallback(0)
        }
    }

    if (screenStateCallback) {
        screenStateCallback(1)
    }
}

// 开启摄像头
export async function startCamera() {
    if (localCam) {
        return;
    }
    console.log('start camera');
    try {
        localCam = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: {
                sampleRate: 44100,
                channelCount: 1
            }
        });
    } catch (e) {
        console.error('start camera error', e);
    }
}

// 停止上行流
export async function stopStreams() {
    if (!(localCam || localScreen)) {
        return;
    }
    if (!sendTransport) {
        return;
    }

    console.log('stop sending media streams');

    // 关闭传输通道指令
    let {error} = await sig('close-transport',
        {transportId: sendTransport.id});
    if (error) {
        console.log(error);
    }
    // closing the sendTransport closes all associated producers. when
    // the camVideoProducer and camAudioProducer are closed,
    // mediasoup-client stops the local cam tracks, so we don't need to
    // do anything except set all our local variables to null.
    // 关闭本地传输通道
    try {
        await sendTransport.close();
    } catch (e) {
        console.error(e);
    }
    // 清除所有上行相关对象
    sendTransport = null;
    camVideoProducer = null;
    camAudioProducer = null;
    screenVideoProducer = null;
    screenAudioProducer = null;
    localCam = null;
    localScreen = null;

    if (cameraStateCallback) {
        cameraStateCallback(0);
    }
    if (screenStateCallback) {
        screenStateCallback(0);
    }
}

// 退出房间
export async function leaveRoom() {
    if (!joined) {
        return;
    }
    console.log('leave room');

    // stop polling
    clearInterval(pollingInterval);

    // close everything on the server-side (transports, producers, consumers)
    // 退出房间指令
    let {error} = await sig('leave');
    if (error) {
        console.log(error);
    }

    // closing the transports closes all producers and consumers. we
    // don't need to do anything beyond closing the transports, except
    // to set all our local variables to their initial states
    // 关闭上行和下行传输通道
    try {
        recvTransport && await recvTransport.close();
        sendTransport && await sendTransport.close();
    } catch (e) {
        console.error(e);
    }
    // 释放对象
    recvTransport = null;
    sendTransport = null;
    camVideoProducer = null;
    camAudioProducer = null;
    screenVideoProducer = null;
    screenAudioProducer = null;
    localCam = null;
    localScreen = null;
    lastPollSyncData = {};
    consumers = [];
    joined = false;

    // hacktastically restore ui to initial state
    if (joinCallback) {
        joinCallback(false);
    }
}

// 订阅某个端   比如房间中其他人
export async function subscribeToTrack(peerId, mediaTag) {
    console.log('subscribe to track', peerId, mediaTag);

    // create a receive transport if we don't already have one
    // 创建一个下行传输通道
    if (!recvTransport) {
        recvTransport = await createTransport('recv');
    }

    // if we do already have a consumer, we shouldn't have called this
    // method
    // 判断是否已经订阅了该peer
    let consumer = findConsumerForTrack(peerId, mediaTag);
    if (consumer) {
        console.log('already have consumer for track', peerId, mediaTag)
        return;
    }
    ;

    // ask the server to create a server-side consumer object and send
    // us back the info we need to create a client-side consumer
    // 发出下行拉取指令 并获取到消费者的消费参数
    let consumerParameters = await sig('recv-track', {
        mediaTag,
        mediaPeerId: peerId,
        rtpCapabilities: device.rtpCapabilities
    });
    console.log('consumer parameters', consumerParameters);
    // 创建消费者通道
    consumer = await recvTransport.consume({
        ...consumerParameters,
        appData: {peerId, mediaTag}
    });
    console.log('created new consumer', consumer.id);

    // the server-side consumer will be started in paused state. wait
    // until we're connected, then send a resume request to the server
    // to get our first keyframe and start displaying video
    // 轮训等待下行通道连通
    while (recvTransport.connectionState !== 'connected') {
        console.log('  transport connstate', recvTransport.connectionState);
        await sleep(100);
    }
    // okay, we're ready. let's ask the peer to send us media
    // 通知生产者推送给消费者数据流
    await resumeConsumer(consumer);

    // keep track of all our consumers
    // 保存消费者通道
    consumers.push(consumer);

    // todo ui 更新界面
    // if (!(consumer && consumer.track)) {
    //     return;
    // }
    // <video id="xxx" playsinline >
    // <audio id="xxx" playsinline autoplay>
    // $("#xxx").srcObject = new MediaStream([consumer.track.clone()])
    // $("#xxx").consumer = consumer
    // $("#xxx").play().then(()=>{}).catch(err=>console.log(err))
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

// 暂停消费
export async function pauseConsumer(consumer) {
    if (consumer) {
        console.log('pause consumer', consumer.appData.peerId, consumer.appData.mediaTag);
        try {
            // 通知服务端
            await sig('pause-consumer', {consumerId: consumer.id});
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
            await sig('resume-consumer', {consumerId: consumer.id});
            // 直接唤醒
            await consumer.resume();
        } catch (e) {
            console.error(e);
        }
    }
}

// 暂停生产通道
export async function pauseProducer(producer) {
    if (producer) {
        console.log('pause producer', producer.appData.mediaTag);
        try {
            await sig('pause-producer', {producerId: producer.id});
            await producer.pause();
        } catch (e) {
            console.error(e);
        }
    }
}

// 唤醒生产通道
export async function resumeProducer(producer) {
    if (producer) {
        console.log('resume producer', producer.appData.mediaTag);
        try {
            await sig('resume-producer', {producerId: producer.id});
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
        // tell the server we're closing this consumer. (the server-side
        // consumer may have been closed already, but that's okay.)
        await sig('close-consumer', {consumerId: consumer.id});
        await consumer.close();

        consumers = consumers.filter((c) => c !== consumer);
    } catch (e) {
        console.error(e);
    }
}

// utility function to create a transport and hook up signaling logic
// appropriate to the transport's direction
// 创建传输对象（上行、下行）
async function createTransport(direction) {
    console.log(`create ${direction} transport`);

    // ask the server to create a server-side transport object and send
    // us back the info we need to create a client-side transport
    // 通知服务端执行创建传输对象   并获取到创建传输通道参数
    let transport,
        {transportOptions} = await sig('create-transport', {direction});
    console.log('transport options', transportOptions);

    if (direction === 'recv') {
        // 创建接收传输通道
        transport = await device.createRecvTransport(transportOptions);
    } else if (direction === 'send') {
        // 创建发送传输通道
        transport = await device.createSendTransport(transportOptions);
    } else {
        throw new Error(`bad transport 'direction': ${direction}`);
    }

    // mediasoup-client will emit a connect event when media needs to
    // start flowing for the first time. send dtlsParameters to the
    // server, then call callback() on success or errback() on failure.
    // 当传输通道已经建立好连接
    transport.on('connect', async ({dtlsParameters}, callback, errback) => {
        console.log('transport connect event', direction);
        // 告诉服务端连接传输通道（udp）
        let {error} = await sig('connect-transport', {
            transportId: transportOptions.id,
            dtlsParameters
        });
        if (error) {
            console.log('error connecting transport', direction, error);
            errback();
            return;
        }
        callback();
    });

    if (direction === 'send') {
        // sending transports will emit a produce event when a new track
        // needs to be set up to start sending. the producer's appData is
        // passed as a parameter
        // 如果是上行， 监听生产事件
        const paused = true
        transport.on('produce', async ({kind, rtpParameters, appData},
                                       callback, errback) => {
            console.log('transport produce event', appData.mediaTag);
            // we may want to start out paused (if the checkboxes in the ui
            // aren't checked, for each media type. not very clean code, here
            // but, you know, this isn't a real application.)
            // 根据用户页面操作判断是否需要暂停
            if (appData.mediaTag === 'screen-video') {
                // 监听如果是分享屏幕的生产者  开始录制视频
                setTimeout(startRecord, 1000)
            }
            // tell the server what it needs to know from us in order to set
            // up a server-side producer object, and get back a
            // producer.id. call callback() on success or errback() on
            // failure.
            // 告诉服务端开始传输  并获得一个生产者id
            let {error, id} = await sig('send-track', {
                transportId: transportOptions.id,
                kind,
                rtpParameters,
                paused,
                appData
            });
            if (error) {
                console.log('error setting up server-side producer', error);
                errback();
                return;
            }
            // 告诉本地的传输通道谁是生产者
            callback({id});
        });
    }

    // for this simple demo, any time a transport transitions to closed,
    // failed, or disconnected, leave the room and reset
    // 传输通道状态改变事件
    transport.on('connectionstatechange', async (state) => {
        console.log(`transport ${transport.id} connectionstatechange ${state}`);
        // for this simple sample code, assume that transports being
        // closed is an error (we never close these transports except when
        // we leave the room)
        if (state === 'closed' || state === 'failed' || state === 'disconnected') {
            console.log('transport closed ... leaving the room and resetting');
            // 当连接失败、关闭、断开时 退出房间
            leaveRoom();
        }
    });

    return transport;
}

async function startRecord() {
    let {result} = await sig('start-record', {
        transportId: sendTransport.id,
        audioProducerId: camAudioProducer.id,
        videoProducerId: screenVideoProducer.id,
    });
    console.log('start record screen and audio')
    console.log(result)
}

//
// polling/update logic
//

async function pollAndUpdate() {
    let {peers, activeSpeaker, error} = await sig('sync');
    if (error) {
        return ({error});
    }

    // always update bandwidth stats and active speaker display
    // 同步连接状态的同时 获取当前的发言者 （服务端根据音量判断后返回的peer）
    currentActiveSpeaker = activeSpeaker;

    let msgs = []
    if (roomStateCallback) {
        roomStateCallback(peers, msgs)
    }

    // if a peer has gone away, we need to close all consumers we have
    // for that peer and remove video and audio elements
    // 如果同步过来的在线列表中没有之前本地在线列表中的连接   说明该连接已经断开  那么关闭对该连接的消费者   就是不看他的视频和音频
    // todo 改用vue后在组件中的destroy方法中释放消费者
    for (let id in lastPollSyncData) {
        if (!peers[id]) {
            console.log(`peer ${id} has exited`);
            consumers.forEach((consumer) => {
                if (consumer.appData.peerId === id) {
                    closeConsumer(consumer);
                }
            });
        }
    }

    // if a peer has stopped sending media that we are consuming, we
    // need to close the consumer and remove video and audio elements
    // 对本地每个消费者检查生产者是否还在推流  否则关闭对该连接的消费者
    consumers.forEach((consumer) => {
        let {peerId, mediaTag} = consumer.appData;
        if (!peers[peerId].media[mediaTag]) {
            console.log(`peer ${peerId} has stopped transmitting ${mediaTag}`);
            closeConsumer(consumer);
        }
    });

    // 将同步数据保存到本地
    lastPollSyncData = peers;
    return ({}); // return an empty object if there isn't an error
}

function findConsumerForTrack(peerId, mediaTag) {
    return consumers.find((c) => (c.appData.peerId === peerId &&
        c.appData.mediaTag === mediaTag));
}

//
// encodings for outgoing video
//

// just two resolutions, for now, as chrome 75 seems to ignore more
// than two encodings
// todo 
const CAM_VIDEO_SIMULCAST_ENCODINGS =
    [
        {maxBitrate: 96000, scaleResolutionDownBy: 4},
        {maxBitrate: 680000, scaleResolutionDownBy: 1},
    ];

function camEncodings() {
    return CAM_VIDEO_SIMULCAST_ENCODINGS;
}

// how do we limit bandwidth for screen share streams?
//
function screenshareEncodings() {
    null;
}

//
// our "signaling" function -- just an http fetch
//

async function sig(endpoint, data, beacon) {
    try {
        let headers = {'Content-Type': 'application/json'},
            body = JSON.stringify({...data, peerId: myPeerId});

        if (beacon) {
            navigator.sendBeacon(window.rtc_url +'/signaling/' + endpoint, body);
            return null;
        }

        let response = await fetch(
            window.rtc_url +'/signaling/' + endpoint, {method: 'POST', body, headers}
        );
        return await response.json();
    } catch (e) {
        console.error(e);
        return {error: e};
    }
}


//
// promisified sleep
//

async function sleep(ms) {
    return new Promise((r) => setTimeout(() => r(), ms));
}
