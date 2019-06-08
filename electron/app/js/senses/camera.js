const zerorpc = require('zerorpc')
const spawn = require('child_process').spawn
const event = require('js/events/events')

class Camera{

	constructor(){
		this.connected = false
		this.client = new zerorpc.Client()
		this.client.connect("tcp://127.0.0.1:4242")
		this.client.invoke("hello", (err, res, more) => {
			if(res){
				console.log(`Connected to camera: ${res}`)
				this.connected = true
			} else {
				console.log('Not connected to camera')
			}
		})

		this.startCamera = this.startCamera.bind(this)
		this.stopCamera = this.stopCamera.bind(this)
		this.startRecording = this.startRecording.bind(this)
		this.stopRecording = this.stopRecording.bind(this)

		event.on('camera-on', this.startCamera)
		event.on('camera-off', this.stopCamera)
		event.on('camera-record', this.startRecording)
		event.on('camera-stop', this.stopRecording)

	}

	startCamera(){
		if(this.connected){
			this.client.invoke("startCamera")
		}
	}

	stopCamera(){
		if(this.connected){
			this.client.invoke("stopCamera")
		}
	}

	startRecording(){
		if(this.connected){
			this.client.invoke("startRecording")
		}
	}

	stopRecording(){
		if(this.connected){
			this.client.invoke("stopRecording")
		}
	}
}

module.exports = Camera