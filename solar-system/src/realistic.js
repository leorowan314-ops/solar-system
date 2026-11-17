/**
 * Realistic body surfaces for the Solar System Observatory.
 *
 * Planet spheres, Earth's cloud/atmosphere shells and Saturn's rings are built
 * here from the locally bundled Solar System Scope texture pack (CC BY 4.0).
 * The particle systems remain in particles.js for belts, stars and comets.
 */

import * as THREE from 'three';

const DEG = Math.PI / 180;
const TEXTURE_BASE = new URL('../assets/textures/', import.meta.url);

export const PLANET_TEXTURES = Object.freeze({
  mercury: '2k_mercury.jpg',
  venus: '2k_venus_atmosphere.jpg',
  earth: '2k_earth_daymap.jpg',
  mars: '2k_mars.jpg',
  jupiter: '2k_jupiter.jpg',
  saturn: '2k_saturn.jpg',
  uranus: '2k_uranus.jpg',
  neptune: '2k_neptune.jpg',
  sun: '2k_sun_4k.jpg',
  moon: '2k_moon.jpg',
  earthNight: '2k_earth_nightmap.jpg',
  'earth-clouds': '2k_earth_clouds.jpg',
  saturnRing: '2k_saturn_ring_alpha.png',
});

const SURFACE_TINTS = Object.freeze({
  mercury: '#cfc7bb',
  venus: '#e6d2a4',
  earth: '#ffffff',
  mars: '#e6c0a8',
  jupiter: '#c9a27d',
  saturn: '#c2a570',
  uranus: '#b9e3e8',
  neptune: '#c4d8ff',
  moon: '#e6e2d8',
});

const textureCache = new Map();

function solidTexture(hex = '#808080') {
  const color = new THREE.Color(hex);
  const data = new Uint8Array([
    Math.round(color.r * 255),
    Math.round(color.g * 255),
    Math.round(color.b * 255),
    255,
  ]);
  const texture = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

export function loadTexture(name) {
  if (textureCache.has(name)) return textureCache.get(name);
  const file = PLANET_TEXTURES[name];
  if (!file) return null;
  const texture = new THREE.Texture();
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  textureCache.set(name, texture);
  const loader = new THREE.TextureLoader();
  loader.load(
    new URL(file, TEXTURE_BASE).href,
    (loaded) => {
      texture.image = loaded.image;
      texture.needsUpdate = true;
      texture.colorSpace = THREE.SRGBColorSpace;
    },
    undefined,
    () => {
      // Keep the material neutral if the local asset is unavailable.
    },
  );
  return texture;
}

const planetVertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;

  void main() {
    vUv = uv;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPosition = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const planetFragmentShader = /* glsl */ `
  uniform sampler2D uMap;
  uniform sampler2D uNightMap;
  uniform vec3 uSunDir;
  uniform vec3 uTint;
  uniform vec3 uRimColor;
  uniform float uAmbient;
  uniform float uHasNight;
  uniform float uRimStrength;

  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;

  void main() {
    vec3 base = texture2D(uMap, vUv).rgb * uTint;
    vec3 normal = normalize(vWorldNormal);
    float ndl = dot(normal, normalize(uSunDir));
    float lit = smoothstep(-0.16, 0.34, ndl);
    vec3 color = base * (uAmbient + 0.72 * lit);

    if (uHasNight > 0.5) {
      float night = smoothstep(0.06, -0.22, ndl);
      vec3 lights = texture2D(uNightMap, vUv).rgb;
      color += lights * night * 1.15;
    }

    vec3 viewDir = normalize(cameraPosition - vWorldPosition);
    float fresnel = pow(1.0 - clamp(dot(normal, viewDir), 0.0, 1.0), 3.0);
    color += uRimColor * fresnel * uRimStrength;
    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const cloudVertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;

  void main() {
    vUv = uv;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPosition = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const cloudFragmentShader = /* glsl */ `
  uniform sampler2D uCloudMap;
  uniform vec3 uSunDir;
  uniform float uOpacity;
  uniform float uAmbient;

  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;

  void main() {
    float cloud = dot(texture2D(uCloudMap, vUv).rgb, vec3(0.3333));
    cloud = smoothstep(0.05, 0.46, cloud);
    if (cloud < 0.01) discard;
    float ndl = dot(normalize(vWorldNormal), normalize(uSunDir));
    float lit = 0.18 + 0.92 * smoothstep(-0.14, 0.36, ndl);
    gl_FragColor = vec4(vec3(0.94, 0.96, 1.0) * lit, cloud * uOpacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const atmosphereVertexShader = /* glsl */ `
  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;
  void main() {
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPosition = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const atmosphereFragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uSunDir;
  uniform float uOpacity;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;

  void main() {
    vec3 normal = normalize(vWorldNormal);
    vec3 viewDir = normalize(cameraPosition - vWorldPosition);
    float rim = pow(1.0 - clamp(dot(normal, viewDir), 0.0, 1.0), 2.4);
    float lit = 0.2 + 0.8 * smoothstep(-0.18, 0.3, dot(normal, normalize(uSunDir)));
    gl_FragColor = vec4(uColor, clamp(rim * lit * uOpacity, 0.0, 0.9));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function makeRingTextureFallback(color = '#c8b89a') {
  const texture = solidTexture(color);
  texture.needsUpdate = true;
  return texture;
}

function makeRing(planet, radius, ringSpec) {
  if (!ringSpec) return null;
  const ratioInner = ringSpec.innerRadiusKm / planet.radiusKm;
  const ratioOuter = ringSpec.outerRadiusKm / planet.radiusKm;
  const inner = radius * ratioInner;
  const outer = radius * ratioOuter;
  const isSaturn = planet.id === 'saturn';
  const ringTexture = isSaturn
    ? loadTexture('saturnRing')
    : makeRingTextureFallback(planet.palette?.accent || '#9b8a75');
  const ringOpacity = isSaturn
    ? 0.95
    : planet.id === 'jupiter'
      ? 0.04
      : planet.id === 'neptune'
        ? 0.02
        : 0.055;
  const ringTint = isSaturn
    ? '#e1c8a3'
    : planet.id === 'jupiter'
      ? '#b39a82'
      : planet.id === 'uranus'
        ? '#a8c4cf'
        : '#9aa0ad';
  const geometry = new THREE.RingGeometry(inner, outer, 256, 12);
  geometry.rotateX(-Math.PI / 2);
  const sunDir = new THREE.Vector3(1, 0, 0);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: ringTexture },
      uTint: { value: new THREE.Color(ringTint) },
      uInner: { value: inner },
      uOuter: { value: outer },
      uPlanetCenter: { value: new THREE.Vector3() },
      uPlanetRadius: { value: radius },
      uSunDir: { value: sunDir },
      uHasTexture: { value: isSaturn ? 1 : 0 },
      uOpacity: { value: ringOpacity },
    },
    vertexShader: /* glsl */ `
      varying float vRadial;
      varying vec3 vWorldPosition;
      varying vec3 vWorldNormal;
      uniform float uInner;
      uniform float uOuter;
      void main() {
        float r = length(position.xz);
        vRadial = clamp((r - uInner) / max(0.0001, uOuter - uInner), 0.0, 1.0);
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorldPosition = world.xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform vec3 uTint;
      uniform vec3 uPlanetCenter;
      uniform vec3 uSunDir;
      uniform float uPlanetRadius;
      uniform float uHasTexture;
      uniform float uOpacity;
      varying float vRadial;
      varying vec3 vWorldPosition;
      varying vec3 vWorldNormal;

      void main() {
        vec4 tex = texture2D(uMap, vec2(vRadial, 0.5));
        float alpha = uHasTexture > 0.5 ? tex.a : (0.68 * smoothstep(0.0, 0.06, vRadial) * (1.0 - smoothstep(0.76, 1.0, vRadial)));
        if (alpha < 0.004) discard;

        vec3 rel = vWorldPosition - uPlanetCenter;
        vec3 sun = normalize(uSunDir);
        float along = dot(rel, sun);
        float perp = length(rel - sun * along);
        float shadow = (along < 0.0 && perp < uPlanetRadius * 0.92) ? 0.28 : 1.0;
        float lighting = 0.7 + 0.3 * abs(dot(normalize(vWorldNormal), sun));
        vec3 color = (uHasTexture > 0.5 ? tex.rgb * uTint : uTint) * lighting * shadow;
        gl_FragColor = vec4(color, alpha * uOpacity);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.NormalBlending,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `ring-${planet.id}`;
  mesh.renderOrder = 3;
  return mesh;
}

function makeAtmosphere(planet, radius) {
  if (planet.id === 'mercury' || planet.id === 'moon') return null;
  const color = planet.palette?.atmosphere || planet.palette?.light || '#7fd9ff';
  const geometry = new THREE.SphereGeometry(radius * 1.04, 48, 32);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uOpacity: { value: planet.id === 'earth' ? 0.42 : planet.id === 'mars' ? 0.055 : planet.bands ? 0.16 : 0.07 },
    },
    vertexShader: atmosphereVertexShader,
    fragmentShader: atmosphereFragmentShader,
    transparent: true,
    side: THREE.BackSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `atmosphere-${planet.id}`;
  mesh.renderOrder = 4;
  mesh.userData.baseOpacity = material.uniforms.uOpacity.value;
  return mesh;
}

/**
 * Build a textured planet group with clouds, atmosphere and rings.
 * The returned object is compatible with bodies.js' planet state.
 */
export function createRealisticPlanet(planet, radius, { particleCount = 0, seed = 1, textureId = planet.id, tint = null } = {}) {
  const orbitGroup = new THREE.Group();
  orbitGroup.name = `orbit-group-${planet.id}`;

  const tiltGroup = new THREE.Group();
  tiltGroup.name = `tilt-${planet.id}`;
  tiltGroup.rotation.z = (planet.obliquityDeg || 0) * DEG;

  const spinGroup = new THREE.Group();
  spinGroup.name = `spin-${planet.id}`;

  const map = loadTexture(textureId);
  const nightMap = planet.id === 'earth' ? loadTexture('earthNight') || loadTexture('earth') : null;
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: map },
      uNightMap: { value: nightMap },
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uTint: { value: new THREE.Color(tint || SURFACE_TINTS[planet.id] || '#ffffff') },
      uRimColor: { value: new THREE.Color(planet.palette?.atmosphere || planet.palette?.light || '#7fd9ff') },
      uAmbient: { value: 0.1 },
      uHasNight: { value: planet.id === 'earth' ? 1 : 0 },
      uRimStrength: { value: planet.id === 'earth' ? 0.32 : 0.16 },
    },
    vertexShader: planetVertexShader,
    fragmentShader: planetFragmentShader,
  });
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(radius, 72, 48), material);
  sphere.name = `surface-${planet.id}`;
  spinGroup.add(sphere);

  let clouds = null;
  if (planet.id === 'earth') {
    const cloudTexture = loadTexture('earth-clouds');
    if (cloudTexture) {
      clouds = new THREE.Mesh(
        new THREE.SphereGeometry(radius * 1.006, 64, 40),
        new THREE.ShaderMaterial({
          uniforms: {
            uCloudMap: { value: cloudTexture },
            uSunDir: { value: new THREE.Vector3(1, 0, 0) },
            uOpacity: { value: 0.78 },
            uAmbient: { value: 0.16 },
          },
          vertexShader: cloudVertexShader,
          fragmentShader: cloudFragmentShader,
          transparent: true,
          depthWrite: false,
          blending: THREE.NormalBlending,
        }),
      );
      clouds.name = 'earth-cloud-layer';
      clouds.renderOrder = 2;
      spinGroup.add(clouds);
    }
  }

  const atmosphere = makeAtmosphere(planet, radius);
  let atmosphereOuter = null;
  if (planet.id === 'earth') {
    const outerMaterial = atmosphere.material.clone();
    outerMaterial.uniforms.uColor.value.set('#63b8ff');
    outerMaterial.uniforms.uOpacity.value = 0.16;
    atmosphereOuter = new THREE.Mesh(
      new THREE.SphereGeometry(radius * 1.1, 48, 32),
      outerMaterial,
    );
    atmosphereOuter.name = 'atmosphere-earth-outer';
    atmosphereOuter.renderOrder = 3;
    atmosphereOuter.userData.baseOpacity = 0.16;
    tiltGroup.add(atmosphereOuter);
  }
  tiltGroup.add(spinGroup);
  if (atmosphere) tiltGroup.add(atmosphere);

  let ring = null;
  if (planet.rings) ring = makeRing(planet, radius, planet.rings);
  if (ring) tiltGroup.add(ring);

  orbitGroup.add(tiltGroup);

  return {
    group: orbitGroup,
    tiltGroup,
    spinGroup,
    sphere,
    material,
    clouds,
    atmosphere,
    atmosphereOuter,
    ring,
    radius,
    particleCount: 0,
  };
}

const SUN_NOISE = /* glsl */ `
  float sunHash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float sunNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(sunHash(i), sunHash(i + vec2(1.0, 0.0)), f.x),
      mix(sunHash(i + vec2(0.0, 1.0)), sunHash(i + vec2(1.0, 1.0)), f.x),
      f.y
    );
  }
  float sunFbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 5; i++) {
      value += amplitude * sunNoise(p);
      p = p * 2.02 + vec2(7.1, 3.7);
      amplitude *= 0.5;
    }
    return value;
  }
`;

function makeSunCorona(radius, scale, color, strength) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(color) },
      uStrength: { value: strength },
    },
    vertexShader: /* glsl */ `
      varying vec3 vN;
      varying vec3 vP;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vP = world.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uColor;
      uniform float uStrength;
      varying vec3 vN;
      varying vec3 vP;
      ${SUN_NOISE}
      void main() {
        vec3 view = normalize(cameraPosition - vP);
        float rim = pow(1.0 - abs(dot(normalize(vN), view)), 1.55);
        vec3 dir = normalize(vP);
        float angle = atan(dir.z, dir.x);
        float n = sunFbm(vec2(angle * 2.2, dir.y * 3.4 + uTime * 0.018));
        float wisps = pow(sunFbm(vec2(angle * 7.0 + uTime * 0.03, dir.y * 7.0)), 1.6);
        float alpha = rim * (0.05 + n * 0.22 + wisps * 0.16) * uStrength;
        alpha *= 0.82 + 0.18 * sin(uTime * 0.5 + angle * 2.0);
        gl_FragColor = vec4(uColor, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.BackSide,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius * scale, 72, 48), material);
  mesh.name = `sun-corona-${scale}`;
  mesh.renderOrder = 2;
  return mesh;
}

function makeSunHalo(radius, scale, color, strength) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(color) },
      uStrength: { value: strength },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uColor;
      uniform float uStrength;
      varying vec2 vUv;
      ${SUN_NOISE}
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float d = length(p);
        if (d > 1.0) discard;
        float angle = atan(p.y, p.x);
        float n = sunFbm(vec2(angle * 2.6, d * 5.0 - uTime * 0.018));
        float wisps = sunFbm(vec2(angle * 8.0 + uTime * 0.02, d * 9.0));
        float rays = pow(max(0.0, sin(angle * 43.0 + sunFbm(vec2(angle * 3.0, uTime * 0.02)) * 7.0 + uTime * 0.06)), 7.0);
        float edge = pow(max(0.0, 1.0 - d), 3.1);
        float alpha = edge * (0.06 + n * 0.25 + wisps * 0.2 + rays * 0.42) * uStrength;
        alpha *= 0.82 + 0.18 * sin(uTime * 0.45 + angle * 3.0);
        gl_FragColor = vec4(uColor, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(radius * scale, radius * scale), material);
  mesh.name = 'sun-halo-plane';
  mesh.renderOrder = 1;
  mesh.onBeforeRender = (renderer, scene, camera) => {
    mesh.quaternion.copy(camera.quaternion);
  };
  return mesh;
}

export function createTexturedSun(radius) {
  const group = new THREE.Group();
  group.name = 'sun';
  const texture = loadTexture('sun');
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: texture },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vN;
      varying vec3 vP;
      void main() {
        vUv = uv;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vP = world.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform float uTime;
      varying vec2 vUv;
      varying vec3 vN;
      varying vec3 vP;
      ${SUN_NOISE}
      void main() {
        vec3 tex = texture2D(uMap, vUv).rgb;
        vec2 p = vUv * 6.28318;
        vec2 warp = vec2(
          sunFbm(p * 1.7 + uTime * 0.012),
          sunFbm(p * 1.7 + vec2(4.3, 9.1) - uTime * 0.015)
        );
        float macro = sunFbm(p * 3.1 + warp * 1.4);
        float cells = sunFbm(p * 10.5 + warp * 0.8 + vec2(uTime * 0.018, -uTime * 0.012));
        float fine = sunFbm(p * 31.0 - vec2(uTime * 0.022, uTime * 0.016));
        float network = smoothstep(0.47, 0.82, sunFbm(p * 12.0 + warp * 2.1));
        float spot = smoothstep(0.38, 0.63, sunFbm(p * 2.3 + warp * 0.6 + 5.2));

        float darkCells = smoothstep(0.42, 0.70, sunFbm(p * 6.5 + warp * 1.2));
        vec3 col = mix(vec3(0.07, 0.0015, 0.0004), vec3(0.48, 0.065, 0.006), 0.38 + darkCells * 0.45);
        col += tex * vec3(0.16, 0.05, 0.01);
        col += vec3(0.34, 0.035, 0.001) * macro;
        col += vec3(0.62, 0.11, 0.006) * pow(cells, 1.5);
        col += vec3(1.35, 0.46, 0.06) * pow(network, 4.6) * 0.92;
        col += vec3(0.36, 0.04, 0.001) * pow(fine, 2.6) * 0.16;
        col *= 1.0 - spot * 0.52;

        vec2 flareUvA = vec2(0.61, 0.56);
        vec2 flareUvB = vec2(0.34, 0.37);
        float flare = exp(-distance(vUv, flareUvA) * 22.0) * (0.55 + 0.45 * sin(uTime * 1.7));
        flare += exp(-distance(vUv, flareUvB) * 30.0) * (0.45 + 0.35 * sin(uTime * 1.1 + 2.1));
        col += vec3(1.35, 0.48, 0.08) * flare * 0.85;

        vec3 view = normalize(cameraPosition - vP);
        float limb = pow(1.0 - abs(dot(normalize(vN), view)), 2.8);
        col += vec3(1.25, 0.55, 0.14) * limb * 1.05;

        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    toneMapped: true,
  });
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(radius, 96, 64), material);
  sphere.name = 'sun-surface';
  group.add(sphere);

  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 1.22, 48, 32),
    new THREE.MeshBasicMaterial({
      color: '#ffb24d',
      transparent: true,
      opacity: 0.04,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  halo.name = 'sun-halo';
  halo.visible = false;

  const corona = makeSunCorona(radius, 1.16, '#ff8d2e', 0.24);
  const haloInner = makeSunHalo(radius, 3.6, '#ff9a3c', 0.4);
  const haloOuter = makeSunHalo(radius, 5.2, '#ff7a2a', 0.055);
  corona.visible = false;
  group.add(haloInner, haloOuter);
  group.add(halo);
  return {
    group,
    sphere,
    material,
    radius,
    halo,
    corona,
    coronaLayers: [haloInner, haloOuter],
  };
}

export function updateRealisticBody(body, { sunDir, dpr = 1, time = 0, focus = false }) {
  const normal = sunDir;
  body.material?.uniforms?.uSunDir?.value?.copy(normal);
  if (body.clouds?.material?.uniforms?.uSunDir) body.clouds.material.uniforms.uSunDir.value.copy(normal);
  if (body.atmosphere?.material?.uniforms?.uSunDir) {
    body.atmosphere.material.uniforms.uSunDir.value.copy(normal);
    const base = body.atmosphere.userData.baseOpacity ?? 0.5;
    body.atmosphere.material.uniforms.uOpacity.value = base * (focus ? 1 : 0.55);
  }
  if (body.atmosphereOuter?.material?.uniforms?.uSunDir) {
    body.atmosphereOuter.material.uniforms.uSunDir.value.copy(normal);
    const base = body.atmosphereOuter.userData.baseOpacity ?? 0.16;
    body.atmosphereOuter.material.uniforms.uOpacity.value = base * (focus ? 1 : 0.4);
  }
  if (body.ring?.material?.uniforms) {
    body.ring.material.uniforms.uSunDir.value.copy(normal);
    body.ring.material.uniforms.uPlanetCenter.value.copy(body.group.position);
    body.ring.material.uniforms.uPlanetRadius.value = body.radius;
  }
  if (body.clouds) {
    body.clouds.material.uniforms.uSunDir.value.copy(sunDir);
    body.clouds.rotation.y = time * 0.008;
  }
}

