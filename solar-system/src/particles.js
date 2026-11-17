/**
 * Solar System Particle Observatory — particle field construction.
 *
 * Everything visible in the orrery is a THREE.Points cloud. The module is
 * deliberately free of simulation state: it turns data + a few profile knobs
 * into buffers, materials and shaders.
 */

import * as THREE from 'three';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/* -------------------------------------------------------------------------- */
/* Deterministic random + value noise                                         */
/* -------------------------------------------------------------------------- */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash3(ix, iy, iz, seed) {
  let h = seed | 0;
  h = Math.imul(h ^ (ix | 0), 0x27d4eb2d);
  h = Math.imul(h ^ (iy | 0), 0x165667b1);
  h = Math.imul(h ^ (iz | 0), 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

const fade = (t) => t * t * (3 - 2 * t);
export function valueNoise3(x, y, z, seed = 1337) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = fade(x - xi);
  const yf = fade(y - yi);
  const zf = fade(z - zi);

  const c000 = hash3(xi, yi, zi, seed);
  const c100 = hash3(xi + 1, yi, zi, seed);
  const c010 = hash3(xi, yi + 1, zi, seed);
  const c110 = hash3(xi + 1, yi + 1, zi, seed);
  const c001 = hash3(xi, yi, zi + 1, seed);
  const c101 = hash3(xi + 1, yi, zi + 1, seed);
  const c011 = hash3(xi, yi + 1, zi + 1, seed);
  const c111 = hash3(xi + 1, yi + 1, zi + 1, seed);

  const x00 = c000 + (c100 - c000) * xf;
  const x10 = c010 + (c110 - c010) * xf;
  const x01 = c001 + (c101 - c001) * xf;
  const x11 = c011 + (c111 - c011) * xf;
  const y0 = x00 + (x10 - x00) * yf;
  const y1 = x01 + (x11 - x01) * yf;
  return y0 + (y1 - y0) * zf;
}

export function fbm3(x, y, z, octaves = 3, seed = 1337) {
  let value = 0;
  let amplitude = 0.5;
  let frequency = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i += 1) {
    value += amplitude * valueNoise3(x * frequency, y * frequency, z * frequency, seed + i * 97);
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2.03;
  }
  return value / norm;
}

/* -------------------------------------------------------------------------- */
/* Colour helpers                                                             */
/* -------------------------------------------------------------------------- */

const COLOR_CACHE = new Map();

export function toRgb(hex) {
  if (!COLOR_CACHE.has(hex)) {
    const c = new THREE.Color(hex);
    COLOR_CACHE.set(hex, [c.r, c.g, c.b]);
  }
  return COLOR_CACHE.get(hex);
}

function mixRgb(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function scaleRgb(c, s) {
  return [Math.min(1, c[0] * s), Math.min(1, c[1] * s), Math.min(1, c[2] * s)];
}

function hslRgb(h, s, l) {
  const c = new THREE.Color();
  c.setHSL(h, s, l);
  return [c.r, c.g, c.b];
}

export function sampleBands(bands, latDeg, seedColor) {
  if (!Array.isArray(bands) || bands.length === 0) return toRgb(seedColor || '#888888');
  let lower = bands[0];
  let upper = bands[bands.length - 1];
  for (let i = 0; i < bands.length - 1; i += 1) {
    if (latDeg >= bands[i].lat && latDeg <= bands[i + 1].lat) {
      lower = bands[i];
      upper = bands[i + 1];
      break;
    }
  }
  if (latDeg <= bands[0].lat) return toRgb(bands[0].color);
  if (latDeg >= bands[bands.length - 1].lat) return toRgb(bands[bands.length - 1].color);
  const span = upper.lat - lower.lat || 1;
  const t = Math.min(1, Math.max(0, (latDeg - lower.lat) / span));
  return mixRgb(toRgb(lower.color), toRgb(upper.color), t);
}

const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/**
 * Builds an equirectangular band texture for the opaque planet core. This is
 * what makes Jupiter's belts and zones (and Saturn's subtle banding) readable
 * behind the sparkle layer; the point cloud alone reads as a noisy sphere.
 * Returns null outside the browser.
 */
export function makeBandTexture(planet, width = 640, height = 320) {
  if (!planet.bands || typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const image = ctx.createImageData(width, height);
  const data = image.data;
  const spot = planet.spot;
  const seed = 1103 + planet.nameEn.length * 71;

  for (let y = 0; y < height; y += 1) {
    const lat = 90 - (y / (height - 1)) * 180;
    const bandNoise = valueNoise3(0.5, lat * 0.12, 1.7, seed) - 0.5;
    for (let x = 0; x < width; x += 1) {
      const lon = (x / width) * 360 - 180;
      const wobble = Math.sin(lon * DEG * 2.3 + lat * 0.06) * 2.4 + bandNoise * 5;
      let col = sampleBands(planet.bands, lat + wobble, planet.palette.base);
      const streak = (valueNoise3(lon * 0.02, lat * 0.35, 4.1, seed + 11) - 0.5) * 0.16;
      let r = linearToSrgb(Math.min(1, Math.max(0, col[0] * (1 + streak))));
      let g = linearToSrgb(Math.min(1, Math.max(0, col[1] * (1 + streak))));
      let b = linearToSrgb(Math.min(1, Math.max(0, col[2] * (1 + streak))));

      if (spot) {
        let dLon = lon - spot.lon;
        if (dLon > 180) dLon -= 360;
        if (dLon < -180) dLon += 360;
        const e = (dLon / spot.width) ** 2 + ((lat - spot.lat) / spot.height) ** 2;
        if (e < 1) {
          const s = new THREE.Color(spot.color);
          const t = Math.min(1, 0.28 + (1 - e) * 0.72);
          r = r * (1 - t) + linearToSrgb(s.r) * t;
          g = g * (1 - t) + linearToSrgb(s.g) * t;
          b = b * (1 - t) + linearToSrgb(s.b) * t;
        }
      }

      const i = (y * width + x) * 4;
      data[i] = Math.round(r * 255);
      data[i + 1] = Math.round(g * 255);
      data[i + 2] = Math.round(b * 255);
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

/* -------------------------------------------------------------------------- */
/* Shared shader chunks                                                       */
/* -------------------------------------------------------------------------- */

const POINT_FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    if (d > 0.5) discard;
    float soft = smoothstep(0.5, 0.12, d);
    gl_FragColor = vec4(vColor, vAlpha * soft);
  }
`;

const PLANET_VERTEX = /* glsl */ `
  precision highp float;
  attribute vec3 aNormal;
  attribute float aSize;
  attribute float aAlpha;
  uniform float uPointSize;
  uniform float uDpr;
  uniform float uFade;
  uniform vec3 uSunDir;
  uniform vec3 uRim;
  uniform float uRimPower;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec3 worldNormal = normalize(mat3(modelMatrix) * aNormal);
    vec3 worldPos = (modelMatrix * vec4(position, 1.0)).xyz;
    vec3 toCamera = normalize(cameraPosition - worldPos);

    // The sun is a point source in this model; diffuse day side + warm fill.
    float sunAmount = max(dot(worldNormal, normalize(uSunDir)), 0.0);
    float fill = max(dot(worldNormal, toCamera), 0.0);
    float lighting = 0.16 + 0.92 * sunAmount + 0.5 * fill;
    float rim = pow(1.0 - max(dot(worldNormal, toCamera), 0.0), uRimPower);

    vColor = color * lighting + uRim * rim * 0.16;
    vAlpha = aAlpha * uFade;

    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = clamp(aSize * uPointSize * uDpr, 0.7, 7.0);
  }
`;

const SIMPLE_VERTEX = /* glsl */ `
  precision highp float;
  attribute float aSize;
  attribute float aAlpha;
  uniform float uPointSize;
  uniform float uDpr;
  uniform float uFade;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = color;
    vAlpha = aAlpha * uFade;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = clamp(aSize * uPointSize * uDpr, 0.55, 8.0);
  }
`;

const RING_VERTEX = /* glsl */ `
  precision highp float;
  attribute float aSize;
  attribute float aAlpha;
  uniform float uPointSize;
  uniform float uDpr;
  uniform float uFade;
  uniform vec3 uPlanetCenter;
  uniform vec3 uSunDir;
  uniform float uPlanetRadius;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vec3 rel = world.xyz - uPlanetCenter;
    vec3 sunDir = normalize(uSunDir);
    float along = dot(rel, sunDir);
    vec3 perpendicular = rel - sunDir * along;
    // Cylindrical umbra: ring particles on the far side of the planet are dimmed.
    float shadow = (along < 0.0 && length(perpendicular) < uPlanetRadius * 1.04) ? 0.22 : 1.0;
    vColor = color * (0.34 + 0.66 * shadow);
    vAlpha = aAlpha * uFade * (0.5 + 0.5 * shadow);
    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = clamp(aSize * uPointSize * uDpr, 0.55, 6.0);
  }
`;

const BELT_VERTEX = /* glsl */ `
  precision highp float;
  attribute float aAngle;
  attribute float aRadius;
  attribute float aHeight;
  attribute float aSpeed;
  attribute float aSize;
  attribute float aAlpha;
  uniform float uTime;
  uniform float uPointSize;
  uniform float uDpr;
  uniform float uFade;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float angle = aAngle + uTime * aSpeed;
    vec3 p = vec3(cos(angle) * aRadius, aHeight, sin(angle) * aRadius);
    vColor = color;
    vAlpha = aAlpha * uFade;
    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = clamp(aSize * uPointSize * uDpr, 0.55, 4.2);
  }
`;

const STAR_VERTEX = /* glsl */ `
  precision highp float;
  attribute float aSize;
  attribute float aAlpha;
  attribute float aPhase;
  uniform float uTime;
  uniform float uPointSize;
  uniform float uDpr;
  uniform float uFade;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float twinkle = 0.82 + 0.18 * sin(uTime * 1.3 + aPhase * 6.28318);
    vColor = color;
    vAlpha = aAlpha * uFade * twinkle;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = clamp(aSize * uPointSize * uDpr * (0.7 + 0.3 * twinkle), 0.45, 4.4);
  }
`;

function pointsMaterial(kind, { pointSize = 2.0, dpr = 1, fade = 1 } = {}) {
  const base = {
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: kind === 'sun' || kind === 'star' ? THREE.AdditiveBlending : THREE.NormalBlending,
    vertexShader: kind === 'planet' ? PLANET_VERTEX : kind === 'ring' ? RING_VERTEX : kind === 'belt' ? BELT_VERTEX : kind === 'star' ? STAR_VERTEX : SIMPLE_VERTEX,
    fragmentShader: POINT_FRAGMENT,
    uniforms: {
      uPointSize: { value: pointSize },
      uDpr: { value: dpr },
      uFade: { value: fade },
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0.3, 0.4, 0.9) },
      uRim: { value: new THREE.Color('#7fd9ff') },
      uRimPower: { value: 2.4 },
      uPlanetCenter: { value: new THREE.Vector3() },
      uPlanetRadius: { value: 1 },
    },
  };
  return new THREE.ShaderMaterial(base);
}

/* -------------------------------------------------------------------------- */
/* Geometry builders                                                          */
/* -------------------------------------------------------------------------- */

function directionFromIndex(i, count, random) {
  const y = 1 - (i / Math.max(1, count - 1)) * 2;
  const radius = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = i * 2.399963229728653 + random() * 0.035;
  return {
    x: Math.cos(theta) * radius,
    y,
    z: Math.sin(theta) * radius,
  };
}

/**
 * Build a particle sphere for a planet. The points are baked in world units
 * (radius = planet visual radius), so the body group can be moved without
 * changing per-particle scale.
 */
export function makePlanetField(planet, count, radiusWorld, { seed = 7 } = {}) {
  const random = mulberry32(seed + planet.id.length * 991);
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const alphas = new Float32Array(count);

  const palette = planet.palette || {};
  const base = toRgb(palette.base || '#888888');
  const light = toRgb(palette.light || palette.base || '#aaaaaa');
  const dark = toRgb(palette.dark || palette.base || '#444444');
  const accent = toRgb(palette.accent || palette.base || '#888888');
  const atmosphere = toRgb(palette.atmosphere || palette.light || '#aaa');
  const isEarth = planet.id === 'earth';
  const isMars = planet.id === 'mars';
  const isMercury = planet.id === 'mercury';
  const isGas = planet.id === 'jupiter' || planet.id === 'saturn';
  const isIce = planet.id === 'uranus' || planet.id === 'neptune';

  for (let i = 0; i < count; i += 1) {
    const dir = directionFromIndex(i, count, random);
    const nx = dir.x;
    const ny = dir.y;
    const nz = dir.z;
    const latDeg = Math.asin(ny) / DEG;
    const lon = Math.atan2(nz, nx);

    // Three independent fields: broad continents, fine turbulence, craters.
    const broad = fbm3(nx * 2.1 + 11.3, ny * 2.1 - 7.7, nz * 2.1 + 3.1, 3, seed + 17);
    const fine = fbm3(nx * 7.2 - 4.1, ny * 7.2 + 2.8, nz * 7.2 + 9.3, 3, seed + 41);
    const micro = fbm3(nx * 18.4 + 1.7, ny * 18.4 - 3.3, nz * 18.4 + 5.1, 2, seed + 73);

    let col = base;
    let brightness = 0.82 + broad * 0.28 + fine * 0.16;

    if (isEarth) {
      const polar = Math.abs(latDeg) > 68 + broad * 7;
      const land = broad > 0.525 && !polar;
      const desert = land && fine > 0.53 && Math.abs(latDeg) < 46;
      const cloud = fine > 0.63 || (broad > 0.68 && micro > 0.54);
      if (polar) {
        col = mixRgb(toRgb('#e8f5ff'), toRgb('#a9d6ef'), fine);
        brightness *= 0.94 + fine * 0.12;
      } else if (land) {
        col = desert ? toRgb('#b78b56') : toRgb('#4e7a45');
        col = mixRgb(col, toRgb('#8db06d'), fine * 0.55);
        brightness *= 0.88 + fine * 0.24;
      } else {
        col = mixRgb(toRgb('#184b76'), toRgb('#2a709c'), broad);
        brightness *= 0.84 + fine * 0.16;
      }
      if (cloud) {
        col = mixRgb(col, toRgb('#f4f7f7'), 0.42 + micro * 0.3);
        brightness = 1.02 + micro * 0.1;
      }
      if (cloud && fine > 0.72) brightness *= 1.1;
    } else if (isMars) {
      const polar = Math.abs(latDeg) > 76 + fine * 5;
      const darkRegion = broad > 0.58;
      col = polar
        ? mixRgb(toRgb('#f4f1e8'), toRgb('#d6cbbd'), fine)
        : darkRegion
          ? mixRgb(toRgb('#7b3b25'), toRgb('#a95c3c'), fine)
          : mixRgb(toRgb('#b95f3d'), toRgb('#d78b5f'), broad);
      brightness *= 0.84 + fine * 0.26;
      if (micro > 0.7) col = mixRgb(col, dark, 0.45);
    } else if (isMercury) {
      col = mixRgb(dark, light, broad * 0.7 + fine * 0.2);
      if (micro > 0.68) col = mixRgb(col, dark, 0.5);
      brightness *= 0.78 + fine * 0.36;
    } else if (isGas) {
      const latWobble = latDeg + (fine - 0.5) * 11 + (broad - 0.5) * 4;
      col = sampleBands(planet.bands, latWobble, palette.base);
      brightness *= 0.8 + fine * 0.28 + broad * 0.12;
      if (planet.spot) {
        const spot = planet.spot;
        const spotLon = spot.lon ?? 0;
        const lonDelta = Math.atan2(Math.sin(lon - spotLon * DEG), Math.cos(lon - spotLon * DEG)) / DEG;
        const spotDistance = (lonDelta / spot.width) ** 2 + ((latDeg - spot.lat) / spot.height) ** 2;
        if (spotDistance < 1.0) {
          const edge = 1 - spotDistance;
          col = mixRgb(col, toRgb(spot.color), 0.3 + edge * 0.7);
          brightness *= 0.8 + edge * 0.3;
        }
      }
      if (planet.id === 'saturn' && Math.abs(latDeg) > 78) {
        col = mixRgb(col, toRgb('#9fb3b5'), 0.3);
      }
    } else if (isIce) {
      col = mixRgb(base, light, broad * 0.55 + fine * 0.16);
      brightness *= 0.86 + fine * 0.2 + broad * 0.08;
      if (fine > 0.72) col = mixRgb(col, toRgb('#e9fbff'), 0.4);
      if (planet.id === 'neptune' && broad > 0.66) col = mixRgb(col, toRgb('#3556a0'), 0.5);
    } else {
      col = mixRgb(dark, light, broad * 0.7 + fine * 0.2);
    }

    if (!isEarth && !isGas) {
      // Subtle regolith variation.
      brightness *= 0.92 + micro * 0.14;
    }

    // A tiny radial jitter keeps the sphere from looking too mathematical.
    const radius = radiusWorld * (1 + (micro - 0.5) * 0.012);
    const idx = i * 3;
    positions[idx] = nx * radius;
    positions[idx + 1] = ny * radius;
    positions[idx + 2] = nz * radius;
    normals[idx] = nx;
    normals[idx + 1] = ny;
    normals[idx + 2] = nz;

    const shaded = scaleRgb(col, brightness);
    colors[idx] = shaded[0];
    colors[idx + 1] = shaded[1];
    colors[idx + 2] = shaded[2];

    const pole = Math.abs(ny);
    const size = 0.78 + random() * 0.52 + (pole > 0.92 ? 0.08 : 0);
    sizes[i] = size;
    alphas[i] = 0.48 + random() * 0.34;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aNormal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));

  const material = pointsMaterial('planet', { pointSize: 2.2, dpr: 1, fade: 1 });
  material.uniforms.uRim.value = new THREE.Color(palette.atmosphere || palette.light || '#7fd9ff');
  const points = new THREE.Points(geometry, material);
  points.name = `planet-${planet.id}`;
  points.frustumCulled = false;
  return { object: points, geometry, material, count };
}

/* -------------------------------------------------------------------------- */
/* Sun                                                                        */
/* -------------------------------------------------------------------------- */

export function makeSunField(count, radiusWorld, { seed = 31 } = {}) {
  const random = mulberry32(seed);
  const photoCount = Math.round(count * 0.34);
  const coronaCount = count - photoCount;

  const photoPositions = new Float32Array(photoCount * 3);
  const photoColors = new Float32Array(photoCount * 3);
  const photoSizes = new Float32Array(photoCount);
  const photoAlphas = new Float32Array(photoCount);

  const gold = toRgb('#ffcf7a');
  const amber = toRgb('#ff9a4d');
  const ivory = toRgb('#fff3cf');
  const rust = toRgb('#c65b28');

  for (let i = 0; i < photoCount; i += 1) {
    const d = directionFromIndex(i, photoCount, random);
    const lat = Math.asin(d.y) / DEG;
    const n = fbm3(d.x * 5.4 + 2, d.y * 5.4 - 3, d.z * 5.4 + 7, 3, seed + 5);
    const granule = fbm3(d.x * 20 + 8, d.y * 20 - 2, d.z * 20 + 1, 2, seed + 61);
    const col = n > 0.58 ? mixRgb(gold, ivory, granule * 0.8) : mixRgb(amber, rust, (1 - n) * 0.48);
    const r = radiusWorld * (1 + (granule - 0.5) * 0.018);
    const idx = i * 3;
    photoPositions[idx] = d.x * r;
    photoPositions[idx + 1] = d.y * r;
    photoPositions[idx + 2] = d.z * r;
    photoColors[idx] = col[0];
    photoColors[idx + 1] = col[1];
    photoColors[idx + 2] = col[2];
    photoSizes[i] = 0.7 + random() * 0.7;
    photoAlphas[i] = 0.34 + random() * 0.4;

    // Sunspots / active latitudes.
    if (Math.abs(lat) < 38 && granule < 0.18) photoAlphas[i] *= 0.45;
  }

  const coronaPositions = new Float32Array(coronaCount * 3);
  const coronaColors = new Float32Array(coronaCount * 3);
  const coronaSizes = new Float32Array(coronaCount);
  const coronaAlphas = new Float32Array(coronaCount);
  const coronaRust = toRgb('#ff7a3c');
  const coronaGold = toRgb('#ffd79a');

  for (let i = 0; i < coronaCount; i += 1) {
    const d = directionFromIndex(i, coronaCount, random);
    const t = Math.pow(random(), 1.8);
    const r = radiusWorld * (1.02 + t * 1.12);
    const col = mixRgb(coronaGold, coronaRust, t * 0.7 + random() * 0.18);
    const idx = i * 3;
    coronaPositions[idx] = d.x * r;
    coronaPositions[idx + 1] = d.y * r;
    coronaPositions[idx + 2] = d.z * r;
    coronaColors[idx] = col[0];
    coronaColors[idx + 1] = col[1];
    coronaColors[idx + 2] = col[2];
    coronaSizes[i] = 0.55 + random() * 0.95;
    coronaAlphas[i] = (0.012 + (1 - t) * 0.10) * (0.7 + random() * 0.3);
  }

  const photoGeometry = new THREE.BufferGeometry();
  photoGeometry.setAttribute('position', new THREE.BufferAttribute(photoPositions, 3));
  photoGeometry.setAttribute('color', new THREE.BufferAttribute(photoColors, 3));
  photoGeometry.setAttribute('aSize', new THREE.BufferAttribute(photoSizes, 1));
  photoGeometry.setAttribute('aAlpha', new THREE.BufferAttribute(photoAlphas, 1));

  const coronaGeometry = new THREE.BufferGeometry();
  coronaGeometry.setAttribute('position', new THREE.BufferAttribute(coronaPositions, 3));
  coronaGeometry.setAttribute('color', new THREE.BufferAttribute(coronaColors, 3));
  coronaGeometry.setAttribute('aSize', new THREE.BufferAttribute(coronaSizes, 1));
  coronaGeometry.setAttribute('aAlpha', new THREE.BufferAttribute(coronaAlphas, 1));

  const photoMaterial = pointsMaterial('sun', { pointSize: 1.65, dpr: 1 });
  const coronaMaterial = pointsMaterial('sun', { pointSize: 1.9, dpr: 1 });
  photoMaterial.uniforms.uRim.value.set('#ffc46b');
  coronaMaterial.uniforms.uRim.value.set('#ff9a55');

  const group = new THREE.Group();
  group.name = 'sun';
  const photo = new THREE.Points(photoGeometry, photoMaterial);
  photo.frustumCulled = false;
  const corona = new THREE.Points(coronaGeometry, coronaMaterial);
  corona.frustumCulled = false;
  group.add(photo, corona);

  return { group, photo, corona, materials: [photoMaterial, coronaMaterial], counts: { photoCount, coronaCount } };
}

/* -------------------------------------------------------------------------- */
/* Rings                                                                      */
/* -------------------------------------------------------------------------- */

const RING_SYSTEMS = {
  saturn: {
    innerR: 1.11,
    outerR: 2.34,
    bands: [
      { from: 1.11, to: 1.236, color: '#8f7b58', alpha: 0.12, weight: 0.4 },
      { from: 1.239, to: 1.526, color: '#c7ae83', alpha: 0.5, weight: 1.6 },
      { from: 1.526, to: 1.951, color: '#f0dcac', alpha: 0.95, weight: 4.5 },
      { from: 2.027, to: 2.269, color: '#d5b985', alpha: 0.7, weight: 2.4 },
      { from: 2.326, to: 2.334, color: '#eee0c2', alpha: 0.45, weight: 0.12 },
    ],
    gaps: [
      { center: 1.989, width: 0.035, alpha: 0.02 },
      { center: 2.216, width: 0.008, alpha: 0.04 },
    ],
    tiltY: 0.015,
  },
  jupiter: {
    innerR: 1.37,
    outerR: 3.52,
    bands: [
      { from: 1.37, to: 1.82, color: '#8e6d58', alpha: 0.08, weight: 0.6 },
      { from: 1.82, to: 2.05, color: '#9d7a60', alpha: 0.14, weight: 0.8 },
      { from: 2.05, to: 3.52, color: '#6f5a50', alpha: 0.05, weight: 1.2 },
    ],
    gaps: [],
    tiltY: 0.01,
  },
  uranus: {
    innerR: 1.64,
    outerR: 2.05,
    bands: [
      { from: 1.64, to: 1.67, color: '#8aa6ad', alpha: 0.28, weight: 0.35 },
      { from: 1.75, to: 1.78, color: '#9ab6bc', alpha: 0.22, weight: 0.3 },
      { from: 1.86, to: 1.89, color: '#77939b', alpha: 0.18, weight: 0.3 },
      { from: 1.96, to: 2.05, color: '#b4cbd2', alpha: 0.06, weight: 0.2 },
    ],
    gaps: [],
    tiltY: 0,
  },
  neptune: {
    innerR: 1.72,
    outerR: 2.42,
    bands: [
      { from: 1.72, to: 1.78, color: '#7a95bd', alpha: 0.14, weight: 0.5 },
      { from: 2.12, to: 2.16, color: '#a8bedf', alpha: 0.2, weight: 0.4 },
      { from: 2.26, to: 2.42, color: '#6e86ad', alpha: 0.05, weight: 0.3 },
    ],
    gaps: [],
    tiltY: 0.01,
  },
};

function pickWeightedBand(bands, random) {
  const total = bands.reduce((sum, band) => sum + band.weight, 0);
  let target = random() * total;
  for (const band of bands) {
    target -= band.weight;
    if (target <= 0) return band;
  }
  return bands[bands.length - 1];
}

export function makeRingField(planet, count, planetRadius, { seed = 23 } = {}) {
  const blueprint = RING_SYSTEMS[planet.id];
  if (!blueprint) return null;
  const random = mulberry32(seed + planet.id.charCodeAt(0) * 3203);
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const alphas = new Float32Array(count);

  for (let i = 0; i < count; i += 1) {
    const band = pickWeightedBand(blueprint.bands, random);
    const radiusUnits = band.from + random() * (band.to - band.from);
    const angle = random() * TAU;
    const radius = radiusUnits * planetRadius;
    const thickness = planet.id === 'saturn' ? 0.0045 : 0.0025;
    const y = (random() - 0.5) * planetRadius * thickness;
    const idx = i * 3;
    positions[idx] = Math.cos(angle) * radius;
    positions[idx + 1] = y;
    positions[idx + 2] = Math.sin(angle) * radius;

    let alpha = band.alpha * (0.55 + random() * 0.45);
    for (const gap of blueprint.gaps) {
      if (Math.abs(radiusUnits - gap.center) < gap.width) alpha *= 0.08;
    }
    // Subtle radial density variation (ringlets).
    const ringlet = 0.8 + 0.2 * Math.sin(radiusUnits * 46 + planet.id.length);
    alpha *= ringlet;

    const base = toRgb(band.color);
    const bright = 0.78 + random() * 0.4;
    colors[idx] = Math.min(1, base[0] * bright);
    colors[idx + 1] = Math.min(1, base[1] * bright);
    colors[idx + 2] = Math.min(1, base[2] * bright);
    sizes[i] = 0.68 + random() * 0.55;
    alphas[i] = alpha;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
  const material = pointsMaterial('ring', { pointSize: 1.7, dpr: 1 });
  material.side = THREE.DoubleSide;
  const points = new THREE.Points(geometry, material);
  points.name = `rings-${planet.id}`;
  points.frustumCulled = false;
  return { object: points, geometry, material, count };
}

/* -------------------------------------------------------------------------- */
/* Belts                                                                      */
/* -------------------------------------------------------------------------- */

export function makeBeltField({ count, innerAU, outerAU, heightAU, radiusForAU, speedScale = 1, seed = 3, palette = ['#8a7a66', '#b6a386', '#5d5348'] }) {
  const random = mulberry32(seed);
  const positions = new Float32Array(count * 3); // unused by shader, but keeps bounds
  const colors = new Float32Array(count * 3);
  const angles = new Float32Array(count);
  const radii = new Float32Array(count);
  const heights = new Float32Array(count);
  const speeds = new Float32Array(count);
  const sizes = new Float32Array(count);
  const alphas = new Float32Array(count);
  const auValues = new Float32Array(count);

  for (let i = 0; i < count; i += 1) {
    const au = innerAU + Math.pow(random(), 1.25) * (outerAU - innerAU);
    const angle = random() * TAU;
    const idx = i * 3;
    positions[idx] = 0;
    positions[idx + 1] = 0;
    positions[idx + 2] = 0;
    angles[i] = angle;
    auValues[i] = au;
    radii[i] = radiusForAU(au);
    heights[i] = (random() - 0.5) * heightAU * (0.4 + random() * 0.6);
    speeds[i] = (0.5 / Math.pow(au, 1.5)) * speedScale * (0.8 + random() * 0.4);
    const color = toRgb(palette[Math.floor(random() * palette.length)]);
    const bright = 0.7 + random() * 0.55;
    colors[idx] = Math.min(1, color[0] * bright);
    colors[idx + 1] = Math.min(1, color[1] * bright);
    colors[idx + 2] = Math.min(1, color[2] * bright);
    sizes[i] = 0.58 + random() * 0.9;
    alphas[i] = 0.22 + random() * 0.55;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aAngle', new THREE.BufferAttribute(angles, 1));
  geometry.setAttribute('aRadius', new THREE.BufferAttribute(radii, 1));
  geometry.setAttribute('aHeight', new THREE.BufferAttribute(heights, 1));
  geometry.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));

  const material = pointsMaterial('belt', { pointSize: 1.35, dpr: 1 });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return {
    object: points,
    geometry,
    material,
    count,
    setScaleMode(radiusFn = radiusForAU) {
      const radiusAttribute = geometry.getAttribute('aRadius');
      for (let i = 0; i < count; i += 1) {
        radiusAttribute.array[i] = radiusFn(auValues[i]);
      }
      radiusAttribute.needsUpdate = true;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Stars                                                                      */
/* -------------------------------------------------------------------------- */

export function makeStarField(count, { radius = 92, seed = 71 } = {}) {
  const random = mulberry32(seed);
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const alphas = new Float32Array(count);
  const phases = new Float32Array(count);

  // Tilt the galactic band.
  const bandNormal = new THREE.Vector3(0.28, 0.9, 0.2).normalize();
  const temp = new THREE.Color();

  for (let i = 0; i < count; i += 1) {
    let x;
    let y;
    let z;
    if (i < count * 0.62) {
      // Milky Way band: a great circle thickened by a soft gaussian.
      const angle = random() * TAU;
      const width = (random() + random() + random() - 1.5) * 0.24;
      const base = new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0);
      const tangent = new THREE.Vector3(-Math.sin(angle), Math.cos(angle), 0);
      const bitangent = new THREE.Vector3().crossVectors(base, tangent).normalize();
      const v = base.addScaledVector(bitangent, width).normalize();
      const tiltQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), bandNormal);
      v.applyQuaternion(tiltQuat);
      x = v.x; y = v.y; z = v.z;
    } else {
      const u = random() * 2 - 1;
      const phi = random() * TAU;
      const r = Math.sqrt(1 - u * u);
      x = Math.cos(phi) * r;
      y = u;
      z = Math.sin(phi) * r;
    }
    const distance = radius * (0.8 + random() * 0.55);
    const idx = i * 3;
    positions[idx] = x * distance;
    positions[idx + 1] = y * distance;
    positions[idx + 2] = z * distance;

    const temperature = random();
    if (temperature > 0.82) temp.setHSL(0.58, 0.45, 0.8 + random() * 0.15);
    else if (temperature > 0.6) temp.setHSL(0.12, 0.35, 0.82 + random() * 0.15);
    else if (temperature > 0.35) temp.setHSL(0.58, 0.1, 0.78 + random() * 0.2);
    else temp.setHSL(0.08, 0.25, 0.7 + random() * 0.2);
    colors[idx] = temp.r;
    colors[idx + 1] = temp.g;
    colors[idx + 2] = temp.b;
    sizes[i] = 0.45 + Math.pow(random(), 2.3) * 1.8;
    alphas[i] = 0.25 + random() * 0.65;
    phases[i] = random();
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  const material = pointsMaterial('star', { pointSize: 1.25, dpr: 1 });
  const points = new THREE.Points(geometry, material);
  points.name = 'stars';
  points.frustumCulled = false;
  return { object: points, geometry, material, count };
}

/* -------------------------------------------------------------------------- */
/* Glow sprite generated on a canvas (no external image)                      */
/* -------------------------------------------------------------------------- */

export function createGlowSprite(color = '#ffcf7a', opacity = 0.6) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.12, 'rgba(255,248,224,0.92)');
  gradient.addColorStop(0.3, color);
  gradient.addColorStop(1, 'rgba(255,150,60,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({
    map: texture,
    color: 0xffffff,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    toneMapped: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.name = 'glow';
  return sprite;
}

/* -------------------------------------------------------------------------- */
/* Orbit line                                                                 */
/* -------------------------------------------------------------------------- */

export function makeOrbitLine(points, color = '#7fd9ff', opacity = 0.18) {
  const positions = new Float32Array(points.length * 3);
  const colors = new Float32Array(points.length * 3);
  const gold = new THREE.Color('#ffd08a');
  const blue = new THREE.Color('#9bd1ff');
  const mixed = new THREE.Color();
  points.forEach((p, i) => {
    positions[i * 3] = p.x;
    positions[i * 3 + 1] = p.y;
    positions[i * 3 + 2] = p.z;
    // Blue-gold transit: cool orbital path with warm sunlight catching it.
    const phase = (i / Math.max(1, points.length - 1)) * Math.PI * 2;
    mixed.copy(blue).lerp(gold, 0.42 + 0.34 * Math.sin(phase * 2 + 0.7));
    colors[i * 3] = mixed.r;
    colors[i * 3 + 1] = mixed.g;
    colors[i * 3 + 2] = mixed.b;
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const line = new THREE.Line(geometry, material);
  line.frustumCulled = false;
  return { object: line, geometry, material };
}

export const PARTICLE_UTILS = {
  TAU,
  DEG,
  fbm3,
  valueNoise3,
  sampleBands,
  hslRgb,
};
