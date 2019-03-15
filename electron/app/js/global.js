'use strict'

require('app-module-path').addPath(__dirname)

const event = require('js/events/events')
const listen = require('js/senses/listen')
const Eyes = require('js/face/eyes')
const leds = require('js/senses/leds')
const speak = require('js/senses/speak')

const listeners = require('js/events/listeners')()

// keyboard shortcuts
document.addEventListener("keydown", (e)=>{
	if(e.which == 123){
		//F12 show js console
		remote.getCurrentWindow().toggleDevTools()
	} else if(e.which == 116){
		//F5 refresh page
		location.reload()
	}
})

const eyes = new Eyes()

event.emit('show-div', 'eyeWrapper')
event.emit('start-blinking')

setTimeout(()=>{
	event.emit('play-sound','alert.wav')
},3000)


listen.startListening()