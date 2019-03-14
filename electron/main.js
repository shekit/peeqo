'use stict'

const {app, BrowserWindow } = require('electron')
const os = require('os')


var createWindow = () => {
	let mainWindow = new BrowserWindow({
		width: 800,
		height: 480
	})

	console.log(__dirname)

	mainWindow.loadURL('file://'+__dirname+'/app/index.html')

	if(os.arch() == 'arm'){

		// For Raspberry Pi

		if(process.env.NODE_ENV == "debug"){
			mainWindow.webContents.openDevTools();
		}

		mainWindow.setMenu(null);
		mainWindow.setFullScreen(true);
		mainWindow.maximize();

	} else {

		// For Desktop OS - Mac, Windows, Linux

		if(process.env.NODE_ENV == "debug"){
			mainWindow.webContents.openDevTools();
		} 

	}
}

app.on('ready', createWindow)

app.on('window-all-closed', ()=>{
	app.quit()
})