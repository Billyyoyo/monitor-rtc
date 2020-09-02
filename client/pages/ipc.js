const {ipcRenderer} = window.require('electron')
let voiceKeyListener = {
    onPress: null,
    onRelease: null
}
ipcRenderer.on('onVoiceKeyPress', (ev, msg) => {
    if (voiceKeyListener.onPress && voiceKeyListener.onRelease) {
        if (msg) {
            voiceKeyListener.onPress()
        } else {
            voiceKeyListener.onRelease()
        }
    }
})