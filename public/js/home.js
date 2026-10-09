(function () {
  var API_BASE = '/ai-music-generator';
  var STORAGE_KEY = 'pendingPrompt';

  // ---------- 预览卡轮播 ----------
  var DEMOS = [
    {
      emoji: '🎤',
      tagKey: 'demoVocal',
      tagFallback: 'With vocals',
      titleKey: 'demoTag2',
      titleFallback: 'Chinese pop ballad',
      coverClass: 'preview-cover-pop',
      src: 'https://toolara.dev/ai-music-generator/api/audio/music/usr_63b993afc756d95b5fd41b62/2d2c630d-f017-4ba2-b730-9163fb4bb81e.mp3'
    },
    {
      emoji: '🎹',
      tagKey: 'demoInstrumental',
      tagFallback: 'Instrumental',
      titleKey: 'demoTag1',
      titleFallback: 'Warm jazz piano',
      coverClass: 'preview-cover-jazz',
      src: 'https://toolara.dev/ai-music-generator/api/audio/music/usr_63b993afc756d95b5fd41b62/f50105c1-117e-41be-8fc8-7093ecb0a54b.mp3'
    }
  ];

  var demoIndex = 0;
  var demoTimer = null;

  function t(key, fallback) {
    return (window.__i18n && window.__i18n.t && window.__i18n.t[key]) || fallback || key;
  }

  function renderDemo(i) {
    var d = DEMOS[i];
    var cover = document.getElementById('previewCover');
    var emoji = document.getElementById('previewEmoji');
    var tag = document.getElementById('previewTag');
    var title = document.getElementById('previewTitle');
    var audio = document.getElementById('previewAudio');
    if (!cover || !audio) return;

    cover.className = 'preview-cover ' + d.coverClass;
    emoji.textContent = d.emoji;
    tag.textContent = t(d.tagKey, d.tagFallback);
    title.textContent = t(d.titleKey, d.titleFallback);

    // 切换音频源，重置播放
    audio.pause();
    audio.src = d.src;
    audio.load();
  }

  function startCarousel() {
    if (demoTimer) clearInterval(demoTimer);
    demoTimer = setInterval(function () {
      demoIndex = (demoIndex + 1) % DEMOS.length;
      renderDemo(demoIndex);
    }, 8000);
  }

  function initCarousel() {
    renderDemo(0);
    startCarousel();
  }

  // ---------- 首屏输入框跳转 ----------
  window.startFromHero = function () {
    var input = document.getElementById('heroPrompt');
    var prompt = input ? input.value.trim() : '';

    fetch(API_BASE + '/api/auth/me')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        var loggedIn = data && data.user;
        if (loggedIn) {
          var url = 'dashboard.html';
          if (prompt) url += '?prompt=' + encodeURIComponent(prompt);
          window.location.href = url;
        } else {
          if (prompt) localStorage.setItem(STORAGE_KEY, prompt);
          window.location.href = 'login.html';
        }
      })
      .catch(function () {
        if (prompt) localStorage.setItem(STORAGE_KEY, prompt);
        window.location.href = 'login.html';
      });
  };

  // 回车触发
  document.addEventListener('i18n-ready', function () {
    initCarousel();
    var input = document.getElementById('heroPrompt');
    if (input) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') window.startFromHero();
      });
    }
  });
})();