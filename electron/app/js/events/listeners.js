const event = require('js/events/events')
const action = require('js/actions/actions')
const common = require('js/helpers/common')
const power = require('js/power/power')
const speak = require('js/senses/speak')
const dialogflow = require('js/intent-engines/dialogflow')
const mic = require('js/senses/mic')

module.exports = () => {

	event.on('wakeword', action.hotword)

	// passes on response object from speech to text engine
	event.on('final-command', action.parseIntent)

	event.on('no-command', () => {
		console.log("nothing heard")
	})

	event.on('speech-to-text', dialogflow.start)

	event.on('end-speech-to-text', () =>{
		
		if(process.env.OS == "unsupported"){
			document.getElementById("wakeword").style.backgroundColor = ""
			mic.startMic()
		} else {
			event.emit('pipe-to-wakeword')
		}
		
	})

	// passes id of div to show
	event.on('show-div', common.showDiv)


	// POWER CONTROL
	event.on('shutdown', power.shutdown)

	event.on('reboot', power.reboot)


	// AUDIO PLAYBACK
	event.on('play-sound', speak.playSound)

	event.on('set-volume', speak.setVolume)

	// BUTTON PRESSES
	event.on('btn-4-short-press',()=>{})
	event.on('btn-4-long-press',()=>{})

	event.on('btn-16-short-press',()=>{})
	event.on('btn-16-long-press',()=>{})

	event.on('btn-17-short-press',()=>{})
	event.on('btn-17-long-press',()=>{})

	event.on('btn-23-short-press',()=>{})
	event.on('btn-23-long-press',()=>{})

}