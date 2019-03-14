

function showDiv(id){

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

module.exports = {
	showDiv
}