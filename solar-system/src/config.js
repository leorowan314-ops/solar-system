/**
 * 太阳系 · 粒子天文台 / Solar System Particle Observatory
 * Central art direction + simulation + interaction tuning.
 *
 * Everything here is intentionally data-driven so the teaching UI can expose
 * the numbers and the art direction can be tuned without touching shaders.
 */
export const CONFIG = Object.freeze({
  app: {
    title: '太阳系',
    titleEn: 'SOLAR SYSTEM',
    subtitle: '粒子天文台',
    subtitleEn: 'PARTICLE OBSERVATORY',
    version: '1.0.0',
  },

  colors: {
    ink: '#02040a',
    deep: '#071224',
    night: '#0b1730',
    ivory: '#eef2f5',
    muted: '#8fa2b8',
    gold: '#ffcf7a',
    solar: '#ffb347',
    cyan: '#7fd9ff',
    teal: '#5ee0c2',
    violet: '#b79cff',
    rust: '#e07a5f',
    ice: '#b9e6ff',
  },

  /**
   * Deliberately over 200,000 particles on desktop — ten times the previous
   * Fingertip Bloom scene. Budgets are distributed per body/ring/belt so the
   * close-up views keep their detail instead of swapping in a lower-res model.
   */
  particles: {
    desktop: 204000,
    mobile: 112000,
    min: 5000,
    max: 400000,
    corona: 42000,
    comet: 16000,
    bodies: {
      sun: 42000,
      mercury: 7000,
      venus: 10000,
      earth: 12000,
      mars: 8000,
      jupiter: 30000,
      saturn: 22000,
      uranus: 9000,
      neptune: 9000,
    },
    rings: {
      jupiter: 12000,
      saturn: 32000,
      uranus: 5000,
      neptune: 3000,
    },
    belts: {
      asteroid: 26000,
      kuiper: 12000,
    },
    stars: 100000,
    pollen: 0,
  },

  scene: {
    fov: 42,
    near: 0.01,
    exposure: 1.05,
    bloomStrength: 0.5,
    bloomRadius: 0.62,
    bloomThreshold: 0.58,
    bloomScaleDesktop: 0.58,
    bloomScaleMobile: 0.46,
    maxDprDesktop: 1.9,
    maxDprMobile: 1.5,
    starRadius: 180,
    far: 600,
    background: '#02040a',
  },

  /**
   * Two display scales. The default keeps Neptune on screen while preserving
   * the correct ORDER and eccentricity of every orbit. The "true" mode uses
   * linear AU distances; planet radii stay artistically exaggerated and the UI
   * says so explicitly.
   */
  scale: {
    // The compressed mode keeps the whole family on screen. The linear mode
    // preserves the true AU ratios; its much larger camera pull-back is the
    // lesson in itself.
    demoDistanceBase: 1.9,
    demoDistancePower: 0.62,
    demoDistanceGain: 1.45,
    trueDistanceBase: 1.15,
    trueDistancePower: 1,
    trueDistanceGain: 2.2,
    radiusBase: 0.16,
    radiusExponent: 0.6,
    sunRadius: 1.10,
    moonScale: 0.18,
  },

  time: {
    // simulated Julian day per real second; 0.35 keeps Mercury visibly moving.
    defaultDaysPerSecond: 5,
    focusSecondsPerDay: 20,
    speeds: [0, 0.35, 1, 5, 10, 35, 120, 365],
    speedLabels: ['暂停', '0.35 天/秒', '1 天/秒', '5 天/秒', '10 天/秒', '35 天/秒', '120 天/秒', '365 天/秒'],
    start: 'now',
  },

  camera: {
    overview: { x: 0, y: 9.2, z: 26.5, targetX: 3.2, targetY: 0.2, minDistance: 6, maxDistance: 170 },
    focusDistancePerRadius: 3.3,
    focusMin: 0.72,
    focusMax: 4.8,
    fovOverview: 42,
    fovFocus: 38,
    introDrift: { yaw: 0.03, pitch: 0.008 },
  },

  /**
   * Hand interaction. Rotation is allowed to feel generous; zoom is the
   * deliberate "low sensitivity" control requested by the user.
   */
  hand: {
    detection: { intervalMs: 1000 / 30, maxHands: 1 },
    smoothing: {
      palm: 0.14,
      rotation: 0.075,
      zoom: 0.06,
      pinch: 0.24,
    },
    deadzone: { x: 0.018, y: 0.02 },
    orbit: {
      gainX: 1.28, // radians across the full neutral hand range
      gainY: 1.9,
      maxPitch: 1.9,
      overviewChase: 0.9,
    },
    pinch: {
      startRatio: 0.46,
      releaseRatio: 0.68,
      confirmFrames: 1,
      holdToSelectMs: 160,
      emptyReleaseMs: 420,
      dragRotation: 2.2,
    },
    zoom: {
      /**
       * Open palm + hand closer/farther changes palm span. This gain is
       * intentionally tiny; 0.18 means a 10% palm-size change moves zoom by
       * under 2%, then it is eased again.
       */
      sensitivity: 0.18,
      min: 0.05,
      max: 14.0,
      rateIn: 1.15,
      rateOut: 0.9,
      distanceSensitivity: 30.0,
      distanceDeadband: 0.025,
      opennessGate: 0.55,
      spanFallback: 0.16,
    },
    wave: {
      windowMs: 260,
      minDx: 0.16,
      maxDy: 0.12,
      minOpenness: 0.62,
      cooldownMs: 1150,
      settleMs: 180,
    },
    neutral: { x: 0.5, y: 0.5 },
    lostHandMs: 320,
  },

  ui: {
    hudHz: 16,
    labels: ['太阳', '水星', '金星', '地球', '火星', '木星', '土星', '天王星', '海王星'],
    defaultPlanet: 'earth',
    defaultScaleMode: 'demo',
    defaultSpeedIndex: 3,
    reducedMotionSpeedIndex: 2,
  },

  quality: {
    bloomScaleLow: 0.4,
    maxDprLow: 1.25,
  },
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * Runtime options:
 *   ?quality=low      smaller budgets / dpr
 *   ?particles=200000 force a total budget (clamped)
 *   ?demo=1          start in pointer demo autopilot
 *   ?nocamera=1      same as demo, never request a camera
 *   ?planet=jupiter  deep-link a planet in focus view
 *   ?scale=true      start in true-distance mode
 *   ?hud=0           hide the hand overlay
 *   ?reducedmotion=1
 */
export function resolveRuntime() {
  const params = new URLSearchParams(window.location.search);
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const narrow = Math.min(window.innerWidth, window.innerHeight) < 700;
  const mobile = coarse || narrow;
  const lowQuality = params.get('quality') === 'low';
  const reducedMotion =
    params.get('reducedmotion') === '1' ||
    params.get('reduced-motion') === '1' ||
    (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);

  let totalParticles = mobile ? CONFIG.particles.mobile : CONFIG.particles.desktop;
  const requested = Number.parseInt(params.get('particles') ?? '', 10);
  if (Number.isFinite(requested)) {
    totalParticles = clamp(requested, CONFIG.particles.min, CONFIG.particles.max);
  }
  if (lowQuality) totalParticles = Math.min(totalParticles, 150000);

  const startPlanet = params.get('planet');
  return {
    mobile,
    lowQuality,
    reducedMotion,
    totalParticles,
    dpr: Math.min(
      window.devicePixelRatio || 1,
      lowQuality ? CONFIG.quality.maxDprLow : mobile ? CONFIG.scene.maxDprMobile : CONFIG.scene.maxDprDesktop,
    ),
    bloomScale: lowQuality || mobile ? CONFIG.scene.bloomScaleMobile : CONFIG.scene.bloomScaleDesktop,
    startInDemo: params.get('demo') === '1' || params.get('nocamera') === '1',
    startPlanet: startPlanet && /^[a-z]+$/i.test(startPlanet) ? startPlanet.toLowerCase() : null,
    scaleMode: params.get('scale') === 'true' || params.get('scale') === 'real' ? 'true' : 'demo',
    showHandOverlay: params.get('hud') !== '0',
  };
}

export { clamp };
