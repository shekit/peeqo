const event = require('js/events/events')
const responses = require('js/responses/responses')

function setAnswer(ans=null){

	console.log("ANSWER")
	console.log(ans)



	if(ans.hasOwnProperty('cb')){
		ans.cb()
	}
	

}

function hotword(){
	setAnswer(responses.wakeword)
}

function parseIntent(cmd){
	
	if(!responses.hasOwnProperty(cmd.intent)){
		// a response for this particular intent does not exist
		console.error(`A response for "${cmd.queryText}" doesn't exist`)
		setAnswer(responses.confused)
		return
	}

	setAnswer(responses[cmd.intent])
}

module.exports = {
	hotword,
	parseIntent
}