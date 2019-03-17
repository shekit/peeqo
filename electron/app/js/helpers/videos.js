const config = require('config/config.js')

async function findOnline(query){

	query = encodeURI(query)

	try {
		let response = await fetch(`https://apiv2.vlipsy.com/v1/vlips/search?q=${query}&key=${config.vlipsy.key}`)
		if(!response.ok){
			throw new Error(`Error accessing vlipsy. Check api key or query`)
		}
		let json = await response.json()
	} catch(e){
		console.error(e)
		return
	}
	
	const acceptableDuration = 5.5;
	let acceptableVlips = []

	for(let i=0; i<json.data.length; i++){
		if(json.data[i].duration <= acceptableDuration){
			acceptableVlips.push(json.data[i])
		}
	}

	const item = acceptableVlips[Math.floor(Math.random()*acceptableVlips.length)]

	return item.media.mp4.urls
}


function findDuration(){

}


function play(){

}

module.exports = {
	findOnline
}