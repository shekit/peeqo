'use strict'

const event = require('js/events/events')
const Snap = require('snapsvg')
const snap = Snap("#eyes")

class Eyes {

	constructor(color="#000000"){

		this.eyeSize = 87.5
		this.closedEye = 1
		this.blinkDuration = 120
		this.leftEye = snap.ellipse(202.5, 330, this.eyeSize, this.eyeSize)
		this.rightEye = snap.ellipse(604.5, 330, this.eyeSize, this.eyeSize)
		this.isBlinking = false
		this.blinkTimer = null
		this.eyes = snap.group(this.leftEye, this.rightEye)
		this.blinkIntervals = [4000, 6000, 10000, 1000, 500, 8000]
		this.transitionSize = 1000
		this.transitionSpeed = 100

		this.eyes.attr({
			fill: color
		})

		this.startBlinking = this.startBlinking.bind(this)
		this.stopBlinking =  this.stopBlinking.bind(this)
		this.transitionToMedia = this.transitionToMedia.bind(this)
		this.transitionFromMedia = this.transitionFromMedia.bind(this)
		this.blink = this.blink.bind(this)

		event.on('start-blinking', this.startBlinking)
		event.on('stop-blinking', this.stopBlinking)
		event.on('transition-eyes-away', this.transitionToMedia)
		event.on('transition-eyes-back', this.transitionFromMedia)
	}

	getRandomBlinkInterval(){
		return this.blinkIntervals[Math.floor(this.blinkIntervals.length * Math.random())]
	}

	startBlinking() {
		this.isBlinking = true
		let duration = this.getRandomBlinkInterval()
		this.blinkTimer = setTimeout(this.blink, duration) 
	}

	transitionFromMedia(){

		// eye animation when transitioning after displaying media

		this.leftEye.animate({ry:this.eyeSize, rx:this.eyeSize}, this.transitionSpeed, mina.easein())
		this.rightEye.animate({ry:this.eyeSize, rx:this.eyeSize}, this.transitionSpeed, mina.easein(), ()=>{
			console.log("transitioned back")
			this.startBlinking()
		})
	}

	transitionToMedia(cb){

		// eye animation when transitioning to display media
		
		if(this.isBlinking){
			this.stopBlinking()
		}

		this.leftEye.animate({ry:this.transitionSize, rx:this.transitionSize}, this.transitionSpeed, mina.elastic())
		this.rightEye.animate({ry:this.transitionSize, rx:this.transitionSize}, this.transitionSpeed, mina.elastic(), ()=>{
			console.log("transitioned away")
			cb()
		})
	}

	blink() {

		let eyes = ['leftEye','rightEye']

		for(const i in eyes){
			this[eyes[i]].animate({ry: this.closedEye}, this.blinkDuration, mina.elastic(), () => {
				this[eyes[i]].animate({ry:this.eyeSize}, this.blinkDuration, mina.easein())
			})
		}

		clearTimeout(this.blinkTimer)

		this.blinkTimer = null
		let duration = this.getRandomBlinkInterval()
		this.blinkTimer = setTimeout(this.blink, duration)

	}

	stopBlinking(){
		this.eyes.isBlinking = false
		clearTimeout(this.blinkTimer)
		this.blinkTimer = null
	}
}

module.exports = Eyes