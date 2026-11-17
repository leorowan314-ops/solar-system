/**
 * Solar System Particle Observatory 鈥?bodies, rings, belts, orbits, labels.
 *
 * This module owns the objects and their physical/animated state. Camera and
 * UI composition live in scene.js/main.js; the data contract is in data.js.
 */

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { SUN, PLANETS } from './data.js';
import { orbitalPositionAU, orbitPathAU } from './astro.js';
import {
  makeStarField,
  makeBeltField,
  makeOrbitLine,
  makePlanetField,
  makeSunField,
  makeRingField,
  createGlowSprite,
} from './particles.js';
import {
  createRealisticPlanet,
  createTexturedSun,
  updateRealisticBody,
} from './realistic.js';
import { createEarthLayers } from './earthLayers.js';
import { COMET, createComet } from './comet.js';
import { MOON } from './moon.js';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const ORBIT_SEGMENTS = 256;

/** Visual distance mapping. Every value is astronomical AU -> scene units. */
export const DISTANCE_SCALES = Object.freeze({
  demo: {
    base: CONFIG.scale.demoDistanceBase,
    gain: CONFIG.scale.demoDistanceGain,
    power: CONFIG.scale.demoDistancePower,
    label: '教学压缩',
  },
  true: {
    base: CONFIG.scale.trueDistanceBase,
    gain: CONFIG.scale.trueDistanceGain,
    power: CONFIG.scale.trueDistancePower,
    label: '真实距离',
  },
});

export function displayDistanceAU(au, mode = 'demo') {
  const scale = DISTANCE_SCALES[mode] || DISTANCE_SCALES.demo;
  return scale.base + scale.gain * Math.pow(Math.max(0, au), scale.power);
}

/** Artist-exaggerated radius, preserving relative order across the planets. */
export function displayRadius(radiusKm) {
  const earth = 6371;
  return CONFIG.scale.radiusBase * Math.pow(Math.max(1, radiusKm / earth), CONFIG.scale.radiusExponent);
}

/** Placement for a heliocentric ecliptic AU position: y-up scene, ecliptic XZ. */
export function heliocentricToScene(positionAU, mode = 'demo') {
  const r = Math.hypot(positionAU.x, positionAU.y, positionAU.z);
  if (r < 1e-9) return { x: 0, y: 0, z: 0, r: 0 };
  const sceneRadius = displayDistanceAU(r, mode);
  const k = sceneRadius / r;
  return {
    x: positionAU.x * k,
    y: positionAU.z * k,
    z: positionAU.y * k,
    r: sceneRadius,
  };
}

function makeOrbitPoints(planet, date, mode) {
  const path = orbitPathAU(planet, date, ORBIT_SEGMENTS);
  return path.map((p) => {
    const scene = heliocentricToScene(p, mode);
    return { x: scene.x, y: scene.y, z: scene.z };
  });
}

function setOrbitGeometry(line, points) {
  const array = line.geometry.getAttribute('position');
  points.forEach((p, i) => {
    array.setXYZ(i, p.x, p.y, p.z);
  });
  array.needsUpdate = true;
  line.geometry.computeBoundingSphere();
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeSolarWind(radius, count = 3200) {
  const random = mulberry32(2026);
  const positions = new Float32Array(count * 3);
  const dirs = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const sizes = new Float32Array(count);
  const axes = [
    [1, 0.15, 0.35],
    [-0.75, 0.45, -0.1],
    [0.1, -0.85, 0.5],
    [-0.2, -0.2, -1],
  ];
  for (let i = 0; i < count; i += 1) {
    const group = i % 4;
    const axis = axes[group];
    const jitter = 0.34;
    const raw = [
      axis[0] + (random() * 2 - 1) * jitter,
      axis[1] + (random() * 2 - 1) * jitter,
      axis[2] + (random() * 2 - 1) * jitter,
    ];
    const len = Math.hypot(raw[0], raw[1], raw[2]) || 1;
    const dir = [raw[0] / len, raw[1] / len, raw[2] / len];
    dirs[i * 3] = dir[0];
    dirs[i * 3 + 1] = dir[1];
    dirs[i * 3 + 2] = dir[2];
    positions[i * 3] = dir[0] * radius;
    positions[i * 3 + 1] = dir[1] * radius;
    positions[i * 3 + 2] = dir[2] * radius;
    // Encode the burst group in the seed so the vertex shader can offset the
    // impulse phase: four localized eruptions instead of one spherical pulse.
    seeds[i] = (group + 0.05 + random() * 0.9) / 4;
    sizes[i] = 0.5 + random() * 1.6;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aDir', new THREE.BufferAttribute(dirs, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uDpr: { value: 1 },
      uRadius: { value: radius },
      uColorA: { value: new THREE.Color('#ffd27a') },
      uColorB: { value: new THREE.Color('#ff7a32') },
    },
    vertexShader: /* glsl */ `
      attribute vec3 aDir;
      attribute float aSeed;
      attribute float aSize;
      uniform float uTime;
      uniform float uDpr;
      uniform float uRadius;
      varying float vAlpha;
      varying float vLife;
      void main() {
        float group = floor(aSeed * 4.0);
        float phase = fract(uTime * 0.18 + group * 0.25);
        float burst = smoothstep(0.0, 0.035, phase) * (1.0 - smoothstep(0.15, 0.23, phase));
        float expand = clamp(phase / 0.23, 0.0, 1.0);
        float r = uRadius * (1.02 + expand * (1.7 + aSeed * 1.1));
        float swirl = expand * (0.55 + aSeed * 1.3) + group * 1.7;
        vec3 dir = aDir;
        float c = cos(swirl), s = sin(swirl);
        vec3 tangent = normalize(cross(dir, vec3(0.0, 1.0, 0.0)) + vec3(0.001));
        vec3 side = normalize(cross(dir, tangent));
        vec3 p = dir * r + (tangent * c + side * s) * (r * 0.055 * expand);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = clamp(aSize * uDpr * (5.0 + expand * 8.0) / max(-mv.z, 0.5), 2.4, 26.0) * (0.55 + burst * 0.9);
        vAlpha = burst * (1.0 - expand * 0.5) * (0.9 + aSeed * 0.8);
        vLife = expand;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColorA;
      uniform vec3 uColorB;
      varying float vAlpha;
      varying float vLife;
      void main() {
        vec2 p = gl_PointCoord - 0.5;
        float d = length(p);
        if (d > 0.5) discard;
        vec3 color = mix(uColorA, uColorB, smoothstep(0.0, 1.0, vLife));
        float a = smoothstep(0.5, 0.0, d) * vAlpha;
        gl_FragColor = vec4(color, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geometry, material);
  points.name = 'solar-wind';
  points.frustumCulled = false;
  return { object: points, material };
}

function makeStormRings(radius) {
  const group = new THREE.Group();
  group.name = 'solar-storm-rings';
  const rings = [];
  for (let i = 0; i < 3; i += 1) {
    const material = new THREE.MeshBasicMaterial({
      color: i === 1 ? '#ffd9a0' : '#ff9a4a',
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radius * 1.2, radius * 0.006, 5, 128), material);
    ring.rotation.set(0.7 + i * 0.55, i * 0.9, 0.35 + i * 0.4);
    ring.userData.phaseOffset = i * 0.25;
    group.add(ring);
    rings.push(ring);
  }
  group.userData.rings = rings;
  return group;
}

function makeProminences(radius) {
  const group = new THREE.Group();
  group.name = 'solar-prominences';
  const materials = [];
  const random = mulberry32(7719);
  for (let i = 0; i < 5; i += 1) {
    const u = random() * 2 - 1;
    const phi = random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const base = new THREE.Vector3(Math.cos(phi) * s, u, Math.sin(phi) * s).normalize();
    const tangent = new THREE.Vector3().crossVectors(base, new THREE.Vector3(0, 1, 0));
    if (tangent.lengthSq() < 1e-4) tangent.set(1, 0, 0);
    tangent.normalize();
    const side = new THREE.Vector3().crossVectors(base, tangent).normalize();
    const points = [];
    const arc = 0.55 + random() * 0.45;
    for (let j = 0; j <= 20; j += 1) {
      const t = j / 20;
      const angle = t * arc;
      const lift = Math.sin(Math.PI * t) * (0.1 + random() * 0.055);
      const p = base
        .clone()
        .multiplyScalar(radius * 1.012)
        .add(tangent.clone().multiplyScalar(radius * 0.18 * Math.cos(angle)))
        .add(side.clone().multiplyScalar(radius * 0.1 * Math.sin(angle * 2)));
      p.addScaledVector(base, radius * lift);
      points.push(p);
    }
    const curve = new THREE.CatmullRomCurve3(points);
    const material = new THREE.MeshBasicMaterial({
      color: random() > 0.5 ? '#ff6a1a' : '#ffb347',
      transparent: true,
      opacity: 0.3 + random() * 0.18,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: true,
    });
    material.userData.baseOpacity = material.opacity;
    const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 28, radius * 0.007, 6, false), material);
    mesh.userData.phase = random() * Math.PI * 2;
    group.add(mesh);
    materials.push(material);
  }
  group.userData.materials = materials;
  return group;
}

function makeSolarBurstRays(radius, count = 180) {
  const positions = new Float32Array(count * 2 * 3);
  const dirs = new Float32Array(count * 2 * 3);
  const ends = new Float32Array(count * 2);
  const seeds = new Float32Array(count * 2);
  const groups = new Float32Array(count * 2);
  const directions = [];
  const axes = [
    new THREE.Vector3(-1, 0.18, 0.3).normalize(),
    new THREE.Vector3(-0.75, 0.45, -0.1).normalize(),
    new THREE.Vector3(-0.25, -0.55, 0.6).normalize(),
    new THREE.Vector3(-0.2, -0.2, -1).normalize(),
  ];
  for (let i = 0; i < count; i += 1) {
    const group = i % 4;
    const axis = axes[group];
    const dir = axis.clone().add(new THREE.Vector3(
      (Math.random() * 2 - 1) * 0.4,
      (Math.random() * 2 - 1) * 0.4,
      (Math.random() * 2 - 1) * 0.4,
    )).normalize();
    const seed = Math.random();
    directions.push(dir);
    for (let k = 0; k < 2; k += 1) {
      const index = i * 2 + k;
      dirs.set([dir.x, dir.y, dir.z], index * 3);
      ends[index] = k;
      seeds[index] = seed;
      groups[index] = group;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aDir', new THREE.BufferAttribute(dirs, 3));
  geometry.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  geometry.setAttribute('aGroup', new THREE.BufferAttribute(groups, 1));
  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uRadius: { value: radius } },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uRadius;
      attribute vec3 aDir;
      attribute float aEnd;
      attribute float aSeed;
      attribute float aGroup;
      varying float vAlpha;
      varying float vTone;
      void main() {
        float phase = fract(uTime * 0.18 + aGroup * 0.25);
        float burst = smoothstep(0.015, 0.055, phase) * (1.0 - smoothstep(0.15, 0.26, phase));
        float travel = smoothstep(0.015, 0.24, phase) * (0.55 + aSeed * 0.55);
        float extent = 1.01 + travel * aEnd;
        vec3 p = aDir * uRadius * extent;
        vAlpha = burst * mix(1.0, 0.2, aEnd) * (0.65 + aSeed * 0.35);
        vTone = aSeed;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      varying float vTone;
      void main() {
        if (vAlpha < 0.005) discard;
        vec3 color = mix(vec3(1.0, 0.45, 0.16), vec3(1.0, 0.82, 0.44), vTone);
        gl_FragColor = vec4(color, vAlpha * 0.55);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(geometry, material);
  lines.frustumCulled = false;
  return lines;
}

function makeCoronaStreamers(radius, count = 110) {
  const positions = new Float32Array(count * 2 * 3);
  const colors = new Float32Array(count * 2 * 3);
  let state = 20261114;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  for (let i = 0; i < count; i += 1) {
    const u = random() * 2 - 1;
    const phi = random() * TAU;
    const s = Math.sqrt(1 - u * u);
    const dir = new THREE.Vector3(Math.cos(phi) * s, u, Math.sin(phi) * s).normalize();
    const tangent = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0));
    if (tangent.lengthSq() < 1e-4) tangent.set(1, 0, 0);
    tangent.normalize();
    const len = radius * (0.35 + random() * 1.25);
    const start = dir.clone().multiplyScalar(radius * 1.01);
    const end = start.clone().addScaledVector(dir, len).addScaledVector(tangent, len * 0.13);
    const base = 0.5 + random() * 0.5;
    positions.set([start.x, start.y, start.z], i * 6);
    positions.set([end.x, end.y, end.z], i * 6 + 3);
    colors.set([1.0 * base, 0.35 * base, 0.05 * base], i * 6);
    colors.set([0.0, 0.0, 0.0], i * 6 + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.4,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const lines = new THREE.LineSegments(geometry, material);
  lines.name = 'sun-corona-streamers';
  lines.frustumCulled = false;
  return lines;
}

function makePlasmaPlumeTexture(seed = 1) {
  if (typeof document === 'undefined') return null;
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  let state = seed * 9973 + 17;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const baseX = size * 0.28;
  const baseY = size * 0.93;
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 150; i += 1) {
    const t = random();
    const startX = baseX + (random() - 0.5) * size * 0.16;
    const startY = baseY - random() * size * 0.08;
    const cp1x = baseX + (random() - 0.5) * size * 0.35;
    const cp1y = baseY - size * (0.2 + random() * 0.25);
    const cp2x = baseX + (random() - 0.25) * size * 0.55;
    const cp2y = baseY - size * (0.45 + random() * 0.3);
    const endX = baseX + (random() - 0.3) * size * 0.75;
    const endY = baseY - size * (0.5 + random() * 0.55);
    const grad = ctx.createLinearGradient(startX, startY, endX, endY);
    grad.addColorStop(0, `rgba(255, 205, 120, ${0.06 + t * 0.18})`);
    grad.addColorStop(0.35, `rgba(255, 130, 38, ${0.05 + t * 0.16})`);
    grad.addColorStop(1, 'rgba(255, 55, 8, 0)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1.2 + random() * 7.5;
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, endX, endY);
    ctx.stroke();
  }
  const core = ctx.createRadialGradient(baseX, baseY, 0, baseX, baseY, size * 0.22);
  core.addColorStop(0, 'rgba(255, 245, 210, .65)');
  core.addColorStop(0.25, 'rgba(255, 180, 70, .28)');
  core.addColorStop(1, 'rgba(255, 80, 10, 0)');
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeSolarPlumes(radius) {
  const group = new THREE.Group();
  group.name = 'solar-plumes';
  const specs = [
    { x: -1.3, y: 0.02, scale: 2.2, opacity: 0.5, seed: 1, rotation: Math.PI / 2 - 0.08 },
    { x: 1.3, y: -0.04, scale: 1.45, opacity: 0.24, seed: 7, rotation: -Math.PI / 2 + 0.1 },
  ];
  for (const spec of specs) {
    const texture = makePlasmaPlumeTexture(spec.seed);
    if (!texture) continue;
    const material = new THREE.SpriteMaterial({
      map: texture,
      color: '#ffb25a',
      transparent: true,
      opacity: spec.opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.position.set(radius * spec.x, radius * spec.y, 0);
    sprite.scale.set(radius * spec.scale, radius * spec.scale, 1);
    sprite.material.rotation = spec.rotation;
    sprite.userData.baseRotation = spec.rotation;
    sprite.userData.baseOpacity = spec.opacity;
    sprite.userData.seed = spec.seed;
    group.add(sprite);
  }
  return group;
}

function makeSolarFlare(radius) {
  const group = new THREE.Group();
  group.name = 'solar-flare';
  const count = 3;
  for (let i = 0; i < count; i += 1) {
    const material = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uSeed: { value: i * 3.7 } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uSeed;
        varying vec2 vUv;
        float hash(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }
        float noise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
                     mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        float fbm(vec2 p) {
          float value = 0.0;
          float amp = 0.5;
          for (int i = 0; i < 4; i++) {
            value += amp * noise(p);
            p = p * 2.03 + 4.1;
            amp *= 0.5;
          }
          return value;
        }
        void main() {
          float t = uTime + uSeed;
          float u = clamp(vUv.x, 0.0, 1.0);
          float v = abs(vUv.y - 0.5) * 2.0;
          float flow = fbm(vec2(u * 7.0 - t * 0.24, (vUv.y - 0.5) * 5.0 + t * 0.08));
          float tongues = fbm(vec2(u * 17.0 - t * 0.62, (vUv.y - 0.5) * 11.0 + t * 0.2));
          float body = smoothstep(1.0, 0.08, u) * smoothstep(1.0, 0.02, v);
          float streak = smoothstep(0.30, 0.92, flow + 0.34 * sin(vUv.y * 22.0 + t * 2.1));
          float alpha = body * (0.18 + streak * 0.55 + tongues * 0.2);
          vec3 color = mix(vec3(1.0, 0.18, 0.015), vec3(1.0, 0.56, 0.08), flow);
          color = mix(color, vec3(1.0, 0.86, 0.42), streak * 0.75);
          gl_FragColor = vec4(color, alpha * 0.82);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2.0, radius * 1.35, 1, 1), material);
    plane.position.set(-radius * 1.22, radius * 0.05, 0);
    plane.rotation.z = Math.PI - 0.16 + i * 0.16;
    plane.userData.seed = i;
    plane.onBeforeRender = (renderer, scene, camera) => {
      plane.quaternion.copy(camera.quaternion);
    };
    group.add(plane);
  }
  group.userData.materials = group.children.map((child) => child.material);
  return group;
}


function makeCME(radius) {
  const count = 6800;
  let a = 0x9e3779b9;
  const random = () => {
    a ^= a << 13; a >>>= 0; a ^= a >>> 17; a ^= a << 5; a >>>= 0;
    return a / 4294967296;
  };
  const p0 = new THREE.Vector3(-radius * 0.98, radius * 0.04, radius * 0.16);
  const p1 = new THREE.Vector3(-radius * 1.48, radius * 0.18, radius * 0.3);
  const p2 = new THREE.Vector3(-radius * 3.1, radius * 0.72, radius * 0.52);
  const tangent = p2.clone().sub(p0).normalize();
  const normal = new THREE.Vector3(0, 1, 0).cross(tangent).normalize();
  const binormal = tangent.clone().cross(normal).normalize();

  const positions = new Float32Array(count * 3);
  const aT = new Float32Array(count);
  const aRad = new Float32Array(count);
  const aTheta = new Float32Array(count);
  const aSeed = new Float32Array(count);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);

  for (let i = 0; i < count; i += 1) {
    const t = Math.pow(random(), 1.75);
    const theta = random() * Math.PI * 2;
    const rad = Math.sqrt(random()) * (0.05 + t * 0.62) * radius;
    const curve = new THREE.QuadraticBezierCurve3(p0, p1, p2).getPoint(t);
    positions[i * 3] = curve.x;
    positions[i * 3 + 1] = curve.y;
    positions[i * 3 + 2] = curve.z;
    aT[i] = t;
    aRad[i] = rad;
    aTheta[i] = theta;
    aSeed[i] = random();
    sizes[i] = (1.1 + random() * 2.6) * (1.0 - t * 0.55);
    const heat = Math.max(0, 1 - t * 1.35);
    colors[i * 3] = 1.0;
    colors[i * 3 + 1] = 0.34 + heat * 0.58;
    colors[i * 3 + 2] = 0.08 + heat * 0.42;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
  geometry.setAttribute('aRad', new THREE.BufferAttribute(aRad, 1));
  geometry.setAttribute('aTheta', new THREE.BufferAttribute(aTheta, 1));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(aSeed, 1));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uDpr: { value: 1 },
      uP0: { value: p0 },
      uP1: { value: p1 },
      uP2: { value: p2 },
      uTangent: { value: tangent },
      uNormal: { value: normal },
      uBinormal: { value: binormal },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uDpr;
      uniform vec3 uP0;
      uniform vec3 uP1;
      uniform vec3 uP2;
      uniform vec3 uTangent;
      uniform vec3 uNormal;
      uniform vec3 uBinormal;
      attribute float aT;
      attribute float aRad;
      attribute float aTheta;
      attribute float aSeed;
      attribute vec3 aColor;
      attribute float aSize;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        float t = fract(aT + uTime * 0.032);
        vec3 p = mix(mix(uP0, uP1, t), mix(uP1, uP2, t), t);
        float radial = aRad * (0.72 + 0.55 * t);
        vec3 offset = (uNormal * cos(aTheta) + uBinormal * sin(aTheta)) * radial;
        p += offset;
        p += uTangent * sin(uTime * 1.7 + aSeed * 18.0) * 0.025;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(aSize * uDpr * (2.6 + t * 3.8) / max(-mv.z, 0.5), 1.4, 16.0);
        vColor = aColor;
        vAlpha = (1.0 - smoothstep(0.62, 1.0, t)) * (0.4 + 0.5 * (1.0 - aT));
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float d = dot(p, p);
        if (d > 1.0) discard;
        float alpha = smoothstep(1.0, 0.0, d) * vAlpha;
        gl_FragColor = vec4(vColor, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.name = 'sun-cme';

  const group = new THREE.Group();
  group.name = 'sun-cme-group';
  group.add(points);

  const mistA = createGlowSprite('#ff8a38', 0.1);
  mistA.scale.setScalar(radius * 1.25);
  mistA.position.set(-radius * 1.32, radius * 0.24, radius * 0.32);
  group.add(mistA);
  const mistB = createGlowSprite('#ffb05c', 0.075);
  mistB.scale.setScalar(radius * 1.05);
  mistB.position.set(-radius * 1.9, radius * 0.42, radius * 0.4);
  group.add(mistB);

  const ropeCurve = new THREE.CatmullRomCurve3([p0, p1, p2], false, 'catmullrom', 0.4);
  const ropeMat = new THREE.MeshBasicMaterial({
    color: '#ffb15a',
    transparent: true,
    opacity: 0.055,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  // Keep the magnetic rope implicit in the particle cloud; a solid tube reads as a column.
  void ropeMat;

  const core = createGlowSprite('#fff3cf', 0.55);
  core.scale.setScalar(radius * 0.72);
  core.position.copy(p0);
  core.material.depthTest = false;
  group.add(core);

  return { object: group, material, core, radius };
}

function makeSun(radius) {
  const sun = createTexturedSun(radius);
  sun.sphere.visible = true;
  sun.sphere.scale.setScalar(1);
  if (sun.halo) sun.halo.visible = false;
  if (sun.corona) sun.corona.visible = true;

  const glow = createGlowSprite('#ffcf7a', 0.12);
  glow.scale.setScalar(radius * 2.2);
  glow.material.depthTest = false;
  glow.renderOrder = 2;
  sun.group.add(glow);
  sun.softGlow = glow;

  sun.data = SUN;
  sun.id = 'sun';
  sun.spinRad = Math.PI;
  return sun;
}

/** Keep the physical sphere for occlusion, but render the body as particles. */
function addParticleShell(realistic, planet, radius, requestedCount, runtime) {
  const dark = new THREE.Color(planet.palette?.base || planet.palette?.dark || '#101018').multiplyScalar(0.48);
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 0.94, 32, 24),
    new THREE.MeshBasicMaterial({ color: dark, toneMapped: false, transparent: true, opacity: 0.18, depthWrite: false }),
  );
  core.name = `core-${planet.id}`;
  realistic.group.add(core);

  const count = Math.max(1600, Math.round(requestedCount * 1.0));
  const field = makePlanetField(planet, count, radius * 1.006, {
    seed: 311 + planet.nameEn.length * 17,
  });
  field.object.material.uniforms.uPointSize.value = 1.35;
  realistic.spinGroup.add(field.object);

  realistic.sphere.visible = false;
  if (realistic.clouds) realistic.clouds.visible = false;
  if (realistic.atmosphere) realistic.atmosphere.visible = false;
  if (realistic.atmosphereOuter) realistic.atmosphereOuter.visible = false;

  let ring = null;
  const ringCount = CONFIG.particles.rings[planet.id];
  if (ringCount && realistic.ring) {
    realistic.ring.visible = false;
    const scaledRing = Math.max(800, Math.round(ringCount * Math.min(1, runtime.totalParticles / CONFIG.particles.desktop)));
    ring = makeRingField(planet, scaledRing, radius, { seed: 23 + planet.nameEn.length });
    if (ring) realistic.tiltGroup.add(ring.object);
  }

  return { core, field, ring };
}

function makePlanet(planet, { date, mode, countFactor = 1, runtime }) {
  const radius = displayRadius(planet.radiusKm);
  const particleCount = Math.max(
    600,
    Math.round((CONFIG.particles.bodies[planet.id] || 8000) * countFactor),
  );
  const realistic = createRealisticPlanet(planet, radius, {
    particleCount,
    seed: 311 + planet.nameEn.length * 17,
  });
  const orbitGroup = realistic.group;
  const position = new THREE.Vector3();
  const orbitLine = makeOrbitLine(
    makeOrbitPoints(planet, date, mode),
    planet.palette?.accent || '#7fd9ff',
    planet.id === 'earth' ? 0.26 : 0.19,
  );
  orbitLine.object.name = `orbit-${planet.id}`;

  return {
    ...realistic,
    data: planet,
    id: planet.id,
    radius,
    count: realistic.particleCount,
    group: orbitGroup,
    orbitLine,
    position,
    spinRad: 0,
    visibility: 1,
    get worldPosition() {
      return orbitGroup.position;
    },
  };
}

export function createSolarBodies({ scene, runtime, date, scaleMode = 'demo' }) {
  const root = new THREE.Group();
  root.name = 'solar-bodies';
  scene.add(root);

  const budget = runtime?.totalParticles ?? CONFIG.particles.desktop;
  const countFactor = Math.max(0.0001, budget / CONFIG.particles.desktop);
  const scaled = (count) => Math.max(1, Math.round(count * countFactor));

  const sunRadius = CONFIG.scale.sunRadius;
  const sun = makeSun(sunRadius);
  root.add(sun.group);

  const stars = makeStarField(scaled(CONFIG.particles.stars), { radius: CONFIG.scene.starRadius, seed: 811 });
  scene.add(stars.object);

  const JUPITER_MOONS = [
    { id: 'io', zh: '木卫一', radiusKm: 1821.6, color: '#f4dfa0', orbitR: 1.36, period: 7.2, phase: 0.9 },
    { id: 'europa', zh: '木卫二', radiusKm: 1560.8, color: '#eef8ff', orbitR: 1.66, period: 13.0, phase: 2.2 },
    { id: 'ganymede', zh: '木卫三', radiusKm: 2634.1, color: '#d6c9b2', orbitR: 1.96, period: 25.0, phase: 4.1 },
    { id: 'callisto', zh: '木卫四', radiusKm: 2410.3, color: '#b8aa96', orbitR: 2.26, period: 52.0, phase: 5.3 },
  ];

  const planets = [];
  for (const planet of PLANETS) {
    const body = makePlanet(planet, { date, mode: scaleMode, countFactor, runtime });
    root.add(body.group);
    root.add(body.orbitLine.object);
    planets.push(body);
  }

  const jupiterBody = planets.find((body) => body.id === 'jupiter');
  const jupiterMoons = [];
  const jupiterMoonOrbits = [];
  if (jupiterBody) {
    for (const moonDef of JUPITER_MOONS) {
      const moonRadius = jupiterBody.radius * (moonDef.radiusKm / 69911) * 1.6;
      const moonBody = createRealisticPlanet(
        { id: moonDef.id, nameZh: moonDef.zh, nameEn: moonDef.id, palette: { light: moonDef.color }, obliquityDeg: 0 },
        moonRadius,
        { textureId: 'moon', tint: moonDef.color, seed: 700 + jupiterMoons.length },
      );
      moonBody.group.name = `jupiter-moon-${moonDef.id}`;
      moonBody.material.uniforms.uAmbient.value = 0.24;
      jupiterBody.group.add(moonBody.group);
      const orbitRadius = jupiterBody.radius * moonDef.orbitR;
      const orbitPoints = [];
      for (let i = 0; i <= 128; i += 1) {
        const ang = (i / 128) * TAU;
        orbitPoints.push(new THREE.Vector3(
          Math.cos(ang) * orbitRadius,
          Math.sin(ang) * orbitRadius * 0.22,
          Math.sin(ang) * orbitRadius * 0.975,
        ));
      }
      const moonOrbit = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(orbitPoints),
        new THREE.LineBasicMaterial({
          color: '#9fb7d8',
          transparent: true,
          opacity: 0.16,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      moonOrbit.visible = false;
      jupiterBody.group.add(moonOrbit);
      jupiterMoonOrbits.push(moonOrbit);
      jupiterMoons.push({
        ...moonDef,
        body: moonBody,
        radius: moonRadius,
        orbitRadius,
        angle: moonDef.phase,
      });
    }
  }

  const earth = planets.find((body) => body.id === 'earth');
  const earthLayers = earth ? createEarthLayers(earth) : null;
  if (earthLayers && earth) earth.tiltGroup.add(earthLayers.group);

  // The Moon is intentionally not part of the planet rail / fist-swipe cycle.
  // It lives in Earth's local frame and is only reachable from Earth's close-up.
  let moon = null;
  if (earth) {
    const moonRadius = displayRadius(MOON.radiusKm) * 0.42;
    const moonReal = createRealisticPlanet(MOON, moonRadius, {
      particleCount: 0,
      seed: 384400,
    });
    const orbitRadius = earth.radius * 8.5;
    const orbitPoints = [];
    for (let i = 0; i <= 128; i += 1) {
      const angle = (i / 128) * TAU;
      orbitPoints.push(new THREE.Vector3(
        Math.cos(angle) * orbitRadius,
        Math.sin(angle) * orbitRadius * Math.sin(5.14 * DEG),
        Math.sin(angle) * orbitRadius,
      ));
    }
    const moonOrbit = makeOrbitLine(orbitPoints, '#c9d4e6', 0.12);
    moonOrbit.object.name = 'orbit-moon';
    earth.group.add(moonOrbit.object);
    earth.group.add(moonReal.group);
    moon = {
      ...moonReal,
      data: MOON,
      id: 'moon',
      parentId: 'earth',
      radius: moonRadius,
      orbitRadius,
      orbitAngle: 0.8,
      orbitLine: moonOrbit,
      count: 0,
      get worldPosition() {
        return moonReal.group.getWorldPosition(new THREE.Vector3());
      },
    };
    moon.group.position.set(
      Math.cos(moon.orbitAngle) * orbitRadius,
      Math.sin(moon.orbitAngle) * orbitRadius * Math.sin(5.14 * DEG),
      Math.sin(moon.orbitAngle) * orbitRadius,
    );
    moon.group.visible = false;
    moonOrbit.object.visible = false;
  }

  const comet = createComet({
    count: scaled(CONFIG.particles.comet ?? 12000),
    seed: 1997,
  });
  root.add(comet.group);
  const cometOrbit = makeOrbitLine(makeOrbitPoints(COMET, date, scaleMode), '#9fe8ff', 0.12);
  cometOrbit.object.name = 'orbit-halley';
  root.add(cometOrbit.object);

  const beltRadius = (au) => displayDistanceAU(au, scaleMode);
  const asteroidBelt = makeBeltField({
    count: scaled(CONFIG.particles.belts.asteroid),
    innerAU: 2.05,
    outerAU: 3.35,
    heightAU: 0.12,
    radiusForAU: beltRadius,
    speedScale: 0.85,
    seed: 941,
    palette: ['#7d6c58', '#a08a6e', '#50473d'],
  });
  root.add(asteroidBelt.object);

  const kuiperBelt = makeBeltField({
    count: scaled(CONFIG.particles.belts.kuiper),
    innerAU: 29.5,
    outerAU: 49.5,
    heightAU: 0.62,
    radiusForAU: beltRadius,
    speedScale: 0.33,
    seed: 509,
    palette: ['#536071', '#7e8a9b', '#39424e'],
  });
  root.add(kuiperBelt.object);

  const belts = { asteroid: asteroidBelt, kuiper: kuiperBelt };
  const allMaterialRefs = [];
  const collectMaterials = (obj) => {
    obj.traverse((child) => {
      if (child.material && child.material.uniforms) allMaterialRefs.push(child.material);
    });
  };
  collectMaterials(sun.group);
  collectMaterials(comet.group);
  planets.forEach((body) => {
    collectMaterials(body.group);
    collectMaterials(body.orbitLine.object);
  });
  if (moon) collectMaterials(moon.group);
  collectMaterials(stars.object);
  collectMaterials(asteroidBelt.object);
  collectMaterials(kuiperBelt.object);

  const tmpSunDir = new THREE.Vector3();
  const tmpMoonPos = new THREE.Vector3();
  const tmpMoonSunDir = new THREE.Vector3();
  const state = {
    root,
    sun,
    sunRadius,
    planets,
    planetById: new Map([
      ['sun', sun],
      ...planets.map((body) => [body.id, body]),
      ...(moon ? [['moon', moon]] : []),
    ]),
    moon,
    comet,
    cometOrbit,
    earthLayers,
    stars,
    belts,
    scaleMode,
    focusId: null,
    elapsed: 0,
    starTime: 0,
    orbitVisibility: new Map(planets.map((body) => [body.id, true])),
    allMaterialRefs,
  };

  function updateBodyPosition(body, dateValue) {
    const posAU = orbitalPositionAU(body.data, dateValue);
    const scenePos = heliocentricToScene(posAU, state.scaleMode);
    body.position.set(scenePos.x, scenePos.y, scenePos.z);
    body.group.position.copy(body.position);
    return scenePos;
  }

  function updateFocusVisibility() {
    const focused = state.focusId;
    for (const body of planets) {
      const isFocus = focused === body.id;
      const earthBackdrop = body.id === 'earth' && focused === 'moon';
      body.group.visible = focused ? (isFocus || earthBackdrop) : true;
      body.orbitLine.object.visible = !focused && state.orbitVisibility.get(body.id) !== false;
    }
    for (const moon of jupiterMoons) {
      moon.body.group.visible = !focused || focused === 'jupiter';
    }
    for (const orbitLine of jupiterMoonOrbits) {
      orbitLine.visible = focused === 'jupiter';
    }
    if (moon) {
      moon.group.visible = focused === 'earth' || focused === 'moon';
      moon.orbitLine.object.visible = focused === 'earth';
    }
    sun.group.visible = !focused || focused === 'sun';
    if (sun.cme) sun.cme.object.visible = focused === 'sun';
    if (sun.dust) sun.dust.visible = focused === 'sun';
    if (sun.cme) sun.cme.core.visible = focused === 'sun';
    comet.group.visible = !focused || focused === 'halley';
    cometOrbit.object.visible = !focused && state.orbitVisibility.get('halley') !== false;
    belts.asteroid.object.visible = !focused;
    belts.kuiper.object.visible = !focused;
    stars.object.visible = false;
  }

  function setFocus(id) {
    state.focusId = id || null;
    updateFocusVisibility();
  }

  function setOverview() {
    setFocus(null);
  }

  function updateCometPosition(dateValue) {
    const posAU = orbitalPositionAU(COMET, dateValue);
    const scenePos = heliocentricToScene(posAU, state.scaleMode);
    comet.group.position.set(scenePos.x, scenePos.y, scenePos.z);
    return { scenePos, rAU: Math.hypot(posAU.x, posAU.y, posAU.z) };
  }

  function setScaleMode(mode) {
    if (!DISTANCE_SCALES[mode] || mode === state.scaleMode) return;
    state.scaleMode = mode;
    // Recompute orbit lines and current positions.
    for (const body of planets) {
      setOrbitGeometry(body.orbitLine.object, makeOrbitPoints(body.data, state.date || date, mode));
      updateBodyPosition(body, state.date || date);
    }
    belts.asteroid.setScaleMode((au) => displayDistanceAU(au, mode));
    belts.kuiper.setScaleMode((au) => displayDistanceAU(au, mode));
    setOrbitGeometry(cometOrbit.object, makeOrbitPoints(COMET, state.date || date, mode));
    updateCometPosition(state.date || date);
  }

  function bodyWorldPosition(id) {
    if (id === 'sun') return sun.group.position;
    if (id === 'halley') return comet.group.position;
    if (id === 'moon' && moon) return moon.group.getWorldPosition(new THREE.Vector3());
    const body = state.planetById.get(id);
    return body ? body.group.position : null;
  }

  function update({ date: dateValue, dt, elapsed, daysPerSecond = CONFIG.time.defaultDaysPerSecond }) {
    state.date = dateValue;
    state.elapsed = elapsed;
    state.starTime += dt;

    for (const body of planets) {
      updateBodyPosition(body, dateValue);
      const spinSeconds = state.focusId
        ? CONFIG.time.focusSecondsPerDay * Math.max(0.1, Math.abs(body.data.rotationHours) / 24)
        : 60;
      body.spinRad += dt * (TAU / Math.max(4, spinSeconds)) * (body.data.rotationHours < 0 ? -1 : 1);
      body.spinGroup.rotation.y = body.spinRad;

      // Sun direction in world space (body -> sun).
      if (body.position.lengthSq() > 1e-8) {
        tmpSunDir.copy(body.position).multiplyScalar(-1).normalize();
      } else {
        tmpSunDir.set(0, 1, 0);
      }
      updateRealisticBody(body, {
        sunDir: tmpSunDir,
        dpr: runtime.dpr,
        time: elapsed,
        focus: state.focusId === body.id,
      });
      if (body.field?.material?.uniforms) {
        const u = body.field.material.uniforms;
        if (u.uTime) u.uTime.value = elapsed;
        if (u.uDpr) u.uDpr.value = runtime.dpr;
        if (u.uSunDir) u.uSunDir.value.copy(tmpSunDir);
      }
      if (body.particleRing?.material?.uniforms) {
        const u = body.particleRing.material.uniforms;
        if (u.uTime) u.uTime.value = elapsed;
        if (u.uDpr) u.uDpr.value = runtime.dpr;
        if (u.uPlanetCenter) u.uPlanetCenter.value.copy(body.position);
        if (u.uPlanetRadius) u.uPlanetRadius.value = body.radius;
        if (u.uSunDir) u.uSunDir.value.copy(tmpSunDir);
      }
    }

    for (const moon of jupiterMoons) {
      moon.angle += dt * (TAU / moon.period);
      const cos = Math.cos(moon.angle);
      const sin = Math.sin(moon.angle);
      moon.body.group.position.set(cos * moon.orbitRadius, sin * moon.orbitRadius * 0.22, sin * moon.orbitRadius * 0.975);
      moon.body.spinGroup.rotation.y += dt * 0.4;
      moon.body.group.getWorldPosition(tmpMoonPos);
      tmpSunDir.copy(tmpMoonPos).multiplyScalar(-1).normalize();
      updateRealisticBody(moon.body, {
        sunDir: tmpSunDir,
        dpr: runtime.dpr,
        time: elapsed,
        focus: state.focusId === 'jupiter',
      });
    }

    // The Moon orbits in Earth's local frame. Its 27.3-day period is compressed
    // to a calm 40-second visual orbit so the Earth close-up stays learnable.
    if (moon && earth) {
      moon.orbitAngle += dt * (TAU / 40);
      moon.group.position.set(
        Math.cos(moon.orbitAngle) * moon.orbitRadius,
        Math.sin(moon.orbitAngle) * moon.orbitRadius * Math.sin(5.14 * DEG),
        Math.sin(moon.orbitAngle) * moon.orbitRadius,
      );
      moon.spinGroup.rotation.y = -moon.orbitAngle + Math.PI;
      moon.group.getWorldPosition(tmpMoonPos);
      tmpMoonSunDir.copy(tmpMoonPos).multiplyScalar(-1).normalize();
      updateRealisticBody(moon, {
        sunDir: tmpMoonSunDir,
        dpr: runtime.dpr,
        time: elapsed,
        focus: state.focusId === 'moon',
      });
    }

    // Sun turns slowly; its texture is emissive and the CME is animated in its own shader.
    sun.spinRad = (sun.spinRad || 0) + dt * (TAU / 40);
    sun.group.rotation.y = sun.spinRad;
    if (sun.field) {
      for (const material of sun.field.materials || []) {
        if (material.uniforms?.uTime) material.uniforms.uTime.value = elapsed;
        if (material.uniforms?.uDpr) material.uniforms.uDpr.value = runtime.dpr;
      }
    }
    if (sun.sphere?.material?.uniforms?.uTime) {
      sun.sphere.material.uniforms.uTime.value = elapsed;
    }
    if (sun.coronaLayers) {
      for (const layer of sun.coronaLayers) {
        if (layer.material?.uniforms?.uTime) layer.material.uniforms.uTime.value = elapsed;
      }
    }
    if (sun.flare) {
      for (const material of sun.flare.userData.materials || []) {
        if (material.uniforms?.uTime) material.uniforms.uTime.value = elapsed;
      }
    }
    const cometState = updateCometPosition(dateValue);
    const cometR = Math.max(0.5, cometState.rAU);
    tmpSunDir.copy(comet.group.position).multiplyScalar(-1).normalize();
    comet.update({
      time: elapsed,
      sunDir: tmpSunDir,
      activity: Math.min(1.5, Math.max(0.08, 1.6 / cometR)),
      focus: state.focusId === 'halley',
      dpr: runtime.dpr,
    });
    earthLayers?.update({
      time: elapsed,
      dpr: runtime.dpr,
      focus: state.focusId === 'earth',
      sunDir: earth
        ? new THREE.Vector3().copy(earth.group.position).multiplyScalar(-1).normalize()
        : null,
    });

    stars.material.uniforms.uTime.value = elapsed;
    stars.material.uniforms.uDpr.value = runtime.dpr;
    asteroidBelt.material.uniforms.uTime.value = elapsed * 0.13;
    asteroidBelt.material.uniforms.uDpr.value = runtime.dpr;
    kuiperBelt.material.uniforms.uTime.value = elapsed * 0.045;
    kuiperBelt.material.uniforms.uDpr.value = runtime.dpr;
  }

  function setPointScale() {
    // Surfaces are textured meshes now; particle point scale is handled by
    // the cloud/belt systems inside their own update.
  }

  function project(id, camera, width, height) {
    const isComet = id === 'halley';
    const isMoon = id === 'moon';
    const body = isComet || isMoon ? null : state.planetById.get(id);
    const target = id === 'sun'
      ? sun.group.position
      : isComet
        ? comet.group.position
        : isMoon
          ? moon?.group.getWorldPosition(new THREE.Vector3())
          : body?.group.position;
    if (!target) return null;
    const v = target.clone().project(camera);
    const x = (v.x * 0.5 + 0.5) * width;
    const y = (-v.y * 0.5 + 0.5) * height;
    const distance = camera.position.distanceTo(target);
    const radius = (id === 'sun' ? sunRadius : isComet ? 0.16 : isMoon ? moon.radius : body.radius)
      / (2 * Math.tan((camera.fov * DEG) / 2) * distance);
    return {
      x,
      y,
      z: v.z,
      visible: v.z > -1 && v.z < 1 && x > -80 && x < width + 80 && y > -80 && y < height + 80,
      screenRadius: radius * height,
    };
  }

  function raycastBody(raycaster, camera, width, height, ids = null) {
    let best = null;
    if (sun.group.visible && (!ids || ids.includes('sun'))) {
      const projected = project('sun', camera, width, height);
      if (projected?.visible) {
        const sphere = new THREE.Sphere(sun.group.position.clone(), sunRadius * 1.03);
        if (raycaster.ray.intersectsSphere(sphere)) {
          best = {
            id: 'sun',
            distance: raycaster.ray.origin.distanceTo(sphere.center),
            projected,
          };
        }
      }
    }
    for (const body of planets) {
      if (ids && !ids.includes(body.id)) continue;
      if (!body.group.visible) continue;
      const projected = project(body.id, camera, width, height);
      if (!projected || !projected.visible) continue;
      const sphere = new THREE.Sphere(body.group.position.clone(), Math.max(body.radius * 1.3, 0.16));
      if (raycaster.ray.intersectsSphere(sphere)) {
        if (!best || projected.z < best.z) best = { id: body.id, distance: raycaster.ray.origin.distanceTo(sphere.center), projected };
      }
    }
    if (moon && moon.group.visible && (!ids || ids.includes('moon'))) {
      const projected = project('moon', camera, width, height);
      if (projected?.visible) {
        const center = moon.group.getWorldPosition(new THREE.Vector3());
        const sphere = new THREE.Sphere(center, Math.max(moon.radius * 1.5, 0.07));
        if (raycaster.ray.intersectsSphere(sphere)) {
          best = {
            id: 'moon',
            distance: raycaster.ray.origin.distanceTo(sphere.center),
            projected,
          };
        }
      }
    }
    if ((!ids || ids.includes('halley')) && comet.group.visible) {
      const projected = project('halley', camera, width, height);
      if (projected?.visible) {
        const closest = raycaster.ray.closestPointToPoint(comet.group.position, new THREE.Vector3());
        const miss = closest.distanceTo(comet.group.position);
        const threshold = state.focusId === 'halley' ? 0.22 : Math.max(0.24, projected.screenRadius * 0.06);
        if (miss <= threshold) {
          best = { id: 'halley', distance: raycaster.ray.origin.distanceTo(comet.group.position), projected };
        }
      }
    }
    return best;
  }

  function setOrbitVisible(visible) {
    for (const body of planets) {
      state.orbitVisibility.set(body.id, Boolean(visible));
      body.orbitLine.object.visible = !state.focusId && Boolean(visible);
    }
    state.orbitVisibility.set('halley', Boolean(visible));
    cometOrbit.object.visible = !state.focusId && Boolean(visible);
  }

  function setEarthLayer(mode) {
    return earthLayers ? earthLayers.setMode(mode) : 'none';
  }

  function cycleEarthLayer() {
    return earthLayers ? earthLayers.cycle() : 'none';
  }

  function dispose() {
    scene.remove(root);
    scene.remove(stars.object);
    root.traverse((obj) => {
      obj.geometry?.dispose?.();
      if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose?.());
      else obj.material?.dispose?.();
    });
    stars.object.geometry.dispose();
    stars.object.material.dispose();
  }

  // Initial placement and visible state.
  for (const body of planets) {
    updateBodyPosition(body, date);
  }
  updateCometPosition(date);
  updateFocusVisibility();
  setScaleMode(scaleMode);

  return {
    state,
    root,
    sun,
    sunWind: sun.wind,
    stars,
    belts,
    planets,
    comet,
    cometOrbit,
    moon,
    planetById: state.planetById,
    sunRadius,
    setFocus,
    setOverview,
    setScaleMode,
    setPointScale,
    setOrbitVisible,
    setEarthLayer,
    cycleEarthLayer,
    earthLayers,
    update,
    project,
    raycastBody,
    bodyWorldPosition,
    dispose,
    get scaleMode() { return state.scaleMode; },
    get focusId() { return state.focusId; },
  };
}



