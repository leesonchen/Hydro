import './maintenance.page.styl';

import { AutoloadPage } from 'vj/misc/Page';
import { i18n } from 'vj/utils';

interface MaintenanceState {
  state: 'inactive' | 'scheduled' | 'active';
  id?: string;
  startAt?: number;
  message?: string;
}

const POLL_INTERVAL = 60000;
const defaultMessage = 'The system will enter maintenance soon. Please save your work.';
let banner: HTMLDivElement;
let bannerObserver: ResizeObserver;
let countdownTimer: number;
let redirectTimer: number;
let currentState: MaintenanceState;

function formatRemaining(ms: number) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds < 60) return i18n('{0} seconds', seconds);
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return i18n('{0} minutes', minutes);
  return i18n('{0} hours', Math.ceil(minutes / 60));
}

function updateBannerOffset() {
  document.documentElement.style.setProperty('--hydro-maintenance-height', `${banner?.getBoundingClientRect().height || 0}px`);
}

function ensureBanner() {
  if (banner) return banner;
  banner = document.createElement('div');
  banner.className = 'hydro-maintenance-banner';
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'polite');
  banner.innerHTML = '<span class="hydro-maintenance-banner__message"></span>'
    + '<span class="hydro-maintenance-banner__countdown"></span>';
  document.body.prepend(banner);
  bannerObserver = new ResizeObserver(updateBannerOffset);
  bannerObserver.observe(banner);
  return banner;
}

function removeBanner() {
  currentState = null;
  if (countdownTimer) window.clearInterval(countdownTimer);
  if (redirectTimer) window.clearTimeout(redirectTimer);
  countdownTimer = undefined;
  redirectTimer = undefined;
  bannerObserver?.disconnect();
  bannerObserver = undefined;
  document.documentElement.style.removeProperty('--hydro-maintenance-height');
  banner?.remove();
  banner = undefined;
}

function updateBanner() {
  if (!currentState || currentState.state === 'inactive') {
    removeBanner();
    return;
  }
  const dom = ensureBanner();
  const message = dom.querySelector('.hydro-maintenance-banner__message') as HTMLElement;
  const countdown = dom.querySelector('.hydro-maintenance-banner__countdown') as HTMLElement;
  message.textContent = currentState.message || i18n(
    currentState.state === 'active'
      ? 'The system is entering maintenance. Please save your work.'
      : defaultMessage,
  );
  if (currentState.state === 'active') {
    dom.classList.add('hydro-maintenance-banner--active');
    countdown.textContent = i18n('Redirecting to the maintenance page.');
    updateBannerOffset();
    redirectTimer ||= window.setTimeout(() => {
      window.location.assign('/maintain.html');
    }, 500);
    return;
  }
  countdownTimer ||= window.setInterval(updateBanner, 1000);
  dom.classList.remove('hydro-maintenance-banner--active');
  const remaining = Number(currentState.startAt) - Date.now();
  countdown.textContent = Number.isFinite(remaining) && remaining > 0
    ? i18n('Maintenance starts in {0}.', formatRemaining(remaining))
    : i18n('Maintenance starts soon.');
  updateBannerOffset();
}

function startCountdown() {
  if (countdownTimer) window.clearInterval(countdownTimer);
  countdownTimer = window.setInterval(updateBanner, 1000);
}

async function poll() {
  try {
    const url = new URL('/maintenance.json', window.location.href);
    url.searchParams.set('_', Date.now().toString());
    const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) return;
    const state = await response.json() as MaintenanceState;
    if (!['inactive', 'scheduled', 'active'].includes(state.state)) return;
    currentState = state;
    updateBanner();
  } catch (e) {
    // Maintenance status is an optional static endpoint. Retry on the next poll.
  }
}

export default new AutoloadPage('maintenancePage', () => {
  if (!UserContext?._id || (window as any).__hydroMaintenanceInitialized) return;
  (window as any).__hydroMaintenanceInitialized = true;
  startCountdown();
  poll();
  window.setInterval(poll, POLL_INTERVAL);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) poll();
  });
});
