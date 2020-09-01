const {desktopCapturer} = require('electron')

const fs = require('fs')

class Recorder {

    constructor(path) {
        this.mediaOutputPath = path;
    }

    startScreenRecord = () => {
        desktopCapturer.getSources({types: ['window', 'screen']}).then(async sources => {
            for (const source of sources) {
                if (source.name === 'Entire Screen') {
                    try {
                        let stream = await navigator.mediaDevices.getUserMedia({
                            audio: false,
                            video: {
                                mandatory: {
                                    chromeMediaSource: 'desktop',
                                    chromeMediaSourceId: source.id,
                                    maxWidth: 1920,
                                    maxHeight: 1080,
                                    maxFrameRate: 5.0,
                                }
                            }
                        })
                        this.createRecorder(stream)
                    } catch (e) {
                        console.log(e)
                    }
                }
            }
        })
    }

    startCameraRecord = async () => {
        try {
            let stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount:1,
                    sampleRate: 16000
                },
                video: {
                    width: 640,
                    height: 360,
                    maxFrameRate: 2.0,
                }
            })
            this.createRecorder(stream)
        } catch (e) {
            console.log(e)
        }
    }

    getMicroAudioStream = () => {
        return navigator.mediaDevices.getUserMedia({audio: true, video: true})
    }

    getUserMediaError = (err) => {
        console.log('mediaError', err);


    }


    getUserAudioError = (err) => {
        console.log('audioError', err);

    }

    createRecorder = (stream) => {
        console.log('start record');
        this.recorder = new MediaRecorder(stream);
        this.recorder.start();
        this.recorder.ondataavailable = event => {
            let blob = new Blob([event.data], {
                type: 'video/mp4'
            });
            this.saveMedia(blob);

        };

    }

    saveMedia = (blob) => {
        let reader = new FileReader();
        reader.onload = function () {
            let buffer = new Buffer(reader.result)
            let now = new Date().toISOString()
            fs.writeFile(`./videos/${now}.mp4`, buffer, {}, (err, res) => {
                if (err) {
                    console.error(err);
                    return
                }
            })
        }
        reader.readAsArrayBuffer(blob);
    }

    stopRecord = () => {
        this.recorder.stop();
    }

}