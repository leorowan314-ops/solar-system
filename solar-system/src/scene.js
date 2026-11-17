/**
 * Renderer, camera choreography and picking for the Solar System Observatory.
 *
 * Camera policy: the camera always orbits the current target (Sun in overview,
 * planet in close-up). The bodies never move the camera directly; this module
 * owns the cinematic transition, hand-driven look, wheel/pinch zoom and the
 * screen-space projection used by DOM labels.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CONFIG } from './config.js';
import { createSolarBodies, displayDistanceAU } from './bodies.js';
import { createGalaxyBackdrop } from './galaxy.js';

const OVERVIEW_TARGET = new THREE.Vector3(
  CONFIG.camera.overview.targetX ?? 0,
  CONFIG.camera.overview.targetY ?? 0,
  0,
);
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const shapePitchInput = (value) => {
  const x = clamp(Number(value) || 0, -1.2, 1.2);
  return Math.sign(x) * Math.pow(Math.abs(x), 1.35);
};
const approach = (current, target, alpha) => current + (target - current) * alpha;

function createColdStars(count = 1100) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const random = (() => { let seed = 0x9e3779b9; return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; })();
  for (let i = 0; i < count; i += 1) {
    const u = random() * 2 - 1;
    const phi = random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const radius = 260 + random() * 150;
    positions[i * 3] = Math.cos(phi) * s * radius;
    positions[i * 3 + 1] = u * radius;
    positions[i * 3 + 2] = Math.sin(phi) * s * radius;
    const tone = 0.55 + random() * 0.45;
    colors[i * 3] = 0.55 * tone;
    colors[i * 3 + 1] = 0.72 * tone;
    colors[i * 3 + 2] = 1.0 * tone;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({
    size: 1.7,
    sizeAttenuation: true,
    vertexColors: true,
    transparent: true,
    opacity: 0.82,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geometry, material);
  points.name = 'sun-cold-stars';
  points.frustumCulled = false;
  return points;
}

export function createSceneStage({ canvas, runtime, initialDate, scaleMode = 'demo' }) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: false,
    powerPreference: 'high-performance',
    stencil: false,
    preserveDrawingBuffer: false,
  });
  renderer.setClearColor(CONFIG.scene.background, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = CONFIG.scene.exposure;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(CONFIG.scene.background);

  const galaxy = createGalaxyBackdrop({ radius: CONFIG.scene.far * 0.7, tilt: 0.28 });
  const galaxyBaseQuat = galaxy.mesh.quaternion.clone();
  const galaxyFocusQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 0.34));
  let galaxyFollowCamera = false;
  scene.add(galaxy.mesh);
  const sunStars = createColdStars();
  sunStars.visible = false;
  scene.add(sunStars);
  const earthStars = createColdStars(900);
  earthStars.name = 'earth-cold-stars';
  earthStars.visible = false;
  scene.add(earthStars);

  const camera = new THREE.PerspectiveCamera(
    CONFIG.camera.fovOverview,
    1,
    CONFIG.scene.near,
    CONFIG.scene.far,
  );

  const bodies = createSolarBodies({ scene, runtime, date: initialDate, scaleMode });
  const bodiesRoot = bodies.root;
  bodiesRoot.rotation.z = 0.015;

  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(runtime.dpr);
  const renderPass = new RenderPass(scene, camera);
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(1, 1),
    CONFIG.scene.bloomStrength,
    CONFIG.scene.bloomRadius,
    CONFIG.scene.bloomThreshold,
  );
  const outputPass = new OutputPass();
  composer.addPass(renderPass);
  composer.addPass(bloomPass);
  composer.addPass(outputPass);

  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();

  let width = 1;
  let height = 1;
  let pixelRatio = runtime.dpr;
  let elapsed = 0;
  let date = initialDate;

  const view = {
    mode: 'overview',
    focusId: null,
    target: new THREE.Vector3(0, 0, 0),
    targetDesired: new THREE.Vector3(0, 0, 0),
    baseYaw: 0.26,
    baseYawDefault: 0.26,
    basePitch: 0.31,
    yaw: 0.26,
    pitch: 0.31,
    yawDesired: 0.26,
    pitchDesired: 0.31,
    handYaw: 0,
    handPitch: 0,
    handYawDesired: 0,
    handPitchDesired: 0,
    distance: 26,
    distanceDesired: 26,
    fov: CONFIG.camera.fovOverview,
    fovDesired: CONFIG.camera.fovOverview,
    zoom: 1,
    zoomDesired: 1,
    dragging: false,
    idleTime: 0,
  };

  function aspect() {
    return width > 0 && height > 0 ? width / height : 1;
  }

  function fitOverviewDistance() {
    const outer = displayDistanceAU(35.08, bodies.scaleMode);
    const vFov = CONFIG.camera.fovOverview * DEG;
    const hHalf = Math.tan(vFov / 2) * Math.max(1, aspect());
    const fit = outer / hHalf * 1.34;
    // On phones we favor a readable inner system over a tiny complete orbit.
    return runtime.mobile ? Math.min(fit, 42) : fit;
  }

  function fitFocusDistance(planetId) {
    if (planetId === 'sun') return runtime.mobile ? 7.6 : 6.6;
    if (planetId === 'halley') return runtime.mobile ? 3.6 : 3.2;
    if (planetId === 'jupiter') return runtime.mobile ? 4.8 : 4.2;
    if (planetId === 'moon') return runtime.mobile ? 1.1 : 0.85;
    const planet = bodies.planetById.get(planetId);
    if (!planet) return CONFIG.camera.focusMin;
    const extent = planet.radius * (planet.ring ? 2.55 : 1.55);
    const fov = CONFIG.camera.fovFocus * DEG;
    // Portrait screens have a much narrower horizontal FOV; fit against the
    // tighter of the two axes so Saturn's rings never bleed off a phone.
    const vHalf = Math.tan(fov / 2);
    const hHalf = vHalf * aspect();
    const fit = (extent / Math.min(vHalf, hHalf)) * 1.05;
    const max = runtime.mobile ? 16 : CONFIG.camera.focusMax;
    return clamp(fit, 0.38, max);
  }

  function orbitOverview() {
    view.mode = 'overview';
    view.focusId = null;
    view.baseYaw = 0.26;
    view.basePitch = 0.31;
    view.yawDesired = view.baseYaw;
    view.pitchDesired = view.basePitch;
    view.fovDesired = CONFIG.camera.fovOverview;
    view.targetDesired.copy(OVERVIEW_TARGET);
    view.distanceDesired = fitOverviewDistance();
    view.zoomDesired = 1;
    bodies.setOverview();
    setSunLook(false);
  }

  function focusTarget(planetId) {
    if (planetId === 'sun') {
      const target = new THREE.Vector3(0, 0, 0);
      if (runtime.mobile) target.y -= fitFocusDistance(planetId) * 0.12;
      return target;
    }
    if (planetId === 'halley' && bodies.comet) {
      return bodies.comet.group.position.clone();
    }
    const moon = planetId === 'moon' ? bodies.planetById.get('moon') : null;
    if (moon) {
      const target = bodies.bodyWorldPosition('moon').clone();
      if (runtime.mobile) target.y -= fitFocusDistance(planetId) * 0.14;
      return target;
    }
    const planet = bodies.planetById.get(planetId);
    if (!planet) return new THREE.Vector3();
    const target = bodies.bodyWorldPosition(planetId).clone();
    if (runtime.mobile) {
      // Lift the planet above the bottom-sheet data panel on phones.
      target.y -= fitFocusDistance(planetId) * 0.14;
    }
    return target;
  }

  function applyCelestialBackdrop(mode, planetId = null) {
    // A photographed Milky Way sits behind every view. Close-ups dim it so the
    // planet remains the subject while the background keeps its depth.
    const special = Boolean(mode);
    galaxy.mesh.visible = true;
    galaxy.setDim(special ? 0.9 : 0.82);
    galaxyFollowCamera = false;
    galaxy.mesh.position.set(0, 0, 0);
    galaxy.mesh.quaternion.copy(galaxyBaseQuat);

    // Every close-up keeps the same cold, twinkling starfield as the Sun.
    sunStars.visible = Boolean(mode);
    earthStars.visible = false;
    if (bodies.stars?.object) bodies.stars.object.visible = false;
    const isSun = mode === 'sun';
    renderer.toneMappingExposure = isSun
      ? 0.8
      : mode === 'earth'
        ? 0.94
        : 0.96;
    bloomPass.strength = isSun
      ? 0.34
      : mode === 'earth'
        ? 0.28
        : 0.26;
    bloomPass.radius = special ? 0.3 : CONFIG.scene.bloomRadius;
    bloomPass.threshold = isSun || mode === 'earth'
      ? (isSun ? 0.78 : 0.76)
      : 0.76;
    scene.background.set(special ? '#010103' : CONFIG.scene.background);
  }

  function setSunLook(active) {
    applyCelestialBackdrop(active ? 'sun' : null);
  }

  function setEarthLook(active) {
    applyCelestialBackdrop(active ? 'earth' : null);
  }

  function alignGalaxyToView() {
    camera.updateMatrixWorld();
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    const up = new THREE.Vector3(0, 1, 0);
    let normal = up.clone().addScaledVector(forward, -up.dot(forward));
    if (normal.lengthSq() < 1e-4) normal.set(0, 0, 1);
    normal.normalize().addScaledVector(forward, 0.30).normalize();
    const baseNormal = new THREE.Vector3(0, 1, 0).applyQuaternion(galaxyBaseQuat);
    const delta = new THREE.Quaternion().setFromUnitVectors(baseNormal, normal);
    galaxy.mesh.quaternion.copy(delta).multiply(galaxyBaseQuat);
    const roll = new THREE.Quaternion().setFromAxisAngle(forward, 0.38);
    galaxy.mesh.quaternion.premultiply(roll);
  }

  function setFocus(planetId) {
    if (!planetId) {
      orbitOverview();
      return;
    }
    const planet = bodies.planetById.get(planetId);
    const comet = planetId === 'halley' ? bodies.comet : null;
    if (!planet && !comet) return;
    view.mode = 'focus';
    view.focusId = planetId;
    view.targetDesired.copy(focusTarget(planetId));
    const heliocentric = bodies.bodyWorldPosition(planetId) || new THREE.Vector3();
    // Put the camera on the sunlit hemisphere; a small offset keeps the
    // terminator out of the middle of the frame. A comet is framed from the
    // side of its sunward axis so the anti-solar tail reads across the frame.
    if (planetId === 'sun') {
      view.baseYaw = 0.42;
      view.basePitch = 0.12;
    } else if (planetId === 'halley') {
      const tail = heliocentric.clone().multiplyScalar(-1).normalize();
      view.baseYaw = Math.atan2(-tail.z, tail.x) + 0.25;
    } else if (planetId === 'moon') {
      // Keep the Moon sunlit while letting Earth sit off to one side, rather
      // than turning the Moon into a dark silhouette against Earth.
      view.baseYaw = Math.atan2(-heliocentric.x, -heliocentric.z) + 0.85;
    } else {
      view.baseYaw = Math.atan2(-heliocentric.x, -heliocentric.z) + 0.2;
    }
    view.baseYawDefault = view.baseYaw;
    view.basePitch = planetId === 'halley'
      ? 0.16
      : planetId === 'moon'
        ? 0.22
        : planet.id === 'saturn'
          ? 0.55
          : planet.id === 'uranus'
            ? 0.72
            : 0.34;
    view.yawDesired = view.baseYaw;
    view.pitchDesired = view.basePitch;
    view.fovDesired = CONFIG.camera.fovFocus;
    view.distanceDesired = fitFocusDistance(planetId);
    bodies.setFocus(planetId);
    applyCelestialBackdrop(
      planetId === 'sun' ? 'sun' : planetId === 'earth' ? 'earth' : 'planet',
      planetId,
    );
    setSphericalCamera(1 / 60, true);
    alignGalaxyToView();
  }

  function setFocusYaw(absoluteYaw = 0) {
    view.baseYaw = absoluteYaw;
    view.yawDesired = absoluteYaw;
  }

  function setFocusYawOffset(offset = 0) {
    view.baseYaw = view.baseYawDefault + offset;
    view.yawDesired = view.baseYaw;
  }


  function setScaleMode(mode) {
    bodies.setScaleMode(mode);
    if (view.mode === 'overview') view.distanceDesired = fitOverviewDistance();
  }

  function setSphericalCamera(dt, immediate = false) {
    const targetAlpha = immediate ? 1 : 1 - Math.exp(-dt * 5.2);
    const distanceAlpha = immediate ? 1 : 1 - Math.exp(-dt * 4.6);
    const angleAlpha = immediate ? 1 : 1 - Math.exp(-dt * 5.8);

    view.handYaw = immediate ? view.handYawDesired : approach(view.handYaw, view.handYawDesired, 1 - Math.exp(-dt * 6.5));
    view.handPitch = immediate ? view.handPitchDesired : approach(view.handPitch, view.handPitchDesired, 1 - Math.exp(-dt * 6.5));
    view.yaw = immediate ? view.yawDesired : approach(view.yaw, view.yawDesired, angleAlpha);
    view.pitch = immediate ? view.pitchDesired : approach(view.pitch, view.pitchDesired, angleAlpha);
    view.fov = immediate ? view.fovDesired : approach(view.fov, view.fovDesired, angleAlpha);
    view.zoom = immediate ? view.zoomDesired : approach(view.zoom, view.zoomDesired, 1 - Math.exp(-dt * 4.0));

    if (immediate) {
      view.target.copy(view.targetDesired);
      view.distance = view.distanceDesired;
    } else {
      view.target.lerp(view.targetDesired, targetAlpha);
      view.distance = approach(view.distance, view.distanceDesired, distanceAlpha);
    }

    const yaw = view.yaw + view.handYaw;
    const pitch = clamp(view.pitch + view.handPitch, -1.55, 1.55);
    const cosPitch = Math.cos(pitch);
    let minDistance = view.mode === 'focus' ? 0.22 : CONFIG.camera.overview.minDistance;
    if (view.mode === 'focus' && view.focusId) {
      if (view.focusId === 'sun') minDistance = Math.max(minDistance, CONFIG.scale.sunRadius * 1.08);
      else if (view.focusId === 'halley') minDistance = Math.max(minDistance, 0.16);
      else {
        const body = bodies.planetById.get(view.focusId);
        if (body?.radius) minDistance = Math.max(0.18, body.radius * 2.05);
      }
    }
    const distance = clamp(view.distance * view.zoom, minDistance, CONFIG.camera.overview.maxDistance);
    camera.position.set(
      view.target.x + Math.sin(yaw) * cosPitch * distance,
      view.target.y + Math.sin(pitch) * distance,
      view.target.z + Math.cos(yaw) * cosPitch * distance,
    );
    camera.up.set(0, 1, 0);
    camera.lookAt(view.target);
    if (Math.abs(camera.fov - view.fov) > 1e-4) {
      camera.fov = view.fov;
      camera.updateProjectionMatrix();
    }
  }

  function update({ dt, time, date: dateValue, lookX = 0, lookY = 0, idle = true }) {
    elapsed = time;
    date = dateValue;
    const safeDt = Math.min(0.05, Math.max(0, dt));

    if (view.focusId) {
      const planet = bodies.planetById.get(view.focusId);
      if (planet) {
        view.targetDesired.copy(focusTarget(view.focusId));
        view.distanceDesired = fitFocusDistance(view.focusId);
      }
    } else {
      view.targetDesired.copy(OVERVIEW_TARGET);
    }

    view.idleTime += safeDt;
    if (idle && !runtime.reducedMotion) {
      // Very slow observatory drift; hand/pointer input always wins.
      view.baseYaw += Math.sin(view.idleTime * 0.11) * 0.00002;
    }

    view.handYawDesired = clamp(lookX * CONFIG.hand.orbit.gainX, -1.35, 1.35);
    view.handPitchDesired = clamp(-shapePitchInput(lookY) * CONFIG.hand.orbit.gainY, -CONFIG.hand.orbit.maxPitch, CONFIG.hand.orbit.maxPitch);

    bodies.update({ date: dateValue, dt: safeDt, elapsed, daysPerSecond: CONFIG.time.defaultDaysPerSecond });
    setSphericalCamera(safeDt);
    camera.updateMatrixWorld();
    if (sunStars.visible) {
      sunStars.material.opacity = 0.52
        + 0.14 * Math.sin(elapsed * 2.3)
        + 0.05 * Math.sin(elapsed * 5.1 + 1.7);
    }

    // In close-ups the Milky Way follows the camera orientation, so every
    // planet keeps a composed galaxy backdrop instead of empty black sky.

  }

  function snap() {
    setSphericalCamera(1 / 60, true);
    bodies.update({ date, dt: 0, elapsed, daysPerSecond: CONFIG.time.defaultDaysPerSecond });
    camera.updateMatrixWorld();
  }

  function resize(nextWidth, nextHeight, nextDpr = runtime.dpr) {
    width = Math.max(1, Math.round(nextWidth));
    height = Math.max(1, Math.round(nextHeight));
    pixelRatio = Math.min(nextDpr, runtime.mobile ? CONFIG.scene.maxDprMobile : CONFIG.scene.maxDprDesktop);
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(width, height, false);
    camera.aspect = aspect();
    camera.updateProjectionMatrix();
    composer.setPixelRatio(pixelRatio);
    composer.setSize(width, height);
    const bloomScale = runtime.bloomScale;
    bloomPass.setSize(
      Math.max(1, Math.round(width * pixelRatio * bloomScale)),
      Math.max(1, Math.round(height * pixelRatio * bloomScale)),
    );
    if (view.mode === 'overview') view.distanceDesired = fitOverviewDistance();
    else if (view.focusId) view.distanceDesired = fitFocusDistance(view.focusId);
    snap();
  }

  function project(id) {
    return bodies.project(id, camera, width, height);
  }

  function labelPositions() {
    const list = [];
    const sun = project('sun');
    if (sun) list.push({ id: 'sun', name: '太阳', nameEn: 'SUN', ...sun });
    for (const planet of bodies.planets) {
      const projected = project(planet.id);
      if (projected) list.push({ id: planet.id, name: planet.data.nameZh, nameEn: planet.data.nameEn, ...projected });
    }
    if (bodies.moon) {
      const projected = project('moon');
      if (projected) list.push({ id: 'moon', name: '月球', nameEn: 'MOON', ...projected });
    }
    if (bodies.comet) {
      const projected = project('halley');
      if (projected) list.push({ id: 'halley', name: '哈雷彗星', nameEn: 'HALLEY', comet: true, ...projected });
    }
    return list;
  }

  function pick(clientX, clientY) {
    pointerNdc.x = (clientX / width) * 2 - 1;
    pointerNdc.y = -(clientY / height) * 2 + 1;
    raycaster.setFromCamera(pointerNdc, camera);
    const hit = bodies.raycastBody(raycaster, camera, width, height);
    if (hit) return hit;

    // Forgiving screen-space pick for tiny or distant bodies (comet, inner
    // planets). This is what makes pinch-grab feel reliable on a phone.
    let best = null;
    const candidates = [];
    if (bodies.sun?.group?.visible) candidates.push('sun');
    for (const planet of bodies.planets) {
      if (planet.group.visible) candidates.push(planet.id);
    }
    if (bodies.moon?.group.visible) candidates.push('moon');
    if (bodies.comet?.group.visible) candidates.push('halley');
    for (const id of candidates) {
      const projected = project(id);
      if (!projected?.visible) continue;
      const dx = clientX - projected.x;
      const dy = clientY - projected.y;
      const threshold = Math.max(180, projected.screenRadius * 8.0 + 90);
      const distance = Math.hypot(dx, dy);
      if (distance <= threshold && (!best || distance < best.distance)) {
        best = { id, distance, projected };
      }
    }
    return best;
  }

  function setLook(x, y) {
    view.handYawDesired = clamp(x * CONFIG.hand.orbit.gainX, -1.35, 1.35);
    view.handPitchDesired = clamp(-shapePitchInput(y) * CONFIG.hand.orbit.gainY, -CONFIG.hand.orbit.maxPitch, CONFIG.hand.orbit.maxPitch);
  }

  function zoomBy(factor) {
    view.zoomDesired = clamp(view.zoomDesired * factor, CONFIG.hand.zoom.min, CONFIG.hand.zoom.max);
  }

  function setZoom(value) {
    view.zoomDesired = clamp(value, CONFIG.hand.zoom.min, CONFIG.hand.zoom.max);
  }

  function startDrag() {
    view.dragging = true;
  }

  function endDrag() {
    view.dragging = false;
  }

  function dragBy(dx, dy) {
    view.handYawDesired = clamp(view.handYawDesired - dx * 0.0018, -1.35, 1.35);
    view.handPitchDesired = clamp(view.handPitchDesired - dy * 0.0014, -CONFIG.hand.orbit.maxPitch, CONFIG.hand.orbit.maxPitch);
  }

  function render() {
    composer.render();
  }

  function isFocus() {
    return view.mode === 'focus';
  }

  // Initial composition. Main calls resize() once the DOM size is known; this
  // gives the camera a sane first frame in case the first render happens early.
  orbitOverview();
  view.distance = fitOverviewDistance();
  snap();

  return {
    renderer,
    scene,
    camera,
    composer,
    bloomPass,
    galaxy,
    bodies,
    root: bodies.root,
    setFocus,
    setFocusYaw,
    setFocusYawOffset,
    setOverview: orbitOverview,
    setScaleMode,
    setLook,
    zoomBy,
    setZoom,
    startDrag,
    endDrag,
    dragBy,
    update,
    render,
    resize,
    snap,
    project,
    labelPositions,
    pick,
    isFocus,
    get mode() { return view.mode; },
    get focusId() { return view.focusId; },
    get scaleMode() { return bodies.scaleMode; },
    get distance() { return view.distance * view.zoom; },
    get zoom() { return view.zoom; },
    get yaw() { return view.yaw + view.handYaw; },
    get pitch() { return view.pitch + view.handPitch; },
  };
}
