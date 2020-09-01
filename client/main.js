const {app, BrowserWindow} = require('electron')
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
    // mainWindow.addExtension('/home/billyyoyo/workspace/mediasoup-client/extentions/ajhifddimkapgcifgcodmmfdlknahffk/3.7_0')
    //mainWindow.loadURL('https://192.168.1.113:3000/')
    // mainWindow.loadURL('https://secure.flyee.cc/aliplay.html')
    // mainWindow.loadFile(`old/old.html`, {})
    mainWindow.loadFile(`pages/index.html`, {})
    mainWindow.webContents.openDevTools()
    mainWindow.setMenu(null)

}

app.on('ready', function () {
    createWindow()
})

// mainWindow.loadURL('http://localhost/')

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit()
})

app.on('activate', function () {
    if (mainWindow === null) createWindow()
})
