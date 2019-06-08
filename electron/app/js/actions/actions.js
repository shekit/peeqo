const event = require('js/events/events')
const responses = require('js/responses/responses')
const common = require('js/helpers/common')
const gif = require('js/helpers/gifs')
const video = require('js/helpers/videos')

async function setAnswer(ans=null, overrides={}){

	// @param {obj} ans - the response object as defined in responses.js
	// @param {obj} overrides - new keys to be added or overriden in ans param
	console.log("RESPONSE > START")

	// merge overriden values and new values
	Object.assign(ans, overrides)

	let q = await common.setQuery(ans)
	console.log(`LOCAL FILE OR SEARCH QUERY > ${q}`)

	let r = null

	if(ans.type == 'remote'){
		r = await gif.findOnline(q)
		console.log(`MEDIA URL > ${r}`)
	} else {
		// local response
		r = q
	}

	let mediaType = await video.findMediaType(r)
	let d = await video.findMediaDuration(r)

	console.log(`MEDIA DURATION > ${d}`)

	if(Object.keys(ans.led).length != 0){
		// run led animation
		event.emit('led-on', {anim: ans.led.anim , color: ans.led.color })
	}

	if(ans.sound !== null){
		event.emit('play-sound', ans.sound)
	}

	if(ans.servo !== null){
		// move servo
		event.emit('servo-move', ans.servo)
	}

	let o = await common.setTimer(d, mediaType)
	console.log(`RESPONSE > END`)

	// callback
	if(ans.hasOwnProperty('cb')){
		ans.cb()
	}
}

function wakeword(){
	setAnswer(responses.wakeword, {type:'wakeword'})
}

function parseIntent(cmd){
	
	if(!responses.hasOwnProperty(cmd.intent)){
		// a response for this particular intent does not exist
		console.error(`A local response for "${cmd.queryText}" doesn't exist`)
		setAnswer(responses.confused, {type:'local'})
		return
	}

	console.log(cmd)

	setAnswer(responses[cmd.intent], {type:'remote'})
}

module.exports = {
	wakeword,
	parseIntent
}