// Shared client script: theme restore, header/footer injection, landing page 3D tilt.
(function () {
  var root = document.documentElement;
  var KEY = 'glassy-ui-preferences';
  var prefs = {};
  try { prefs = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) {}
  root.setAttribute('data-lg-theme', prefs.theme === 'dark' ? 'dark' : 'light');
  root.setAttribute('data-lg-mode', 'clear');

  var LOGO = '<svg width="24" height="24" viewBox="0 0 24 24" role="img" aria-label="Instagram"><defs><radialGradient id="ig" cx="0.3" cy="1.05" r="1.15"><stop offset="0" stop-color="#feda75"/><stop offset=".25" stop-color="#fa7e1e"/><stop offset=".5" stop-color="#d62976"/><stop offset=".75" stop-color="#962fbf"/><stop offset="1" stop-color="#4f5bd5"/></radialGradient></defs><rect x="1" y="1" width="22" height="22" rx="6.2" fill="url(#ig)"/><rect x="4.9" y="4.9" width="14.2" height="14.2" rx="4.4" fill="none" stroke="#fff" stroke-width="1.7"/><circle cx="12" cy="12" r="3.3" fill="none" stroke="#fff" stroke-width="1.7"/><circle cx="16.4" cy="7.6" r="1" fill="#fff"/></svg>';
  var SURFACE = 'lg-glass-surface';

  function button(href, label, variant, size) {
    return '<a href="' + href + '" class="lg-button lg-button--' + variant + ' lg-button--' + size + '">' +
      '<span class="lg-button__layers" aria-hidden="true"><span class="lg-button__light"></span><span class="lg-button__distortion"></span><span class="lg-button__tint"></span><span class="lg-button__shine"></span><span class="lg-button__bloom"></span><span class="lg-button__rim"></span></span>' +
      '<span class="lg-button__label">' + label + '</span></a>';
  }
  window.gpButton = button;
  window.gpLogo = function (size) { return LOGO.replace('width="24" height="24"', 'width="' + size + '" height="' + size + '"'); };

  function mount() {
    var signedIn = document.body.dataset.signedIn === 'true';
    var header = document.createElement('header');
    header.className = SURFACE + ' lg-panel--pill gp-header';
    header.setAttribute('data-lg-preset', 'control');
    header.setAttribute('data-lg-refraction', 'none');
    header.innerHTML =
      '<a class="gp-brand" href="/">' + LOGO + 'GlassPost</a>' +
      '<nav class="gp-nav" aria-label="Primary"><a href="/#features">Features</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav>' +
      '<button class="gp-toggle" type="button" aria-label="Toggle light and dark theme">◐</button>' +
      button(signedIn ? '/dashboard' : '/api/auth/instagram', signedIn ? 'Open dashboard' : 'Connect Instagram', 'prominent', 'sm');
    document.body.prepend(header);

    header.querySelector('.gp-toggle').addEventListener('click', function () {
      var next = root.getAttribute('data-lg-theme') === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-lg-theme', next);
      prefs.theme = next;
      try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch (e) {}
    });

    var footer = document.createElement('footer');
    footer.className = 'gp-container gp-muted';
    footer.style.cssText = 'padding:48px 0 64px;font-size:14px;display:flex;flex-wrap:wrap;gap:20px;justify-content:space-between';
    footer.innerHTML = '<span>© ' + new Date().getFullYear() + ' GlassPost. Not affiliated with or endorsed by Instagram or Meta.</span>' +
      '<nav aria-label="Legal" style="display:flex;gap:18px"><a href="/privacy">Privacy policy</a><a href="/terms">Terms of service</a><a href="/data-deletion">Data deletion</a></nav>';
    document.body.append(footer);

    // Landing page: sign-in error message.
    var error = new URLSearchParams(location.search).get('error');
    var slot = document.getElementById('error');
    if (error && slot) { slot.textContent = error; slot.hidden = false; }

    // Landing page: pointer-driven 3D tilt.
    var stage = document.getElementById('phone-stage');
    var phone = document.getElementById('phone');
    if (stage && phone) {
      stage.addEventListener('pointermove', function (e) {
        var b = stage.getBoundingClientRect();
        phone.style.setProperty('--ry', (-16 + ((e.clientX - b.left) / b.width - 0.5) * 26) + 'deg');
        phone.style.setProperty('--rx', (8 - ((e.clientY - b.top) / b.height - 0.5) * 20) + 'deg');
      });
      stage.addEventListener('pointerleave', function () {
        phone.style.setProperty('--ry', '-16deg');
        phone.style.setProperty('--rx', '8deg');
      });
    }
  }

  function start() {
    // Marketing pages show "Open dashboard" when a valid session exists.
    fetch('/api/me', { cache: 'no-store' })
      .then(function (r) { document.body.dataset.signedIn = r.ok ? 'true' : 'false'; })
      .catch(function () {})
      .then(mount);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
