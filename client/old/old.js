// import * as config from './config';
import * as mediasoup from 'mediasoup-client';
import deepEqual from 'deep-equal';
import {getScreenMedias} from '../renderer-record'

const $ = document.querySelector.bind(document);
const $$ = document.querySelectorAll.bind(document);

//
// export all the references we use internally to manage call state,
// to make it easy to tinker from the js console. for example:
//
//   `Client.camVideoProducer.paused`
// 随机生成一个peerid
export const myPeerId = uuidv4();
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
export async function joinRoom() {
    if (joined) {
        return;
    }

    console.log('join room');
    $('#join-control').style.display = 'none';

    try {
        // signal that we're a new peer and initialize our
        // mediasoup-client device, if this is our first time connecting
        // 调用加入指令，获取rtc支持的能力
        let {routerRtpCapabilities} = await sig('join-as-new-peer');
        // 用服务端支持的能力加载设备对象
        if (!device.loaded) {
            await device.load({routerRtpCapabilities});
        }
        joined = true;
        $('#leave-room').style.display = 'initial';
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
    $('#send-camera').style.display = 'none';

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
    // 如果页面上的摄像头暂停状态checkbox关闭  那么暂停上传
    if (getCamPausedState()) {
        try {
            await camVideoProducer.pause();
        } catch (e) {
            console.error(e);
        }
    }

    // same thing for audio, but we can use our already-created
    // 开始对接麦克风音频流到上行传输对象  并获得一个上行的生产者控制对象
    camAudioProducer = await sendTransport.produce({
        track: localCam.getAudioTracks()[0],
        appData: {mediaTag: 'cam-audio'}
    });
    if (getMicPausedState()) {
        try {
            camAudioProducer.pause();
        } catch (e) {
            console.error(e);
        }
    }

    $('#stop-streams').style.display = 'initial';
    showCameraInfo();
}

// 页面点击分享屏幕视频流
export async function startScreenshare() {
    console.log('start screen share');
    $('#share-screen').style.display = 'none';

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
        $('#local-screen-pause-ctrl').style.display = 'none';
        $('#local-screen-audio-pause-ctrl').style.display = 'none';
        $('#share-screen').style.display = 'initial';
    }

    $('#local-screen-pause-ctrl').style.display = 'block';
    if (screenAudioProducer) {
        $('#local-screen-audio-pause-ctrl').style.display = 'block';
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
            audio: true
        });
    } catch (e) {
        console.error('start camera error', e);
    }
}

// switch to sending video from the "next" camera device in our device
// list (if we have multiple cameras)
// 多个摄像头的时候做切换摄像头用
export async function cycleCamera() {
    if (!(camVideoProducer && camVideoProducer.track)) {
        console.log('cannot cycle camera - no current camera track');
        return;
    }

    console.log('cycle camera');

    // find "next" device in device list
    let deviceId = await getCurrentDeviceId(),
        allDevices = await navigator.mediaDevices.enumerateDevices(),
        vidDevices = allDevices.filter((d) => d.kind === 'videoinput');
    if (!vidDevices.length > 1) {
        console.log('cannot cycle camera - only one camera');
        return;
    }
    let idx = vidDevices.findIndex((d) => d.deviceId === deviceId);
    if (idx === (vidDevices.length - 1)) {
        idx = 0;
    } else {
        idx += 1;
    }

    // get a new video stream. might as well get a new audio stream too,
    // just in case browsers want to group audio/video streams together
    // from the same device when possible (though they don't seem to,
    // currently)
    console.log('getting a video stream from new device', vidDevices[idx].label);
    localCam = await navigator.mediaDevices.getUserMedia({
        video: {deviceId: {exact: vidDevices[idx].deviceId}},
        audio: true
    });

    // replace the tracks we are sending
    await camVideoProducer.replaceTrack({track: localCam.getVideoTracks()[0]});
    await camAudioProducer.replaceTrack({track: localCam.getAudioTracks()[0]});

    // update the user interface
    showCameraInfo();
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
    $('#stop-streams').style.display = 'none';

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

    // update relevant ui elements
    $('#send-camera').style.display = 'initial';
    $('#share-screen').style.display = 'initial';
    $('#local-screen-pause-ctrl').style.display = 'none';
    $('#local-screen-audio-pause-ctrl').style.display = 'none';
    showCameraInfo();
}

// 退出房间
export async function leaveRoom() {
    if (!joined) {
        return;
    }

    console.log('leave room');
    $('#leave-room').style.display = 'none';

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
    $('#join-control').style.display = 'initial';
    $('#send-camera').style.display = 'initial';
    $('#stop-streams').style.display = 'none';
    $('#remote-video').innerHTML = '';
    $('#share-screen').style.display = 'initial';
    $('#local-screen-pause-ctrl').style.display = 'none';
    $('#local-screen-audio-pause-ctrl').style.display = 'none';
    showCameraInfo();
    updateCamVideoProducerStatsDisplay();
    updateScreenVideoProducerStatsDisplay();
    updatePeersDisplay();
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

    // ui 更新界面
    await addVideoAudio(consumer);
    updatePeersDisplay();
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
    // force update of ui
    updatePeersDisplay();
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

// 管理消费者
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
        // 删除该消费通道的页面元素
        removeVideoAudio(consumer);
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
        transport.on('produce', async ({kind, rtpParameters, appData},
                                       callback, errback) => {
            console.log('transport produce event', appData.mediaTag);
            // we may want to start out paused (if the checkboxes in the ui
            // aren't checked, for each media type. not very clean code, here
            // but, you know, this isn't a real application.)
            // 根据用户页面操作判断是否需要暂停
            let paused = false;
            if (appData.mediaTag === 'cam-video') {
                paused = getCamPausedState();
            } else if (appData.mediaTag === 'cam-audio') {
                paused = getMicPausedState();
            } else if (appData.mediaTag === 'screen-video') {
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
    updateActiveSpeaker();
    updateCamVideoProducerStatsDisplay();
    updateScreenVideoProducerStatsDisplay();
    updateConsumersStatsDisplay();

    // decide if we need to update tracks list and video/audio
    // elements. build list of peers, sorted by join time, removing last
    // seen time and stats, so we can easily do a deep-equals
    // comparison. compare this list with the cached list from last
    // poll.
    // 在线连接列表
    let thisPeersList = sortPeers(peers),
        lastPeersList = sortPeers(lastPollSyncData);
    if (!deepEqual(thisPeersList, lastPeersList)) {
        updatePeersDisplay(peers, thisPeersList);
    }

    // if a peer has gone away, we need to close all consumers we have
    // for that peer and remove video and audio elements
    // 如果同步过来的在线列表中没有之前本地在线列表中的连接   说明该连接已经断开  那么关闭对该连接的消费者   就是不看他的视频和音频
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
    // 对本地每个消费者检查是否还在推流  否则关闭对该连接的消费者
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

function sortPeers(peers) {
    return Object.entries(peers)
        .map(([id, info]) => ({id, joinTs: info.joinTs, media: {...info.media}}))
        .sort((a, b) => (a.joinTs > b.joinTs) ? 1 : ((b.joinTs > a.joinTs) ? -1 : 0));
}

function findConsumerForTrack(peerId, mediaTag) {
    return consumers.find((c) => (c.appData.peerId === peerId &&
        c.appData.mediaTag === mediaTag));
}

//
// -- user interface --
//

export function getCamPausedState() {
    return !$('#local-cam-checkbox').checked;
}

export function getMicPausedState() {
    return !$('#local-mic-checkbox').checked;
}

export function getScreenPausedState() {
    return !$('#local-screen-checkbox').checked;
}

export function getScreenAudioPausedState() {
    return !$('#local-screen-audio-checkbox').checked;
}

export async function changeCamPaused() {
    if (getCamPausedState()) {
        pauseProducer(camVideoProducer);
        $('#local-cam-label').innerHTML = 'camera (paused)';
    } else {
        resumeProducer(camVideoProducer);
        $('#local-cam-label').innerHTML = 'camera';
    }
}

export async function changeMicPaused() {
    if (getMicPausedState()) {
        pauseProducer(camAudioProducer);
        $('#local-mic-label').innerHTML = 'mic (paused)';
    } else {
        resumeProducer(camAudioProducer);
        $('#local-mic-label').innerHTML = 'mic';
    }
}

export async function changeScreenPaused() {
    if (getScreenPausedState()) {
        pauseProducer(screenVideoProducer);
        $('#local-screen-label').innerHTML = 'screen (paused)';
    } else {
        resumeProducer(screenVideoProducer);
        $('#local-screen-label').innerHTML = 'screen';
    }
}

export async function changeScreenAudioPaused() {
    if (getScreenAudioPausedState()) {
        pauseProducer(screenAudioProducer);
        $('#local-screen-audio-label').innerHTML = 'screen (paused)';
    } else {
        resumeProducer(screenAudioProducer);
        $('#local-screen-audio-label').innerHTML = 'screen';
    }
}


export async function updatePeersDisplay(peersInfo = lastPollSyncData,
                                         sortedPeers = sortPeers(peersInfo)) {
    console.log('room state updated', peersInfo);

    $('#available-tracks').innerHTML = '';
    if (camVideoProducer) {
        $('#available-tracks')
            .appendChild(makeTrackControlEl('my', 'cam-video',
                peersInfo[myPeerId].media['cam-video']));
    }
    if (camAudioProducer) {
        $('#available-tracks')
            .appendChild(makeTrackControlEl('my', 'cam-audio',
                peersInfo[myPeerId].media['cam-audio']));
    }
    if (screenVideoProducer) {
        $('#available-tracks')
            .appendChild(makeTrackControlEl('my', 'screen-video',
                peersInfo[myPeerId].media['screen-video']));
    }
    if (screenAudioProducer) {
        $('#available-tracks')
            .appendChild(makeTrackControlEl('my', 'screen-audio',
                peersInfo[myPeerId].media['screen-audio']));
    }

    for (let peer of sortedPeers) {
        if (peer.id === myPeerId) {
            continue;
        }
        for (let [mediaTag, info] of Object.entries(peer.media)) {
            $('#available-tracks')
                .appendChild(makeTrackControlEl(peer.id, mediaTag, info));
        }
    }
}

function makeTrackControlEl(peerName, mediaTag, mediaInfo) {
    let div = document.createElement('div'),
        peerId = (peerName === 'my' ? myPeerId : peerName),
        consumer = findConsumerForTrack(peerId, mediaTag);
    div.classList = `track-subscribe track-subscribe-${peerId}`;

    let sub = document.createElement('button');
    if (!consumer) {
        sub.innerHTML += 'subscribe'
        sub.onclick = () => subscribeToTrack(peerId, mediaTag);
        div.appendChild(sub);

    } else {
        sub.innerHTML += 'unsubscribe'
        sub.onclick = () => unsubscribeFromTrack(peerId, mediaTag);
        div.appendChild(sub);
    }

    let trackDescription = document.createElement('span');
    trackDescription.innerHTML = `${peerName} ${mediaTag}`
    div.appendChild(trackDescription);

    try {
        if (mediaInfo) {
            let producerPaused = mediaInfo.paused;
            let prodPauseInfo = document.createElement('span');
            prodPauseInfo.innerHTML = producerPaused ? '[producer paused]'
                : '[producer playing]';
            div.appendChild(prodPauseInfo);
        }
    } catch (e) {
        console.error(e);
    }

    if (consumer) {
        let pause = document.createElement('span'),
            checkbox = document.createElement('input'),
            label = document.createElement('label');
        pause.classList = 'nowrap';
        checkbox.type = 'checkbox';
        checkbox.checked = !consumer.paused;
        checkbox.onchange = async () => {
            if (checkbox.checked) {
                await resumeConsumer(consumer);
            } else {
                await pauseConsumer(consumer);
            }
            updatePeersDisplay();
        }
        label.id = `consumer-stats-${consumer.id}`;
        if (consumer.paused) {
            label.innerHTML = '[consumer paused]'
        } else {
            let stats = lastPollSyncData[myPeerId].stats[consumer.id],
                bitrate = '-';
            if (stats) {
                bitrate = Math.floor(stats.bitrate / 1000.0);
            }
            label.innerHTML = `[consumer playing ${bitrate} kb/s]`;
        }
        pause.appendChild(checkbox);
        pause.appendChild(label);
        div.appendChild(pause);

        if (consumer.kind === 'video') {
            let remoteProducerInfo = document.createElement('span');
            remoteProducerInfo.classList = 'nowrap track-ctrl';
            remoteProducerInfo.id = `track-ctrl-${consumer.producerId}`;
            div.appendChild(remoteProducerInfo);
        }
    }

    return div;
}

function addVideoAudio(consumer) {
    if (!(consumer && consumer.track)) {
        return;
    }
    let el = document.createElement(consumer.kind);
    // set some attributes on our audio and video elements to make
    // mobile Safari happy. note that for audio to play you need to be
    // capturing from the mic/camera
    if (consumer.kind === 'video') {
        el.setAttribute('playsinline', true);
    } else {
        el.setAttribute('playsinline', true);
        el.setAttribute('autoplay', true);
    }
    $(`#remote-${consumer.kind}`).appendChild(el);
    el.srcObject = new MediaStream([consumer.track.clone()]);
    el.consumer = consumer;
    // let's "yield" and return before playing, rather than awaiting on
    // play() succeeding. play() will not succeed on a producer-paused
    // track until the producer unpauses.
    el.play()
        .then(() => {
        })
        .catch((e) => {
            console.log(e);
        });
}

function removeVideoAudio(consumer) {
    document.querySelectorAll(consumer.kind).forEach((v) => {
        if (v.consumer === consumer) {
            v.parentNode.removeChild(v);
        }
    });
}

async function showCameraInfo() {
    let deviceId = await getCurrentDeviceId(),
        infoEl = $('#camera-info');
    if (!deviceId) {
        infoEl.innerHTML = '';
        return;
    }
    let devices = await navigator.mediaDevices.enumerateDevices(),
        deviceInfo = devices.find((d) => d.deviceId === deviceId);
    infoEl.innerHTML = `
      ${deviceInfo.label}
      <button onclick="Client.cycleCamera()">switch camera</button>
  `;
}

export async function getCurrentDeviceId() {
    if (!camVideoProducer) {
        return null;
    }
    let deviceId = camVideoProducer.track.getSettings().deviceId;
    if (deviceId) {
        return deviceId;
    }
    // Firefox doesn't have deviceId in MediaTrackSettings object
    let track = localCam && localCam.getVideoTracks()[0];
    if (!track) {
        return null;
    }
    let devices = await navigator.mediaDevices.enumerateDevices(),
        deviceInfo = devices.find((d) => d.label.startsWith(track.label));
    return deviceInfo.deviceId;
}

function updateActiveSpeaker() {
    $$('.track-subscribe').forEach((el) => {
        el.classList.remove('active-speaker');
    });
    if (currentActiveSpeaker.peerId) {
        $$(`.track-subscribe-${currentActiveSpeaker.peerId}`).forEach((el) => {
            el.classList.add('active-speaker');
        });
    }
}

function updateCamVideoProducerStatsDisplay() {
    let tracksEl = $('#camera-producer-stats');
    tracksEl.innerHTML = '';
    if (!camVideoProducer || camVideoProducer.paused) {
        return;
    }
    makeProducerTrackSelector({
        internalTag: 'local-cam-tracks',
        container: tracksEl,
        peerId: myPeerId,
        producerId: camVideoProducer.id,
        currentLayer: camVideoProducer.maxSpatialLayer,
        layerSwitchFunc: (i) => {
            console.log('client set layers for cam stream');
            camVideoProducer.setMaxSpatialLayer(i)
        }
    });
}

function updateScreenVideoProducerStatsDisplay() {
    let tracksEl = $('#screen-producer-stats');
    tracksEl.innerHTML = '';
    if (!screenVideoProducer || screenVideoProducer.paused) {
        return;
    }
    makeProducerTrackSelector({
        internalTag: 'local-screen-tracks',
        container: tracksEl,
        peerId: myPeerId,
        producerId: screenVideoProducer.id,
        currentLayer: screenVideoProducer.maxSpatialLayer,
        layerSwitchFunc: (i) => {
            console.log('client set layers for screen stream');
            screenVideoProducer.setMaxSpatialLayer(i)
        }
    });
}

function updateConsumersStatsDisplay() {
    try {
        for (let consumer of consumers) {
            let label = $(`#consumer-stats-${consumer.id}`);
            if (label) {
                if (consumer.paused) {
                    label.innerHTML = '(consumer paused)'
                } else {
                    let stats = lastPollSyncData[myPeerId].stats[consumer.id],
                        bitrate = '-';
                    if (stats) {
                        bitrate = Math.floor(stats.bitrate / 1000.0);
                    }
                    label.innerHTML = `[consumer playing ${bitrate} kb/s]`;
                }
            }

            let mediaInfo = lastPollSyncData[consumer.appData.peerId] &&
                lastPollSyncData[consumer.appData.peerId]
                    .media[consumer.appData.mediaTag];
            if (mediaInfo && !mediaInfo.paused) {
                let tracksEl = $(`#track-ctrl-${consumer.producerId}`);
                if (tracksEl && lastPollSyncData[myPeerId]
                    .consumerLayers[consumer.id]) {
                    tracksEl.innerHTML = '';
                    let currentLayer = lastPollSyncData[myPeerId]
                        .consumerLayers[consumer.id].currentLayer;
                    makeProducerTrackSelector({
                        internalTag: consumer.id,
                        container: tracksEl,
                        peerId: consumer.appData.peerId,
                        producerId: consumer.producerId,
                        currentLayer: currentLayer,
                        layerSwitchFunc: (i) => {
                            console.log('ask server to set layers');
                            sig('consumer-set-layers', {
                                consumerId: consumer.id,
                                spatialLayer: i
                            });
                        }
                    });
                }
            }
        }
    } catch (e) {
        console.log('error while updating consumers stats display', e);
    }
}

function makeProducerTrackSelector({
                                       internalTag, container, peerId, producerId,
                                       currentLayer, layerSwitchFunc
                                   }) {
    try {
        let pollStats = lastPollSyncData[peerId] &&
            lastPollSyncData[peerId].stats[producerId];
        if (!pollStats) {
            return;
        }

        let stats = [...Array.from(pollStats)]
            .sort((a, b) => a.rid > b.rid ? 1 : (a.rid < b.rid ? -1 : 0));
        let i = 0;
        for (let s of stats) {
            let div = document.createElement('div'),
                radio = document.createElement('input'),
                label = document.createElement('label'),
                x = i;
            radio.type = 'radio';
            radio.name = `radio-${internalTag}-${producerId}`;
            radio.checked = currentLayer == undefined ?
                (i === stats.length - 1) :
                (i === currentLayer);
            radio.onchange = () => layerSwitchFunc(x);
            let bitrate = Math.floor(s.bitrate / 1000);
            label.innerHTML = `${bitrate} kb/s`;
            div.appendChild(radio);
            div.appendChild(label);
            container.appendChild(div);
            i++;
        }
        if (i) {
            let txt = document.createElement('div');
            txt.innerHTML = 'tracks';
            container.insertBefore(txt, container.firstChild);
        }
    } catch (e) {
        console.log('error while updating track stats display', e);
    }
}

//
// encodings for outgoing video
//

// just two resolutions, for now, as chrome 75 seems to ignore more
// than two encodings
//
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
            navigator.sendBeacon('http://10.8.240.133:3000/signaling/' + endpoint, body);
            return null;
        }

        let response = await fetch(
            'https://10.8.240.133:3000/signaling/' + endpoint, {method: 'POST', body, headers}
        );
        return await response.json();
    } catch (e) {
        console.error(e);
        return {error: e};
    }
}

//
// simple uuid helper function
//

function uuidv4() {
    return ('111-111-1111').replace(/[018]/g, () =>
        (crypto.getRandomValues(new Uint8Array(1))[0] & 15).toString(16));
}

//
// promisified sleep
//

async function sleep(ms) {
    return new Promise((r) => setTimeout(() => r(), ms));
}
