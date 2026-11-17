/**
 * 太阳系 · 粒子天文台 — DOM / teaching UI layer.
 *
 * The UI owns no simulation state. `main.js` pushes state in and receives
 * intent through the handlers object. All copy is local; no network resources.
 */

import { PLANETS, SUN } from './data.js';

const TERRESTRIAL = new Set(['mercury', 'venus', 'earth', 'mars']);
const ICE_GIANT = new Set(['uranus', 'neptune']);

const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
const superscript = (n) => String(n).split('').map((c) => SUP[c] ?? c).join('');

const pct = (n, digits = 1) => `${n >= 0 ? '+' : ''}${n.toFixed(digits)}`;

function fmtNumber(value, digits = 0) {
  if (!Number.isFinite(Number(value))) return '—';
  return Number(value).toLocaleString('en-US', {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  });
}

function fmtMass(kg) {
  if (!Number.isFinite(kg)) return '—';
  if (kg >= 1e27) return `${(kg / 1e27).toFixed(3)} × 10${superscript(27)} kg`;
  if (kg >= 1e24) return `${(kg / 1e24).toFixed(3)} × 10${superscript(24)} kg`;
  if (kg >= 1e21) return `${(kg / 1e21).toFixed(2)} × 10${superscript(21)} kg`;
  return `${fmtNumber(kg)} kg`;
}

function fmtDays(days) {
  if (!Number.isFinite(days)) return '—';
  if (days >= 365.25 * 10) return `${(days / 365.25).toFixed(1)} 年`;
  if (days >= 365.25) return `${(days / 365.25).toFixed(2)} 年（${fmtNumber(days, 1)} 天）`;
  return `${days.toFixed(1)} 天`;
}

function fmtRotation(hours) {
  if (!Number.isFinite(hours)) return '—';
  const abs = Math.abs(hours);
  const sign = hours < 0 ? '逆行 · ' : '';
  if (abs >= 48) return `${sign}${(abs / 24).toFixed(1)} 天`;
  return `${sign}${abs.toFixed(1)} 小时`;
}

function planetGroup(planet) {
  if (planet.kind === 'star') return '恒星 · G2V MAIN SEQUENCE';
  if (planet.id === 'halley') return '周期彗星 · PERIODIC COMET';
  if (planet.id === 'moon') return '天然卫星 · NATURAL SATELLITE';
  if (TERRESTRIAL.has(planet.id)) return '类地行星 · TERRESTRIAL';
  if (planet.id === 'jupiter' || planet.id === 'saturn') return '气态巨行星 · GAS GIANT';
  if (ICE_GIANT.has(planet.id)) return '冰巨星 · ICE GIANT';
  return '行星 · PLANET';
}

function toneFor(planet) {
  return planet?.accent || planet?.palette?.accent || planet?.color || '#ffcf7a';
}

function el(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing required UI element #${id}`);
  return node;
}

function setText(node, text) {
  if (node && node.textContent !== text) node.textContent = text;
}

/**
 * @param {object} options
 * @param {HTMLElement} [options.root]
 * @param {Array} [options.planets]
 * @param {object} [options.handlers]
 */
export function createUI({ root = document.getElementById('app'), planets = PLANETS, railBodies = null, handlers = {} } = {}) {
  if (!root) throw new Error('Missing #app');

  const refs = {
    phaseHost: root,
    topbar: el('topbar'),
    hero: el('hero'),
    hud: el('hud'),
    planetList: el('planet-list'),
    planetButtons: el('planet-buttons'),
    rail: el('scene-nav'),
    start: el('start-btn'),
    demo: el('demo-btn'),
    statusChip: el('status-chip'),
    statusText: el('status-text'),
    date: el('date-value'),
    speedBtn: el('speed-btn'),
    speedValue: el('speed-value'),
    scaleToggle: el('scale-toggle'),
    scaleValue: el('scale-value'),
    particles: el('particles-value'),
    heroParticles: el('hero-particles'),
    fps: el('fps-value'),
    gestureCard: el('gesture-card'),
    gestureLabel: el('gesture-label'),
    gestureValue: el('gesture-value'),
    zoomValue: el('zoom-value'),
    gestureFill: el('gesture-fill'),
    pinchHint: el('pinch-hint'),
    hint: el('hint-text'),
    labels: el('body-labels'),

    focusTopbar: el('focus-topbar'),
    focusBack: el('focus-back'),
    focusPrev: el('focus-prev'),
    focusNext: el('focus-next'),
    focusOverview: el('focus-overview-btn'),
    focusPanel: el('focus-panel'),
    focusSymbol: el('focus-symbol'),
    focusNumber: el('focus-number'),
    focusType: el('focus-type'),
    focusName: el('focus-name'),
    focusEn: el('focus-en'),
    focusTagline: el('focus-tagline'),
    focusData: el('focus-data'),
    focusFacts: el('focus-facts'),
    focusZoom: el('focus-zoom'),
    focusOrbit: el('focus-orbit-btn'),
    crumbPlanet: el('crumb-planet'),

    distanceBand: el('distance-band'),
    distanceTrack: el('distance-track'),
    distanceSun: el('distance-sun'),
    distancePlanets: el('distance-planets'),
    distanceRuler: el('distance-ruler'),

    share: el('share-btn'),
    help: el('help-btn'),
    hudHelp: el('hud-help'),
    helpPanel: el('help-panel'),
    helpClose: el('help-close-btn'),

    loading: el('loading-panel'),
    loadingText: el('loading-text'),
    error: el('error-panel'),
    errorTitle: el('error-title'),
    errorMessage: el('error-message'),
    errorHint: el('error-hint'),
    errorCode: el('error-code'),
    retry: el('retry-btn'),
    errorDemo: el('error-demo-btn'),
    errorClose: el('error-close-btn'),
    toast: el('toast'),
  };

  const state = {
    phase: root.dataset.phase || 'intro',
    activeId: root.dataset.planet || 'earth',
    focusId: null,
    speedIndex: 3,
    scaleMode: 'demo',
    orbit: true,
    handVisible: false,
    shareBusy: false,
    toastTimer: 0,
    lastFocus: null,
    modal: null,
  };

  const planetById = new Map(planets.map((p) => [p.id, p]));
  const buttonById = new Map();
  const distanceById = new Map();
  const allBodies = [SUN, ...planets];

  // ---------------------------------------------------------------- planets
  function buildPlanetList() {
    refs.planetButtons.replaceChildren();
    buttonById.clear();
    const bodies = railBodies || planets;

    bodies.forEach((planet, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'planet-btn';
      button.dataset.planetId = planet.id;
      button.style.setProperty('--accent', toneFor(planet));
      button.setAttribute('aria-pressed', planet.id === state.activeId ? 'true' : 'false');
      const isSun = planet.id === 'sun';
      button.setAttribute('aria-label', `查看${planet.nameZh}特写`);
      button.innerHTML = `
        <span class="planet-btn__num">${isSun ? '00' : String(index).padStart(2, '0')}</span>
        <span class="planet-btn__name">${planet.nameZh}<em>${planet.nameEn}</em></span>
        <span class="planet-btn__meta">${isSun ? '中心恒星' : `${Number(planet.semiMajorAU).toFixed(2)} AU`}</span>
        <span class="planet-btn__dot" aria-hidden="true"></span>
      `;
      button.addEventListener('click', () => invoke('onPlanetSelect', planet.id));
      refs.planetButtons.append(button);
      buttonById.set(planet.id, button);
    });
  }

  function setActivePlanet(id) {
    state.activeId = id || state.activeId;
    for (const [planetId, button] of buttonById) {
      button.setAttribute('aria-pressed', planetId === state.activeId ? 'true' : 'false');
    }
    for (const [bodyId, node] of distanceById) {
      node.setAttribute('aria-current', bodyId === state.activeId ? 'true' : 'false');
    }
  }

  // ------------------------------------------------------------ focus panel
  function focusDataRows(planet) {
    if (planet.id === 'sun') {
      return [
        ['赤道半径', '695,700 km'],
        ['质量', '1.988 × 10³⁰ kg'],
        ['表面温度', '5,772 K'],
        ['核心温度', '约 1,570 万 K'],
        ['自转周期', '约 25.4 天（赤道）'],
        ['光谱型', 'G2V 主序星'],
        ['主要成分', '氢 ~90.9% · 氦 ~8.9%'],
        ['质量占比', '太阳系的 99.86%'],
        ['光到地球', '约 8 分 20 秒'],
        ['类型', '恒星'],
      ];
    }
    if (planet.id === 'halley') {
      return [
        ['彗核直径', '约 11 km'],
        ['轨道半长轴', `${Number(planet.semiMajorAU).toFixed(3)} AU`],
        ['偏心率', Number(planet.eccentricity).toFixed(3)],
        ['近日点', `${Number(planet.perihelionAU).toFixed(3)} AU`],
        ['远日点', `${Number(planet.aphelionAU).toFixed(2)} AU`],
        ['轨道倾角', `${Number(planet.inclinationDeg).toFixed(2)}°`],
        ['公转周期', `约 ${Number(planet.orbitalPeriodYears).toFixed(1)} 年`],
        ['上次近日点', planet.lastPerihelion],
        ['下次近日点', planet.nextPerihelion],
        ['彗核温度', `约 ${fmtNumber(planet.nucleusTempC)} °C`],
        ['彗尾方向', '背离太阳'],
        ['类型', '周期彗星'],
      ];
    }
    if (planet.id === 'moon') {
      return [
        ['赤道半径', '1,737.4 km'],
        ['质量', '7.342 × 10²² kg'],
        ['平均密度', '3,344 kg/m³'],
        ['表面重力', '1.62 m/s²'],
        ['逃逸速度', '2.38 km/s'],
        ['地月平均距离', '384,400 km'],
        ['公转周期', '27.32 天'],
        ['自转周期', '27.32 天（潮汐锁定）'],
        ['轨道倾角', '5.14°'],
        ['平均温度', '-20 °C'],
        ['反照率', '0.12'],
        ['类型', '天然卫星'],
      ];
    }
    const rows = [
      ['赤道半径', `${fmtNumber(planet.radiusKm)} km`],
      ['质量', fmtMass(planet.massKg)],
      ['平均密度', `${fmtNumber(planet.densityKgM3)} kg/m³`],
      ['表面重力', `${Number(planet.gravityMs2).toFixed(2)} m/s²`],
      ['逃逸速度', `${Number(planet.escapeKms).toFixed(1)} km/s`],
      ['平均日距', `${Number(planet.semiMajorAU).toFixed(3)} AU`],
      ['公转周期', fmtDays(planet.orbitalPeriodDays)],
      ['自转周期', fmtRotation(planet.rotationHours)],
      ['转轴倾角', `${Number(planet.obliquityDeg).toFixed(1)}°`],
      ['平均温度', `${fmtNumber(planet.tempC)} °C`],
      ['已知卫星', fmtNumber(planet.moons)],
      ['反照率', Number(planet.albedo).toFixed(2)],
    ];
    return rows;
  }

  function setFocusData(planet) {
    if (!planet) return;
    state.focusId = planet.id;
    state.activeId = planet.id;
    const index = planets.findIndex((p) => p.id === planet.id);
    setText(refs.focusSymbol, planet.symbol || '●');
    setText(
      refs.focusNumber,
      planet.id === 'moon'
        ? 'M / 01'
        : planet.id === 'sun'
          ? 'S / 01'
          : index >= 0
          ? `${String(index + 1).padStart(2, '0')} / ${String(planets.length).padStart(2, '0')}`
          : planet.number || 'C / 01',
    );
    setText(refs.focusType, planetGroup(planet));
    setText(refs.focusName, planet.nameZh);
    setText(refs.focusEn, planet.nameEn);
    setText(refs.focusTagline, focusTagline(planet));
    setText(refs.crumbPlanet, planet.nameEn.toUpperCase());
    root.style.setProperty('--scene-accent', toneFor(planet));
    refs.focusPanel.style.setProperty('--scene-accent', toneFor(planet));

    refs.focusData.replaceChildren();
    for (const [label, value] of focusDataRows(planet)) {
      const cell = document.createElement('div');
      cell.className = 'data-cell';
      const l = document.createElement('span');
      l.textContent = label;
      const v = document.createElement('strong');
      v.textContent = value;
      cell.append(l, v);
      refs.focusData.append(cell);
    }

    refs.focusFacts.replaceChildren();
    for (const fact of planet.facts || []) {
      const li = document.createElement('li');
      li.textContent = fact;
      refs.focusFacts.append(li);
    }

    setActivePlanet(planet.id);
    buildDistanceBand(planet.id);
  }

  function focusTagline(planet) {
    if (planet.tagline) return planet.tagline;
    const map = {
      sun: '太阳系唯一的恒星，以光和太阳风塑造整个行星系统。',
      mercury: '离太阳最近、昼夜温差最极端的岩石世界。',
      venus: '被厚重二氧化碳云层包裹的失控温室行星。',
      earth: '目前唯一已知拥有液态水海洋与生命的行星。',
      mars: '锈红色沙漠、极冠与巨大火山的寒冷世界。',
      jupiter: '太阳系质量之王，云带与风暴持续数个世纪。',
      saturn: '以冰粒环系统闻名的气态巨行星。',
      uranus: '侧躺自转的冰巨星，拥有暗淡的竖直环。',
      neptune: '风速超过 2,000 km/h 的深蓝冰巨星。',
    };
    return map[planet.id] || '太阳系中的一颗行星。';
  }

  function showFocus(planet) {
    if (!planet) return;
    setFocusData(planet);
    root.dataset.planet = planet.id;
    refs.focusPanel.scrollTop = 0;
  }

  function hideFocus() {
    state.focusId = null;
  }

  // ----------------------------------------------------------- distance band
  const MAX_AU = 31;
  const distancePosition = (au) => Math.min(99, Math.max(0, (au / MAX_AU) * 100));

  function buildDistanceBand(currentId = state.activeId) {
    refs.distancePlanets.replaceChildren();
    refs.distanceRuler.replaceChildren();
    distanceById.clear();

    for (const planet of planets) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'distance-planet';
      button.style.left = `${distancePosition(planet.semiMajorAU)}%`;
      button.style.setProperty('--accent', toneFor(planet));
      button.dataset.planetId = planet.id;
      button.setAttribute('aria-label', `${planet.nameZh}，平均距离 ${Number(planet.semiMajorAU).toFixed(2)} AU`);
      button.setAttribute('aria-current', planet.id === currentId ? 'true' : 'false');
      const short = Number(planet.semiMajorAU) < 2 ? planet.nameZh.slice(0, 1) : planet.nameZh;
      button.innerHTML = `
        <span class="distance-planet__dot" aria-hidden="true"></span>
        <span class="distance-planet__label">${short}</span>
        <span class="distance-planet__au">${Number(planet.semiMajorAU).toFixed(2)} AU</span>
      `;
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        invoke('onDistanceBody', planet.id);
      });
      refs.distancePlanets.append(button);
      distanceById.set(planet.id, button);
    }

    for (let au = 0; au <= 30; au += 5) {
      const tick = document.createElement('i');
      tick.style.left = `${distancePosition(au)}%`;
      refs.distanceRuler.append(tick);
    }
  }

  // -------------------------------------------------------------- gestures
  function setGesture(payload = {}) {
    const {
      label = state.handVisible ? '追踪中' : '待机',
      value = state.handVisible ? '手掌已连接' : '等待手掌',
      zoom = null,
      fill = 0,
      hint = null,
      handVisible = state.handVisible,
    } = payload;
    state.handVisible = Boolean(handVisible);
    root.dataset.hand = state.handVisible ? 'true' : 'false';
    setText(refs.gestureLabel, label);
    setText(refs.gestureValue, value);
    if (hint) setText(refs.pinchHint, hint);
    if (Number.isFinite(fill)) {
      refs.gestureFill.style.width = `${Math.min(100, Math.max(0, fill * 100))}%`;
    }
    if (zoom !== null) setZoom(zoom);
  }

  function setZoom(zoom) {
    const text = `${Number(zoom).toFixed(2)}×`;
    setText(refs.zoomValue, text);
    setText(refs.focusZoom, text);
  }

  // ------------------------------------------------------------------ chrome
  function setDate(value) {
    setText(refs.date, value);
  }

  function setSpeed(index, label) {
    state.speedIndex = Number(index);
    setText(refs.speedValue, label);
    refs.speedBtn.setAttribute('aria-label', `时间速度：${label}，点击切换`);
    refs.speedBtn.dataset.speedIndex = String(index);
  }

  function setScale(mode, label) {
    state.scaleMode = mode;
    setText(refs.scaleValue, label);
    refs.scaleToggle.setAttribute('aria-label', `距离比例：${label}，点击切换`);
    refs.scaleToggle.dataset.mode = mode;
  }

  function setParticles(count) {
    const label = fmtNumber(count);
    setText(refs.particles, label);
    setText(refs.heroParticles, label);
  }

  function setFps(fps) {
    setText(refs.fps, String(Math.max(0, Math.round(fps))));
  }

  function setStatus(text, tone = 'idle') {
    setText(refs.statusText, text);
    refs.statusChip.dataset.tone = tone;
  }

  function setPhase(phase) {
    state.phase = phase;
    root.dataset.phase = phase;
    if (phase === 'focus') {
      // Focus chrome is controlled entirely by CSS; data state is enough.
    }
    if (phase !== 'error') hideErrorModal();
    if (phase !== 'loading') refs.loading.hidden = true;
  }

  function setLoading(text = '正在加载本地手部模型…') {
    setText(refs.loadingText, text);
    refs.loading.hidden = false;
  }

  function setOverviewPlanets(list) {
    if (!Array.isArray(list) || !list.length) return;
    planets = list;
    planetById.clear();
    for (const p of planets) planetById.set(p.id, p);
    buildPlanetList();
    buildDistanceBand(state.activeId);
  }

  function setOrbit(enabled) {
    state.orbit = Boolean(enabled);
    const strong = refs.focusOrbit.querySelector('strong');
    if (strong) strong.textContent = state.orbit ? '开启' : '暂停';
    refs.focusOrbit.setAttribute('aria-pressed', state.orbit ? 'true' : 'false');
  }

  function setShareState(mode) {
    state.shareBusy = mode === 'busy';
    if (mode === 'done') {
      setText(refs.share, '链接已复制');
      window.setTimeout(() => {
        if (!state.shareBusy) setText(refs.share, '分享');
      }, 1800);
    } else if (mode === 'busy') {
      setText(refs.share, '生成链接…');
    } else {
      setText(refs.share, '分享');
    }
  }

  // ------------------------------------------------------------------ modals
  function captureModalFocus(modal) {
    state.lastFocus = document.activeElement;
    state.modal = modal;
    const focusable = modal.querySelector(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus({ preventScroll: true });
  }

  function releaseModalFocus() {
    state.modal = null;
    const target = state.lastFocus;
    state.lastFocus = null;
    if (target && document.contains(target)) target.focus({ preventScroll: true });
  }

  function showLoading(text) {
    if (text) setText(refs.loadingText, text);
    refs.loading.hidden = false;
    refs.error.hidden = true;
  }

  function hideLoading() {
    refs.loading.hidden = true;
  }

  function showError({ title = '摄像头未能启动', message = '浏览器阻止了摄像头访问。', hint = '', code = '' } = {}) {
    setText(refs.errorTitle, title);
    setText(refs.errorMessage, message);
    setText(refs.errorHint, hint);
    setText(refs.errorCode, code ? `CODE ${code}` : '');
    refs.error.hidden = false;
    refs.loading.hidden = true;
    root.dataset.phase = 'error';
    state.phase = 'error';
    captureModalFocus(refs.error);
  }

  function hideErrorModal() {
    if (refs.error.hidden) return;
    const wasModal = state.modal === refs.error;
    refs.error.hidden = true;
    if (wasModal) releaseModalFocus();
  }

  function hideError() {
    hideErrorModal();
  }

  function showHelp() {
    if (refs.helpPanel.hidden === false) return;
    refs.helpPanel.hidden = false;
    refs.help.setAttribute('aria-expanded', 'true');
    captureModalFocus(refs.helpPanel);
    invoke('onHelp');
  }

  function hideHelp() {
    if (refs.helpPanel.hidden) return;
    refs.helpPanel.hidden = true;
    refs.help.setAttribute('aria-expanded', 'false');
    if (state.modal === refs.helpPanel) releaseModalFocus();
    invoke('onHelpClose');
  }

  function toast(text, duration = 2600) {
    if (!text) return;
    window.clearTimeout(state.toastTimer);
    refs.toast.textContent = text;
    refs.toast.classList.add('is-visible');
    state.toastTimer = window.setTimeout(() => refs.toast.classList.remove('is-visible'), duration);
  }

  // ---------------------------------------------------------------- handlers
  function invoke(name, ...args) {
    const fn = handlers[name];
    if (typeof fn === 'function') fn(...args);
  }

  refs.start.addEventListener('click', () => invoke('onStart'));
  refs.demo.addEventListener('click', () => invoke('onDemo'));
  refs.retry.addEventListener('click', () => invoke('onRetry'));
  refs.errorDemo.addEventListener('click', () => invoke('onDemo'));
  refs.errorClose.addEventListener('click', () => invoke('onErrorClose'));
  refs.focusBack.addEventListener('click', () => invoke('onFocusBack'));
  refs.focusOverview.addEventListener('click', () => invoke('onFocusBack'));
  refs.focusPrev.addEventListener('click', () => invoke('onPrevPlanet'));
  refs.focusNext.addEventListener('click', () => invoke('onNextPlanet'));
  refs.speedBtn.addEventListener('click', () => invoke('onSpeed'));
  refs.scaleToggle.addEventListener('click', () => invoke('onScale'));
  refs.share.addEventListener('click', () => invoke('onShare'));
  refs.help.addEventListener('click', showHelp);
  refs.hudHelp.addEventListener('click', showHelp);
  refs.helpClose.addEventListener('click', hideHelp);
  refs.helpPanel.addEventListener('click', (event) => {
    if (event.target === refs.helpPanel) hideHelp();
    if (event.target.closest?.('[data-close-help]')) hideHelp();
  });
  refs.error.addEventListener('click', (event) => {
    if (event.target === refs.error) invoke('onErrorClose');
  });
  refs.focusOrbit.addEventListener('click', () => {
    setOrbit(!state.orbit);
    invoke('onToggleOrbit', state.orbit);
  });
  let lastSunAxisTap = 0;
  const selectSunFromAxis = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const now = performance.now();
    if (now - lastSunAxisTap < 450) return;
    lastSunAxisTap = now;
    invoke('onDistanceBody', 'sun');
  };
  refs.distanceSun.addEventListener('pointerdown', selectSunFromAxis);
  refs.distanceSun.addEventListener('click', selectSunFromAxis);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!refs.helpPanel.hidden) {
        event.preventDefault();
        hideHelp();
      } else if (!refs.error.hidden) {
        event.preventDefault();
        invoke('onErrorClose');
      }
    }
    if (event.key === 'Tab' && state.modal) {
      const focusable = [...state.modal.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )].filter((node) => !node.disabled && node.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });

  // ------------------------------------------------------------------- boot
  buildPlanetList();
  buildDistanceBand(state.activeId);
  setParticles(0);
  setActivePlanet(state.activeId);

  return Object.freeze({
    state,
    setPhase,
    setLoading,
    showLoading,
    hideLoading,
    setStatus,
    setDate,
    setSpeed,
    setScale,
    setParticles,
    setFps,
    setOverviewPlanets,
    setActivePlanet,
    showFocus,
    hideFocus,
    setFocusData,
    setDistanceBand: (currentId) => buildDistanceBand(currentId || state.activeId),
    setGesture,
    setZoom,
    setOrbit,
    showError,
    hideError,
    showHelp,
    hideHelp,
    toast,
    setShareState,
    setHint: (text) => setText(refs.hint, text),
    setLabels: (nodes) => {
      const host = refs.labels;
      if (!host) return;
      host.replaceChildren(...nodes);
    },
    get activePlanetId() { return state.activeId; },
  });
}
