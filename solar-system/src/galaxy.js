/**
 * Photographic Milky Way backdrop.
 * Uses a pre-graded, lightly softened ESO panorama so the band reads as a
 * continuous luminous structure instead of a field of point stars.
 */

import * as THREE from 'three';

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vDirection;
  void main() {
    vUv = uv;
    vDirection = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uDim;
  varying vec2 vUv;
  varying vec3 vDirection;

  void main() {
    vec3 tex = texture2D(uMap, vUv).rgb;
    float lum = dot(tex, vec3(0.299, 0.587, 0.114));

    // Let the luminous band carry the eye; the dark sky around it is pulled down.
    float band = exp(-pow((vUv.y - 0.5) / 0.16, 2.0));
    float lumBand = smoothstep(0.006, 0.16, lum);
    float poleFade = smoothstep(0.04, 0.24, vUv.y) * (1.0 - smoothstep(0.78, 0.97, vUv.y));

    vec3 color = tex * vec3(1.18, 1.02, 0.90);
    color *= mix(vec3(0.82, 0.76, 0.74), vec3(1.14, 1.02, 0.88), smoothstep(0.08, 0.34, lum));
    color += vec3(0.022, 0.016, 0.046) * (1.0 - band);
    color = mix(color * 0.08, color * 1.55, band);
    color *= poleFade * 0.8 * uDim;

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const textureUrl = new URL('../assets/textures/milkyway-band.jpg', import.meta.url).href;

export function createGalaxyBackdrop({ radius = 420, tilt = 0.32 } = {}) {
  const texture = new THREE.TextureLoader().load(textureUrl, (loaded) => {
    loaded.colorSpace = THREE.SRGBColorSpace;
    loaded.anisotropy = 8;
    loaded.wrapS = THREE.RepeatWrapping;
    loaded.wrapT = THREE.ClampToEdgeWrapping;
    material.uniforms.uMap.value = loaded;
    material.needsUpdate = true;
  });
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: texture },
      uDim: { value: 1.0 },
    },
    vertexShader,
    fragmentShader,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    toneMapped: false,
  });

  const geometry = new THREE.SphereGeometry(radius, 96, 64);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'galaxy-backdrop';
  mesh.rotation.set(-0.32, 0.6, tilt + 0.18);
  mesh.renderOrder = -100;
  mesh.frustumCulled = false;

  return {
    mesh,
    material,
    setDim(value) {
      material.uniforms.uDim.value = value;
    },
    dispose() {
      texture.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
}
