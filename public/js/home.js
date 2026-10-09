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
      src: 'demo/chinese-pop.mp3'
    },
    {
      emoji: '🎹',
      tagKey: 'demoInstrumental',
      tagFallback: 'Instrumental',
      titleKey: 'demoTag1',
      titleFallback: 'Warm jazz piano',
      coverClass: 'preview-cover-jazz',
      src: 'demo/jazz-piano.mp3'
    }
  ];

  var demoIndex = 0;
  var demoTimer = null;
  var AUTO_MS = 12000;

  function t(key, fallback) {
    return (window.__i18n && window.__i18n.t && window.__i18n.t[key]) || fallback || key;
  }

  function renderDots() {
    var dots = document.querySelectorAll('#previewDots .preview-dot');
    dots.forEach(function (d, i) {
      d.classList.toggle('active', i === demoIndex);
    });
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

    audio.pause();
    audio.src = d.src;
    audio.load();
    renderDots();
  }

  function resetAuto() {
    if (demoTimer) clearInterval(demoTimer);
    demoTimer = setInterval(function () {
      demoIndex = (demoIndex + 1) % DEMOS.length;
      renderDemo(demoIndex);
    }, AUTO_MS);
  }

  window.previewNext = function () {
    demoIndex = (demoIndex + 1) % DEMOS.length;
    renderDemo(demoIndex);
    resetAuto();
  };
  window.previewPrev = function () {
    demoIndex = (demoIndex - 1 + DEMOS.length) % DEMOS.length;
    renderDemo(demoIndex);
    resetAuto();
  };
  window.previewGo = function (i) {
    if (i < 0 || i >= DEMOS.length) return;
    demoIndex = i;
    renderDemo(demoIndex);
    resetAuto();
  };

  // ---------- 波形动画 ----------
  // 播放时动，暂停时停
  function initWave() {
    var wave = document.getElementById('previewWave');
    var audio = document.getElementById('previewAudio');
    if (!wave || !audio) return;

    // 生成 32 根细条
    var N = 32;
    var bars = [];
    for (var i = 0; i < N; i++) {
      var bar = document.createElement('span');
      bar.className = 'preview-wave-bar';
      // 每根条给一个随机的动画延迟和时长，看起来更自然
      bar.style.animationDelay = (Math.random() * 1.2).toFixed(2) + 's';
      bar.style.animationDuration = (0.7 + Math.random() * 0.8).toFixed(2) + 's';
      wave.appendChild(bar);
      bars.push(bar);
    }

    function play() { wave.classList.add('playing'); }
    function pause() { wave.classList.remove('playing'); }

    audio.addEventListener('play', play);
    audio.addEventListener('pause', pause);
    audio.addEventListener('ended', pause);
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

  document.addEventListener('i18n-ready', function () {
    renderDemo(0);
    resetAuto();
    initWave();

    var input = document.getElementById('heroPrompt');
    if (input) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') window.startFromHero();
      });
    }
  });
})();