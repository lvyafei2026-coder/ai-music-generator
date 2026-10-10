(function () {
  var DEFAULT_LANG = 'en';
  var SUPPORTED = ['en', 'zh'];
  var STORAGE_KEY = 'lang';
  var cache = {};

  function getBase() {
    return '';
  }

  function getLang() {
    var params = new URLSearchParams(window.location.search);
    var fromUrl = params.get('lang');
    if (fromUrl && SUPPORTED.indexOf(fromUrl) !== -1) return fromUrl;

    var stored = localStorage.getItem(STORAGE_KEY);
    if (stored && SUPPORTED.indexOf(stored) !== -1) return stored;

    return DEFAULT_LANG;
  }

  function loadLocale(lang) {
    if (cache[lang]) return Promise.resolve(cache[lang]);
    var base = getBase();
    return fetch(base + '/locales/' + lang + '.json')
      .then(function (r) { return r.json(); })
      .then(function (data) { cache[lang] = data; return data; });
  }

  function apply(t) {
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      var key = el.getAttribute('data-i18n');
      if (t[key] !== undefined) el.textContent = t[key];
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      var key = el.getAttribute('data-i18n-placeholder');
      if (t[key] !== undefined) el.setAttribute('placeholder', t[key]);
    });
    document.querySelectorAll('[data-i18n-html]').forEach(function (el) {
      var key = el.getAttribute('data-i18n-html');
      if (t[key] !== undefined) el.innerHTML = t[key];
    });
  }

  function init() {
    var lang = getLang();
    document.documentElement.lang = lang === 'zh' ? 'zh-Hans' : 'en';
    loadLocale(lang).then(function (t) {
      apply(t);
      window.__i18n = { lang: lang, t: t };
      var sel = document.getElementById('langSelect');
      if (sel) sel.value = lang;
      document.dispatchEvent(new Event('i18n-ready'));
    }).catch(function (err) {
      console.error('i18n load failed:', err);
    });
  }

  window.setLang = function (lang) {
    if (SUPPORTED.indexOf(lang) === -1) lang = DEFAULT_LANG;
    localStorage.setItem(STORAGE_KEY, lang);
    var url = new URL(window.location.href);
    url.searchParams.set('lang', lang);
    window.location.href = url.toString();
  };

  document.addEventListener('DOMContentLoaded', init);
})();