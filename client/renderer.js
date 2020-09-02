const {desktopCapturer} = require('electron')


export async function getScreenMedias() {
    let stream = null
    await desktopCapturer.getSources({types: ['window', 'screen']}).then(async sources => {
        for (const source of sources) {
            if (source.name === 'Entire Screen') {
                try {
                    stream = await navigator.mediaDevices.getUserMedia({
                        audio: false,
                        video: {
                            mandatory: {
                                chromeMediaSource: 'desktop',
                                chromeMediaSourceId: source.id,
                                minWidth: 1920,
                                maxWidth: 1920,
                                minHeight: 1080,
                                maxHeight: 1080,
                                maxFrameRate: 8.0
                            }
                        }
                    })
                } catch (e) {
                    console.log(e)
                }
            }
        }
    })
    return stream
}

//                                maxFrameRate: 5.0
export async function getCameraMedias() {
    let stream
    console.log('start camera');
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            video: {
                width: 640,
                height: 360,
                frameRate: 15
            },
            audio: {
                noiseSuppression: true,
                echoCancellation:true
            }
        });
    } catch (e) {
        console.error('start camera error', e);
    }
    return stream
}

// video: {
//     width: 640,
//         height: 360,
//         maxBitrate: 600,
//         minBitrate: 400,
// },
// audio: {
//     sampleRate: 16000,
//         channelCount: 1
// }