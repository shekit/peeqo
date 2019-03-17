const event = require('js/events/events')
const responses = require('js/responses/responses')
const common = require('js/helpers/common')
const gif = require('js/helpers/gifs')
const video = require('js/helpers/videos')

async function setAnswer(ans=null, overrides={}){

	// @param {obj} ans - the response object as defined in responses.js
	// @param {obj} overrides - new keys to be added or overriden in ans param
	console.log("ANSWER")

	// merge overriden values and new values
	Object.assign(ans, overrides)

	let q = await common.setQuery(ans)
	console.log(`BACK IN FUNCTION ${q}`)

	let r = await gif.findOnline(q)
	console.log(`Returned video: ${r}`)

	let d = await video.findDuration(r)
	console.log(`Duration: ${d}`)

	let o = await common.setTimer(d)
	console.log(`Done in answer`)

	if(ans.type == 'remote'){
		// search online for query n wait for it

	} else if(ans.type == 'local'){
		// local gifs/videos
	}

	
	//wait to get api response
	//wait to get gif/video

	

	if(ans.hasOwnProperty('cb')){
		ans.cb()
	}
}

function hotword(){
	//setAnswer(responses.wakeword)
	responses.wakeword.cb()
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