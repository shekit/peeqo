const spawn = require('child_process').spawn
const os = require('os')
const path = require('path')
const event = require('js/events/events')

const tts = (os.arch() == 'arm')?'flite':'say'

function speak(text){

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

function playSound(filename){
	if(!filename.endsWith('.wav') || !filename.endsWith('.mp3')){
		console.error(`File ${filename} is not supported`)
		return
	}
	let audio = document.getElementById("sound")
	audio.currentTime = 0
	audio.src = path.join(process.cwd(),'app','media','sounds',filename)
	audio.play()
}

function stopSound(){
	let audio = document.getElementById("sound")
	audio.currentTime = 0
	audio.pause()
	audio.src = ''
}

module.exports = {
	speak,
	playSound,
	stopSound
}