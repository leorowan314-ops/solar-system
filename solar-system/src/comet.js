/**
 * Halley's comet — a small nucleus, a dusty coma and two anti-solar tails.
 * The tail direction is recomputed every frame; lengths grow near perihelion.
 */

import * as THREE from 'three';

const TAU = Math.PI * 2;

export const COMET = Object.freeze({
  id: 'halley',
  number: 'C / 01',
  nameZh: '哈雷彗星',
  nameEn: 'HALLEY',
  symbol: '☄',
  type: 'comet',
  tagline: '每约 75 年回归一次的周期彗星，尘埃尾总是指向背离太阳的方向。',
  semiMajorAU: 17.834,
  eccentricity: 0.96714,
  inclinationDeg: 162.26,
  meanLongitudeDeg: 236.2,
  perihelionLongDeg: 169.75,
  nodeLongDeg: 58.42,
  rates: {
    semiMajorAU: 0,
    eccentricity: 0,
    inclinationDeg: 0,
    meanLongitudeDeg: 0,
    perihelionLongDeg: 0,
    nodeLongDeg: 0,
  },
  diameterKm: 11,
  perihelionAU: 0.586,
  aphelionAU: 35.08,
  orbitalPeriodYears: 75.3,
  lastPerihelion: '1986-02-09',
  nextPerihelion: '2061-07-28',
  nucleusTempC: -70,
  accent: '#9fe8ff',
  facts: [
    '哈雷彗星是人类第一颗预言回归并成功观测到的周期彗星。',
    '彗核平均直径约 11 km，像一块被冰和尘埃包裹的“脏雪球”。',
    '尘埃尾被太阳辐射压推向背离太阳的方向，因此尾巴总在太阳的反侧张开。',
    '上一次近日点是 1986 年 2 月 9 日，下一次将于 2061 年 7 月 28 日前后回归。',
    '哈雷彗星的轨道倾角约 162°，是一颗逆行彗星。',
  ],
});

function randomFactory(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeTail({ count, length, colorA, colorB, dust, seed, size = 1 }) {
  const random = randomFactory(seed);
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const sizes = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    const t = Math.pow(random(), 0.72);
    const z = 0.06 + t * length;
    const spread = (0.005 + z * (dust ? 0.03 : 0.018)) * (0.6 + random() * 0.8);
    const theta = random() * TAU;
    const curve = dust ? Math.sin(t * 4.2) * length * 0.055 + t * t * length * 0.08 : 0;
    positions[i * 3] = Math.cos(theta) * spread + curve;
    positions[i * 3 + 1] = Math.sin(theta) * spread + (dust ? Math.sin(t * 3.1) * length * 0.03 : 0);
    positions[i * 3 + 2] = z;
    seeds[i] = random();
    sizes[i] = (0.5 + random() * 1.1) * (dust ? 1.15 : 0.85) * size;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uDpr: { value: 1 },
      uColorA: { value: new THREE.Color(colorA) },
      uColorB: { value: new THREE.Color(colorB) },
      uOpacity: { value: dust ? 0.72 : 0.58 },
      uActivity: { value: 1 },
    },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      attribute float aSize;
      uniform float uTime;
      uniform float uDpr;
      uniform float uActivity;
      varying float vAlpha;
      varying float vT;
      void main() {
        vec3 p = position;
        float t = clamp(p.z / 2.6, 0.0, 1.0);
        p.z *= uActivity;
        p.x *= uActivity * (0.7 + 0.3 * sin(uTime * 0.2 + aSeed * 8.0));
        p.y *= uActivity;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = clamp(aSize * uDpr * 9.0 / max(-mv.z, 0.45), 1.0, 4.2);
        vAlpha = (0.25 + aSeed * 0.75) * (1.0 - t * 0.55);
        vT = t;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColorA;
      uniform vec3 uColorB;
      uniform float uOpacity;
      varying float vAlpha;
      varying float vT;
      void main() {
        vec2 p = gl_PointCoord - 0.5;
        float d = length(p);
        if (d > 0.5) discard;
        float a = smoothstep(0.5, 0.0, d) * uOpacity * vAlpha;
        vec3 color = mix(uColorB, uColorA, smoothstep(0.0, 0.7, vT));
        gl_FragColor = vec4(color, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  return new THREE.Points(geometry, material);
}

function makeTailRibbon({ length, widthStart, widthEnd, color, opacity, dust = false, segments = 30 }) {
  const positions = [];
  const alphas = [];
  const indices = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const z = 0.04 + t * length;
    const width = widthStart + (widthEnd - widthStart) * Math.sqrt(t);
    const curve = dust ? Math.sin(t * 4.2) * length * 0.04 + t * t * length * 0.055 : 0;
    const yCurve = dust ? Math.sin(t * 3.1) * length * 0.018 : 0;
    positions.push(-width + curve, yCurve, z, width + curve, yCurve, z);
    const alpha = Math.pow(1 - t, 1.35) * (0.55 + 0.45 * (1 - t));
    alphas.push(alpha, alpha);
  }
  for (let i = 0; i < segments; i += 1) {
    const a = i * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aAlpha', new THREE.Float32BufferAttribute(alphas, 1));
  geometry.setIndex(indices);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: opacity },
    },
    vertexShader: /* glsl */ `
      attribute float aAlpha;
      varying float vAlpha;
      void main() {
        vAlpha = aAlpha;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vAlpha;
      void main() {
        gl_FragColor = vec4(uColor, vAlpha * uOpacity);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  return mesh;
}


export function createComet({ count = 9000, seed = 1234 } = {}) {
  const group = new THREE.Group();
  group.name = 'comet-halley';
  const radius = 0.07;

  const nucleus = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 16, 12),
    new THREE.MeshBasicMaterial({ color: '#b9c8d3', toneMapped: false }),
  );
  group.add(nucleus);

  const comaCount = Math.max(500, Math.round(count * 0.12));
  const comaPositions = new Float32Array(comaCount * 3);
  const comaSizes = new Float32Array(comaCount);
  const random = randomFactory(seed + 7);
  for (let i = 0; i < comaCount; i += 1) {
    const r = radius * (1.1 + Math.pow(random(), 0.6) * 4.2);
    const theta = random() * TAU;
    const phi = Math.acos(2 * random() - 1);
    comaPositions[i * 3] = Math.sin(phi) * Math.cos(theta) * r;
    comaPositions[i * 3 + 1] = Math.cos(phi) * r;
    comaPositions[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * r;
    comaSizes[i] = 0.6 + random() * 1.2;
  }
  const comaGeometry = new THREE.BufferGeometry();
  comaGeometry.setAttribute('position', new THREE.BufferAttribute(comaPositions, 3));
  comaGeometry.setAttribute('aSize', new THREE.BufferAttribute(comaSizes, 1));
  const comaMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uDpr: { value: 1 },
      uColor: { value: new THREE.Color('#d9f4ff') },
      uOpacity: { value: 0.52 },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      attribute float aSize;
      uniform float uDpr;
      uniform float uTime;
      varying float vAlpha;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = clamp(aSize * uDpr * 14.0 / max(-mv.z, 0.45), 1.0, 5.0);
        vAlpha = 0.35 + 0.65 * sin(uTime * 0.7 + aSize * 5.0) * 0.5 + 0.32;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vAlpha;
      void main() {
        vec2 p = gl_PointCoord - 0.5;
        float d = length(p);
        if (d > 0.5) discard;
        float a = smoothstep(0.5, 0.0, d) * uOpacity * vAlpha;
        gl_FragColor = vec4(uColor, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const coma = new THREE.Points(comaGeometry, comaMaterial);
  group.add(coma);

  const tailGroup = new THREE.Group();
  const ion = makeTail({
    count: Math.round(count * 0.44),
    length: 2.4,
    colorA: '#bfeaff',
    colorB: '#3a84c8',
    dust: false,
    seed: seed + 31,
  });
  const dust = makeTail({
    count: Math.round(count * 0.44),
    length: 2.0,
    colorA: '#ffe0ae',
    colorB: '#a76b43',
    dust: true,
    seed: seed + 73,
    size: 1.15,
  });
  const ionRibbon = makeTailRibbon({
    length: 3.2,
    widthStart: 0.012,
    widthEnd: 0.12,
    color: '#7fd9ff',
    opacity: 0.09,
  });
  const dustRibbon = makeTailRibbon({
    length: 2.9,
    widthStart: 0.02,
    widthEnd: 0.24,
    color: '#ffcf7a',
    opacity: 0.07,
    dust: true,
  });
  tailGroup.add(ionRibbon, dustRibbon, ion, dust);
  group.add(tailGroup);

  let activity = 1;
  let visibleTail = true;
  const antiSun = new THREE.Vector3(0, 0, 1);
  const forward = new THREE.Vector3(0, 0, 1);

  function update({ time = 0, sunDir = null, activity: nextActivity = 1, focus = false, dpr = 1 } = {}) {
    activity = Number.isFinite(nextActivity) ? nextActivity : 1;
    const visualActivity = focus ? Math.max(0.92, activity) : Math.max(0.32, activity);
    if (sunDir) {
      antiSun.copy(sunDir).multiplyScalar(-1);
      if (antiSun.lengthSq() > 1e-8) antiSun.normalize();
      group.quaternion.setFromUnitVectors(forward, antiSun);
    }
    comaMaterial.uniforms.uDpr.value = dpr;
    comaMaterial.uniforms.uTime.value = time;
    ion.material.uniforms.uTime.value = time;
    ion.material.uniforms.uDpr.value = dpr;
    ion.material.uniforms.uActivity.value = visualActivity;
    ion.material.uniforms.uOpacity.value = (visibleTail ? 0.56 : 0.1) * (focus ? 1.15 : 0.72);
    dust.material.uniforms.uTime.value = time;
    dust.material.uniforms.uDpr.value = dpr;
    dust.material.uniforms.uActivity.value = visualActivity * 0.9;
    dust.material.uniforms.uOpacity.value = (visibleTail ? 0.72 : 0.12) * (focus ? 1.05 : 0.7);
    ionRibbon.material.uniforms.uOpacity.value = (visibleTail ? 0.09 : 0.015) * (focus ? 1.15 : 0.55);
    dustRibbon.material.uniforms.uOpacity.value = (visibleTail ? 0.07 : 0.012) * (focus ? 1.1 : 0.5);
    ionRibbon.scale.z = Math.max(0.7, visualActivity);
    dustRibbon.scale.z = Math.max(0.7, visualActivity * 0.9);
    nucleus.material.color.set(focus ? '#e4f7ff' : '#aebfca');
  }

  return {
    group,
    nucleus,
    coma,
    ion,
    dust,
    ionRibbon,
    dustRibbon,
    tailGroup,
    data: COMET,
    id: 'halley',
    radius,
    get activity() { return activity; },
    setTailVisible(value) { visibleTail = Boolean(value); },
    update,
  };
}
