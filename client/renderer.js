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
                                minWidth: 1280,
                                maxWidth: 1280,
                                minHeight: 720,
                                maxHeight: 720
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