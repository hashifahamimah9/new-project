;(function () {
  'use strict'
  console.log('[UGC Flow Connector] Initializing on flow.google.com...')
  let activeData = null
  let isMinimized = false

  function createUI() {
    if (document.getElementById('ugc-flow-panel')) return

    const panel = document.createElement('div')
    panel.id = 'ugc-flow-panel'
    panel.innerHTML = '<div id="ugc-flow-header">' +
      '<div id="ugc-flow-title">' +
        '<span class="ugc-flow-dot" id="ugc-dot"></span>' +
        '<span>UGC Studio Assistant</span>' +
      '</div>' +
      '<button id="ugc-btn-min" style="background:none;border:none;color:#A0A5B5;cursor:pointer;font-size:16px;">—</button>' +
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

    fetchData()
    setInterval(fetchData, 5000)
  }

  async function fetchData() {
    try {
      const res = await fetch('http://localhost:8787/api/extension/active-scenes')
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const data = await res.json()
      activeData = data
      renderScenes(data)
      const dot = document.getElementById('ugc-dot')
      if (dot) dot.className = 'ugc-flow-dot'
    } catch (err) {
      const dot = document.getElementById('ugc-dot')
      if (dot) dot.className = 'ugc-flow-dot offline'
      const status = document.getElementById('ugc-status')
      if (status) status.innerHTML = '<span style="color:#E86A5E">UGC Studio offline</span>. Pastikan server aktif di localhost:8787.'
    }
  }

  function renderScenes(data) {
    const container = document.getElementById('ugc-scenes-container')
    const status = document.getElementById('ugc-status')
    if (!container) return

    if (!data || !data.scenes || !data.scenes.length) {
      if (status) status.textContent = 'Belum ada skrip. Buat skrip dulu di UGC Studio!'
      container.innerHTML = ''
      return
    }

    if (status) status.innerHTML = 'Produk: <strong style="color:#5E9FE8">' + (data.product || 'Produk') + '</strong> (' + data.scenes.length + ' scene)'

    let html = ''
    data.scenes.forEach(function(scene) {
      html += '<div class="ugc-scene-card">' +
        '<div class="ugc-scene-head">' +
          '<span>SCENE ' + scene.index + ' (' + (scene.duration || 5) + 's)</span>' +
          '<span>' + (scene.motion || 'cinematic') + '</span>' +
        '</div>' +
        '<div class="ugc-scene-prompt" title="' + esc(scene.prompt) + '">' + esc(scene.prompt) + '</div>' +
        '<div class="ugc-scene-actions">' +
          '<button class="ugc-btn ugc-btn-primary" data-inject="' + scene.index + '">⚡ Masukkan & Generate</button>' +
          '<button class="ugc-btn ugc-btn-ghost" data-copy="' + scene.index + '" title="Salin Prompt">📋 Salin</button>' +
        '</div>' +
      '</div>'
    })
    container.innerHTML = html

    container.querySelectorAll('[data-inject]').forEach(function(btn) {
      btn.addEventListener('click', function () {
        const idx = Number(btn.getAttribute('data-inject'))
        const scene = data.scenes.find(function(s) { return s.index === idx })
        if (scene) injectPromptAndGenerate(scene.prompt, idx)
      })
    })

    container.querySelectorAll('[data-copy]').forEach(function(btn) {
      btn.addEventListener('click', function () {
        const idx = Number(btn.getAttribute('data-copy'))
        const scene = data.scenes.find(function(s) { return s.index === idx })
        if (scene) {
          navigator.clipboard.writeText(scene.prompt)
          showToast('Prompt Scene ' + idx + ' berhasil disalin!')
        }
      })
    })
  }

  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
    })
  }

  function findPromptInput() {
    const candidates = [
      'textarea[placeholder*="prompt" i]',
      'textarea[aria-label*="prompt" i]',
      'textarea[placeholder*="describe" i]',
      'textarea[placeholder*="video" i]',
      'textarea',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      'input[type="text"][placeholder*="prompt" i]',
      'input[type="text"]'
    ]
    for (let i = 0; i < candidates.length; i++) {
      const els = document.querySelectorAll(candidates[i])
      for (let j = 0; j < els.length; j++) {
        const el = els[j]
        if (el && el.id !== 'ugc-flow-panel' && !el.closest('#ugc-flow-panel') && el.offsetParent !== null) return el
      }
    }
    return null
  }

  function findGenerateButton() {
    const list = document.querySelectorAll('button, [role="button"]')
    for (let i = 0; i < list.length; i++) {
      const btn = list[i]
      if (btn.closest('#ugc-flow-panel')) continue
      const txt = (btn.innerText || btn.getAttribute('aria-label') || btn.getAttribute('title') || '').toLowerCase()
      if (txt.includes('generate') || txt.includes('buat') || txt.includes('create') || txt.includes('run') || txt.includes('submit')) {
        if (btn.offsetParent !== null && !btn.disabled) return btn
      }
    }
    // Also look for send arrow icons near textarea
    const svgs = document.querySelectorAll('button svg, [role="button"] svg')
    for (let j = 0; j < svgs.length; j++) {
      const p = svgs[j].closest('button, [role="button"]')
      if (p && !p.closest('#ugc-flow-panel') && p.offsetParent !== null && !p.disabled) return p
    }
    return null
  }

  function injectPromptAndGenerate(promptText, sceneIdx) {
    const input = findPromptInput()
    if (!input) {
      navigator.clipboard.writeText(promptText)
      alert('Prompt Scene ' + sceneIdx + ' sudah DISALIN ke clipboard!\n\nSilakan klik kotak prompt di Google Flow lalu tekan Ctrl + V, kemudian klik Generate.')
      return
    }

    input.focus()
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      const proto = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
      if (descriptor && descriptor.set) {
        descriptor.set.call(input, promptText)
      } else {
        input.value = promptText
      }
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    } else if (input.isContentEditable) {
      input.focus()
      input.innerText = promptText
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }

    showToast('Prompt Scene ' + sceneIdx + ' dimasukkan!')

    setTimeout(function () {
      const genBtn = findGenerateButton()
      if (genBtn) {
        genBtn.click()
        showToast('🚀 Generate Scene ' + sceneIdx + ' dimulai!')
      } else {
        showToast('Prompt dimasukkan. Klik tombol Generate di Flow!')
      }
    }, 600)
  }

  function showToast(msg) {
    const existing = document.querySelector('.ugc-toast')
    if (existing) existing.remove()
    const toast = document.createElement('div')
    toast.className = 'ugc-toast'
    toast.textContent = msg
    document.body.appendChild(toast)
    setTimeout(function () { toast.remove() }, 3500)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createUI)
  } else {
    createUI()
  }
})()