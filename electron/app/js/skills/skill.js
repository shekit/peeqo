const event = require('js/events/events')

/**
Each skill class has to have the following functions:
init()				Initializes the skill and allows to run basic setup
setParam(name, value)		Allows to store parameters returned from the intent engine
setResponseText(value)		Allows to store responseText retured from the intent engine
setRaw(intentResponse)		Allows to store the raw intent response
run()				Runs the skill
**/
class Skill {

	/**
	Initialize the class variables
	*/
	constructor () {
		this.params = {}
                this.responseText = ""
                this.intentResponse = null
	}

	/**
	Initialize Module and copy date format locales
	**/
	init () {
		event.emit('init-skill', this.constructor.name)
	}

	/**
	Set Parameters
	**/
	setParam(name, value) {
		this.params[name] = value
	}

	/**
	Set Response Text
	**/
	setResponseText (value) {
		this.responseText = value
	}

	/**
	Set Raw intent engine response
	**/
	setRaw(intentResponse) {
		this.intentResponse = intentResponse
	}

	/**
	Run skill
	**/
	run () {
		event.emit('run-skill', this.constructor.name)
	}

}


module.exports = Skill
