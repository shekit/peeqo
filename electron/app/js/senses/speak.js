const spawn = require('child_process').spawn
const os = require('os')
const path = require('path')
const event = require('js/events/events')

const tts = (os.arch() == 'arm')?'flite':'say'

function speak(text){
	// speaks out the given text using the system voice
	// @param {string} text - the text to be spoken
	
	let speechProcess = null

	if(tts === 'flite'){
		speechProcess = spawn(tts, ['-voice','awb','-t',text],{detached:false})

		
	} else if(tts === 'say'){
		speechProcess = spawn(tts, [text], {detached: false})
	}

	speechProcess.on('close', ()=>{
		event.emit("finished-speaking")
	})
}

function playSound(filename, vol){
	// plays passed in file located in app/media/sounds
	// @param {string} filename - accepts .wav & .mp3 files located in app/media/sounds
	console.log(`FILE: ${filename}`)

	if(!filename.endsWith('.wav') && !filename.endsWith('.mp3')){
		console.error(`File ${filename} is not supported`)
		return
	}

	setVolume(vol)
	let audio = document.getElementById("sound")
	audio.currentTime = 0
	audio.src = path.join(process.cwd(),'app','media','sounds',filename)
	audio.play()
}

function stopSound(){
	// stop sound playback

	let audio = document.getElementById("sound")
	audio.currentTime = 0
	audio.pause()
	audio.src = ''
}

function setVolume(vol) {
	// sets volume level for audio and video playback
	// @param {float} vol - range 0-1

	if(vol < 0){
		vol = 0
	} else if(vol > 1){
		vol = 1
	}

	const video = document.getElementById("video")
	const audio = document.getElementById("sound")
	
	video.volume = vol
	audio.volume = vol
}

module.exports = {
	speak,
	playSound,
	stopSound,
	setVolume
}