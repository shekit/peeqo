const dialogflow = require('dialogflow')
const through2 = require('through2')
const path = require('path')
const uuid = require('uuid')
const config = require('config/config')
const event = require('js/events/events')
const mic = require('js/senses/mic')

function setup(){
	// DIALOGFLOW

	//create unique id for new dialogflow session
	const sessionId = uuid.v4()

	//create a dialogflow session
	const sessionClient = new dialogflow.SessionsClient({
		projectId: config.speech.projectId,
		keyFilename: path.join(process.cwd(), 'app', 'config', config.speech.dialogflowKey)
	})

	const sessionPath = sessionClient.sessionPath(config.speech.projectId, sessionId)

	// the dialogflow request
	const dialogflowRequest = {
		session: sessionPath,
		queryParams: {
			session: sessionClient.sessionPath(config.speech.projectId, sessionId)
		},
		queryInput:{
			audioConfig:{
				audioEncoding: "AUDIO_ENCODING_LINEAR_16",
				sampleRateHertz: 16000,
				languageCode: config.speech.language
			}
		},
		singleUtterance: true,
	    interimResults: false
	}

	return {sessionClient, dialogflowRequest}
}

function start(){
	const {sessionClient, dialogflowRequest} = setup()

	let stt = new DialogflowSpeech(sessionClient, dialogflowRequest)
	
	event.emit('start-stt')
}

class DialogflowSpeech {

	constructor(client, request){
		this.request = request
		this.stream = client.streamingDetectIntent()
		this.result = ''
		this.unpipeTimer = null
		this.listenFor = 4000
		this.intentObj = {}
		this.sttStream = null
		// this.wakewordDetector = wakewordDetector

		this.stream.write(this.request)

		this.startStream = this.startStream.bind(this)

		event.once('start-stt', this.startStream)
	}

	startSttStream(){
		this.sttStream =  through2.obj((obj,_,next)=>{
			next(null, {inputAudio: obj})
		})
	}

	startStream(){
		const self = this

		this.startSttStream()

		this.stream.once('pipe', () => {
			console.log('PIPING > DIALOGFLOW')

			self.unpipeTimer = setTimeout(()=>{
				console.log('UNPIPING DIALOGFLOW > QUERY TIME EXCEEDED')
				self.sttStream.unpipe(self.stream)
				mic.getMic().unpipe(self.sttStream)
				self.unpipeTimer = null
			}, self.listenFor)
		})

		this.stream.on('data', (data) => {
			if(data.queryResult != null){
				
				if(data.queryResult.queryText == ""){
					return
				}

				self.intentObj.intent = data.queryResult.intent.displayName
				self.intentObj.params = data.queryResult.parameters.fields
				self.intentObj.queryText = data.queryResult.queryText
				self.intentObj.responseText = data.queryResult.fulfillmentText

				self.result = self.intentObj

				self.sttStream.unpipe(self.stream)
				mic.getMic().unpipe(self.sttStream)
			}
		})

		this.stream.once('error', (err) => {
			console.error('ERROR > DIALOGFLOW', err)
		})

		this.stream.once('close', function(){
			console.log('DIALOGFLOW PIPE > CLOSED')
		})

		this.stream.once('unpipe', function(src){
			console.log('UNPIPING > DIALOGFLOW')
			self.sttStream.end()
			self.stream.end()
		})

		this.stream.once('finish', () => {

			console.log("FINISHED > DIALOGFLOW")
			if(self.unpipeTimer != null){
				// timer is running but result has returned already
				clearTimeout(self.unpipeTimer)
				self.unpipeTimer = null
				
				console.log("CLEARING TIMEOUT > RESULT RETURNED")
			}

			if(self.result){
				console.log("DIALOGFLOW > SENDING RESULT")
				event.emit('final-command', self.result)
			} else {
				console.log("DIALOGFLOW > NO RESULT/NTN HEARD")
				event.emit('no-command')
			}	

			self.request = null
			self.stream = null
			self.result = null
			self.intentObj = {}
			self.sttStream = null

			event.emit('end-speech-to-text')

			// self.mic.pipe(self.wakewordDetector)

			// self.mic = null
			// self.wakewordDetector = null

			event.removeListener('start-speech-to-text', self.startStream)

		})

		mic.startMic().pipe(this.sttStream).pipe(this.stream)
	}
}

module.exports = {
	setup,
	start,
	DialogflowSpeech
}