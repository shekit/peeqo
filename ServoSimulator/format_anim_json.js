// inverts servo anims 1 -> 0, 2 -> 1, 0 -> 2 to correct orientation
// pass in anim file name without .json as argument


var fs = require('fs')
var path = require('path')

// var anim = [
// [0,1,2],
// [3,4,5],
// [6,7,8]
// ]

anim_file = process.argv[2]

//var variant = process.argv[3]

var anim = JSON.parse(fs.readFileSync(path.join(process.cwd(),'js','commands','anims', `${anim_file}.json` )), 'utf8')

var new_array =[]

for (var i=0; i<anim.length; i++){
	var lil_array = []
	for(var k=0; k<anim[i].length; k++){


		/// THIS IS THE RIGHT TRANSFORMATION
		if(k == 0){
			lil_array.splice(1,0, anim[i][k])
		}else if(k == 1){
			lil_array.splice(0,0, anim[i][k])
		}else if(k==2){
			lil_array.splice(2,0, anim[i][k])
		}


		// if(variant == 1){
		// 	if(k == 0){
		// 		lil_array.splice(2,0, anim[i][k])
		// 	}else if(k == 1){
		// 		lil_array.splice(0,0, anim[i][k])
		// 	}else if(k==2){
		// 		lil_array.splice(1,0, anim[i][k])
		// 	}
		// }
		// else if(variant == 2){
		// 	if(k == 0){
		// 		lil_array.splice(1,0, anim[i][k])
		// 	}else if(k == 1){
		// 		lil_array.splice(2,0, anim[i][k])
		// 	}else if(k==2){
		// 		lil_array.splice(0,0, anim[i][k])
		// 	}
		// }
		// else if(variant == 3){
		// 	if(k == 0){
		// 		lil_array.splice(1,0, anim[i][k])
		// 	}else if(k == 1){
		// 		lil_array.splice(0,0, anim[i][k])
		// 	}else if(k==2){
		// 		lil_array.splice(2,0, anim[i][k])
		// 	}
		// }
	}
	new_array.push(lil_array)
}

fs.writeFileSync(path.join(process.cwd(),'js','commands','anims', `${anim_file}-inverted.json`), JSON.stringify(new_array))
//console.log(new_array)