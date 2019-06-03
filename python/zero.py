import zerorpc 
from time import sleep
import os
import logging
import atexit
logging.basicConfig()

isPi = False

print(os.uname())

if os.uname()[4].lower().startswith("arm"):
	isPi = True

if isPi:
	from picamera import PiCamera 
	try:
		camera = PiCamera()
		camera.resolution = (800,480)
	except:
		print "There is no camera connected"
		return

def exit_handler():
	if camera:
		camera.close()
	print "closing camera"

atexit.register(exit_handler)
# set pi camera settings
#camera = PiCamera()
#camera.resolution = (640, 480)

full_path = os.path.realpath(__file__)

# RPC class that can be called from node client
class ControlRPC(object):

	def hello(self):
		print("connected")
		return "connected"

	def startCamera(self):
		if isPi:
			camera.start_preview()

		print "start preview"

	def stopCamera(self):
		if isPi:
			camera.stop_preview()
		print "stop preview"

	#def startRecording(self):
		#camera.start_recording(os.path.join(os.path.dirname(full_path),'gif.h264'), resize=(320,240))

	#def stopRecording(self):
		#camera.stop_recording()

# start zerorpc server and accept client connections at port
s = zerorpc.Server(ControlRPC())
s.bind("tcp://0.0.0.0:4242")
s.run()