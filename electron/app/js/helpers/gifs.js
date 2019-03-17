const config = require('config/config.js')
const giphy = require('giphy-api')(config.giphy.key);

function findOnline(query){

	return new Promise((resolve, reject)=>{
		giphy.translate(query, (err,res)=>{

			if(err || !res) reject(`Got error or no response when searching for "${query}" from Giphy`);

			console.log(res.data.images)

			const gif = res.data.images.original_mp4.mp4

			resolve(gif)

		})
	})	
}


function findDuration(){

}

function setTimer(){

}

function play(){

}

module.exports = {
	findOnline
}