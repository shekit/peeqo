module.exports = {
	giphy:{
		key:'dc6zaTOxFJmzC', // public giphy key - you can get your own from https://developers.giphy.com/docs/
		max_gif_size: 800000, // max gif size it should try to download
        max_mp4_size: 700000  // max video size it should try to download
	},
	speech: {
        projectId: '', // your dialogflow project name
        dialogflowKey: '', // *.json - name of your dialogflow key file - should be stored in app/config/
        wakeword: "peeqo", // you can change this wakeword if you record a differnt one on snowboy.kitt.ai
        language: "en-US", // find supported language codes - https://cloud.google.com/dialogflow-enterprise/docs/reference/language
        model: "Peeqo.pmdl", // The name of your model - name model downloaded from snowboy.kitt.ai - should be stored in app/config
        sensitivity: 0.5, // Keyword getting too many false positives or not detecting? Change this.
        continuous: false // After a keyword is detected keep listening until speech is not heard
    },
    fileExtensions: [".gif", ".mp4", ".webp"], // list of supported file types
    server: "", //"http://localhost:3000"
    openweather: {
        key: "", // please get api key from https://openweathermap.org/api
        city: 'New York' // default city to search - change it to your city of choice
    },
    spotify:{
        clientId:"", // get from https://developer.spotify.com/dashboard/applications
        clientSecret:""
    },
    vlipsy:{
        key:"" // request for api key by emailing api@vlipsy.com
    }
}