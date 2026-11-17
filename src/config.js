/**
 * 指尖生花 / Fingertip Bloom
 * Central configuration. Values here are intentionally easy to tune.
 */
export const CONFIG = Object.freeze({
  title: '指尖生花',
  titleEn: 'FINGERTIP BLOOM',

  // 5,000 – 20,000 particles. The runtime may lower this on small screens.
  particles: {
    // Dense enough that the petals read as surfaces, not as scattered sparks.
    desktop: 20000,
    mobile: 13000,
    min: 5000,
    max: 20000,
  },

  // tension: 0 = fist, 1 = open palm.
  // Below `closed` the flower is a bud; above `open` it is fully bloomed.
  // Deliberately shifted toward the ends so a relaxed / half-open hand only
  // reaches the middle of the transition: a fist closes, a *fully* open palm
  // blooms. This is the main "sensitivity" knob.
  tension: {
    closed: 0.48,
    open: 0.88,
    // adaptive EMA: opening reacts a little faster than closing
    smoothUp: 0.22,
    smoothDown: 0.15,
  },

  // The classic frame-rate dependent easing requested by the brief:
  // currentSpread += (targetSpread - currentSpread) * spreadEasing
  spreadEasing: 0.1,

  // When no hand is visible, the flower breathes at the edge of the closed
  // threshold: still a bud, but with enough movement to feel alive.
  idle: {
    baseTension: 0.52,
    breathAmplitude: 0.1,
    breathSpeed: 0.34,
  },

  camera: {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30, max: 60 },
    facingMode: 'user',
  },

  tracking: {
    /** Detection is deliberately capped below render rate to stay light. */
    intervalMs: 1000 / 30,
    minHandDetectionConfidence: 0.55,
    minHandPresenceConfidence: 0.55,
    minTrackingConfidence: 0.55,
    maxHands: 1,
  },

  scene: {
    fov: 45,
    fovMin: 38,
    bloomStrength: 0.4,
    bloomRadius: 0.58,
    bloomThreshold: 0.7,
    exposure: 1.04,
    /** Bloom is rendered at a fraction of canvas resolution for speed. */
    bloomScaleDesktop: 0.62,
    bloomScaleMobile: 0.48,
    maxDprDesktop: 2,
    maxDprMobile: 1.75,
  },

  colors: {
    ink: '#060509',
    ivory: '#f4eadb',
    rose: '#ff7d9c',
    coral: '#ff9a76',
    gold: '#ffc46f',
    plum: '#792548',
  },
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * Browser-only runtime tweaks. Query parameters make the piece easy to inspect:
 *   ?particles=7000   force a particle budget
 *   ?demo=1           open in pointer/auto demo mode after boot
 *   ?quality=low      reduce particle count and bloom cost
 */
export function resolveRuntime() {
  const params = new URLSearchParams(window.location.search);
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const narrow = Math.min(window.innerWidth, window.innerHeight) < 640;
  const mobile = coarse || narrow;
  const lowQuality = params.get('quality') === 'low';

  let particleCount = mobile ? CONFIG.particles.mobile : CONFIG.particles.desktop;
  const requested = Number.parseInt(params.get('particles') ?? '', 10);
  if (Number.isFinite(requested)) {
    particleCount = clamp(requested, CONFIG.particles.min, CONFIG.particles.max);
  }
  if (lowQuality) particleCount = Math.min(particleCount, 6500);

  const reducedMotion =
    params.get('reducedmotion') === '1' ||
    params.get('reduced-motion') === '1' ||
    (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);

  return {
    mobile,
    lowQuality,
    particleCount,
    reducedMotion,
    dpr: Math.min(
      window.devicePixelRatio || 1,
      mobile ? CONFIG.scene.maxDprMobile : CONFIG.scene.maxDprDesktop,
    ),
    bloomScale: mobile || lowQuality
      ? CONFIG.scene.bloomScaleMobile
      : CONFIG.scene.bloomScaleDesktop,
    startInDemo: params.get('demo') === '1' || params.get('nocamera') === '1',
  };
}
