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

		this.eyes.attr({
			fill: color
		})

		this.startBlinking = this.startBlinking.bind(this)
		this.stopBlinking =  this.stopBlinking.bind(this)
		this.blink = this.blink.bind(this)

		event.on('start-blinking', this.startBlinking)
		event.on('stop-blinking', this.stopBlinking)
	}

	getRandomBlinkInterval(){
		return this.blinkIntervals[Math.floor(this.blinkIntervals.length * Math.random())]
	}

	startBlinking() {
		this.isBlinking = true
		let duration = this.getRandomBlinkInterval()
		this.blinkTimer = setTimeout(this.blink, duration) 
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