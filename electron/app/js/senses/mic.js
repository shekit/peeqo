'use strict'

const record = require('node-record-lpcm16')
const os = require('os')

class Mic {
	constructor(){
		this.recorder = (os.arch()=='arm')?'arecord':'rec' // use arecord on pi, rec on laptop

		this.recorderOpts={
			verbose: false,
			threshold:0,
			recordProgram: this.recorder,
			sampleRateHertz: 16000
		}

		this.mic = null
		this.startMic()
	}

	startMic(){
		this.mic = null
		this.mic = record.start(this.recorderOpts)
	}

	getMic(){
		return this.mic
	}
}

const mic = new Mic()

module.exports = mic