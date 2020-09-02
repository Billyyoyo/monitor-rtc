const {app, BrowserWindow, globalShortcut, ipcMain} = require('electron')
const path = require('path')

let mainWindow

app.commandLine.appendSwitch('ignore-certificate-errors')

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 640,
        minWidth: 640,
        height: 500,
        minHeight: 500,
        frame: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            allowRunningInsecureContent: true,
            nodeIntegration: true,
            webSecurity: false,
            plugins: true
        }
    })
    // mainWindow.loadURL('https://secure.flyee.cc/aliplay.html')
    // mainWindow.loadFile(`old/old.html`, {})
    mainWindow.loadFile(`pages/index.html`, {})
    mainWindow.webContents.openDevTools()
    mainWindow.setMenu(null)
}

app.on('ready', function () {
    createWindow()
})

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit()
})

app.on('activate', function () {
    if (mainWindow === null) createWindow()
})

let f2Original, f2Ticket = 0
let f2Interval

app.whenReady().then(() => {
    const ret = globalShortcut.register('F2', () => {
        let curr = new Date().getTime()
        if (f2Ticket === 0) {
            f2Original = curr
            onVoicePress(true)
            f2Interval = setInterval(() => {
                let now = new Date().getTime()

                if (now - f2Original > 600 && now - f2Ticket > 100) {
                    f2Ticket = 0
                    f2Original = 0
                    onVoicePress(false)
                    clearInterval(f2Interval)
                }
            }, 100)
        }
        f2Ticket = curr
    })
    if (!ret) {
        console.log('registration failed')
    }
    console.log(globalShortcut.isRegistered('F2'))
})

function onVoicePress(press) {
    if (mainWindow) {
        mainWindow.webContents.send('onVoiceKeyPress', press)
    }
}

app.on('will-quit', () => {
    globalShortcut.unregister('F2')
    globalShortcut.unregisterAll()
})
