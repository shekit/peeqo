const path = require('path')
const event = require('js/events/events')

class Glasses{

	constructor(){
		this.glasses = document.getElementById("glasses")
		this.currentGlass = 0
		this.glassList = ["glass-regular.png","glass-pointy.png","glass-square.png","glass-circle.png","glass-rectangle.png","glass-rayban.png"]

		this.changeGlasses = this.changeGlasses.bind(this)

		event.on('change-glasses', this.changeGlasses)
	}

	changeGlasses(){
		this.currentGlass++

		console.log(this)
		if(this.currentGlass == this.glassList.length){
			this.currentGlass = 0
		}

		let imgPath = path.join(process.cwd(),'app','media','imgs','glasses', this.glassList[this.currentGlass])

		this.glasses.src = imgPath
	}


}

module.exports = Glasses