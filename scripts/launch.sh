#!/bin/bash

# starts bg script to access camera
cd ~/peeqo/python
python zero.py &


cd ~/peeqo/electron
./node_modules/.bin/electron main.js