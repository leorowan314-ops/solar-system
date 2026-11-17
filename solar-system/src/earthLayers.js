/**
 * Earth's invisible structure, visualised for teaching:
 *   none -> dipole magnetic field -> Van Allen radiation belts -> none
 *
 * Both layers live under Earth's tilted group so they follow the planet's
 * 23.4掳 axial tilt. They are only shown in the Earth close-up.
 */

import * as THREE from 'three';

const DEG = Math.PI / 180;

export const EARTH_LAYER_MODES = Object.freeze(['none', 'magnetic', 'radiation']);

export const EARTH_LAYER_LABELS = Object.freeze({
  none: '原生态地球 · 1 指',
  magnetic: '地球磁场 · 2 指',
  radiation: '范艾伦辐射带 · 3 指',
});

function makeRadiationBelt(radius, { count, major, minor, color, colorB = color, seed = 1, opacity = 0.8 }) {
  let a = seed >>> 0;
  const random = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const sizes = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    const around = random() * Math.PI * 2;
    const tube = random() * Math.PI * 2;
    const r = radius * (major + minor * Math.cos(tube)) * (0.96 + random() * 0.08);
    const y = radius * minor * Math.sin(tube) * (0.86 + random() * 0.28);
    positions[i * 3] = Math.cos(around) * r;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = Math.sin(around) * r;
    seeds[i] = random();
    sizes[i] = 0.6 + Math.pow(random(), 1.6) * 1.9;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uDpr: { value: 1 },
      uColor: { value: new THREE.Color(color) },
      uColorB: { value: new THREE.Color(colorB) },
      uOpacity: { value: opacity },
    },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      attribute float aSize;
      uniform float uTime;
      uniform float uDpr;
      uniform float uOpacity;
      varying float vAlpha;
      void main() {
        vec3 p = position;
        float angle = uTime * (0.11 + aSeed * 0.16);
        float c = cos(angle);
        float s = sin(angle);
        p.xz = mat2(c, -s, s, c) * p.xz;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = clamp(aSize * uDpr * 2.6 / max(-mv.z, 0.4), 1.0, 4.2);
        vAlpha = (0.24 + aSeed * 0.76) * uOpacity;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform vec3 uColorB;
      varying float vAlpha;
      void main() {
        vec2 p = gl_PointCoord - 0.5;
        float d = length(p);
        if (d > 0.5) discard;
        float a = smoothstep(0.5, 0.0, d) * vAlpha;
        vec3 color = mix(uColor, uColorB, smoothstep(0.0, 1.0, vAlpha));
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
  points.name = `earth-radiation-${major}`;
  return points;
}

function makeAuroraCurtain(radius, ySign, color, colorB, seed = 1) {
  const group = new THREE.Group();
  group.name = ySign > 0 ? 'aurora-north' : 'aurora-south';
  const materials = [];
  const layers = [
    { polar: 0.44, height: 0.23, color, colorB, opacity: 1.0, seed },
    { polar: 0.50, height: 0.17, color: colorB, colorB: color, opacity: 0.7, seed: seed + 3.2 },
    { polar: 0.56, height: 0.11, color, colorB, opacity: 0.42, seed: seed + 7.4 },
  ];
  for (let layer = 0; layer < layers.length; layer += 1) {
    const cfg = layers[layer];
    const segments = 192;
    const rows = 4;
    const positions = [];
    const uvs = [];
    const indices = [];
    const sinP = Math.sin(cfg.polar);
    const cosP = Math.cos(cfg.polar);
    for (let i = 0; i <= segments; i += 1) {
      const theta = (i / segments) * Math.PI * 2;
      for (let row = 0; row <= rows; row += 1) {
        const t = row / rows;
        const rr = radius * (1.006 + t * cfg.height);
        positions.push(
          Math.cos(theta) * sinP * rr,
          ySign * cosP * rr,
          Math.sin(theta) * sinP * rr,
        );
        uvs.push(i / segments, t);
      }
    }
    for (let i = 0; i < segments; i += 1) {
      for (let row = 0; row < rows; row += 1) {
        const a = i * (rows + 1) + row;
        const b = (i + 1) * (rows + 1) + row;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uColorA: { value: new THREE.Color(cfg.color) },
        uColorB: { value: new THREE.Color(cfg.colorB) },
        uOpacity: { value: cfg.opacity },
        uSeed: { value: cfg.seed },
        uRadius: { value: radius },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        uniform float uTime;
        uniform float uSeed;
        uniform float uRadius;
        void main() {
          vUv = uv;
          vec3 p = position;
          vec3 n = normalize(p);
          float ang = uv.x * 6.2831853;
          float wave = sin(ang * 7.0 + uTime * 0.54 + uv.y * 4.0) * 0.022
                     + sin(ang * 13.0 - uTime * 0.37 + uSeed) * 0.009;
          p += n * wave * (0.6 + uv.y * 1.8) * (uRadius / 1.0);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform float uTime;
        uniform float uSeed;
        uniform vec3 uColorA;
        uniform vec3 uColorB;
        uniform float uOpacity;
        float hash(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
                     mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        float fbm(vec2 p) {
          float v = 0.0;
          float a = 0.5;
          for (int i = 0; i < 4; i++) {
            v += a * noise(p);
            p = p * 2.03 + vec2(7.1, 3.7);
            a *= 0.5;
          }
          return v;
        }
        void main() {
          float angle = vUv.x * 6.2831853;
          float vertical = smoothstep(0.0, 0.12, vUv.y) * (1.0 - smoothstep(0.55, 1.0, vUv.y));
          float waves = fbm(vec2(angle * 8.5 + uSeed, vUv.y * 3.2 - uTime * 0.42));
          float ribbons = 0.58 + 0.42 * sin(angle * 42.0 + uTime * 1.04 + waves * 6.0);
          float rays = pow(0.5 + 0.5 * sin(angle * 88.0 + uTime * 1.35 + waves * 7.0), 7.0);
          float alpha = vertical * (0.22 + waves * 0.60 + rays * 0.48) * (0.55 + ribbons * 0.55) * uOpacity;
          vec3 color = mix(uColorA, uColorB, smoothstep(0.3, 0.95, waves + vUv.y * 0.35));
          color += vec3(0.18, 0.86, 0.55) * rays * vertical * 0.8;
          color += vec3(0.04, 0.25, 0.15) * waves * vertical;
          gl_FragColor = vec4(color, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    materials.push(material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 4;
    group.add(mesh);
  }
  group.userData.materials = materials;
  return group;
}

function makeAuroraOval(radius, ySign, color, count = 1600, seed = 5) {
  let a = seed >>> 0;
  const random = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const seeds = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    const angle = random() * Math.PI * 2;
    const ring = radius * (0.43 + random() * 0.18);
    const y = radius * (ySign * (0.84 + random() * 0.12) + (random() - 0.5) * 0.05);
    positions[i * 3] = Math.cos(angle) * ring;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = Math.sin(angle) * ring * 0.7;
    sizes[i] = 0.4 + random() * 1.2;
    seeds[i] = random();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uDpr: { value: 1 },
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: 0.9 },
    },
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute float aSeed;
      uniform float uDpr;
      uniform float uTime;
      varying float vAlpha;
      void main() {
        vec3 p = position;
        float shimmer = 0.55 + 0.45 * sin(uTime * 1.1 + aSeed * 9.0);
        p.y += sin(uTime * 0.7 + aSeed * 6.0) * 0.006;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = clamp(aSize * uDpr * 3.0 / max(-mv.z, 0.4), 1.0, 4.5);
        vAlpha = (0.25 + aSeed * 0.75) * shimmer;
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
        gl_FragColor = vec4(uColor, smoothstep(0.5, 0.0, d) * vAlpha * uOpacity);
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

function makeBeltRibbon(radius, major, color, opacity) {
  const geometry = new THREE.TorusGeometry(radius * major, radius * 0.012, 6, 160);
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = Math.PI / 2;
  mesh.renderOrder = 1;
  return mesh;
}

function makeDotTexture() {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.24, 'rgba(255,255,255,0.85)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeDipoleField(radius) {
  const group = new THREE.Group();
  group.name = 'earth-magnetic-field';
  const dotTexture = makeDotTexture();
  const flows = [];

  // True dipole field lines r = R0 sin^2(theta): they leave one magnetic pole,
  // bow outward around the equator, and return to the other pole. Using only
  // four shells on two meridian planes keeps the cutaway readable.
  const shells = [1.55, 2.05, 2.6, 3.2];
  const planes = [0.34, Math.PI / 2 + 0.34];
  const palette = ['#8fe4ff', '#6fc8ff', '#a8eeff', '#5ab8f0'];
  const flowPalette = [new THREE.Color('#7fe4ff'), new THREE.Color('#b7a4ff'), new THREE.Color('#ffd08a')];

  shells.forEach((shell, shellIndex) => {
    const r0 = radius * shell;
    const thetaMin = Math.asin(Math.min(0.98, Math.sqrt(radius / r0)));
    planes.forEach((phi) => {
      const points = [];
      const steps = 110;
      for (let i = 0; i <= steps; i += 1) {
        const t = i / steps;
        const theta = thetaMin + (Math.PI - 2 * thetaMin) * t;
        const r = r0 * Math.sin(theta) ** 2;
        const axial = r * Math.cos(theta);
        const radial = r * Math.sin(theta);
        let x = radial * Math.cos(phi);
        const z = radial * Math.sin(phi);
        // Solar wind compresses the dayside and stretches the nightside.
        x = x >= 0 ? x * 0.48 : x * 2.1 - radius * 0.08;
        points.push(new THREE.Vector3(x, axial, z * 0.9));
      }
      const material = new THREE.LineBasicMaterial({
        color: palette[shellIndex % palette.length],
        transparent: true,
        opacity: 0.26 + shellIndex * 0.03,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material);
      line.renderOrder = 2;
      group.add(line);

      // Fine luminous particles travel along the field line, so the field
      // reads as flowing plasma rather than a static diagram.
      const count = 64;
      const positions = new Float32Array(count * 3);
      const colors = new Float32Array(count * 3);
      const phases = new Float32Array(count);
      for (let j = 0; j < count; j += 1) {
        phases[j] = (j / count + Math.random() * 0.018) % 1;
        const c = flowPalette[(j + shellIndex) % flowPalette.length];
        colors[j * 3] = c.r;
        colors[j * 3 + 1] = c.g;
        colors[j * 3 + 2] = c.b;
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      const pointsMaterial = new THREE.PointsMaterial({
        size: radius * 0.085,
        map: dotTexture,
        transparent: true,
        opacity: 0.86,
        vertexColors: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
      });
      const flow = new THREE.Points(geometry, pointsMaterial);
      flow.renderOrder = 3;
      flow.visible = false;
      group.add(flow);
      flows.push({ base: points, geometry, phases });
    });
  });

  function updateFlows(time) {
    for (const flow of flows) {
      const positions = flow.geometry.attributes.position.array;
      const base = flow.base;
      const maxIndex = base.length - 1;
      for (let j = 0; j < flow.phases.length; j += 1) {
        const u = (flow.phases[j] + time * 0.045) % 1;
        const p = u * maxIndex;
        const i0 = Math.floor(p);
        const i1 = Math.min(maxIndex, i0 + 1);
        const f = p - i0;
        const a = base[i0];
        const b = base[i1];
        positions[j * 3] = a.x + (b.x - a.x) * f;
        positions[j * 3 + 1] = a.y + (b.y - a.y) * f;
        positions[j * 3 + 2] = a.z + (b.z - a.z) * f;
      }
      flow.geometry.attributes.position.needsUpdate = true;
    }
  }

  // Geomagnetic axis tilted about 11 degrees from the rotation axis.
  group.rotation.z = 11 * DEG;
  group.userData.updateFlows = updateFlows;
  return group;
}

/**
 * Paraboloid shell used for the bow shock / magnetopause. Apex points at +X
 * (sunward); the tail opens toward -X.
 */
function makeParaboloidShell(radius, { apex, length, maxRadius, color, opacity = 0.12 }) {
  const group = new THREE.Group();
  const material = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  // Two parabolic cross-section curves in the equatorial plane. This reads as
  // the classic textbook bow-shock / magnetopause outline, unlike a full 3D
  // wire cage.
  for (const side of [-1, 1]) {
    const points = [];
    for (let i = 0; i <= 72; i += 1) {
      const t = i / 72;
      const x = radius * (apex - length * t);
      const y = side * radius * maxRadius * Math.sqrt(t);
      points.push(new THREE.Vector3(x, y, 0));
    }
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material));
  }
  group.name = 'magnetosphere-boundary';
  return group;
}

function makeLabelSprite(text, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 96;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.font = '600 34px ui-monospace, SFMono-Regular, Menlo, monospace';
  context.fillStyle = color;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, canvas.width / 2, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    opacity: 0.82,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.8, 0.34, 1);
  return sprite;
}

function makeMagnetosphere(radius) {
  const root = new THREE.Group();
  root.name = 'earth-magnetosphere';
  const dipole = makeDipoleField(radius);
  root.add(dipole);

  // The outer boundary is compressed slightly so the whole magnetosphere can
  // fit in the close-up camera while the dipole remains at true planet scale.
  const outer = new THREE.Group();
  outer.name = 'magnetosphere-boundaries';
  outer.scale.setScalar(0.62);
  root.add(outer);

  const bowShock = makeParaboloidShell(radius, {
    apex: 2.15,
    length: 6.2,
    maxRadius: 3.1,
    color: '#a485ff',
    opacity: 0.16,
  });
  bowShock.name = 'bow-shock';
  outer.add(bowShock);

  const magnetopause = makeParaboloidShell(radius, {
    apex: 1.45,
    length: 4.6,
    maxRadius: 2.15,
    color: '#72d7ff',
    opacity: 0.3,
  });
  magnetopause.name = 'magnetopause';
  outer.add(magnetopause);

  const tailLength = 5.2;
  const tail = new THREE.Group();
  tail.name = 'magnetotail';
  const tailMaterial = new THREE.LineBasicMaterial({
    color: '#6bb7ff',
    transparent: true,
    opacity: 0.16,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  for (let spoke = 0; spoke < 2; spoke += 1) {
    const angle = (spoke / 4) * Math.PI * 2;
    const points = [];
    for (let i = 0; i <= 24; i += 1) {
      const t = i / 24;
      const x = -radius * (1.7 + tailLength * t);
      const r = radius * (1.0 + 0.65 * t);
      points.push(new THREE.Vector3(x, Math.cos(angle) * r, Math.sin(angle) * r));
    }
    tail.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), tailMaterial));
  }
  for (const t of [0.7]) {
    const points = [];
    const x = -radius * (1.7 + tailLength * t);
    const r = radius * (1.0 + 0.65 * t);
    for (let i = 0; i <= 40; i += 1) {
      const angle = (i / 40) * Math.PI * 2;
      points.push(new THREE.Vector3(x, Math.cos(angle) * r, Math.sin(angle) * r));
    }
    tail.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), tailMaterial));
  }
  outer.add(tail);

  return { root, dipole, outer, bowShock, magnetopause, tail, labels: [] };
}

function makeBeltHalo(radius, { major, tube, colorA, colorB, opacity = 0.08, seed = 1 }) {
  const geometry = new THREE.TorusGeometry(
    radius * major,
    radius * tube,
    24,
    180,
  );
  geometry.rotateX(Math.PI / 2);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColorA: { value: new THREE.Color(colorA) },
      uColorB: { value: new THREE.Color(colorB) },
      uOpacity: { value: opacity },
      uSeed: { value: seed },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vNormal;
      void main() {
        vUv = uv;
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vNormal;
      uniform float uTime;
      uniform vec3 uColorA;
      uniform vec3 uColorB;
      uniform float uOpacity;
      uniform float uSeed;
      void main() {
        float bands = 0.45 + 0.55 * sin(vUv.x * 42.0 + uTime * 0.35 + uSeed);
        float edge = 0.5 + 0.5 * sin(vUv.y * 3.14159);
        float alpha = uOpacity * (0.32 + bands * 0.68) * edge;
        vec3 color = mix(uColorA, uColorB, 0.5 + 0.5 * sin(vUv.x * 12.0 + uSeed));
        color *= 0.85 + 0.15 * vNormal.z;
        gl_FragColor = vec4(color, alpha);
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
  mesh.name = `earth-belt-halo-${major}`;
  mesh.renderOrder = 2;
  return mesh;
}

function makeAuroraCurtains(radius, ySign, colorA, colorB, seed = 1) {
  let a = seed >>> 0;
  const random = () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const positions = [];
  const uvs = [];
  const seeds = [];
  const indices = [];
  const layers = 3;
  const segs = 224;
  const rows = 7;

  for (let layer = 0; layer < layers; layer += 1) {
    const phi0 = 0.31 + layer * 0.022;
    const height = 0.055 + layer * 0.018;
    const baseSeed = random();
    const baseIndex = positions.length / 3;
    for (let i = 0; i <= segs; i += 1) {
      const theta = (i / segs) * Math.PI * 2;
      const breath = 0.72 + 0.28 * Math.sin(theta * 5.0 + baseSeed * 18.0 + layer);
      for (let j = 0; j <= rows; j += 1) {
        const v = j / rows;
        const vertical = v * height * breath;
        const phi = phi0 + v * 0.028;
        const r = radius * (1.004 + vertical);
        positions.push(
          Math.cos(theta) * Math.sin(phi) * r,
          ySign * Math.cos(phi) * r,
          Math.sin(theta) * Math.sin(phi) * r,
        );
        uvs.push(i / segs, v);
        seeds.push(baseSeed + layer * 3.7);
      }
    }
    for (let i = 0; i < segs; i += 1) {
      for (let j = 0; j < rows; j += 1) {
        const p = baseIndex + i * (rows + 1) + j;
        const q = p + (rows + 1);
        indices.push(p, q, p + 1, q, q + 1, p + 1);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 1));
  geometry.setIndex(indices);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColorA: { value: new THREE.Color(colorA) },
      uColorB: { value: new THREE.Color(colorB) },
      uOpacity: { value: 0.9 },
    },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      varying vec2 vUv;
      varying float vSeed;
      uniform float uTime;
      void main() {
        vUv = uv;
        vSeed = aSeed;
        vec3 p = position;
        vec3 n = normalize(p);
        float wave = sin(uv.x * 13.0 + uTime * 0.55 + aSeed * 9.0) * 0.010
                   + sin(uv.x * 31.0 - uTime * 0.35) * 0.004;
        p += n * wave;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying float vSeed;
      uniform float uTime;
      uniform vec3 uColorA;
      uniform vec3 uColorB;
      uniform float uOpacity;
      float hash(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
                   mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
      }
      float fbm(vec2 p) {
        float v = 0.0;
        float amp = 0.5;
        for (int i = 0; i < 4; i++) {
          v += amp * noise(p);
          p = p * 2.03 + vec2(5.3, 2.7);
          amp *= 0.5;
        }
        return v;
      }
      void main() {
        float bottom = smoothstep(0.0, 0.08, vUv.y);
        float top = 1.0 - smoothstep(0.42, 0.95, vUv.y);
        float curtain = fbm(vec2(vUv.x * 13.0 + vSeed * 9.0, vUv.y * 2.4 - uTime * 0.11));
        float silk = 0.62 + 0.38 * sin(vUv.x * 120.0 + curtain * 7.0 + uTime * 0.45);
        float mask = smoothstep(0.22, 0.78, fbm(vec2(vUv.x * 6.0, vSeed * 3.1)));
        float alpha = bottom * top * mask * (0.18 + silk * 0.42) * uOpacity;
        vec3 color = mix(uColorA, uColorB, smoothstep(0.08, 0.78, vUv.y));
        color += uColorA * bottom * 0.18;
        gl_FragColor = vec4(color, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
  });

  const group = new THREE.Group();
  group.name = ySign > 0 ? 'aurora-north' : 'aurora-south';
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 4;
  group.add(mesh);
  group.userData.materials = [material];
  return group;
}

export function createEarthLayers(earthBody) {
  const radius = earthBody.radius;
  const group = new THREE.Group();
  group.name = 'earth-layers';
  group.visible = false;

  const radiation = new THREE.Group();
  radiation.name = 'earth-radiation-belts';
  radiation.rotation.z = 11 * DEG;
  const inner = makeRadiationBelt(radius, {
    count: 6200,
    major: 1.2,
    minor: 0.15,
    color: '#ff9f5f',
    colorB: '#ffe2b0',
    seed: 71,
    opacity: 0.82,
  });
  const outer = makeRadiationBelt(radius, {
    count: 9400,
    major: 1.72,
    minor: 0.29,
    color: '#4fbfff',
    colorB: '#c4f2ff',
    seed: 97,
    opacity: 0.68,
  });
  const innerRibbon = makeBeltRibbon(radius, 1.2, '#ffbd7b', 0.1);
  const outerRibbon = makeBeltRibbon(radius, 1.72, '#83d8ff', 0.07);
  const innerHalo = makeBeltHalo(radius, {
    major: 1.2,
    tube: 0.2,
    colorA: '#ffb367',
    colorB: '#ffe6b8',
    opacity: 0.075,
    seed: 7,
  });
  const outerHalo = makeBeltHalo(radius, {
    major: 1.72,
    tube: 0.36,
    colorA: '#48b8ff',
    colorB: '#9fe8ff',
    opacity: 0.055,
    seed: 13,
  });
  const auroraNorth = makeAuroraCurtains(radius, 1, '#28d98d', '#7563ff', 19);
  const auroraSouth = makeAuroraCurtains(radius, -1, '#45e5c8', '#607dff', 37);
  auroraNorth.rotation.z = 0.18;
  auroraSouth.rotation.z = 0.18;
  radiation.add(inner, innerRibbon, outer, outerRibbon, innerHalo, outerHalo, auroraNorth, auroraSouth);
  group.add(radiation);

  const magnetic = makeMagnetosphere(radius);
  magnetic.root.visible = false;
  group.add(magnetic.root);

  const tiltGroup = earthBody.tiltGroup || null;
  const orientationQuaternion = new THREE.Quaternion();
  const localSunDirection = new THREE.Vector3(1, 0, 0);

  let mode = 'none';
  let time = 0;
  let focus = false;

  function applyVisibility() {
    group.visible = focus && mode !== 'none';
    radiation.visible = mode === 'radiation';
    magnetic.root.visible = mode === 'magnetic';
  }

  function orientToSun(sunDir) {
    if (!sunDir || !Number.isFinite(sunDir.x)) return;
    if (tiltGroup) {
      tiltGroup.getWorldQuaternion(orientationQuaternion);
      orientationQuaternion.invert();
      localSunDirection.copy(sunDir).applyQuaternion(orientationQuaternion).normalize();
    } else {
      localSunDirection.copy(sunDir).normalize();
    }
    magnetic.root.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), localSunDirection);
  }

  function setMode(next) {
    mode = EARTH_LAYER_MODES.includes(next) ? next : 'none';
    applyVisibility();
    return mode;
  }

  function cycle() {
    const index = EARTH_LAYER_MODES.indexOf(mode);
    return setMode(EARTH_LAYER_MODES[(index + 1) % EARTH_LAYER_MODES.length]);
  }

  function update({ time: nextTime = 0, dpr = 1, focus: nextFocus = false, sunDir = null } = {}) {
    time = nextTime;
    focus = Boolean(nextFocus);
    applyVisibility();
    if (mode === 'radiation') {
      inner.material.uniforms.uTime.value = time;
      outer.material.uniforms.uTime.value = time;
      inner.material.uniforms.uDpr.value = dpr;
      outer.material.uniforms.uDpr.value = dpr;
      innerHalo.material.uniforms.uTime.value = time;
      outerHalo.material.uniforms.uTime.value = time;
      for (const aurora of [auroraNorth, auroraSouth]) {
        for (const material of aurora.userData.materials) {
          material.uniforms.uTime.value = time;
        }
      }
      innerRibbon.material.opacity = 0.07 + 0.03 * Math.sin(time * 0.7);
      outerRibbon.material.opacity = 0.05 + 0.022 * Math.sin(time * 0.55 + 1.2);
    }
    if (mode === 'magnetic') {
      const gust = 0.5 + 0.5 * Math.sin(time * 0.33) * Math.sin(time * 0.11 + 1.2);
      magnetic.dipole.scale.set(1 - 0.035 * gust, 1 + 0.018 * gust, 1);
      magnetic.dipole.position.x = -0.045 * radius * gust;
      magnetic.root.children.forEach((child) => {
        if (child.isSprite) child.material.opacity = 0.55 + 0.25 * Math.sin(time * 0.8 + child.position.x);
      });
      magnetic.dipole.userData.updateFlows?.(time);
    }
  }

  return {
    group,
    radiation,
    magnetic: magnetic.root,
    magnetosphere: magnetic,
    setMode,
    cycle,
    update,
    get mode() { return mode; },
    modes: EARTH_LAYER_MODES,
  };
}

