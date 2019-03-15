const event = require('js/events/events')
const responses = require('js/responses/responses')
const common = require('js/helpers/common')

async function setAnswer(ans=null, overrides={}){

	// @param {obj} ans - the response object as defined in responses.js
	// @param {obj} overrides - new keys to be added or overriden in ans param
	console.log("ANSWER")

	// merge overriden values and new values
	Object.assign(ans, overrides)

	let q = await common.setQuery(ans)

	console.log(`BACK IN FUNCTION ${q}`)

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
		setAnswer(responses.confused, {type:'remote'})
		return
	}

	setAnswer(responses[cmd.intent])
}

module.exports = {
	hotword,
	parseIntent
}