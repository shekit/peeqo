'use strict'

const record = require('node-record-lpcm16')
const path = require('path')
const os = require('os')
const config = require('config/config')

const {Detector, Models} = require('snowboy')

const event = require('js/events/events')
const mic = require('js/senses/mic')

// const dialogflow = require('js/intent-engines/dialogflow')

const wakewordDetector = setupSnowboy()

function setupSnowboy(){
	//SNOWBOY WAKEWORD DETECTOR

	const models = new Models()

	models.add({
		file: path.join(process.cwd(),'app','config',config.speech.model),
		sensitivity: config.speech.sensitivity, // adjust sensitivity if you are getting too many false positive or negatives
		hotwords: config.speech.wakeword
	})

	const wakewordDetector = new Detector({
		resource: path.join(process.cwd(), 'app', 'config', 'common.res'),
		models: models,
		audioGain: 2.0
	})

	return wakewordDetector
}

function setupRecorder(){
	// MIC RECORDER

	const recorder = (os.arch()=='arm')?'arecord':'rec' // use arecord on pi, rec on laptop

	const recorderOpts={
		verbose: false,
		threshold:0,
		recordProgram: recorder,
		sampleRateHertz: 16000
	}

	return {recorder, recorderOpts}
}


function startListening(){

	const {recorder, recorderOpts} = setupRecorder()

	// WAKEWORD SNOWBOY EVENTS
	wakewordDetector.on('unpipe', (src) => {
		console.log("STOPPED PIPING > WAKEWORD")
	})

	wakewordDetector.on('pipe', (src) => {
		console.log("PIPING > WAKEWORD")
	})

	wakewordDetector.on('error', (err) => {
		console.error("WAKEWORD ERROR: ", err)
	})

	wakewordDetector.on('close', () => {
		console.log("WAKEWORD PIPE CLOSED")
	})

	wakewordDetector.on('hotword', (index, hotword) => {

		console.log("WAKEWORD > DETECTED")

		//unpipe recording from wakeword listener
		mic.getMic().unpipe(wakewordDetector)
		event.emit("wakeword")
	})

	event.on('pipe-to-wakeword', () => {
		// prevent bug in arecord. WAV has 2gb file limit. After streaming 2GB it starts
		// sending headers with no data
		// possible short term solution: restart mic everytime after a response
		mic.startMic().pipe(wakewordDetector)
	})

	mic.getMic().pipe(wakewordDetector)
}

/**
Unpipe Wakedetector to mute Peeqo
**/
function stopListening() {
	mic.getMic().unpipe(wakewordDetector)
        event.emit("stop-listening")
}

/**
Pipe Wakedetector to resume listening
**/
function resumeListening() {
	mic.getMic().pipe(wakewordDetector)
        event.emit("resume-listening")
}

module.exports = {
	startListening,
	stopListening,
	resumeListening
}


