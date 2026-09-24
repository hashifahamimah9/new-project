;(function () {
  'use strict'
  // UGC Flow Connector - panel bantu di Google Flow (flow.google.com).
  // Mengambil skrip scene aktif dari UGC Flow Studio (server lokal) lalu
  // memasukkan prompt ke kotak prompt Flow dengan satu klik.
  var DEFAULT_SERVER = 'http://localhost:8787'
  var POLL_MS = 5000

  var serverBase = DEFAULT_SERVER
  var lastSignature = ''
  var isMinimized = false

  function loadServerBase(done) {
    try {
      if (window.chrome && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get({ serverUrl: DEFAULT_SERVER }, function (items) {
          serverBase = normalizeBase(items && items.serverUrl)
          done()
        })
        return
      }
    } catch (err) {
      // storage tidak tersedia, pakai default
    }
    done()
  }

  function normalizeBase(value) {
    var text = String(value || '').trim().replace(/\/+$/, '')
    return /^https?:\/\/[^\s]+$/i.test(text) ? text : DEFAULT_SERVER
  }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
    })
  }

  function createUI() {
    if (document.getElementById('ugc-flow-panel')) return

    var panel = document.createElement('div')
    panel.id = 'ugc-flow-panel'
    panel.innerHTML =
      '<div id="ugc-flow-header">' +
      '<div id="ugc-flow-title">' +
      '<span class="ugc-flow-dot" id="ugc-dot"></span>' +
      '<span>UGC Studio Assistant</span>' +
      '</div>' +
      '<button id="ugc-btn-min" type="button" style="background:none;border:none;color:#A0A5B5;cursor:pointer;font-size:16px;">—</button>' +
      '</div>' +
      '<div id="ugc-flow-body">' +
      '<div id="ugc-status" style="font-size:12px;color:#A0A5B5;">Menghubungkan ke UGC Studio...</div>' +
      '<div id="ugc-scenes-container"></div>' +
      '</div>'
    document.body.appendChild(panel)

    document.getElementById('ugc-flow-header').addEventListener('click', function (e) {
      if (e.target.id === 'ugc-btn-min' || e.currentTarget === e.target) {
        isMinimized = !isMinimized
        panel.classList.toggle('minimized', isMinimized)
        document.getElementById('ugc-flow-body').style.display = isMinimized ? 'none' : 'flex'
        document.getElementById('ugc-btn-min').textContent = isMinimized ? '+' : '—'
      }
    })

    loadServerBase(function () {
      fetchData()
      setInterval(function () {
        if (!document.hidden) fetchData()
      }, POLL_MS)
    })
  }

  function fetchJson(base) {
    return fetch(base + '/api/extension/active-scenes', { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json()
    })
  }

  function fetchData() {
    fetchJson(serverBase)
      .catch(function (err) {
        // localhost kadang tidak ter-resolve ke IPv4, coba 127.0.0.1
        if (serverBase.indexOf('//localhost') === -1) throw err
        var alt = serverBase.replace('//localhost', '//127.0.0.1')
        return fetchJson(alt).then(function (data) {
          serverBase = alt
          return data
        })
      })
      .then(function (data) {
        var dot = document.getElementById('ugc-dot')
        if (dot) dot.className = 'ugc-flow-dot'
        var signature = JSON.stringify([data && data.product, data && data.updatedAt, data && data.scenes])
        if (signature === lastSignature) return
        lastSignature = signature
        renderScenes(data)
      })
      .catch(function () {
        lastSignature = ''
        var dot = document.getElementById('ugc-dot')
        if (dot) dot.className = 'ugc-flow-dot offline'
        var status = document.getElementById('ugc-status')
        if (status) {
          status.innerHTML =
            '<span style="color:#E86A5E">UGC Studio offline</span>. Pastikan server aktif di ' +
            esc(serverBase) +
            ' (jalankan KLIK-DISINI-UNTUK-MULAI.bat).'
        }
        var container = document.getElementById('ugc-scenes-container')
        if (container) container.innerHTML = ''
      })
  }

  function sceneByIndex(data, idx) {
    for (var i = 0; i < data.scenes.length; i++) {
      if (Number(data.scenes[i].index) === idx) return data.scenes[i]
    }
    return null
  }

  function renderScenes(data) {
    var container = document.getElementById('ugc-scenes-container')
    var status = document.getElementById('ugc-status')
    if (!container) return

    if (!data || !Array.isArray(data.scenes) || !data.scenes.length) {
      if (status) status.textContent = 'Belum ada skrip. Buat skrip dulu di UGC Studio!'
      container.innerHTML = ''
      return
    }

    if (status) {
      status.innerHTML =
        'Produk: <strong style="color:#5E9FE8">' + esc(data.product || 'Produk') + '</strong> (' + data.scenes.length + ' scene)'
    }

    var html = ''
    data.scenes.forEach(function (scene, position) {
      var idx = Number(scene.index) || position + 1
      scene.index = idx
      html +=
        '<div class="ugc-scene-card">' +
        '<div class="ugc-scene-head">' +
        '<span>SCENE ' + esc(idx) + ' (' + esc(scene.duration || 5) + 's)</span>' +
        '<span>' + esc(scene.motion || 'cinematic') + '</span>' +
        '</div>' +
        '<div class="ugc-scene-prompt" title="' + esc(scene.prompt) + '">' + esc(scene.prompt) + '</div>' +
        '<div class="ugc-scene-actions">' +
        '<button type="button" class="ugc-btn ugc-btn-primary" data-inject="' + esc(idx) + '">⚡ Masukkan &amp; Generate</button>' +
        '<button type="button" class="ugc-btn ugc-btn-ghost" data-copy="' + esc(idx) + '" title="Salin Prompt">📋 Salin</button>' +
        '</div>' +
        '</div>'
    })
    container.innerHTML = html

    container.querySelectorAll('[data-inject]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = Number(btn.getAttribute('data-inject'))
        var scene = sceneByIndex(data, idx)
        if (scene) injectPromptAndGenerate(scene.prompt || '', idx)
      })
    })

    container.querySelectorAll('[data-copy]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = Number(btn.getAttribute('data-copy'))
        var scene = sceneByIndex(data, idx)
        if (!scene) return
        copyText(scene.prompt || '').then(
          function () {
            showToast('Prompt Scene ' + idx + ' berhasil disalin!')
          },
          function () {
            showToast('Gagal menyalin otomatis. Blok teks prompt lalu tekan Ctrl + C.')
          },
        )
      })
    })
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text)
    return Promise.reject(new Error('clipboard tidak tersedia'))
  }

  function visible(el) {
    return Boolean(el && (el.offsetParent !== null || el.getClientRects().length))
  }

  function outsidePanel(el) {
    return el && el.id !== 'ugc-flow-panel' && !el.closest('#ugc-flow-panel')
  }

  function findPromptInput() {
    var active = document.activeElement
    if (active && outsidePanel(active) && (active.tagName === 'TEXTAREA' || active.isContentEditable) && visible(active)) return active
    var candidates = [
      'textarea[placeholder*="prompt" i]',
      'textarea[aria-label*="prompt" i]',
      'textarea[placeholder*="describe" i]',
      'textarea[placeholder*="video" i]',
      'textarea',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      'input[type="text"][placeholder*="prompt" i]',
    ]
    for (var i = 0; i < candidates.length; i++) {
      var els = document.querySelectorAll(candidates[i])
      for (var j = 0; j < els.length; j++) {
        var el = els[j]
        if (outsidePanel(el) && visible(el) && !el.disabled && !el.readOnly) return el
      }
    }
    return null
  }

  var GENERATE_WORDS = /\b(generate|buat|create|kirim|send|submit)\b|arrow_forward/i
  var AVOID_WORDS = /\b(delete|hapus|remove|close|tutup|cancel|batal|settings|setelan|menu|more|lainnya|upload|unggah|add|tambah)\b/i

  // Cari tombol Generate HANYA di sekitar kotak prompt (bukan seluruh halaman)
  function findGenerateButton(input) {
    var scope = input
    for (var level = 0; level < 6 && scope; level++) {
      scope = scope.parentElement
      if (!scope) break
      var buttons = scope.querySelectorAll('button, [role="button"]')
      var usable = []
      for (var i = 0; i < buttons.length; i++) {
        var btn = buttons[i]
        if (!outsidePanel(btn) || !visible(btn) || btn.disabled || btn.getAttribute('aria-disabled') === 'true') continue
        usable.push(btn)
      }
      for (var k = 0; k < usable.length; k++) {
        var label = [usable[k].innerText, usable[k].getAttribute('aria-label'), usable[k].getAttribute('title')].join(' ')
        if (GENERATE_WORDS.test(label) && !AVOID_WORDS.test(label)) return usable[k]
      }
      if (usable.length && level >= 2) {
        // Tombol kirim di Flow biasanya tombol ikon paling akhir di dekat kotak prompt
        var last = usable[usable.length - 1]
        var lastLabel = [last.innerText, last.getAttribute('aria-label'), last.getAttribute('title')].join(' ')
        if (!AVOID_WORDS.test(lastLabel) && last.querySelector('svg, i, span')) return last
      }
    }
    return null
  }

  function setPrompt(input, promptText) {
    input.focus()
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      var proto = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
      var descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
      if (descriptor && descriptor.set) descriptor.set.call(input, promptText)
      else input.value = promptText
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    }
    if (input.isContentEditable) {
      // execCommand memicu event input yang dipahami editor React/Lexical/ProseMirror
      var ok = false
      try {
        document.execCommand('selectAll', false, null)
        ok = document.execCommand('insertText', false, promptText)
      } catch (err) {
        ok = false
      }
      if (!ok || (input.innerText || '').trim() !== promptText.trim()) {
        input.textContent = promptText
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: promptText }))
      }
      return true
    }
    return false
  }

  function injectPromptAndGenerate(promptText, sceneIdx) {
    var input = findPromptInput()
    if (!input || !setPrompt(input, promptText)) {
      copyText(promptText).then(
        function () {
          alert('Prompt Scene ' + sceneIdx + ' sudah DISALIN ke clipboard!\n\nKlik kotak prompt di Google Flow, tekan Ctrl + V, lalu klik Generate.')
        },
        function () {
          alert('Kotak prompt Flow tidak ditemukan dan clipboard ditolak browser.\n\nSalin prompt Scene ' + sceneIdx + ' secara manual dari panel.')
        },
      )
      return
    }

    showToast('Prompt Scene ' + sceneIdx + ' dimasukkan!')

    setTimeout(function () {
      var genBtn = findGenerateButton(input)
      if (genBtn) {
        genBtn.click()
        showToast('🚀 Generate Scene ' + sceneIdx + ' dimulai!')
      } else {
        showToast('Prompt dimasukkan. Klik tombol Generate di Flow!')
      }
    }, 700)
  }

  function showToast(msg) {
    var existing = document.querySelector('.ugc-toast')
    if (existing) existing.remove()
    var toast = document.createElement('div')
    toast.className = 'ugc-toast'
    toast.textContent = msg
    document.body.appendChild(toast)
    setTimeout(function () {
      toast.remove()
    }, 3500)
  }

  try {
    if (window.chrome && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(function (changes) {
        if (changes.serverUrl) {
          serverBase = normalizeBase(changes.serverUrl.newValue)
          lastSignature = ''
          fetchData()
        }
      })
    }
  } catch (err) {
    // abaikan
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createUI)
  } else {
    createUI()
  }
})()
