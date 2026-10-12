// Preserve custom Gravatar, QQ, GitHub and uploaded avatars when they load.
// When an avatar cannot be fetched, show a same-origin placeholder instead.
const DEFAULT_AVATAR_URL = '/img/avatar.png';

document.addEventListener('error', (event) => {
  const image = event.target;
  if (image?.tagName !== 'IMG') return;
  if (!image.hasAttribute('data-avatar-fallback') && !image.classList.contains('user-profile-avatar')) return;
  // Avoid infinite retries if the local placeholder itself cannot be loaded.
  if (image.getAttribute('src') === DEFAULT_AVATAR_URL) return;
  image.removeAttribute('srcset');
  image.src = DEFAULT_AVATAR_URL;
}, true);
