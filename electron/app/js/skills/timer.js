const event = require('js/events/events')
const actions = require('js/actions/actions')
const responses = require('js/responses/responses')

class Timer {
	constructor(time, units){
		
		this.time = time
		this.unit = units
		this.timer = null
		this.multiplier = 1000

		if(this.unit == "hour" || this.unit == "hours"){
			this.multiplier *= 3600
		} else if(this.unit == "minute" || this.unit == "minutes"){
			this.multiplier *= 60
		}

		this.time = this.time * this.multiplier

		this.clearTimer = this.clearTimer.bind(this)

		event.once('stop-timer', this.clearTimer)
	}

	startTimer(){

		actions.setAnswer(responses.ok, {type: 'local'})

		this.timer = setTimeout(()=>{
			actions.setAnswer(responses.alarm, {type: 'local'})
			console.log("timer over")
			this.timer = null
		}, this.time)
	}

	clearTimer(){
		if(this.timer !== null){
			clearTimeout(this.timer)
			this.timer = null
		}
	}
}

module.exports = Timer