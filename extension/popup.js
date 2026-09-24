;(function () {
  'use strict'
  var DEFAULT_SERVER = 'http://localhost:8787'
  var input = document.getElementById('serverUrl')
  var status = document.getElementById('status')
  var openStudio = document.getElementById('openStudio')

  function normalizeBase(value) {
    var text = String(value || '').trim().replace(/\/+$/, '')
    return /^https?:\/\/[^\s]+$/i.test(text) ? text : DEFAULT_SERVER
  }

  function check(base) {
    status.className = 'status'
    status.textContent = 'Mengecek ' + base + ' ...'
    openStudio.href = base + '/#ugc'
    fetch(base + '/api/health', { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status)
        return res.json()
      })
      .then(function (data) {
        status.className = 'status ok'
        status.textContent = '● UGC Studio online' + (data && data.version ? ' (v' + data.version + ')' : '')
      })
      .catch(function () {
        status.className = 'status bad'
        status.textContent = '● UGC Studio offline. Jalankan KLIK-DISINI-UNTUK-MULAI.bat dulu.'
      })
  }

  chrome.storage.local.get({ serverUrl: DEFAULT_SERVER }, function (items) {
    var base = normalizeBase(items && items.serverUrl)
    input.value = base
    check(base)
  })

  document.getElementById('save').addEventListener('click', function () {
    var base = normalizeBase(input.value)
    input.value = base
    chrome.storage.local.set({ serverUrl: base }, function () {
      check(base)
    })
  })
})()
