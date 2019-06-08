const event = require('js/events/events')
const common = require('js/helpers/common')
const media = require('js/helpers/media')
const responses = require('js/responses/responses')


async function setAnswer(ans=null, overrides={}){

	// @param {obj} ans - the response object as defined in responses.js
	// @param {obj} overrides - new keys to be added or overriden in ans param
	console.log("RESPONSE > START")

	// merge overriden values and new values
	Object.assign(ans, overrides)

	if(ans.hasOwnProperty('sound') && ans.sound !== null){
		event.emit('play-sound', ans.sound)
	}

	let q = await common.setQuery(ans)
	console.log(`LOCAL FILE OR SEARCH QUERY > ${q}`)

	let r = null

	if(ans.type == 'remote'){
		r = await media.findRemoteGif(q)
		console.log(`MEDIA URL > ${r}`)
	} else {
		// local response
		r = q
	}

	let mediaType = await media.findMediaType(r)
	let d = await media.findMediaDuration(r)

	console.log(`MEDIA DURATION > ${d}`)

	if(ans.hasOwnProperty('led') && Object.keys(ans.led).length != 0){
		// run led animation
		event.emit('led-on', {anim: ans.led.anim , color: ans.led.color })
	}

	if(ans.hasOwnProperty('servo') && ans.servo !== null){
		// move servo
		event.emit('servo-move', ans.servo)
	}

	if(ans.hasOwnProperty('cbBefore')){
		ans.cbBefore()
	}

	let showMedia = common.transitionToMedia(d, mediaType)

	if(ans.hasOwnProperty('text') && ans.text){
		text.showText(ans.text)
	}

	if(ans.hasOwnProperty('cbDuring')){
		ans.cbDuring()
	}

	let o = await common.transitionFromMedia(d)

	if(ans.hasOwnProperty('text')){
		text.removeText()
	}

	console.log(`RESPONSE > END`)

	// callback
	if(ans.hasOwnProperty('cbAfter')){
		ans.cbAfter()
	}
}

function wakeword(){
	setAnswer(responses.wakeword, {type:'wakeword'})
}


module.exports = {
	wakeword,
	setAnswer
}