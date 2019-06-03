import peasy.*; //<>//
import controlP5.*;

import processing.serial.*;

Serial port;

float MAX_TRANSLATION = 50;
float MAX_ROTATION = PI/2;

ControlP5 cp5;
PeasyCam camera;

Platform mPlatform;

Button recordBtn;
Button saveBtn;

Textfield animFileName;
Textlabel recordingText;
Textlabel savedFileName;

// reference to slider elements on screen
Slider posZSlider;
Slider rotXSlider;
Slider rotYSlider;
Slider2D rotXYSlider;

// named references to values of 1D sliders
float posX=0, posY=0, posZ=0, rotX=0, rotY=0, rotZ=0;

float rotXMain = rotX;
float rotYMain = rotY;
float posZMain = posZ;

float prevRotX = rotX;
float prevRotY = rotY;
float prevPosZ = posZ;

//float camRotX=-1.0, camRotY=0.0, camRotZ=0.0;
float camRotX=-0.685, camRotY=1.0, camRotZ=-0.88;

boolean ctlPressed = false;

CallbackListener rotXcb;
CallbackListener rotYcb;

float currentXMax=1;
float currentYMax=1;
float currentXMin=-1;
float currentYMin=-1;
float currentZMax = 1;
float currentZMin = -1;

boolean hitXLimit = false;
boolean hitYLimit = false;
boolean hitZLimit = false;

float previousAngles[];

void setup() {
  size(1024, 768, P3D);
  smooth();
  frameRate(60);
  textSize(20);
  
  String portName = "/dev/cu.usbmodem1421";
  //port = new Serial(this, portName, 115200);
  
  camera = new PeasyCam(this, 333);
  camera.setRotations(camRotX, camRotY, camRotZ);
  camera.lookAt(8.0, -50.0, 80.0);
  
  // create platform and set to default start position
  mPlatform = new Platform(1); //pass scale of 1
  mPlatform.applyTranslationAndRotation(new PVector(), new PVector());
  
  //create an instance of control p5
  cp5 = new ControlP5(this);
  
  
  //recordBtn = cp5.addButton("Not Recording - Hit 'r' to start/stop")
  //  .setPosition(20,20)
  //  .setSize(200,100);
    
  recordingText = cp5.addTextlabel("rec")
    .setText("Not Recording")
    .setPosition(20,20)
    .setColorValue(0xffffff00)
    .setFont(createFont("arial", 30));
    
  cp5.addTextlabel("tip")
    .setText("Press '~' key to start/stop recording")
    .setPosition(20,60)
    .setFont(createFont("arial", 16));
  
  savedFileName = cp5.addTextlabel("No File Name Entered")
    .setPosition(20,120)
    .setFont(createFont("arial", 18));
    
  animFileName = cp5.addTextfield("animation Name")
    .setPosition(20,150)
    .setFocus(true)
    .setAutoClear(false);
    
  saveBtn = cp5.addButton("Set File Name")
    .setPosition(20,200)
    .setSize(200,20);
    
  //cp5.addSlider("posX")
  //  .setPosition(20, 20)
  //  .setSize(180, 40).setRange(-1, 1);
  //cp5.addSlider("posY")
  //  .setPosition(20, 70)
  //  .setSize(180, 40).setRange(-1, 1);
  posZSlider = cp5.addSlider("posZ")
    .setPosition(width-250, 20)
    .setSize(180, 40).setRange(-1, 1);

  rotXSlider = cp5.addSlider("rotX")
    .setPosition(width-250, 70)
    .setSize(180, 40).setRange(-1, 1);
  rotYSlider = cp5.addSlider("rotY")
    .setPosition(width-250, 120)
    .setSize(180, 40).setRange(-1, 1);
  //cp5.addSlider("rotZ")
  //  .setPosition(width-200, 120)
  //  .setSize(180, 40).setRange(-1, 1);
  rotXYSlider = cp5.addSlider2D("x+y")
    .setPosition(width-250,170)
    .setSize(200,200)
    .setMinMax(-1,-1,1,1)
    .setValue(0,0);
  
  rotXcb = new CallbackListener(){
    public void controlEvent(CallbackEvent theEvent){
      switch(theEvent.getAction()){
       case(ControlP5.ACTION_RELEASED):
         println("Released X slider");
         rotXYSlider.setValue(rotXMain, rotYMain);
         break;
       case(ControlP5.ACTION_RELEASEDOUTSIDE):
         println("Released X Slider outside");
         rotXYSlider.setValue(rotXMain, rotYMain);
         break;
      }
    }
  };
  
  rotYcb = new CallbackListener(){
    public void controlEvent(CallbackEvent theEvent){
      switch(theEvent.getAction()){
       case(ControlP5.ACTION_RELEASED):
         println("Released Y slider");
         rotXYSlider.setValue(rotXMain, rotYMain);
         break;
       case(ControlP5.ACTION_RELEASEDOUTSIDE):
         println("Released Y Slider outside");
         rotXYSlider.setValue(rotXMain, rotYMain);
         break;
      }
    }
  };
  
  rotXSlider.addCallback(rotXcb);
  rotYSlider.addCallback(rotYcb);
  
  rotXSlider.onDrag(rotXcb);

  cp5.setAutoDraw(false);
  camera.setActive(true);
}

void draw() {
  background(200);
  //if(!hitMax){
    mPlatform.applyTranslationAndRotation(PVector.mult(new PVector(posX, posY, posZMain), MAX_TRANSLATION), 
      PVector.mult(new PVector(rotXMain, rotYMain, rotZ), MAX_ROTATION));
  //} else {
  //  //println("MAMAMA");
  //   mPlatform.applyTranslationAndRotation(PVector.mult(new PVector(posX, posY, posZ), MAX_TRANSLATION), 
  //    PVector.mult(new PVector(prevRotX, rotYMain, rotZ), MAX_ROTATION));
  //}
  mPlatform.draw();

  hint(DISABLE_DEPTH_TEST);
  camera.beginHUD();
  cp5.draw();
  camera.endHUD();
  hint(ENABLE_DEPTH_TEST);

}

void checkXLimits(){
  
  float[] angles = mPlatform.getAlpha();
  
  boolean hasHitLimit = false;
  
  for (float f : angles) {
    if (Float.isNaN(f)) {
      hasHitLimit = true;
      break;
    } 

  }
  
  if(hasHitLimit){
    hitXLimit = true;
    
    // if value is positive and we have received a NaN value
    // set the previous nonNan giving value as the acceptable max limit
    if(rotXSlider.getValue()>0){
      currentXMax = prevRotX;

    }
    
    // if value is negative and we have received a NaN value
    // set the previous nonNan giving value as the acceptable min limit
    if(rotXSlider.getValue()<0){
      currentXMin = prevRotX; 
    }

  } else {
    hitXLimit = false;
    currentXMax = 1;
    currentXMin = -1;
  }  
}

void checkYLimits(){
  
  float[] angles = mPlatform.getAlpha();
  
  boolean hasHitLimit = false;
  
  for (float f : angles) {
    if (Float.isNaN(f)) {
      hasHitLimit = true;
      break;
    } 
  }
  
  if(hasHitLimit){
    hitYLimit = true;
    
    // if value is positive and we have received a NaN value
    // set the previous nonNan giving value as the acceptable max limit
    if(rotYSlider.getValue()>0){
      currentYMax = prevRotY;
    }
    
    // if value is negative and we have received a NaN value
    // set the previous nonNan giving value as the acceptable min limit
    if(rotYSlider.getValue()<0){
      currentYMin = prevRotY; 
    }

  } else {
    hitYLimit = false;
    currentYMax = 1;
    currentYMin = -1;
  }  
}

void checkZLimits(){
  float[] angles = mPlatform.getAlpha();
  
  boolean hasHitLimit = false;
  
  for (float f : angles) {
    if (Float.isNaN(f)) {
      hasHitLimit = true;
      break;
    } 
  }
  
  if(hasHitLimit){
    hitZLimit = true;
    
    // if value is positive and we have received a NaN value
    // set the previous nonNan giving value as the acceptable max limit
    if(posZSlider.getValue()>0){
      currentZMax = prevPosZ;
    }
    
    // if value is negative and we have received a NaN value
    // set the previous nonNan giving value as the acceptable min limit
    if(posZSlider.getValue()<0){
      currentZMin = prevPosZ; 
    }

  } else {
    hitZLimit = false;
    currentZMax = 1;
    currentZMin = -1;
  }
}

void controlEvent(ControlEvent theEvent) {
  camera.setActive(false);
  
  if(theEvent.isFrom(rotXSlider)){
    // if value is currently within acceptable limits
    if(rotX < currentXMax && rotX > currentXMin){
      rotXMain = rotX;
      prevRotX = rotXMain;
    } 
    
    checkXLimits();
  }
  
  if(theEvent.isFrom(rotYSlider)){
    if(rotY < currentYMax && rotY > currentYMin){
      rotYMain = rotY;
      prevRotY = rotYMain;
    } 
    
    checkYLimits();
  }
  
  if(theEvent.isFrom(posZSlider)){
    if(posZ < currentZMax && posZ > currentZMin){
      posZMain = posZ;
      prevPosZ = posZMain;
    }
    
    checkZLimits();
  }
  
  if(theEvent.isFrom(rotXYSlider)){
    
    if(rotXYSlider.getArrayValue()[0] < currentXMax && rotXYSlider.getArrayValue()[0] > currentXMin){
      rotXMain = rotXYSlider.getArrayValue()[0];
      rotXSlider.setValue(rotXMain);
    }
    
    if(rotXYSlider.getArrayValue()[1] < currentYMax && rotXYSlider.getArrayValue()[1] > currentYMin){
      rotYMain = rotXYSlider.getArrayValue()[1];
      rotYSlider.setValue(rotYMain);
    }
  }
  
  if(theEvent.isFrom(saveBtn)){
    
    if(animFileName.getText().trim().length() > 0){
      println("save file name");
      println(animFileName.getText().trim());
      mPlatform.saveAnimationDetails(animFileName.getText().trim());
      savedFileName.setText(animFileName.getText().trim()+".json");
      animFileName.clear();
    } else {
      println("Enter file name"); 
    }
  }
}
void mouseReleased() {
  camera.setActive(true);
}

void keyPressed() {
  if (key == ' ') {
    resetEverything();
  } else if (key == '`') {
    
    if(!mPlatform.setFileName){
       println("Enter file name first");
       return; 
    }
    
    mPlatform.isRecording = !mPlatform.isRecording;
    
    if(mPlatform.isRecording){
      //show record btn
      recordingText.setText("RECORDING").setColor(0xffff0000);
    } else {
      // show not recording btn 
      recordingText.setText("Not Recording").setColor(0xffffff00);
      mPlatform.saveAnimationToFile();
      savedFileName.setText("Saved!");
    }
  }
}

void resetEverything(){
  // RESET EVERYTHING
    camera.setRotations(camRotX, camRotY, camRotZ);
    camera.lookAt(8.0, -50.0, 80.0);
    camera.setDistance(333);
    posZ=0;
    rotX=0;
    rotY=0;
    posZSlider.setValue(0);
    rotXSlider.setValue(0);
    rotYSlider.setValue(0);
    rotXYSlider.setValue(0, 0);
}

void keyReleased() {
  if (keyCode == CONTROL) {
    camera.setActive(true);
    ctlPressed = false;
  }
}
