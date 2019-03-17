const config = require('config/config.js')

async function findOnline(query){

	query = encodeURI(query)
	// let json = null
	try {
		let response = await fetch(`https://apiv2.vlipsy.com/v1/vlips/search?q=${query}&key=${config.vlipsy.key}`)
		if(!response.ok){
			throw new Error(`Error accessing vlipsy. Check api key or query`)
		}
		var json = await response.json()
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

	return item.media.mp4.url
}


async function findDuration(path){

	let endPauseDuration = 1200
	let video = document.getElementById("video")
	video.src = path
	video.pause()

	const canplay = await new Promise((resolve, reject) => {
		video.addEventListener('canplay', (e)=>{
			resolve(e.returnValue)
		})
	})

	if(!canplay){
		return 0
	}

	let duration = video.duration*1000+endPauseDuration
	return duration
}


function play(){

}

module.exports = {
	findOnline,
	findDuration
}