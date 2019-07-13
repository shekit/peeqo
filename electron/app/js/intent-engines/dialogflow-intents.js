const actions = require('js/actions/actions')
const weather = require('js/skills/weather')
const Timer = require('js/skills/timer')
const event = require('js/events/events')
const responses = require('js/responses/responses')
const skill = require('js/skills/skill')
const fs = require('fs')
const path = require('path')

function parseIntent(cmd){

	/* param {cmd} - response object from speech to text engine */

	// this one is for google dialogflow, you might need to make adjustments for a different engine	

	console.log(cmd)

	switch(cmd.intent){

		case "greeting":
			actions.setAnswer(responses.greeting, {type: 'remote'})
			break

		case "camera":
			event.emit(`camera-${cmd.params.on.stringValue}`)
			break

		case "timer":
			let timer = new Timer(cmd.params.time.numberValue, cmd.params.timeUnit.stringValue)
			timer.startTimer()
			break

		case "weather":
			weather.getWeather(cmd.params.city.stringValue)
			break

		case "changeGlasses":
			event.emit("change-glasses")
			break

		case "goodbye":
			actions.setAnswer(responses.bye, {type: 'local'})
			break
		default:
			/** Check if a skill with the name of this intent exists in js/skills **/
                        let skillPath = path.join(process.cwd(),'app','js','skills', cmd.intent + '.js')
                        if (fs.existsSync(skillPath)) {
                                /** Include skill **/
                                let skill = require('js/skills/'+cmd.intent)

                                /** Check if skill is inherited from Skill class **/
                                if (Object.getPrototypeOf(skill.constructor).name == "Skill") {
                                        console.log(`Running skill ${cmd.intent} from js/skills/${cmd.intent}.js`)

                                        /** Initialize skill **/
                                        skill.init()

                                        /** Set responseText from dialogflow **/
                                        if (cmd.responseText) {
                                                skill.setResponseText(cmd.responseText)
                                        }

                                        /** Set dialogflow parameters **/
                                        for (var paramName in cmd.params) {
                                                if (cmd.params[paramName].stringValue) {
                                                        skill.setParam(paramName, cmd.params[paramName].stringValue)
                                                }
                                        }

                                        /** Run skill and stop **/
                                        skill.run()
                                        break

                                /** If skill is not inherited from Skill class, log error and go on **/
                                } else {
                                        console.log(`${cmd.intent} is not of type Skill (${Object.getPrototypeOf(skill.constructor).name})`)
                                }
                        }

                        let responseTerms = []
                        let responseLed = {anim:'blink', color: 'green'}

                        /** If no skill for this intent exists, check if dialogflow gave us a responseText, 
			    otherwise use the name of the intent **/
                        if (cmd.responseText) {
                                responseTerms = [cmd.responseText]
                        } else {
                                responseTerms = [cmd.intent]
                                responseLed.color = 'orange'
                        }
                        actions.setAnswer({queryTerms: responseTerms, led: responseLed}, {type:'remote'})
			break
	}

	// setAnswer(responses[cmd.intent], {type:'remote'})
}

module.exports = {
	parseIntent
}
