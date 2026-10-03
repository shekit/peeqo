import * as THREE from 'three';
import { LED_RING_LAYOUT, type LedPixel } from '@peeqo/core';

const vertexShader = /* glsl */ `
  varying vec3 vLocal;
  varying vec3 vNormalW;
  void main() {
    vLocal = position;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  #define LED_COUNT 12
  uniform vec3 uLedColor[LED_COUNT];
  uniform float uLedAngle[LED_COUNT];
  uniform vec3 uBaseColor;
  uniform float uSpread;
  varying vec3 vLocal;
  varying vec3 vNormalW;
  const float PI = 3.141592653589793;
  void main() {
    float angle = atan(vLocal.y, vLocal.x);
    vec3 glow = vec3(0.0);
    for (int i = 0; i < LED_COUNT; i++) {
      float d = abs(mod(angle - uLedAngle[i] + PI, 2.0 * PI) - PI);
      glow += uLedColor[i] * exp(-0.5 * d * d / (uSpread * uSpread));
    }
    // World +Y is up in the scene.
    float light = 0.55 + 0.45 * max(dot(normalize(vNormalW), normalize(vec3(0.3, 1.0, 0.25))), 0.0);
    gl_FragColor = vec4(uBaseColor * light + glow * 2.5, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** Diffuser material that glows around each lit LED. Angles are taken in the mesh's own (head) frame. */
export function createLedRingMaterial(): { material: THREE.ShaderMaterial; setPixels(pixels: readonly LedPixel[]): void } {
  const colors = Array.from({ length: LED_RING_LAYOUT.count }, () => new THREE.Color(0, 0, 0));
  const angles = Array.from(
    { length: LED_RING_LAYOUT.count },
    (_, i) => THREE.MathUtils.degToRad(LED_RING_LAYOUT.firstLedDeg + LED_RING_LAYOUT.stepDeg * i),
  );
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uLedColor: { value: colors },
      uLedAngle: { value: angles },
      uBaseColor: { value: new THREE.Color(0xc9cbd1) },
      // Glow width around each LED; LEDs are 30° apart, so they read as separate points.
      uSpread: { value: THREE.MathUtils.degToRad(5.5) },
    },
  });
  const setPixels = (pixels: readonly LedPixel[]): void => {
    colors.forEach((color, i) => {
      const p = pixels[i];
      if (!p || p.brightness === 0) {
        color.setRGB(0, 0, 0);
        return;
      }
      // DotStar global brightness scales output roughly linearly (0–31).
      color.setRGB(p.r / 255, p.g / 255, p.b / 255, THREE.SRGBColorSpace).multiplyScalar(p.brightness / 31);
    });
  };
  return { material, setPixels };
}
