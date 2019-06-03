

class Platform {
  private PVector translation, rotation, initialHeight;
  private PVector[] baseJoint, platformJoint, q, l, A;
  private float[] alpha;
  private float baseRadius, platformRadius, hornLength, legLength;
  private String[] prevAllowableAngleValues = new String [3];
  
  private int servoUpperRangeAngle = 180;
  private int servoLowerRangeAngle = 0;
  
  private int servoUpperRangeMicros = 2560;
  private int servoLowerRangeMicros = 500;
  
  public boolean isRecording = false;
  public boolean shouldSave = false;
  
  private JSONArray animation = new JSONArray();
  private String animationFileName;
  
  public boolean setFileName = false;
  
  int time;
  int wait = 33; // every 33 ms or roughly 30fps
  // REAL ANGLES
  
  //new angles new small platform, need to invert the servo horns 
  private final float baseAngles[] = {
   0,  120,  240 }; // angle positions on base platform

  private final float platformAngles[]  = {
   0,  120,  240}; // corresponding angles on top platform

   private final float beta[] = {
   0, 2*PI/3, 4*PI/3}; // angles the servo arms point in. This makes them point outward like our setup

  // REAL MEASUREMENTS
  private final float SCALE_INITIAL_HEIGHT = 125; //  height of platform above base
  private final float SCALE_BASE_RADIUS = 65; // radius of base platform. radius at point at center of servo axis
  private final float SCALE_PLATFORM_RADIUS = 85; //radius of top platform. radius at Point where the dof arms connect
  private final float SCALE_HORN_LENGTH = 13;  // length of servo arm
  private final float SCALE_LEG_LENGTH = 125; // length of leg connecting end of servo arm to top of platform 

  public Platform(float s) {
    translation = new PVector();
    initialHeight = new PVector(0, 0, s*SCALE_INITIAL_HEIGHT);
    rotation = new PVector();
    baseJoint = new PVector[3];
    platformJoint = new PVector[3];
    alpha = new float[3];
    q = new PVector[3];
    l = new PVector[3];
    A = new PVector[3];
    baseRadius = s*SCALE_BASE_RADIUS;
    platformRadius = s*SCALE_PLATFORM_RADIUS;
    hornLength = s*SCALE_HORN_LENGTH;
    legLength = s*SCALE_LEG_LENGTH;

    for (int i=0; i<3; i++) {
      float mx = baseRadius*cos(radians(baseAngles[i]));
      float my = baseRadius*sin(radians(baseAngles[i]));
      baseJoint[i] = new PVector(mx, my, 0);
    }

    for (int i=0; i<3; i++) {
     float mx = platformRadius*cos(radians(platformAngles[i]));
     float my = platformRadius*sin(radians(platformAngles[i]));

      platformJoint[i] = new PVector(mx, my, 0);
      q[i] = new PVector(0, 0, 0);
      l[i] = new PVector(0, 0, 0);
      A[i] = new PVector(0, 0, 0);
    }
    calcQ();
  }

  public void applyTranslationAndRotation(PVector t, PVector r) {

      rotation.set(r);
      translation.set(t);
    
      calcQ();
      calcAlpha();
    
  }

  private void calcQ() {
    for (int i=0; i<3; i++) {
      // rotation
      q[i].x = cos(rotation.z)*cos(rotation.y)*platformJoint[i].x +
        (-sin(rotation.z)*cos(rotation.x)+cos(rotation.z)*sin(rotation.y)*sin(rotation.x))*platformJoint[i].y +
        (sin(rotation.z)*sin(rotation.x)+cos(rotation.z)*sin(rotation.y)*cos(rotation.x))*platformJoint[i].z;

      q[i].y = sin(rotation.z)*cos(rotation.y)*platformJoint[i].x +
        (cos(rotation.z)*cos(rotation.x)+sin(rotation.z)*sin(rotation.y)*sin(rotation.x))*platformJoint[i].y +
        (-cos(rotation.z)*sin(rotation.x)+sin(rotation.z)*sin(rotation.y)*cos(rotation.x))*platformJoint[i].z;

      q[i].z = -sin(rotation.y)*platformJoint[i].x +
        cos(rotation.y)*sin(rotation.x)*platformJoint[i].y +
        cos(rotation.y)*cos(rotation.x)*platformJoint[i].z;

      // translation
      q[i].add(PVector.add(translation, initialHeight));
      l[i] = PVector.sub(q[i], baseJoint[i]);
    }
  }

  private void calcAlpha() {
    for (int i=0; i<3; i++) {
      float L = l[i].magSq()-(legLength*legLength)+(hornLength*hornLength);
      float M = 2*hornLength*(q[i].z-baseJoint[i].z);
      float N = 2*hornLength*(cos(beta[i])*(q[i].x-baseJoint[i].x) + sin(beta[i])*(q[i].y-baseJoint[i].y));
      alpha[i] = asin(L/sqrt(M*M+N*N)) - atan2(N, M);

      A[i].set(hornLength*cos(alpha[i])*cos(beta[i]) + baseJoint[i].x, 
      hornLength*cos(alpha[i])*sin(beta[i]) + baseJoint[i].y, 
      hornLength*sin(alpha[i]) + baseJoint[i].z);

      //float xqxb = (q[i].x-baseJoint[i].x);
      //float yqyb = (q[i].y-baseJoint[i].y);
      //float h0 = sqrt((legLength*legLength)+(hornLength*hornLength)-(xqxb*xqxb)-(yqyb*yqyb)) - q[i].z;

      //float L0 = 2*hornLength*hornLength;
      //float M0 = 2*hornLength*(h0+q[i].z);
      //float a0 = asin(L0/sqrt(M0*M0+N*N)) - atan2(N, M0);

      //println(i+":"+alpha[i]+"  h0:"+h0+"  a0:"+a0);
    }
  }
  
  public float[] getAlpha(){
    return alpha; 
  }

  public void draw() {
    // draw Base
    noStroke();
    fill(128);
    ellipse(0, 0, 2*baseRadius, 2*baseRadius);
    for (int i=0; i<3; i++) {
      pushMatrix();
      translate(baseJoint[i].x, baseJoint[i].y, baseJoint[i].z);
      noStroke();
      fill(0);
      ellipse(0, 0, 5, 5); //ellipse at joint of red servo arm to circular base
      textSize(32);
      text(str(i), 15, 65 ,15);
      textSize(16);
      text(String.format("%.2f", degrees(alpha[i])), 5,5,5);
      popMatrix();

      stroke(245,0,0); // draw servo arms
      line(baseJoint[i].x, baseJoint[i].y, baseJoint[i].z, A[i].x, A[i].y, A[i].z);

      PVector rod = PVector.sub(q[i], A[i]);
      rod.setMag(legLength);
      rod.add(A[i]);
      
      //draw leg attachments
      stroke(0,100,0);
      strokeWeight(3);
      line(A[i].x, A[i].y, A[i].z, rod.x, rod.y, rod.z);
    }

    // draw phone jointss and rods
    for (int i=0; i<3; i++) {
      pushMatrix();
      translate(q[i].x, q[i].y, q[i].z);
      noStroke();
      fill(0);
      ellipse(0, 0, 5, 5);
      popMatrix();

      stroke(0,0,254);
      strokeWeight(1);
      // draw vertical debug line
      line(baseJoint[i].x, baseJoint[i].y, baseJoint[i].z, q[i].x, q[i].y, q[i].z);
    }

    // sanity check
    pushMatrix();
    translate(initialHeight.x, initialHeight.y, initialHeight.z);
    translate(translation.x, translation.y, translation.z);
    rotateZ(rotation.z);
    rotateY(rotation.y);
    rotateX(rotation.x);
    stroke(245);
    noFill();
    ellipse(0, 0, 2*platformRadius, 2*platformRadius);
    popMatrix();
    
    String [] str = new String[3];
    
    for(int i=0;i<3;i++){
      if(Float.isNaN(alpha[i])){
         // if any value is NaN, then send previous non NaN Angle Values
         sendSerial(prevAllowableAngleValues);
         return; 
      } 
      
      if(degrees(alpha[i]) <=0){
         // if negative make positive add to 90
         int mappedToMicro = int(map(int(90 + abs(degrees(alpha[i]))),servoLowerRangeAngle,servoUpperRangeAngle,servoLowerRangeMicros,servoUpperRangeMicros));
         str[i] = str(mappedToMicro);  
      } else if(degrees(alpha[i]) > 0){
        // if positive, then subtract from 90
        int mappedToMicro = int(map(int(90 - degrees(alpha[i])),servoLowerRangeAngle,servoUpperRangeAngle,servoLowerRangeMicros,servoUpperRangeMicros));
        str[i] = str(mappedToMicro); 
      }
    }
    
    sendSerial(str);
  }
  
  public void saveAnimationDetails(String fileName){
    println("Ready to save: "+fileName); 
    animation = new JSONArray();
    setFileName = true;
    animationFileName = fileName;
  }
  
  public void saveAnimationToFile(){
    String date = str(day())+"-"+str(hour())+"-"+str(minute())+"-"+str(second());
    saveJSONArray(animation, "anims/"+animationFileName+"-"+date+".json");
    setFileName = false;
  }

  void sendSerial(String[] str){
   
   if(str.length != 3){
    return; 
   }  
   
   JSONArray angles = new JSONArray();
   
   if(millis() - time >= wait){
     
     for(int i=0;i<3;i++){
       if(str[i]!=null || str[i]!=""){
         if(port != null){
            port.write(str[i] + '@');
            delay(1);
          }
          
          if(isRecording){
            angles.setInt(i, int(str[i]));
          }
       }
     }
     
     time = millis();
     
     if(isRecording){
       animation.append(angles);
     }
     
     prevAllowableAngleValues = str;
   }
  }

}
