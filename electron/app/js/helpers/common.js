const path = require('path')
const fs = require('fs')
const util = require('util')

const readdir = util.promisify(fs.readdir)
const exists = util.promisify(fs.stat)

function showDiv(id) {

	// Hides all divs in majorDivs array and shows div passed as param
	// @param {string} id - id of div to show
	
	const majorDivs = ["eyeWrapper", "cameraWrapper", "gifWrapper", "pictureWrapper", "videoWrapper"]

	if(!majorDivs.includes(id)){
		console.error(`Div with id ${id} is not included in array`)
		return
	}

	for(var i in majorDivs){
		if(majorDivs[i] != id){
			let div = document.getElementById(majorDivs[i])
			if(div){
				// only if div is found in DOM
				div.style.display = "none"
			}
		} else {
			document.getElementById(id).style.display = "block"
		}
	}
}

async function setQuery(answer) {

	// returns path to local file or remote query terms

	if(answer.type === 'local'){
		// search from local folder
		let file = await pickFile(path.join(process.cwd(),'app','media','responses',answer.localFolder));
		console.log(`Picked File: ${file}`);
		return file

	} else if(answer.type === 'remote'){
		// use remote query terms array to search online service
		let searchTerm = pickRandom(answer.queryTerms)
		return searchTerm
	} else {
		// if type is wakeword or something else
		return null
	}
}

async function findLocalMediaType(filepath){

	if(!filepath){
		return null
	}

	let imgFiles = [".png", ".jpg", ".jpeg"]
	let videoFiles = [".mp4", ".webp"]
	let gifFiles = [".gif"]

	if(imgFiles.includes(path.extname(filepath).toLowerCase())){
		return "image"
	}

	if(videoFiles.includes(path.extname(filepath).toLowerCase())){
		return "video"
	}

	if(gifFiles.includes(path.extname(filepath).toLowerCase())){
		return "gif"
	}
}

async function pickFile(folderPath){
	// picks random media file from folder
	// @param {string} folderPath - path of folder to pick file from

	let isValid = false;
	try{
		isValid = await exists(folderPath)
	} catch (e){
		console.log(e)
	}
	
	if(!isValid){
		console.error(`Folder at path ${folderPath} does not exist. Create this folder and add some media to it`)
		return null
	}

	console.log("PICKING FILE")
	const fileExtensions = [".gif",".mp4",".webp",".png",".jpg",".jpeg"] //acceptable file extensions

	const files = await readdir(folderPath)

	let mediaFiles = files.filter((file)=>{
		return fileExtensions.includes(path.extname(file).toLowerCase())
	})

	if(mediaFiles.length === 0){
		console.log(`No media files found in ${folderPath}`)
		return null
	}

	let chosenFile = mediaFiles[Math.floor(Math.random()*mediaFiles.length)]

	return path.join(folderPath,chosenFile)
}

function pickRandom(array){
	// shuffles and picks random element from array
	// @param {array} array
	if(!array){
		return null
	}

	var m = array.length, t, i;
 
  	// While there remain elements to shuffle…
  	while (m) {

    	// Pick a remaining element…
    	i = Math.floor(Math.random() * m--);

    	// And swap it with the current element.
    	t = array[m];
    	array[m] = array[i];
    	array[i] = t;
  	}

  	var randomNumber = Math.floor(Math.random()*array.length)

  	return array[randomNumber];
}

async function transitionFromMedia(ms){
	return new Promise((resolve) => {
		let wait = setTimeout(()=>{
			clearTimeout(wait);
			event.emit('show-div','eyeWrapper');
			event.emit('transition-eyes-back');
			resolve(true)
		}, ms)
	})
}

function transitionToMedia(duration, type){
	if(!duration){
		return null
	}

	duration = parseInt(duration);
	let loop = 1;

	let afterTransition = () => {
		if(type === 'video'){
			let video = document.getElementById("video");
			event.emit('show-div','videoWrapper');
			video.play()
		} else if(type === 'gif' || type === 'img'){
			let img = document.getElementById("gif");
			event.emit('show-div', 'gifWrapper')
		}
	};

	event.emit('transition-eyes-away', afterTransition)
}


async function setTimer(duration, type){

	if(!duration){
		return null
	}

	duration = parseInt(duration)
	let loop = 1

	let afterTransition = () => {
		if(type == 'video'){
			let video = document.getElementById("video")
			event.emit('show-div','videoWrapper')
			video.play()
		} else if(type == 'gif' || type == 'img'){
			let img = document.getElementById("gif")
			event.emit('show-div', 'gifWrapper')
		}
	}

	event.emit('transition-eyes-away', afterTransition)

	let done = await transitionFromMedia(duration*loop)

	return done
}

module.exports = {
	showDiv,
	pickFile,
	setQuery,
	setTimer,
	transitionToMedia,
	transitionFromMedia,
	findLocalMediaType
}