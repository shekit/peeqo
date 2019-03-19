# Get a Peeqo Dev Kit
Get on the waitlist for a peeqo dev kit? Enter your email here - http://bit.ly/2TyocgY

# Setup Instructions

## Getting Started:
1. [Setup Wakeword](#setup-wakeword)
2. [Setup Dialogflow](#setup-dialogflow)
3. [Rename `config-dev.js` to `config.js`](#)
4. [Setup on Mac OSX/Linux](#)

### Setup Wakeword

Peeqo uses snowboy for offline on-device wakeword detection. Follow these steps to get him to respond to you saying Peeqo.

1. Go to https://snowboy.kitt.ai/dashboard
2. Login using Google/Github/Facebook
3. Type “Peeqo” in the “Search Hotwords” text box & hit enter. Only one result should turn up
4. Click on the microphone icon near the Peeqo search result
5. Click “Record my voice” in the popup that opens
6. Follow the instructions and record yourself saying Peeqo three times. You will need to allow the browser microphone access
7. Click on “Test the model”
8. Enter the details on the left and say “Peeqo” a couple of times till it says “Test Successful”
9. The model is now trained to respond to only you saying Peeqo
10. Click on “Save and download”. 
11. This will create a file called `Peeqo.pmdl`.
12. Place this file in `/electron/app/config/`


