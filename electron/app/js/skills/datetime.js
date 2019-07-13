const event = require('js/events/events')
const actions = require('js/actions/actions')
const responses = require('js/responses/responses')
const config = require('config/config')
const dateFormat = require('dateformat')
const Skill = require('js/skills/skill')

/**
Displays the current time, day of the week and date with an appropriate GIF
In Dialogflow: Create an intent namend datetime and add training phrases asking for the time and/or date
*/
class Datetime extends Skill{

	/** Run skill **/
	run () {
		super.run()

	        let now = new Date()
	        let dayStr = dateFormat(now, "dddd")
	        let dateStr = dateFormat(now, "d. mmmm yyyy")
	        let timeStr = dateFormat(now, "HH:MM")
	        let dateTimeStr = `${timeStr}<br /><small>${dayStr}</small><br /><small>${dateStr}</small>`
        	actions.setAnswer({type:'remote', queryTerms: ["clock", "time", dayStr], text: dateTimeStr})
	}

}


module.exports = new Datetime()
