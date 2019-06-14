'use strict'

require('app-module-path').addPath(__dirname)

const event = require('js/events/events')
const mic = require('js/senses/mic')

let listen = null

if(process.env.OS !== 'unsupported'){
	// only include snowboy for supported OS
	listen = require('js/senses/listen')
}

const Eyes = require('js/face/eyes')
const Glasses = require('js/face/glasses')
const speak = require('js/senses/speak')
const buttons = require('js/senses/buttons')
const weather = require('js/skills/weather')

const listeners = require('js/events/listeners')()

// keyboard shortcuts
const remote = require('electron').remote

document.addEventListener("keydown", (e)=>{
	if(e.which == 123){

		// F12 - show js console
		remote.getCurrentWindow().toggleDevTools()

	} else if(e.which == 116){

		// F5 - refresh page
		// make sure page is in focus, not console
		location.reload()

	}
})

// initiate eyes and glasses
const eyes = new Eyes()
event.emit('show-div', 'eyeWrapper')
event.emit('start-blinking')
const glasses = new Glasses()


setTimeout(()=>{
	
},3000)

// initiate buttons
buttons.initializeButtons()

//initiate leds and run initial animation
const leds = require('js/senses/leds')
event.emit('led-on', {anim: 'circle', color: 'aqua'})

// initiate camera
const Camera = require('js/senses/camera')
const camera = new Camera()

// initiate servos
const Servo = require('js/senses/servo')
const servo = new Servo()

// initiate text
const text = require('js/senses/text')

// set audio volume level. 0 - mute; 1-max
event.emit('set-volume',0.4)

// initiate listening or show wakeword button
if(process.env.OS == 'unsupported'){
	// on certain linux systems and windows snowboy offline keyword detection does not work
	// pass in OS=unsupported when starting application to show a clickable wakeword button instead
	document.getElementById("wakeword").addEventListener('click', (e) => {
		e.preventDefault()
		document.getElementById("wakeword").style.backgroundColor = "red"
		event.emit('wakeword')
	})

    document.getElementById("hue").addEventListener('click', (e) => {
        e.preventDefault()
        document.getElementById("hue").style.backgroundColor = "red"
        event.emit('hue')
    })
} else {
	listen.startListening()
	document.getElementById("wakeword").style.display = "none"
}
