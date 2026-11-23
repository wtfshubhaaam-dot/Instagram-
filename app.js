// Page logic: landing buttons, data-deletion status and the dashboard (plain DOM, no framework).
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var safeUrl = function (url) { return /^https:\/\//.test(url) ? esc(url) : ''; };

  /* Landing page */
  if ($('cta')) {
    $('cta').innerHTML = window.gpButton('/api/auth/instagram', 'Connect Instagram', 'prominent', 'lg') +
      window.gpButton('#features', 'See how it works', 'soft', 'lg');
    $('ig-mini').innerHTML = window.gpLogo(20);
  }

  /* Data deletion confirmation */
  if ($('status')) {
    var code = new URLSearchParams(location.search).get('code');
    if (code) {
      fetch('/api/deletion-status?code=' + encodeURIComponent(code))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          $('status').innerHTML = '<p>' + (d.found
            ? 'Your data deletion request (' + esc(code) + ') has been completed. Your account, tokens and scheduled posts were removed.'
            : 'We could not find that confirmation code.') + '</p>';
        });
    }
  }

  /* Dashboard */
  if (!$('composer')) return;

  var LABELS = { scheduled: 'Scheduled', processing: 'Publishing', published: 'Published', failed: 'Needs attention' };
  var TONES = { scheduled: 'blue', processing: 'orange', published: 'green', failed: 'red' };
  var mediaType = 'IMAGE';

  function pad(n) { return String(n).padStart(2, '0'); }
  function localInput(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  $('when').value = localInput(new Date(Date.now() + 3600000));

  function say(tone, text) {
    var box = $('message');
    box.hidden = !text;
    box.dataset.tone = tone;
    box.textContent = text || '';
  }

  fetch('/api/me', { cache: 'no-store' }).then(function (r) {
    if (!r.ok) { location.href = '/'; return null; }
    return r.json();
  }).then(function (me) {
    if (!me) return;
    var days = Math.ceil((new Date(me.tokenExpiresAt).getTime() - Date.now()) / 86400000);
    var avatar = me.avatar && /^https:\/\//.test(me.avatar)
      ? '<img src="' + safeUrl(me.avatar) + '" alt="" width="44" height="44" style="border-radius:99px">'
      : window.gpLogo(44);
    $('account').innerHTML = avatar +
      '<div style="flex:1"><strong style="font-size:18px">@' + esc(me.username) + '</strong>' +
      '<div class="gp-muted" style="font-size:14px">Connected' + (days < 7 ? ', token renews automatically (' + days + ' days left)' : '') + '</div></div>' +
      '<form action="/api/auth/logout" method="post"><button type="submit" class="lg-button lg-button--soft lg-button--sm"><span class="lg-button__label">Sign out</span></button></form>';
  });

  document.querySelectorAll('.gp-seg button').forEach(function (b) {
    b.addEventListener('click', function () {
      mediaType = b.dataset.type;
      document.querySelectorAll('.gp-seg button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      var photo = mediaType === 'IMAGE';
      $('file').accept = photo ? 'image/jpeg' : 'video/mp4,video/quicktime';
      $('file').value = '';
      $('file-label').textContent = photo ? 'Photo (JPEG, up to 8 MB)' : 'Video (MP4 or MOV, up to 300 MB)';
    });
  });
  $('caption').addEventListener('input', function () { $('count').textContent = $('caption').value.length.toLocaleString() + ' / 2,200'; });

  function render(posts) {
    var queue = $('queue');
    if (!posts.length) { queue.innerHTML = '<li class="gp-muted">Nothing scheduled yet. Upload your first post to see it here.</li>'; return; }
    queue.innerHTML = posts.map(function (p) {
      var media = p.media_type === 'IMAGE'
        ? '<img class="gp-thumb" src="' + safeUrl(p.media_url) + '" alt="">'
        : '<video class="gp-thumb" src="' + safeUrl(p.media_url) + '" muted preload="metadata"></video>';
      var when = new Date(p.scheduled_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
      return '<li class="gp-post">' + media +
        '<div style="min-width:0"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="lg-badge" data-tone="' + TONES[p.status] + '">' + LABELS[p.status] + '</span><span style="font-size:14px">' + esc(when) + '</span></div>' +
        '<div class="gp-muted" style="font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (esc(p.caption) || 'No caption') + '</div>' +
        (p.error ? '<div style="font-size:13px;color:var(--lg-invalid)">' + esc(p.error) + '</div>' : '') + '</div>' +
        '<div style="display:flex;gap:8px">' +
        (p.permalink && /^https:\/\//.test(p.permalink) ? '<a class="lg-button lg-button--soft lg-button--sm" href="' + safeUrl(p.permalink) + '" target="_blank" rel="noreferrer"><span class="lg-button__label">View</span></a>' : '') +
        (p.status !== 'processing' ? '<button type="button" class="lg-button lg-button--ghost lg-button--sm" data-remove="' + esc(p.id) + '"><span class="lg-button__label">' + (p.status === 'scheduled' ? 'Cancel' : 'Remove') + '</span></button>' : '') +
        '</div></li>';
    }).join('');
  }

  function load() {
    return fetch('/api/posts', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) { if (d) render(d.posts); });
  }
  $('queue').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-remove]');
    if (btn) fetch('/api/posts/' + btn.dataset.remove, { method: 'DELETE' }).then(load);
  });
  load();
  setInterval(load, 30000);

  $('composer').addEventListener('submit', async function (event) {
    event.preventDefault();
    say('', '');
    var file = $('file').files[0];
    if (!file) return say('danger', 'Choose a file to upload.');
    var submit = $('submit');
    submit.disabled = true;
    submit.querySelector('.lg-button__label').textContent = 'Uploading and scheduling...';
    try {
      var sign = await fetch('/api/uploads/sign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contentType: file.type, size: file.size }) });
      var signed = await sign.json();
      if (!sign.ok) throw new Error(signed.error);
      var upload = await fetch(signed.uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
      if (!upload.ok) throw new Error('The upload failed. Check the storage CORS settings.');
      var create = await fetch('/api/posts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caption: $('caption').value, mediaType: mediaType, mediaUrl: signed.publicUrl, scheduledAt: new Date($('when').value).toISOString() }) });
      var created = await create.json();
      if (!create.ok) throw new Error(created.error);
      $('file').value = '';
      $('caption').value = '';
      $('count').textContent = '0 / 2,200';
      say('success', 'Scheduled. It will publish automatically at the chosen time.');
      await load();
    } catch (error) {
      say('danger', error && error.message ? error.message : 'Something went wrong.');
    } finally {
      submit.disabled = false;
      submit.querySelector('.lg-button__label').textContent = 'Schedule post';
    }
  });
})();
