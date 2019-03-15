const event = require('js/events/events')

class Timer {
	constructor(time){
		//@params time {object} - {hrs:int, mins: int, secs:int}
		this.time = time
		this.timer = null

		this.clearTimer = this.clearTimer.bind(this)

		event.once('stop-timer', this.clearTimer)
	}

	startTimer(){

		let time = 0 

		time += this.time.hrs*60*60*1000
		time += this.time.mins*60*1000
		time += this.time.secs*1000

		this.timer = setTimeout(()=>{
			console.log("timer over")
			this.timer = null
		}, time)
	}

	clearTimer(){
		if(this.timer !== null){
			clearTimeout(this.timer)
			this.timer = null
		}
	}
}

module.exports = Timer