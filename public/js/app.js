'use strict'

/* UGC Flow Studio - UI (vanilla JS, tanpa framework) */

var state = {
	view: 'dashboard',
	boot: null,
	settings: {},
	brand: {},
	presets: {},
	assets: [],
	selected: [],
	ugcScript: null,
	podScript: null,
	jobs: [],
	streams: [],
	automations: [],
	library: { videos: [], audios: [] },
	products: [],
	voiceTab: 'tts',
	transformAssetId: null,
	activeStream: null,
	sse: null,
	sseTries: 0,
}

var VIEWS = {
	dashboard: ['Dashboard', 'Ringkasan render, job, dan status live'],
	ugc: ['UGC Studio', 'Foto produk jadi video UGC otomatis'],
	podcast: ['Podcast AI', 'Dialog multi host dengan suara natural'],
	voice: ['Voice Studio', 'Text to speech dan naturalizer suara'],
	live: ['Live 24/7', 'Streaming non stop ke YouTube'],
	automation: ['Automation', 'Watch folder, jadwal, interval, webhook'],
	jobs: ['Jobs', 'Antrian render dan progresnya'],
	library: ['Library', 'Semua video, audio, dan skrip'],
	assets: ['Assets', 'Foto produk, video, dan audio'],
	brand: ['Brand Kit', 'Identitas yang dipakai semua render'],
	settings: ['Settings', 'API key, render, queue, notifikasi'],
	logs: ['Logs', 'Aktivitas sistem'],
}

/* ------------------------------- helpers -------------------------------- */

function $(id) {
	return document.getElementById(id)
}

function esc(value) {
	return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, function (char) {
		return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
	})
}

function fmtBytes(bytes) {
	var num = Number(bytes) || 0
	if (num < 1024) return num + ' B'
	if (num < 1048576) return (num / 1024).toFixed(0) + ' KB'
	if (num < 1073741824) return (num / 1048576).toFixed(1) + ' MB'
	return (num / 1073741824).toFixed(2) + ' GB'
}

function fmtDur(seconds) {
	var total = Math.max(0, Math.round(Number(seconds) || 0))
	var hours = Math.floor(total / 3600)
	var mins = Math.floor((total % 3600) / 60)
	var secs = total % 60
	function pad(value) {
		return String(value).padStart(2, '0')
	}
	if (hours > 0) return hours + ':' + pad(mins) + ':' + pad(secs)
	return mins + ':' + pad(secs)
}

function timeAgo(iso) {
	if (!iso) return '-'
	var diff = (Date.now() - new Date(iso).getTime()) / 1000
	if (diff < 60) return 'baru saja'
	if (diff < 3600) return Math.round(diff / 60) + ' menit lalu'
	if (diff < 86400) return Math.round(diff / 3600) + ' jam lalu'
	return Math.round(diff / 86400) + ' hari lalu'
}

function titleCase(value) {
	return String(value || '')
		.replace(/[-_.]+/g, ' ')
		.replace(/\b\w/g, function (char) {
			return char.toUpperCase()
		})
}

function toast(message, kind) {
	var host = $('toasts')
	if (!host) return
	var node = document.createElement('div')
	node.className = 'toast ' + (kind || 'info')
	node.textContent = message
	host.appendChild(node)
	setTimeout(function () {
		node.classList.add('out')
		setTimeout(function () {
			if (node.parentNode) node.parentNode.removeChild(node)
		}, 400)
	}, 4200)
}

async function api(path, options) {
	var o = options || {}
	var init = { method: o.method || 'GET', headers: {} }
	if (o.body !== undefined) {
		init.headers['Content-Type'] = 'application/json'
		init.body = JSON.stringify(o.body)
	}
	var res
	try {
		res = await fetch(path, init)
	} catch (netErr) {
		throw new Error('Server offline / belum aktif. Silakan jalankan file KLIK-DISINI-UNTUK-MULAI.bat!')
	}
	var text = await res.text()
	var data = {}
	try {
		data = text ? JSON.parse(text) : {}
	} catch (err) {
		data = { raw: text }
	}
	if (!res.ok) throw new Error(data.error || data.message || 'HTTP ' + res.status)
	return data
}

async function uploadFiles(files, source) {
	if (!files || !files.length) return []
	var form = new FormData()
	for (var i = 0; i < files.length; i += 1) form.append('file' + i, files[i])
	form.append('source', source || 'upload')
	var res = await fetch('/api/uploads', { method: 'POST', body: form })
	var data = await res.json().catch(function () {
		return {}
	})
	if (!res.ok) throw new Error(data.error || 'Upload gagal')
	toast(data.uploaded + ' file berhasil diupload', 'success')
	return data.assets || []
}

function optionList(value) {
	var items = []
	if (!value) return items
	if (Array.isArray(value)) {
		value.forEach(function (item) {
			if (item === null || item === undefined) return
			if (typeof item === 'object') items.push({ value: item.id || item.key || item.value || item.name, label: item.label || item.name || item.title || item.id })
			else items.push({ value: item, label: titleCase(item) })
		})
		return items
	}
	if (typeof value === 'object') {
		Object.keys(value).forEach(function (key) {
			var item = value[key]
			var label = item && typeof item === 'object' ? item.label || item.name || titleCase(key) : titleCase(key)
			items.push({ value: key, label: label })
		})
	}
	return items
}

function fillSelect(id, source, current, placeholder) {
	var node = $(id)
	if (!node) return
	if (node.tagName !== 'SELECT') {
		if (current !== undefined && current !== null) node.value = current
		return
	}
	var items = optionList(source)
	var value = current !== undefined && current !== null ? String(current) : node.value
	var html = placeholder ? '<option value="">' + esc(placeholder) + '</option>' : ''
	items.forEach(function (item) {
		html += '<option value="' + esc(item.value) + '">' + esc(item.label) + '</option>'
	})
	node.innerHTML = html
	if (value) node.value = value
	if (!node.value && items.length && !placeholder) node.value = items[0].value
}

function setDot(dotId, labelId, ok, label) {
	var dot = $(dotId)
	var text = $(labelId)
	if (dot) dot.className = 'dot ' + (ok ? 'on' : 'warn')
	if (text) text.textContent = label
}

function badge(status) {
	var map = { done: 'green', running: 'blue', queued: 'dim', failed: 'red', canceled: 'dim', live: 'green', stopped: 'dim', reconnecting: 'orange', error: 'red' }
	return '<span class="badge ' + (map[status] || 'dim') + '">' + esc(status) + '</span>'
}

function hide(node, hidden) {
	if (node) node.hidden = Boolean(hidden)
}

/* -------------------------------- router -------------------------------- */

function go(view) {
	if (!VIEWS[view]) view = 'dashboard'
	state.view = view
	document.querySelectorAll('section.view').forEach(function (section) {
		section.classList.toggle('active', section.getAttribute('data-view') === view)
	})
	document.querySelectorAll('#nav [data-go]').forEach(function (item) {
		item.classList.toggle('active', item.getAttribute('data-go') === view)
	})
	$('viewTitle').textContent = VIEWS[view][0]
	$('viewSub').textContent = VIEWS[view][1]
	if (location.hash.slice(1) !== view) location.hash = view
	refreshView(view)
}

function initRouter() {
	document.querySelectorAll('[data-go]').forEach(function (node) {
		node.addEventListener('click', function (event) {
			event.preventDefault()
			go(node.getAttribute('data-go'))
		})
	})
	window.addEventListener('hashchange', function () {
		var view = location.hash.slice(1)
		if (view && view !== state.view) go(view)
	})
}

async function refreshView(view) {
	try {
		if (view === 'dashboard') await loadDashboard()
		else if (view === 'ugc') await loadAssets()
		else if (view === 'podcast') await loadAssets()
		else if (view === 'voice') await loadVoiceList()
		else if (view === 'live') await loadStreams()
		else if (view === 'automation') await loadAutomations()
		else if (view === 'jobs') await loadJobs()
		else if (view === 'library') await loadLibrary()
		else if (view === 'assets') await loadAssets()
		else if (view === 'brand') await loadBrand()
		else if (view === 'settings') await loadSettings()
		else if (view === 'logs') await loadLogs()
	} catch (err) {
		toast(err.message, 'error')
	}
}

/* --------------------------------- SSE ---------------------------------- */

function initSSE() {
	try {
		if (state.sse) state.sse.close()
		var source = new EventSource('/api/events')
		state.sse = source
		source.onopen = function () {
			state.sseTries = 0
			setDot('dotSse', 'modeSse', true, 'realtime')
		}
		source.onmessage = function (event) {
			var payload = {}
			try {
				payload = JSON.parse(event.data)
			} catch (err) {
				return
			}
			handleEvent(payload.type, payload.data || payload.payload || payload)
		}
		source.onerror = function () {
			setDot('dotSse', 'modeSse', false, 'offline')
			source.close()
			state.sseTries += 1
			setTimeout(initSSE, Math.min(15000, 2000 * state.sseTries))
		}
	} catch (err) {
		setDot('dotSse', 'modeSse', false, 'offline')
	}
}

function handleEvent(type, data) {
	if (!type) return
	if (type.indexOf('job:') === 0) {
		var job = data.job || data
		upsertJob(job)
		if (type === 'job:done') {
			toast('Selesai: ' + (job.title || 'job'), 'success')
			if (job.source === 'flow_auto_ingest' || job.source === 'flow_download') {
				var statusNode = $('flowIngestStatus')
				if (statusNode) {
					statusNode.style.display = 'block'
					statusNode.innerHTML =
						'<strong style="color:#72BC8F;font-size:14px;">🎉 Video UGC Berhasil Dibuat!</strong>' +
						'<p class="muted small" style="margin:6px 0 10px 0;">Video dari Google Flow telah digabungkan dengan suara AI (bersih tanpa teks yang menutupi).</p>' +
						'<div class="row gap"><a href="#library" class="btn small primary" onclick="go(\'library\')">📁 Buka Video di Library</a><button type="button" class="btn small ghost" onclick="$(\'flowIngestStatus\').style.display=\'none\'">Tutup</button></div>'
				}
			}
			if (state.view === 'library') loadLibrary()
			if (state.view === 'dashboard') loadDashboard()
			if (state.view === 'assets') loadAssets()
			if (state.view === 'voice') loadVoiceList()
		}
		if (type === 'job:failed') toast('Gagal: ' + (job.title || 'job') + ' - ' + (job.error || ''), 'error')
		if (type === 'job:log' && data.message && state.activeJob === (job.id || data.jobId)) appendJobLog(data.message)
		return
	}
	if (type === 'flow:download-detected') {
		toast('🎉 Video dari Flow terdeteksi: ' + (data.file || ''), 'info')
		var statusNode = $('flowIngestStatus')
		if (statusNode) {
			statusNode.style.display = 'block'
			statusNode.innerHTML = '<strong>🎉 Video Flow Terdeteksi!</strong><p class="muted small">' + esc(data.file) + ' sedang di-import &amp; diolah...</p>'
		}
		return
	}
	if (type === 'flow:auto-render-started') {
		toast('🎙️ Menggabungkan video Flow dengan suara AI...', 'info')
		if (data.job) upsertJob(data.job)
		var statusNode = $('flowIngestStatus')
		if (statusNode) {
			statusNode.style.display = 'block'
			statusNode.innerHTML = '<strong>🎙️ Sedang Me-render Video UGC...</strong><p class="muted small">Menggabungkan video Flow + suara AI Nadia (bersih tanpa teks overlay). Hasil akan otomatis masuk ke Library!</p>'
		}
		return
	}
	if (type.indexOf('stream:') === 0) {
		if (type === 'stream:started') toast('Live dimulai: ' + (data.name || ''), 'success')
		if (type === 'stream:stopped') toast('Live dihentikan: ' + (data.name || ''), 'info')
		if (type === 'stream:reconnecting') toast('Live reconnect: ' + (data.name || ''), 'warn')
		if (state.view === 'live' && type !== 'stream:stats' && type !== 'stream:log') loadStreams()
		if (type === 'stream:log' && state.activeStream === data.streamId) loadStreamLogs(data.streamId)
		if (state.view === 'dashboard') renderDashLive()
		return
	}
	if (type === 'asset:created') {
		if (state.view === 'assets' || state.view === 'ugc') loadAssets()
		return
	}
	if (type === 'automation:run') {
		toast('Automation jalan: ' + (data.name || ''), 'info')
		if (state.view === 'automation') loadAutomations()
		return
	}
	if (type === 'queue:paused') {
		var button = $('btnPause')
		if (button) button.textContent = data.paused ? 'Lanjutkan queue' : 'Pause queue'
		return
	}
	if (type === 'log' && state.view === 'logs') loadLogs()
}

function upsertJob(job) {
	if (!job || !job.id) return
	var found = false
	state.jobs = state.jobs.map(function (item) {
		if (item.id === job.id) {
			found = true
			return Object.assign({}, item, job)
		}
		return item
	})
	if (!found) state.jobs.unshift(job)
	state.jobs = state.jobs.slice(0, 60)
	renderJobs()
	renderDashJobs()
	var active = state.jobs.filter(function (item) {
		return item.status === 'running' || item.status === 'queued'
	}).length
	var badgeNode = $('navJobs')
	if (badgeNode) {
		badgeNode.textContent = active ? String(active) : ''
		badgeNode.hidden = !active
	}
}

/* ------------------------------- bootstrap ------------------------------ */

async function loadBootstrap() {
	var data = await api('/api/bootstrap')
	state.boot = data
	state.settings = data.settings || {}
	state.brand = data.brand || {}
	state.presets = data.presets || {}
	var flowOk = data.modes.flow === 'flow'
	var ttsOk = data.modes.tts && data.modes.tts !== 'simulate'
	setDot('dotFlow', 'modeFlow', flowOk, flowOk ? 'Flow Ultra' : 'Flow simulasi')
	setDot('dotTts', 'modeTts', ttsOk, ttsOk ? 'Voice ' + data.modes.tts : 'Voice simulasi')
	if ($('brandSub')) $('brandSub').textContent = (state.brand.name || data.app.name) + ' - v' + data.app.version
	if ($('inboxPath')) $('inboxPath').textContent = data.inboxPath || ''
	if ($('ugcHint')) $('ugcHint').textContent = 'Maks upload ' + data.app.maxUploadMb + ' MB per file. Lane low = lower priority (unlimited).'
	if ($('assetHint')) $('assetHint').textContent = 'Folder inbox otomatis: ' + (data.inboxPath || '')
	applyPresets()
	var pauseButton = $('btnPause')
	if (pauseButton && data.queue) pauseButton.textContent = data.queue.paused ? 'Lanjutkan queue' : 'Pause queue'
}

function applyPresets() {
	var presets = state.presets || {}
	var render = state.settings.render || {}
	var ugcSettings = state.settings.ugc || {}

	fillSelect('ugcAngle', presets.angles, ugcSettings.angle)
	fillSelect('ugcPersona', presets.personas, ugcSettings.persona)
	fillSelect('ugcVoice', presets.voices, (state.settings.tts || {}).defaultVoice)
	fillSelect('ugcMotion', ['auto'].concat(optionList(presets.motions).map(function (item) {
		return item.value
	})), 'auto')
	fillSelect('ugcSubtitle', presets.subtitleStyles, render.subtitleStyle || 'none')
	fillSelect('ugcMusic', presets.musicMoods, 'lofi')
	fillSelect('ugcNatural', presets.naturalPresets, (state.settings.tts || {}).naturalPreset)
	fillSelect('ugcMode', [
		{ id: 'flow-video', label: 'Flow video AI (terbaik)' },
		{ id: 'flow-image', label: 'Flow gambar + animasi (cepat)' },
		{ id: 'local', label: 'Foto sendiri + animasi (offline)' },
	], 'flow-video')
	fillSelect('ugcLane', [
		{ id: 'low', label: 'Lower priority (unlimited)' },
		{ id: 'standard', label: 'Standard (kuota)' },
	], (state.settings.flow || {}).defaultLane)

	var aspects = Object.keys(presets.resolutions || { '9:16': [] })
	fillSelect('ugcAspect', aspects, '9:16')
	fillSelect('podAspect', aspects, '16:9')
	syncResolutions('ugcAspect', 'ugcResolution', render.resolution)
	syncResolutions('podAspect', 'podResolution', render.resolution)

	fillSelect('podVoice1', presets.voices, 'host-a')
	fillSelect('podVoice2', presets.voices, 'host-b')
	fillSelect('podNatural', presets.naturalPresets, 'podcast-warm')
	fillSelect('podMusic', presets.musicMoods, 'calm')
	fillSelect('podStyle', [
		{ id: 'wave', label: 'Gelombang suara' },
		{ id: 'bars', label: 'Bar equalizer' },
		{ id: 'spectrum', label: 'Spektrum' },
	], 'wave')
	if ($('podSubtitle') && $('podSubtitle').type === 'checkbox') $('podSubtitle').checked = true
	else fillSelect('podSubtitle', presets.subtitleStyles, 'minimal')

	fillSelect('voiceSelect', presets.voices, (state.settings.tts || {}).defaultVoice)
	fillSelect('voiceNatural', presets.naturalPresets, (state.settings.tts || {}).naturalPreset)

	fillSelect('lvMode', presets.streamModes, (state.settings.stream || {}).mode)
	fillSelect('lvRes', ['2160', '1080', '720', '480'], String((state.settings.stream || {}).resolution || '1080'))
	fillSelect('lvFps', ['24', '25', '30', '60'], String((state.settings.stream || {}).fps || 30))
	fillSelect('lvAudio', [
		{ id: 'source', label: 'Audio asli video' },
		{ id: 'music', label: 'Musik loop' },
		{ id: 'silent', label: 'Tanpa suara' },
	], 'source')
	if ($('lvRtmp') && !$('lvRtmp').value) $('lvRtmp').value = (state.settings.stream || {}).rtmpUrl || ''
	if ($('lvBitrate') && !$('lvBitrate').value) $('lvBitrate').value = (state.settings.stream || {}).videoBitrate || '4500k'

	fillSelect('atAction', presets.automationActions, 'ugc.render')
	fillSelect('atTrigger', presets.automationTriggers, 'watch-folder')

	fillSelect('ugcResolution', undefined, render.resolution)
}

function syncResolutions(aspectId, resolutionId, current) {
	var aspectNode = $(aspectId)
	var resolutions = (state.presets || {}).resolutions || {}
	if (!aspectNode) return
	var list = resolutions[aspectNode.value] || ['720', '1080', '1440', '2160']
	fillSelect(resolutionId, list, current || '1080')
}

/* ------------------------------- dashboard ------------------------------ */

async function loadDashboard() {
	var results = await Promise.all([api('/api/analytics'), api('/api/jobs?limit=8'), api('/api/streams'), api('/api/health')])
	var analytics = results[0]
	state.jobs = results[1] || []
	state.streams = (results[2] || {}).streams || []
	var health = results[3] || {}

	var totals = analytics.totals || {}
	var storage = analytics.storage || {}
	var cards = [
		{ label: 'Video UGC', value: totals.ugc || 0, note: (totals.videos || 0) + ' total video' },
		{ label: 'Podcast', value: totals.podcasts || 0, note: (totals.audios || 0) + ' file audio' },
		{ label: 'Menit render', value: totals.renderMinutes || 0, note: 'dari semua video' },
		{ label: 'Live aktif', value: health.liveStreams || 0, note: (totals.streams || 0) + ' channel tersimpan' },
		{ label: 'Job jalan', value: (analytics.queue || {}).running || 0, note: ((analytics.queue || {}).queued || 0) + ' menunggu' },
		{ label: 'Storage', value: fmtBytes((storage.renders || 0) + (storage.uploads || 0) + (storage.audio || 0)), note: 'tmp ' + fmtBytes(storage.tmp || 0) },
		{ label: 'Automation', value: totals.automations || 0, note: 'flow otomatis' },
		{ label: 'Uptime', value: fmtDur(health.uptimeSeconds || 0), note: health.flowMode === 'flow' ? 'Flow Ultra aktif' : 'Flow simulasi' },
	]
	$('statGrid').innerHTML = cards
		.map(function (card) {
			return '<div class="stat"><span class="stat-label">' + esc(card.label) + '</span><strong>' + esc(card.value) + '</strong><span class="stat-note">' + esc(card.note) + '</span></div>'
		})
		.join('')

	renderDashJobs()
	renderDashLive()
	renderUsageChart(analytics.daily || [])
	renderDashVideos(analytics.topVideos || [])
}

function renderDashJobs() {
	var node = $('dashJobs')
	if (!node) return
	var jobs = state.jobs.slice(0, 6)
	if (!jobs.length) {
		node.innerHTML = '<p class="empty">Belum ada job. Mulai dari UGC Studio.</p>'
		return
	}
	node.innerHTML = jobs
		.map(function (job) {
			return (
				'<div class="list-item"><div class="list-main"><strong>' +
				esc(job.title) +
				'</strong><span class="muted">' +
				esc(job.stage || job.type) +
				'</span><div class="progress"><i style="width:' +
				(job.progress || 0) +
				'%"></i></div></div>' +
				badge(job.status) +
				'</div>'
			)
		})
		.join('')
}

function renderDashLive() {
	var node = $('dashLive')
	if (!node) return
	if (!state.streams.length) {
		node.innerHTML = '<p class="empty">Belum ada channel live. Buat di menu Live 24/7.</p>'
		return
	}
	node.innerHTML = state.streams
		.map(function (stream) {
			var status = stream.status || {}
			return (
				'<div class="list-item"><div class="list-main"><strong>' +
				esc(stream.name) +
				'</strong><span class="muted">' +
				esc((status.mode || stream.mode) + ' - uptime ' + fmtDur(status.uptimeSeconds || 0) + ' - restart ' + (status.restarts || 0)) +
				'</span></div>' +
				badge(status.status || 'stopped') +
				'</div>'
			)
		})
		.join('')
}

function renderUsageChart(daily) {
	var node = $('usageChart')
	if (!node) return
	if (!daily.length) {
		node.innerHTML = '<p class="empty">Belum ada data pemakaian.</p>'
		return
	}
	var max = Math.max.apply(
		null,
		daily.map(function (day) {
			return (day.low || 0) + (day.standard || 0) + (day.images || 0)
		}),
	)
	if (!max) max = 1
	node.innerHTML = daily
		.map(function (day) {
			var total = (day.low || 0) + (day.standard || 0) + (day.images || 0)
			var height = Math.max(4, Math.round((total / max) * 100))
			return (
				'<div class="bar" title="' +
				esc(day.day + ': low ' + (day.low || 0) + ', standard ' + (day.standard || 0) + ', gambar ' + (day.images || 0)) +
				'"><i style="height:' +
				height +
				'%"></i><span>' +
				esc(String(day.day).slice(5)) +
				'</span></div>'
			)
		})
		.join('')
}

function renderDashVideos(videos) {
	var node = $('dashVideos')
	if (!node) return
	if (!videos.length) {
		node.innerHTML = '<p class="empty">Belum ada video. Render pertama kamu di UGC Studio.</p>'
		return
	}
	node.innerHTML = videos.map(videoCard).join('')
}

function videoCard(video) {
	var thumb = video.thumbUrl ? '<img src="' + esc(video.thumbUrl) + '" alt="" loading="lazy" />' : '<div class="thumb-fallback">' + esc((video.type || 'video').toUpperCase()) + '</div>'
	return (
		'<article class="video-card"><div class="thumb">' +
		thumb +
		'<span class="pill">' +
		esc(fmtDur(video.duration)) +
		'</span></div><div class="video-meta"><strong>' +
		esc(video.title) +
		'</strong><span class="muted">' +
		esc((video.aspect || '') + ' - ' + fmtBytes(video.size) + ' - ' + timeAgo(video.createdAt)) +
		'</span><div class="row gap"><a class="btn tiny" href="' +
		esc(video.url) +
		'" target="_blank" rel="noreferrer">Preview</a><a class="btn tiny" href="' +
		esc(video.downloadUrl) +
		'">Download</a></div></div></article>'
	)
}

/* ------------------------------- assets --------------------------------- */

async function loadAssets() {
	var data = await api('/api/assets?limit=200')
	state.assets = data.assets || []
	renderAssetPicker()
	renderAssetGrid()
	renderAssetSelects()
}

function renderAssetPicker() {
	var node = $('ugcAssets')
	if (!node) return
	var images = state.assets.filter(function (asset) {
		return asset.kind === 'image' || asset.kind === 'video'
	})
	if (!images.length) {
		node.innerHTML = '<p class="empty">Upload foto produk dulu di atas.</p>'
		return
	}
	node.innerHTML = images
		.map(function (asset) {
			var active = state.selected.indexOf(asset.id) !== -1
			var preview = asset.kind === 'image' ? '<img src="' + esc(asset.url) + '" alt="" loading="lazy" />' : '<div class="thumb-fallback">VIDEO</div>'
			return '<button type="button" class="pick' + (active ? ' active' : '') + '" data-asset="' + esc(asset.id) + '" title="' + esc(asset.name) + '">' + preview + '<span>' + esc(asset.name) + '</span></button>'
		})
		.join('')
	node.querySelectorAll('[data-asset]').forEach(function (button) {
		button.addEventListener('click', function () {
			var id = button.getAttribute('data-asset')
			var index = state.selected.indexOf(id)
			if (index === -1) state.selected.push(id)
			else state.selected.splice(index, 1)
			renderAssetPicker()
		})
	})
}

function renderAssetGrid() {
	var node = $('assetGrid')
	if (!node) return
	var filter = $('assetFilter') ? $('assetFilter').value : ''
	var items = state.assets.filter(function (asset) {
		return !filter || asset.kind === filter
	})
	if (!items.length) {
		node.innerHTML = '<p class="empty">Belum ada aset.</p>'
		return
	}
	node.innerHTML = items
		.map(function (asset) {
			var preview =
				asset.kind === 'image'
					? '<img src="' + esc(asset.url) + '" alt="" loading="lazy" />'
					: '<div class="thumb-fallback">' + esc(String(asset.kind).toUpperCase()) + '</div>'
			return (
				'<article class="asset-card"><div class="thumb">' +
				preview +
				'</div><div class="asset-meta"><strong>' +
				esc(asset.name) +
				'</strong><span class="muted">' +
				esc(fmtBytes(asset.size) + ' - ' + (asset.source || '') + ' - ' + timeAgo(asset.createdAt)) +
				'</span><div class="row gap"><a class="btn tiny" href="' +
				esc(asset.url) +
				'" target="_blank" rel="noreferrer">Lihat</a><button class="btn tiny danger" data-del-asset="' +
				esc(asset.id) +
				'">Hapus</button></div></div></article>'
			)
		})
		.join('')
	node.querySelectorAll('[data-del-asset]').forEach(function (button) {
		button.addEventListener('click', async function () {
			if (!confirm('Hapus aset ini?')) return
			try {
				await api('/api/assets/' + button.getAttribute('data-del-asset'), { method: 'DELETE' })
				toast('Aset dihapus', 'success')
				loadAssets()
			} catch (err) {
				toast(err.message, 'error')
			}
		})
	})
}

function renderAssetSelects() {
	var audios = state.assets.filter(function (asset) {
		return asset.kind === 'audio'
	})
	var images = state.assets.filter(function (asset) {
		return asset.kind === 'image'
	})
	fillSelect(
		'lvMusic',
		audios.map(function (asset) {
			return { id: asset.id, label: asset.name }
		}),
		'',
		'Tanpa musik',
	)
	fillSelect(
		'podCover',
		images.map(function (asset) {
			return { id: asset.id, label: asset.name }
		}),
		'',
		'Tanpa cover',
	)
	fillSelect(
		'voiceAsset',
		state.assets
			.filter(function (asset) {
				return asset.kind === 'audio' || asset.kind === 'video'
			})
			.map(function (asset) {
				return { id: asset.id, label: asset.name }
			}),
		state.transformAssetId || '',
		'Pilih file...',
	)
}

function initDropzone(dropId, inputId, onDone) {
	var drop = $(dropId)
	var input = $(inputId)
	if (!drop || !input) return
	drop.addEventListener('click', function () {
		input.click()
	})
	drop.addEventListener('dragover', function (event) {
		event.preventDefault()
		drop.classList.add('over')
	})
	drop.addEventListener('dragleave', function () {
		drop.classList.remove('over')
	})
	drop.addEventListener('drop', async function (event) {
		event.preventDefault()
		drop.classList.remove('over')
		try {
			var assets = await uploadFiles(event.dataTransfer.files)
			if (onDone) onDone(assets)
		} catch (err) {
			toast(err.message, 'error')
		}
	})
	input.addEventListener('change', async function () {
		try {
			var assets = await uploadFiles(input.files)
			input.value = ''
			if (onDone) onDone(assets)
		} catch (err) {
			toast(err.message, 'error')
		}
	})
}

/* ------------------------------ UGC studio ------------------------------ */

function ugcBrief() {
	return {
		product: $('ugcProduct').value.trim(),
		problem: $('ugcProblem').value.trim(),
		benefits: $('ugcBenefits').value.trim(),
		angle: $('ugcAngle').value,
		persona: $('ugcPersona').value,
		voice: $('ugcVoice').value,
		sceneCount: Number($('ugcScenesCount').value) || 5,
		sceneDuration: Number($('ugcSceneDuration').value) || 5,
	}
}

function ugcRenderPayload() {
	var brief = ugcBrief()
	var motion = $('ugcMotion').value
	return Object.assign(brief, {
		assetIds: state.selected.slice(),
		script: state.ugcScript,
		mode: $('ugcMode').value,
		lane: $('ugcLane').value,
		aspect: $('ugcAspect').value,
		resolution: $('ugcResolution').value,
		fps: Number($('ugcFps').value) || 30,
		motion: motion === 'auto' ? null : motion,
		subtitleStyle: $('ugcSubtitle').value,
		musicMood: $('ugcMusic').value,
		naturalPreset: $('ugcNatural').value,
		watermark: $('ugcWatermark').value.trim(),
		variants: Number($('ugcVariants').value) || 1,
		perAsset: $('ugcPerAsset').checked,
	})
}

function renderUgcScript() {
	var script = state.ugcScript
	var card = $('ugcScriptCard')
	if (!script) {
		hide(card, true)
		return
	}
	hide(card, false)
	$('ugcScriptTitle').value = script.title || ''
	$('ugcScriptHook').value = script.hook || ''
	$('ugcCaption').value = script.caption || ''
	$('ugcHashtags').value = script.hashtags || ''
	$('ugcScenes').innerHTML = (script.scenes || [])
		.map(function (scene, index) {
			return (
				'<div class="scene" data-scene="' +
				index +
				'"><div class="scene-head"><strong>Scene ' +
				(index + 1) +
				'</strong><div class="row gap"><button type="button" class="btn tiny primary" data-open-flow="' + index + '" title="Buka Google Flow & Isi Prompt">🚀 Buka di Flow</button><button type="button" class="btn tiny ghost" data-copy-prompt="' + index + '" title="Salin Prompt">📋 Salin</button><input class="mini" type="number" min="2" max="20" step="0.5" value="' +
				(scene.duration || 5) +
				'" data-field="duration" title="Durasi detik" /><button class="btn tiny danger" data-remove-scene="' +
				index +
				'">x</button></div></div>' +
				'<textarea rows="2" data-field="narration" placeholder="Narasi voice over">' +
				esc(scene.narration || '') +
				'</textarea>' +
				'<input data-field="onScreenText" placeholder="Teks di layar" value="' +
				esc(scene.onScreenText || '') +
				'" />' +
				'<input data-field="visual" placeholder="Deskripsi visual untuk AI" value="' +
				esc(scene.visual || '') +
				'" /></div>'
			)
		})
		.join('')

	$('ugcScenes')
		.querySelectorAll('.scene')
		.forEach(function (sceneNode) {
			var index = Number(sceneNode.getAttribute('data-scene'))
			sceneNode.querySelectorAll('[data-field]').forEach(function (field) {
				field.addEventListener('input', function () {
					var key = field.getAttribute('data-field')
					state.ugcScript.scenes[index][key] = key === 'duration' ? Number(field.value) || 5 : field.value
				})
			})
			function buildIndonesianPrompt(sc) {
				var prod = $('ugcProduct') ? $('ugcProduct').value.trim() : 'produk'
				var motionMap = {
					zoomin: 'gerakan kamera zoom perlahan mendekati produk',
					zoomout: 'gerakan kamera zoom menjauh perlahan memperlihatkan produk utuh',
					panright: 'kamera bergeser perlahan ke kanan',
					panleft: 'kamera bergeser perlahan ke kiri',
					panup: 'kamera bergerak perlahan dari bawah ke atas',
					pandown: 'kamera bergerak perlahan dari atas ke bawah',
					still: 'posisi kamera stabil dengan fokus sangat tajam ke produk',
					cinematic: 'gerakan kamera sinematik yang sangat halus',
				}
				var motionDesc = motionMap[sc.motion] || sc.motion || 'gerakan kamera sinematik halus'
				return 'Video vertikal 9:16 gaya video ulasan pengguna asli, ' + (sc.visual || 'rekaman produk dari dekat dipegang tangan wanita') + ', produk: ' + prod + ', rekaman kamera ponsel natural dan stabil, ' + motionDesc + ', pencahayaan alami siang hari dari jendela, detail kemasan dan tekstur produk tajam jernih, warna natural, tanpa teks tulisan di layar, tanpa watermark, kualitas video sinematik realistis'
			}

			var openFlowBtn = sceneNode.querySelector('[data-open-flow]')
			if (openFlowBtn) {
				openFlowBtn.addEventListener('click', async function (e) {
					e.preventDefault()
					var sc = state.ugcScript.scenes[index]
					var prompt = buildIndonesianPrompt(sc)
					try {
						await navigator.clipboard.writeText(prompt)
					} catch (err) {}
					try {
						var payload = ugcRenderPayload()
						await api('/api/ugc/flow-session', { method: 'POST', body: payload })
					} catch (err) {}
					startFlowWatcher()
					window.open('https://flow.google.com/', '_blank')
					toast('Prompt Scene ' + (index + 1) + ' disalin! Tab Google Flow dibuka. Tekan Ctrl+V lalu klik Generate.', 'success', 7000)
					var statusNode = $('flowIngestStatus')
					if (statusNode) {
						statusNode.style.display = 'block'
						statusNode.innerHTML = '<strong>🚀 Menunggu video dari Google Flow...</strong><p class="muted small" style="margin-top:4px;">Begitu Anda klik Download di Flow, video otomatis terdeteksi &amp; diolah menjadi video utuh dengan suara AI di Library!</p>'
					}
				})
			}
			var copyBtn = sceneNode.querySelector('[data-copy-prompt]')
			if (copyBtn) {
				copyBtn.addEventListener('click', function (e) {
					e.preventDefault()
					var sc = state.ugcScript.scenes[index]
					var prompt = buildIndonesianPrompt(sc)
					navigator.clipboard.writeText(prompt)
					toast('Prompt Scene ' + (index + 1) + ' berhasil disalin!', 'success')
				})
			}
			var remove = sceneNode.querySelector('[data-remove-scene]')
			if (remove) {
				remove.addEventListener('click', function () {
					state.ugcScript.scenes.splice(index, 1)
					renderUgcScript()
				})
			}
		})
}

function bindUgcScriptFields() {
	;[
		['ugcScriptTitle', 'title'],
		['ugcScriptHook', 'hook'],
		['ugcCaption', 'caption'],
		['ugcHashtags', 'hashtags'],
	].forEach(function (pair) {
		var node = $(pair[0])
		if (!node) return
		node.addEventListener('input', function () {
			if (state.ugcScript) state.ugcScript[pair[1]] = node.value
		})
	})
}

function initUgc() {
	initDropzone('ugcDrop', 'ugcFiles', function (assets) {
		assets.forEach(function (asset) {
			if (state.selected.indexOf(asset.id) === -1) state.selected.push(asset.id)
		})
		loadAssets()
	})
	initDropzone('assetDrop', 'assetFiles', function () {
		loadAssets()
	})
	initDropzone('voiceDrop', 'voiceFile', function (assets) {
		if (assets[0]) {
			state.transformAssetId = assets[0].id
			loadAssets()
		}
	})
	bindUgcScriptFields()

	$('ugcAspect').addEventListener('change', function () {
		syncResolutions('ugcAspect', 'ugcResolution')
	})
	if ($('podAspect')) {
		$('podAspect').addEventListener('change', function () {
			syncResolutions('podAspect', 'podResolution')
		})
	}
	if ($('assetFilter')) $('assetFilter').addEventListener('change', renderAssetGrid)

	$('ugcScriptBtn').addEventListener('click', async function () {
		var brief = ugcBrief()
		if (!brief.product) return toast('Isi nama produk dulu', 'warn')
		$('ugcScriptBtn').disabled = true
		$('ugcScriptBtn').textContent = 'Menulis skrip...'
		try {
			var data = await api('/api/ugc/script', { method: 'POST', body: brief })
			state.ugcScript = data.script
			renderUgcScript()
			toast('Skrip siap, silakan edit kalau perlu', 'success')
		} catch (err) {
			toast(err.message, 'error')
		} finally {
			$('ugcScriptBtn').disabled = false
			$('ugcScriptBtn').textContent = 'Buat skrip'
		}
	})

	$('ugcScriptClear').addEventListener('click', function () {
		state.ugcScript = null
		renderUgcScript()
	})

	$('ugcRender').addEventListener('click', async function () {
		var payload = ugcRenderPayload()
		if (!payload.product) return toast('Isi nama produk dulu', 'warn')
		if (payload.mode === 'local' && !payload.assetIds.length) return toast('Mode offline butuh minimal 1 foto', 'warn')
		$('ugcRender').disabled = true
		try {
			var data = await api('/api/ugc/render', { method: 'POST', body: payload })
			var jobs = data.jobs || []
			jobs.forEach(upsertJob)
			toast(jobs.length + ' job render masuk antrian', 'success')
			go('jobs')
		} catch (err) {
			toast(err.message, 'error')
		} finally {
			$('ugcRender').disabled = false
		}
	})

	$('imgGenerate').addEventListener('click', async function () {
		var prompt = $('imgPrompt').value.trim()
		if (!prompt) return toast('Isi prompt gambar dulu', 'warn')
		try {
			var data = await api('/api/images/generate', {
				method: 'POST',
				body: {
					prompt: prompt,
					count: Number($('imgCount').value) || 4,
					aspect: $('imgAspect').value,
					resolution: $('ugcResolution').value,
					assetIds: state.selected.slice(0, 1),
					lane: $('ugcLane').value,
					title: prompt.slice(0, 40),
				},
			})
			upsertJob(data.job)
			toast('Generate gambar masuk antrian', 'success')
		} catch (err) {
			toast(err.message, 'error')
		}
	})

	$('ugcSaveProduct').addEventListener('click', async function () {
		var brief = ugcBrief()
		if (!brief.product) return toast('Isi nama produk dulu', 'warn')
		try {
			await api('/api/collections/products', { method: 'POST', body: { name: brief.product, brief: brief } })
			toast('Preset produk disimpan', 'success')
			loadProducts()
		} catch (err) {
			toast(err.message, 'error')
		}
	})

	$('ugcProductPreset').addEventListener('change', function () {
		var item = state.products.filter(function (product) {
			return product.id === $('ugcProductPreset').value
		})[0]
		if (!item) return
		var brief = item.brief || {}
		$('ugcProduct').value = brief.product || item.name || ''
		$('ugcProblem').value = brief.problem || ''
		$('ugcBenefits').value = brief.benefits || ''
		if (brief.angle) $('ugcAngle').value = brief.angle
		if (brief.persona) $('ugcPersona').value = brief.persona
		if (brief.voice) $('ugcVoice').value = brief.voice
		toast('Preset dimuat', 'info')
	})

	if ($('btnCheckDownloads')) {
		$('btnCheckDownloads').addEventListener('click', async function () {
			var btn = $('btnCheckDownloads')
			btn.disabled = true
			btn.textContent = 'Memeriksa Downloads...'
			try {
				var data = await api('/api/ugc/downloads/scan')
				var files = (data && data.files) || []
				if (!files.length) {
					toast('Folder Downloads kosong. Download dulu video dari Google Flow, atau klik "Pilih File Video Manual"!', 'warn', 6000)
				} else {
					toast('Ditemukan ' + files.length + ' video di folder Downloads!', 'success')
					renderRecentDownloads(files)
				}
			} catch (err) {
				toast(err.message, 'error')
			} finally {
				btn.disabled = false
				btn.textContent = '📥 Cek & Ambil Video dari Downloads'
			}
		})
	}

	if ($('btnUploadFlowManual') && $('flowManualVideoInput')) {
		$('btnUploadFlowManual').addEventListener('click', function () {
			$('flowManualVideoInput').click()
		})
		$('flowManualVideoInput').addEventListener('change', async function () {
			var files = $('flowManualVideoInput').files
			if (!files || !files.length) return
			var btn = $('btnUploadFlowManual')
			btn.disabled = true
			btn.textContent = 'Mengupload video...'
			try {
				var uploaded = await uploadFiles([files[0]])
				if (!uploaded.length) throw new Error('Gagal mengupload video')
				var asset = uploaded[0]
				toast('Video berhasil diupload! Memulai render suara AI...', 'info')
				var statusNode = $('flowIngestStatus')
				if (statusNode) {
					statusNode.style.display = 'block'
					statusNode.innerHTML = '<strong>🎙️ Sedang Me-render Video UGC...</strong><p class="muted small">Video Anda sedang digabungkan dengan suara AI Nadia (bersih tanpa teks overlay)...</p>'
				}
				var payload = ugcRenderPayload()
				payload.assetIds = [asset.id]
				payload.mode = 'local'
				var data = await api('/api/ugc/render', { method: 'POST', body: payload })
				var jobs = data.jobs || []
				jobs.forEach(upsertJob)
				go('jobs')
			} catch (err) {
				toast(err.message, 'error')
			} finally {
				btn.disabled = false
				btn.textContent = '📁 Pilih File Video Manual'
				$('flowManualVideoInput').value = ''
			}
		})
	}

	if ($('btnShowFlowGuide')) {
		$('btnShowFlowGuide').addEventListener('click', function () {
			alert(
				'PANDUAN ALUR GOOGLE FLOW OTOMATIS:\n\n' +
				'1. Klik tombol "🚀 Buka di Flow" pada salah satu scene di atas.\n' +
				'   Prompt scene otomatis disalin ke clipboard dan halaman Google Flow terbuka.\n\n' +
				'2. Di Google Flow, klik kotak teks prompt lalu tekan Ctrl + V untuk menempel prompt.\n' +
				'   Klik tombol "Generate" untuk membuat video.\n\n' +
				'3. Saat video Flow selesai, klik tombol Download pada video tersebut.\n\n' +
				'4. UGC Studio otomatis mendeteksi video dari folder Downloads Anda, menggabungkannya dengan suara AI (Nadia/Raka), lalu langsung menyimpannya di Library!'
			)
		})
	}
}

var flowWatcherInterval = null

function startFlowWatcher() {
	if (flowWatcherInterval) clearInterval(flowWatcherInterval)
	var badge = $('flowWatcherBadge')
	if (badge) {
		badge.textContent = '🟢 Menunggu Download Flow...'
		badge.style.background = '#1C2E24'
		badge.style.color = '#72BC8F'
	}
	flowWatcherInterval = setInterval(async function () {
		try {
			var data = await api('/api/ugc/downloads/scan?limitMinutes=15')
			if (data && data.files && data.files.length) {
				renderRecentDownloads(data.files)
			}
		} catch (err) {}
	}, 4000)
}

function renderRecentDownloads(files) {
	var node = $('flowRecentDownloads')
	if (!node) return
	if (!files || !files.length) {
		node.style.display = 'none'
		return
	}
	node.style.display = 'block'
	node.innerHTML =
		'<strong style="font-size:12px;color:#A0A5B5;">Video terdeteksi di Downloads:</strong>' +
		'<div class="stack" style="margin-top:6px;gap:6px;">' +
		files
			.slice(0, 3)
			.map(function (f) {
				return (
					'<div style="display:flex;align-items:center;justify-content:space-between;background:#121316;padding:8px 12px;border-radius:6px;font-size:12px;">' +
					'<span>📁 <strong>' +
					esc(f.name) +
					'</strong> <span class="muted">(' +
					fmtBytes(f.size) +
					' - ' +
					f.ageSeconds +
					's lalu)</span></span>' +
					'<button type="button" class="btn tiny primary" data-import-file="' +
					esc(f.file) +
					'">⚡ Gabung ke UGC Ini</button>' +
					'</div>'
				)
			})
			.join('') +
		'</div>'

	node.querySelectorAll('[data-import-file]').forEach(function (btn) {
		btn.addEventListener('click', async function () {
			var file = btn.getAttribute('data-import-file')
			btn.disabled = true
			btn.textContent = 'Memproses...'
			try {
				var res = await api('/api/ugc/downloads/import', { method: 'POST', body: { file: file, autoRender: true } })
				toast(res.message || 'Video berhasil di-import!', 'success')
				if (res.job) {
					upsertJob(res.job)
					go('jobs')
				}
			} catch (err) {
				toast(err.message, 'error')
				btn.disabled = false
				btn.textContent = '⚡ Gabung ke UGC Ini'
			}
		})
	})
}

async function loadProducts() {
	try {
		var data = await api('/api/collections/products')
		state.products = data.items || []
		fillSelect(
			'ugcProductPreset',
			state.products.map(function (product) {
				return { id: product.id, label: product.name || 'Produk' }
			}),
			'',
			'Preset produk...',
		)
	} catch (err) {}
}

/* ------------------------------- podcast -------------------------------- */

function podBrief() {
	var hosts = []
	if ($('podHost1').value.trim()) hosts.push({ name: $('podHost1').value.trim(), voice: $('podVoice1').value })
	if ($('podHost2').value.trim()) hosts.push({ name: $('podHost2').value.trim(), voice: $('podVoice2').value })
	return {
		topic: $('podTopic').value.trim(),
		notes: $('podNotes').value.trim(),
		minutes: Number($('podMinutes').value) || 5,
		tone: $('podTone').value,
		hosts: hosts.length ? hosts : [{ name: 'Host A', voice: 'host-a' }, { name: 'Host B', voice: 'host-b' }],
	}
}

function renderPodScript() {
	var script = state.podScript
	var card = $('podScriptCard')
	if (!script) {
		hide(card, true)
		return
	}
	hide(card, false)
	$('podScriptMeta').textContent = (script.title || '') + ' - ' + (script.segments || []).length + ' dialog'
	$('podSegments').innerHTML = (script.segments || [])
		.map(function (segment, index) {
			return (
				'<div class="segment" data-segment="' +
				index +
				'"><div class="row between"><input class="mini wide" data-field="speaker" value="' +
				esc(segment.speaker || '') +
				'" /><button class="btn tiny danger" data-remove-segment="' +
				index +
				'">x</button></div><textarea rows="2" data-field="text">' +
				esc(segment.text || '') +
				'</textarea></div>'
			)
		})
		.join('')
	$('podSegments')
		.querySelectorAll('.segment')
		.forEach(function (node) {
			var index = Number(node.getAttribute('data-segment'))
			node.querySelectorAll('[data-field]').forEach(function (field) {
				field.addEventListener('input', function () {
					state.podScript.segments[index][field.getAttribute('data-field')] = field.value
				})
			})
			var remove = node.querySelector('[data-remove-segment]')
			if (remove) {
				remove.addEventListener('click', function () {
					state.podScript.segments.splice(index, 1)
					renderPodScript()
				})
			}
		})
}

function initPodcast() {
	$('podScriptBtn').addEventListener('click', async function () {
		var brief = podBrief()
		if (!brief.topic) return toast('Isi topik podcast dulu', 'warn')
		$('podScriptBtn').disabled = true
		$('podScriptBtn').textContent = 'Menulis skrip...'
		try {
			var data = await api('/api/podcast/script', { method: 'POST', body: brief })
			state.podScript = data.script
			renderPodScript()
			toast('Skrip podcast siap', 'success')
		} catch (err) {
			toast(err.message, 'error')
		} finally {
			$('podScriptBtn').disabled = false
			$('podScriptBtn').textContent = 'Buat skrip'
		}
	})

	$('podRender').addEventListener('click', async function () {
		var brief = podBrief()
		if (!brief.topic && !state.podScript) return toast('Isi topik dulu', 'warn')
		$('podRender').disabled = true
		try {
			var data = await api('/api/podcast/render', {
				method: 'POST',
				body: Object.assign(brief, {
					script: state.podScript,
					style: $('podStyle').value,
					aspect: $('podAspect').value,
					resolution: $('podResolution').value,
					musicMood: $('podMusic').value,
					gap: Number($('podGap').value) || 0.35,
					coverAssetId: $('podCover').value || null,
					subtitle: $('podSubtitle') && $('podSubtitle').type === 'checkbox' ? $('podSubtitle').checked : $('podSubtitle').value !== 'none',
					subtitleStyle: $('podSubtitle') && $('podSubtitle').type === 'checkbox' ? ($('podSubtitle').checked ? 'minimal' : 'none') : $('podSubtitle').value,
					naturalPreset: $('podNatural').value,
				}),
			})
			upsertJob(data.job)
			toast('Render podcast masuk antrian', 'success')
			go('jobs')
		} catch (err) {
			toast(err.message, 'error')
		} finally {
			$('podRender').disabled = false
		}
	})
}

/* --------------------------------- voice -------------------------------- */

async function loadVoiceList() {
	var data = await api('/api/library')
	state.library = { videos: data.videos || [], audios: data.audios || [] }
	var node = $('voiceList')
	if (!node) return
	var audios = state.library.audios
	if (!audios.length) {
		node.innerHTML = '<p class="empty">Belum ada hasil suara.</p>'
		return
	}
	node.innerHTML = audios
		.map(function (audio) {
			return (
				'<div class="list-item column"><div class="row between"><strong>' +
				esc(audio.title) +
				'</strong><span class="muted">' +
				esc(fmtDur(audio.duration) + ' - ' + timeAgo(audio.createdAt)) +
				'</span></div><audio controls preload="none" src="' +
				esc(audio.url) +
				'"></audio><div class="row gap"><a class="btn tiny" href="' +
				esc(audio.downloadUrl) +
				'">Download</a><button class="btn tiny danger" data-del-audio="' +
				esc(audio.id) +
				'">Hapus</button></div></div>'
			)
		})
		.join('')
	node.querySelectorAll('[data-del-audio]').forEach(function (button) {
		button.addEventListener('click', async function () {
			try {
				await api('/api/library/audio/' + button.getAttribute('data-del-audio'), { method: 'DELETE' })
				loadVoiceList()
			} catch (err) {
				toast(err.message, 'error')
			}
		})
	})
}

function initVoice() {
	document.querySelectorAll('#voiceTabs [data-tab]').forEach(function (tab) {
		tab.addEventListener('click', function () {
			state.voiceTab = tab.getAttribute('data-tab')
			document.querySelectorAll('#voiceTabs [data-tab]').forEach(function (item) {
				item.classList.toggle('active', item === tab)
			})
			document.querySelectorAll('[data-pane]').forEach(function (pane) {
				pane.hidden = pane.getAttribute('data-pane') !== state.voiceTab
			})
		})
	})

	;[
		['voicePitch', 'voicePitchVal', ' st'],
		['voiceSpeed', 'voiceSpeedVal', 'x'],
		['voiceRoom', 'voiceRoomVal', ''],
	].forEach(function (pair) {
		var input = $(pair[0])
		var label = $(pair[1])
		if (!input || !label) return
		var sync = function () {
			label.textContent = input.value + pair[2]
		}
		input.addEventListener('input', sync)
		sync()
	})

	if ($('voiceText')) {
		$('voiceText').addEventListener('input', function () {
			if ($('voiceCount')) $('voiceCount').textContent = $('voiceText').value.length + ' karakter'
		})
	}
	if ($('voiceRefresh')) $('voiceRefresh').addEventListener('click', loadVoiceList)
	if ($('voiceAsset')) {
		$('voiceAsset').addEventListener('change', function () {
			state.transformAssetId = $('voiceAsset').value
		})
	}

	$('voiceRender').addEventListener('click', async function () {
		var isTransform = state.voiceTab === 'transform'
		var body = {
			mode: isTransform ? 'transform' : 'tts',
			naturalPreset: $('voiceNatural').value,
			pitch: Number($('voicePitch').value) || 0,
			speed: Number($('voiceSpeed').value) || 1,
			room: Number($('voiceRoom').value) || 0,
			denoise: $('voiceDenoise').checked,
			mp3: $('voiceMp3').checked,
		}
		if (isTransform) {
			body.assetId = $('voiceAsset').value || state.transformAssetId
			if (!body.assetId) return toast('Pilih file audio/video dulu', 'warn')
		} else {
			body.text = $('voiceText').value.trim()
			body.voice = $('voiceSelect').value
			if (!body.text) return toast('Isi teksnya dulu', 'warn')
		}
		$('voiceRender').disabled = true
		try {
			var data = await api('/api/voice/render', { method: 'POST', body: body })
			upsertJob(data.job)
			toast('Proses suara masuk antrian', 'success')
		} catch (err) {
			toast(err.message, 'error')
		} finally {
			$('voiceRender').disabled = false
		}
	})
}

/* --------------------------------- live --------------------------------- */

async function loadStreams() {
	var results = await Promise.all([api('/api/streams'), api('/api/library'), api('/api/assets?limit=200')])
	state.streams = (results[0] || {}).streams || []
	state.library = { videos: (results[1] || {}).videos || [], audios: (results[1] || {}).audios || [] }
	state.assets = (results[2] || {}).assets || []
	renderAssetSelects()

	var options = state.library.videos
		.map(function (video) {
			return { id: video.id, label: '[video] ' + video.title + ' (' + fmtDur(video.duration) + ')' }
		})
		.concat(
			state.assets
				.filter(function (asset) {
					return asset.kind === 'video'
				})
				.map(function (asset) {
					return { id: asset.id, label: '[file] ' + asset.name }
				}),
		)
	fillSelect('lvItems', options)
	renderStreams()
}

function renderStreams() {
	var node = $('streamList')
	if (!node) return
	if (!state.streams.length) {
		node.innerHTML = '<p class="empty">Belum ada channel. Buat di form sebelah.</p>'
		return
	}
	node.innerHTML = state.streams
		.map(function (stream) {
			var status = stream.status || {}
			var live = status.status === 'live' || status.status === 'reconnecting'
			var stats = status.stats || {}
			return (
				'<article class="card stream"><div class="row between"><div><strong>' +
				esc(stream.name) +
				'</strong><div class="muted small">' +
				esc(stream.rtmpUrl + ' - key ' + (stream.streamKey || 'belum diisi')) +
				'</div></div>' +
				badge(status.status || 'stopped') +
				'</div><div class="kv"><span>Mode</span><b>' +
				esc(status.mode || stream.mode) +
				'</b><span>Playlist</span><b>' +
				esc((stream.items || []).length + ' video') +
				'</b><span>Uptime</span><b>' +
				esc(fmtDur(status.uptimeSeconds || 0)) +
				'</b><span>Total uptime</span><b>' +
				esc(fmtDur(status.totalUptimeSeconds || 0)) +
				'</b><span>Restart</span><b>' +
				esc(String(status.restarts || 0)) +
				'</b><span>Bitrate</span><b>' +
				esc(stats.bitrate || stream.videoBitrate || '-') +
				'</b><span>Speed</span><b>' +
				esc(stats.speed ? stats.speed + 'x' : '-') +
				'</b><span>Auto start</span><b>' +
				(stream.autoStart ? 'ya' : 'tidak') +
				'</b></div>' +
				(status.lastError ? '<p class="error-text">' + esc(status.lastError) + '</p>' : '') +
				'<div class="row gap wrap">' +
				(live
					? '<button class="btn tiny danger" data-stream-stop="' + esc(stream.id) + '">Stop</button><button class="btn tiny" data-stream-restart="' + esc(stream.id) + '">Restart</button>'
					: '<button class="btn tiny primary" data-stream-start="' + esc(stream.id) + '">Start</button>') +
				'<button class="btn tiny" data-stream-inspect="' +
				esc(stream.id) +
				'">Inspect</button><button class="btn tiny" data-stream-logs="' +
				esc(stream.id) +
				'">Logs</button><button class="btn tiny" data-stream-auto="' +
				esc(stream.id) +
				'">' +
				(stream.autoStart ? 'Matikan auto' : 'Auto start') +
				'</button><button class="btn tiny danger" data-stream-del="' +
				esc(stream.id) +
				'">Hapus</button></div></article>'
			)
		})
		.join('')

	function bind(attribute, handler) {
		node.querySelectorAll('[' + attribute + ']').forEach(function (button) {
			button.addEventListener('click', async function () {
				button.disabled = true
				try {
					await handler(button.getAttribute(attribute))
				} catch (err) {
					toast(err.message, 'error')
				} finally {
					button.disabled = false
				}
			})
		})
	}

	bind('data-stream-start', async function (id) {
		await api('/api/streams/' + id + '/start', { method: 'POST', body: {} })
		toast('Streaming dimulai', 'success')
		loadStreams()
	})
	bind('data-stream-stop', async function (id) {
		await api('/api/streams/' + id + '/stop', { method: 'POST', body: {} })
		loadStreams()
	})
	bind('data-stream-restart', async function (id) {
		await api('/api/streams/' + id + '/restart', { method: 'POST', body: {} })
		loadStreams()
	})
	bind('data-stream-auto', async function (id) {
		var stream = state.streams.filter(function (item) {
			return item.id === id
		})[0]
		await api('/api/streams/' + id, { method: 'PATCH', body: { autoStart: !(stream && stream.autoStart) } })
		loadStreams()
	})
	bind('data-stream-del', async function (id) {
		if (!confirm('Hapus channel ini?')) return
		await api('/api/streams/' + id, { method: 'DELETE' })
		loadStreams()
	})
	bind('data-stream-logs', async function (id) {
		state.activeStream = id
		await loadStreamLogs(id)
	})
	bind('data-stream-inspect', async function (id) {
		var info = await api('/api/streams/' + id + '/inspect')
		var lines = [
			'Total durasi playlist: ' + info.totalDurationText,
			'Loop per hari: ' + info.loopCountPerDay + 'x',
			'Estimasi bandwidth: ' + info.estimatedGbPerDay + ' GB/hari',
			'Mode siap pakai: ' + info.readyMode,
			info.missing ? 'File hilang: ' + info.missing : 'Semua file lengkap',
			'',
		].concat(
			(info.files || []).map(function (file) {
				return file.name + ' | ' + file.durationText + ' | ' + file.width + 'x' + file.height + ' | ' + file.fps + 'fps | ' + file.videoCodec + '/' + file.audioCodec + ' | ' + fmtBytes(file.size)
			}),
		)
		state.activeStream = id
		$('streamLogs').textContent = lines.join('\n')
	})
}

async function loadStreamLogs(id) {
	if (!id) return
	var data = await api('/api/streams/' + id + '/logs')
	var node = $('streamLogs')
	if (!node) return
	var logs = data.logs || []
	node.textContent = logs.length
		? logs
				.map(function (entry) {
					return '[' + String(entry.at).slice(11, 19) + '] ' + String(entry.level).toUpperCase() + ' ' + entry.message
				})
				.join('\n')
		: 'Belum ada log.'
}

function initLive() {
	$('lvCreate').addEventListener('click', async function () {
		var items = Array.prototype.slice.call($('lvItems').selectedOptions).map(function (option) {
			return option.value
		})
		if (!items.length) return toast('Pilih minimal 1 video untuk playlist', 'warn')
		var body = {
			name: $('lvName').value.trim() || 'Live 24 Jam',
			rtmpUrl: $('lvRtmp').value.trim(),
			streamKey: $('lvKey').value.trim(),
			items: items,
			mode: $('lvMode').value,
			resolution: $('lvRes').value,
			fps: Number($('lvFps').value) || 30,
			videoBitrate: $('lvBitrate').value.trim() || '4500k',
			audioMode: $('lvAudio').value,
			musicAssetId: $('lvMusic').value || null,
			loop: $('lvLoop').checked,
			autoStart: $('lvAuto').checked,
		}
		if (!body.streamKey) return toast('Stream key YouTube wajib diisi', 'warn')
		try {
			await api('/api/streams', { method: 'POST', body: body })
			toast('Channel live dibuat', 'success')
			$('lvKey').value = ''
			loadStreams()
		} catch (err) {
			toast(err.message, 'error')
		}
	})
	if ($('streamLogRefresh')) {
		$('streamLogRefresh').addEventListener('click', function () {
			loadStreamLogs(state.activeStream)
		})
	}
}

/* ------------------------------ automation ------------------------------ */

async function loadAutomations() {
	var results = await Promise.all([api('/api/automations'), api('/api/streams')])
	state.automations = (results[0] || {}).automations || []
	state.streams = (results[1] || {}).streams || []
	fillSelect(
		'atStream',
		state.streams.map(function (stream) {
			return { id: stream.id, label: stream.name }
		}),
		'',
		'Pilih channel...',
	)
	if ($('inboxPath') && results[0].inbox) $('inboxPath').textContent = results[0].inbox
	renderAutomations()
}

function renderAutomations() {
	var node = $('automationList')
	if (!node) return
	if (!state.automations.length) {
		node.innerHTML = '<p class="empty">Belum ada automation.</p>'
		return
	}
	node.innerHTML = state.automations
		.map(function (item) {
			return (
				'<article class="card automation"><div class="row between"><div><strong>' +
				esc(item.name) +
				'</strong><div class="muted small">' +
				esc(item.action + ' - trigger ' + item.trigger) +
				'</div></div><span class="badge ' +
				(item.enabled ? 'green' : 'dim') +
				'">' +
				(item.enabled ? 'aktif' : 'nonaktif') +
				'</span></div><div class="kv"><span>Jalan</span><b>' +
				esc(String(item.runs || 0) + 'x') +
				'</b><span>Terakhir</span><b>' +
				esc(item.lastRunAt ? timeAgo(item.lastRunAt) : '-') +
				'</b><span>Berikutnya</span><b>' +
				esc(item.nextRunAt ? new Date(item.nextRunAt).toLocaleString('id-ID') : '-') +
				'</b></div>' +
				(item.trigger === 'webhook' ? '<div class="code-line">POST ' + esc(location.origin + item.webhookUrl) + '</div>' : '') +
				(item.trigger === 'watch-folder' ? '<div class="code-line">' + esc(item.watchFolder || '') + '</div>' : '') +
				'<div class="row gap wrap"><button class="btn tiny primary" data-at-run="' +
				esc(item.id) +
				'">Run sekarang</button><button class="btn tiny" data-at-toggle="' +
				esc(item.id) +
				'">' +
				(item.enabled ? 'Nonaktifkan' : 'Aktifkan') +
				'</button><button class="btn tiny danger" data-at-del="' +
				esc(item.id) +
				'">Hapus</button></div></article>'
			)
		})
		.join('')

	node.querySelectorAll('[data-at-run]').forEach(function (button) {
		button.addEventListener('click', async function () {
			try {
				await api('/api/automations/' + button.getAttribute('data-at-run') + '/run', { method: 'POST', body: {} })
				toast('Automation dijalankan', 'success')
				loadAutomations()
			} catch (err) {
				toast(err.message, 'error')
			}
		})
	})
	node.querySelectorAll('[data-at-toggle]').forEach(function (button) {
		button.addEventListener('click', async function () {
			var id = button.getAttribute('data-at-toggle')
			var item = state.automations.filter(function (automation) {
				return automation.id === id
			})[0]
			try {
				await api('/api/automations/' + id, { method: 'PATCH', body: { enabled: !(item && item.enabled) } })
				loadAutomations()
			} catch (err) {
				toast(err.message, 'error')
			}
		})
	})
	node.querySelectorAll('[data-at-del]').forEach(function (button) {
		button.addEventListener('click', async function () {
			if (!confirm('Hapus automation ini?')) return
			try {
				await api('/api/automations/' + button.getAttribute('data-at-del'), { method: 'DELETE' })
				loadAutomations()
			} catch (err) {
				toast(err.message, 'error')
			}
		})
	})
}

function syncAutomationFields() {
	var trigger = $('atTrigger').value
	var action = $('atAction').value
	hide($('atScheduleFields'), trigger !== 'schedule')
	hide($('atIntervalField'), trigger !== 'interval')
	hide($('atStreamField'), action.indexOf('stream.') !== 0)
}

function initAutomation() {
	$('atTrigger').addEventListener('change', syncAutomationFields)
	$('atAction').addEventListener('change', syncAutomationFields)
	syncAutomationFields()

	$('atCreate').addEventListener('click', async function () {
		var payload = {}
		var raw = $('atPayload').value.trim()
		if (raw) {
			try {
				payload = JSON.parse(raw)
			} catch (err) {
				return toast('Payload JSON tidak valid', 'error')
			}
		}
		if ($('atProduct').value.trim()) payload.product = $('atProduct').value.trim()
		var body = {
			name: $('atName').value.trim() || 'Automation',
			action: $('atAction').value,
			trigger: $('atTrigger').value,
			payload: payload,
			streamId: $('atStream').value || null,
			schedule: {
				time: $('atTime').value || '08:00',
				days: String($('atDays').value || '0,1,2,3,4,5,6')
					.split(',')
					.map(function (day) {
						return Number(day.trim())
					})
					.filter(function (day) {
						return !isNaN(day)
					}),
			},
			intervalMinutes: Number($('atMinutes').value) || 120,
		}
		try {
			await api('/api/automations', { method: 'POST', body: body })
			toast('Automation dibuat', 'success')
			$('atName').value = ''
			loadAutomations()
		} catch (err) {
			toast(err.message, 'error')
		}
	})
}

/* --------------------------------- jobs --------------------------------- */

async function loadJobs() {
	var filter = $('jobFilter') ? $('jobFilter').value : ''
	var data = await api('/api/jobs?limit=60' + (filter ? '&status=' + encodeURIComponent(filter) : ''))
	state.jobs = Array.isArray(data) ? data : data.jobs || []
	renderJobs()
}

function renderJobs() {
	var node = $('jobList')
	if (!node) return
	if (!state.jobs.length) {
		node.innerHTML = '<p class="empty">Belum ada job.</p>'
		return
	}
	node.innerHTML = state.jobs
		.map(function (job) {
			var result = job.result || {}
			return (
				'<div class="list-item column"><div class="row between"><div><strong>' +
				esc(job.title) +
				'</strong><div class="muted small">' +
				esc(job.type + ' - ' + (job.lane || '') + ' - ' + (job.source || '') + ' - ' + timeAgo(job.createdAt)) +
				'</div></div>' +
				badge(job.status) +
				'</div><div class="progress"><i style="width:' +
				(job.progress || 0) +
				'%"></i></div><div class="row between"><span class="muted small">' +
				esc((job.stage || '') + (job.error ? ' - ' + job.error : '')) +
				'</span><div class="row gap">' +
				(result.url ? '<a class="btn tiny" href="' + esc(result.url) + '" target="_blank" rel="noreferrer">Hasil</a>' : '') +
				'<button class="btn tiny" data-job-detail="' +
				esc(job.id) +
				'">Detail</button>' +
				(job.status === 'running' || job.status === 'queued' ? '<button class="btn tiny danger" data-job-cancel="' + esc(job.id) + '">Cancel</button>' : '') +
				(job.status === 'failed' || job.status === 'canceled' ? '<button class="btn tiny" data-job-retry="' + esc(job.id) + '">Retry</button>' : '') +
				'<button class="btn tiny danger" data-job-del="' +
				esc(job.id) +
				'">Hapus</button></div></div></div>'
			)
		})
		.join('')

	node.querySelectorAll('[data-job-detail]').forEach(function (button) {
		button.addEventListener('click', function () {
			openJobDetail(button.getAttribute('data-job-detail'))
		})
	})
	node.querySelectorAll('[data-job-cancel]').forEach(function (button) {
		button.addEventListener('click', async function () {
			await api('/api/jobs/' + button.getAttribute('data-job-cancel') + '/cancel', { method: 'POST', body: {} })
			loadJobs()
		})
	})
	node.querySelectorAll('[data-job-retry]').forEach(function (button) {
		button.addEventListener('click', async function () {
			await api('/api/jobs/' + button.getAttribute('data-job-retry') + '/retry', { method: 'POST', body: {} })
			loadJobs()
		})
	})
	node.querySelectorAll('[data-job-del]').forEach(function (button) {
		button.addEventListener('click', async function () {
			await api('/api/jobs/' + button.getAttribute('data-job-del'), { method: 'DELETE' })
			loadJobs()
		})
	})
}

async function openJobDetail(id) {
	try {
		var data = await api('/api/jobs/' + id)
		var job = data.job
		state.activeJob = id
		hide($('jobDetailCard'), false)
		$('jobDetailTitle').textContent = job.title
		var lines = [
			'Status: ' + job.status + ' (' + (job.progress || 0) + '%)',
			'Tipe: ' + job.type + ' | lane: ' + (job.lane || '-') + ' | sumber: ' + (job.source || '-'),
			'Dibuat: ' + (job.createdAt || '-'),
			'Selesai: ' + (job.finishedAt || '-'),
			job.error ? 'Error: ' + job.error : '',
			'',
		]
			.concat(
				(job.logs || []).map(function (entry) {
					return '[' + String(entry.at || '').slice(11, 19) + '] ' + (entry.message || entry)
				}),
			)
			.filter(Boolean)
		$('jobDetail').textContent = lines.join('\n')
	} catch (err) {
		toast(err.message, 'error')
	}
}

function appendJobLog(message) {
	var node = $('jobDetail')
	if (!node) return
	node.textContent = node.textContent + '\n' + message
	node.scrollTop = node.scrollHeight
}

function initJobs() {
	if ($('jobFilter')) $('jobFilter').addEventListener('change', loadJobs)
	if ($('jobDetailClose')) {
		$('jobDetailClose').addEventListener('click', function () {
			state.activeJob = null
			hide($('jobDetailCard'), true)
		})
	}
}

/* -------------------------------- library ------------------------------- */

async function loadLibrary() {
	var filter = $('libFilter') ? $('libFilter').value : 'all'
	var data = await api('/api/library?type=' + encodeURIComponent(filter || 'all'))
	state.library = { videos: data.videos || [], audios: data.audios || [] }
	var videoNode = $('libVideos')
	if (videoNode) {
		videoNode.innerHTML = state.library.videos.length
			? state.library.videos
					.map(function (video) {
						return (
							'<article class="video-card"><div class="thumb">' +
							(video.thumbUrl ? '<img src="' + esc(video.thumbUrl) + '" alt="" loading="lazy" />' : '<div class="thumb-fallback">' + esc(String(video.type).toUpperCase()) + '</div>') +
							'<span class="pill">' +
							esc(fmtDur(video.duration)) +
							'</span></div><div class="video-meta"><strong>' +
							esc(video.title) +
							'</strong><span class="muted">' +
							esc((video.aspect || '') + ' - ' + video.width + 'x' + video.height + ' - ' + fmtBytes(video.size)) +
							'</span>' +
							(video.simulated ? '<span class="badge orange">simulasi</span>' : '') +
							'<div class="row gap wrap"><a class="btn tiny" href="' +
							esc(video.url) +
							'" target="_blank" rel="noreferrer">Preview</a><a class="btn tiny" href="' +
							esc(video.downloadUrl) +
							'">Download</a>' +
							(video.caption ? '<button class="btn tiny" data-copy-caption="' + esc(video.id) + '">Copy caption</button>' : '') +
							'<button class="btn tiny danger" data-del-video="' +
							esc(video.id) +
							'">Hapus</button></div></div></article>'
						)
					})
					.join('')
			: '<p class="empty">Belum ada video.</p>'

		videoNode.querySelectorAll('[data-copy-caption]').forEach(function (button) {
			button.addEventListener('click', function () {
				var video = state.library.videos.filter(function (item) {
					return item.id === button.getAttribute('data-copy-caption')
				})[0]
				if (!video) return
				var text = video.caption + (video.hashtags ? '\n\n' + video.hashtags : '')
				navigator.clipboard.writeText(text).then(function () {
					toast('Caption dicopy', 'success')
				})
			})
		})
		videoNode.querySelectorAll('[data-del-video]').forEach(function (button) {
			button.addEventListener('click', async function () {
				if (!confirm('Hapus video ini?')) return
				try {
					await api('/api/library/video/' + button.getAttribute('data-del-video'), { method: 'DELETE' })
					loadLibrary()
				} catch (err) {
					toast(err.message, 'error')
				}
			})
		})
	}

	var audioNode = $('libAudios')
	if (audioNode) {
		audioNode.innerHTML = state.library.audios.length
			? state.library.audios
					.map(function (audio) {
						return (
							'<div class="list-item column"><div class="row between"><strong>' +
							esc(audio.title) +
							'</strong><span class="muted">' +
							esc(fmtDur(audio.duration)) +
							'</span></div><audio controls preload="none" src="' +
							esc(audio.url) +
							'"></audio><a class="btn tiny" href="' +
							esc(audio.downloadUrl) +
							'">Download</a></div>'
						)
					})
					.join('')
			: '<p class="empty">Belum ada audio.</p>'
	}
}

function initLibrary() {
	if ($('libFilter')) $('libFilter').addEventListener('change', loadLibrary)
}

/* --------------------------------- brand -------------------------------- */

async function loadBrand() {
	var data = await api('/api/brand')
	state.brand = data.brand || {}
	var map = {
		brName: 'name',
		brTagline: 'tagline',
		brAudience: 'audience',
		brTone: 'tone',
		brCta: 'ctaText',
		brHashtags: 'hashtags',
		brWatermark: 'watermarkText',
		brBanned: 'bannedWords',
		brPrimary: 'primaryColor',
		brAccent: 'accentColor',
	}
	Object.keys(map).forEach(function (id) {
		var node = $(id)
		if (!node) return
		var value = state.brand[map[id]]
		node.value = Array.isArray(value) ? value.join(', ') : value || ''
	})
}

function initBrand() {
	$('brSave').addEventListener('click', async function () {
		var body = {
			name: $('brName').value.trim(),
			tagline: $('brTagline').value.trim(),
			audience: $('brAudience').value.trim(),
			tone: $('brTone').value.trim(),
			ctaText: $('brCta').value.trim(),
			hashtags: $('brHashtags').value.trim(),
			watermarkText: $('brWatermark').value.trim(),
			bannedWords: $('brBanned')
				.value.split(',')
				.map(function (word) {
					return word.trim()
				})
				.filter(Boolean),
			primaryColor: $('brPrimary').value,
			accentColor: $('brAccent').value,
		}
		try {
			await api('/api/brand', { method: 'PATCH', body: body })
			toast('Brand kit disimpan', 'success')
		} catch (err) {
			toast(err.message, 'error')
		}
	})
}

/* ------------------------------- settings ------------------------------- */

var SETTING_FIELDS = [
	['stFlowProvider', 'flow', 'provider', ['flow', 'simulate']],
	['stFlowBase', 'flow', 'baseUrl'],
	['stFlowKey', 'flow', 'apiKey'],
	['stFlowVideoModel', 'flow', 'videoModel'],
	['stFlowImageModel', 'flow', 'imageModel'],
	['stFlowLane', 'flow', 'defaultLane', ['low', 'standard']],
	['stFlowLowConc', 'flow', 'lowConcurrency'],
	['stFlowDaily', 'flow', 'standardDailyLimit'],
	['stFlowVideoPath', 'flow', 'videoPath'],
	['stFlowImagePath', 'flow', 'imagePath'],
	['stFlowStatusPath', 'flow', 'statusPath'],
	['stFlowFallback', 'flow', 'autoFallbackToLow'],
	['stTtsProvider', 'tts', 'provider', ['fishaudio', 'simulate', 'elevenlabs', 'openai', 'custom']],
	['stTtsBase', 'tts', 'baseUrl'],
	['stTtsKey', 'tts', 'apiKey'],
	['stTtsModel', 'tts', 'model'],
	['stTtsVoice', 'tts', 'defaultVoice'],
	['stTtsCache', 'tts', 'cache'],
	['stTtsNatural', 'tts', 'naturalPreset'],
	['stTtsNaturalize', 'tts', 'naturalize'],
	['stLlmProvider', 'llm', 'provider', ['local', 'remote']],
	['stLlmBase', 'llm', 'baseUrl'],
	['stLlmKey', 'llm', 'apiKey'],
	['stLlmModel', 'llm', 'model'],
	['stRenderRes', 'render', 'resolution', ['720', '1080', '1440', '2160']],
	['stRenderFps', 'render', 'fps', ['24', '25', '30', '60']],
	['stRenderPreset', 'render', 'preset', ['ultrafast', 'veryfast', 'faster', 'fast', 'medium']],
	['stRenderCrf', 'render', 'crf'],
	['stRenderMusicVol', 'render', 'musicVolume'],
	['stQueueConc', 'queue', 'concurrency'],
	['stQueueRetry', 'queue', 'maxRetries'],
	['stNotifyUrl', 'notifications', 'webhookUrl'],
	['stStreamRtmp', 'stream', 'rtmpUrl'],
	['stStreamKey', 'stream', 'streamKey'],
	['stStreamBitrate', 'stream', 'videoBitrate'],
	['stStreamBackoff', 'stream', 'restartBackoffMs'],
]

async function loadSettings() {
	var data = await api('/api/settings')
	state.settings = data.settings || {}
	fillSelect('stTtsNatural', (state.presets || {}).naturalPresets, ((state.settings.tts || {}).naturalPreset))
	SETTING_FIELDS.forEach(function (field) {
		var node = $(field[0])
		if (!node) return
		if (field[3] && node.tagName === 'SELECT') fillSelect(field[0], field[3])
		var value = (state.settings[field[1]] || {})[field[2]]
		if (node.type === 'checkbox') node.checked = Boolean(value)
		else node.value = value === undefined || value === null ? '' : value
	})
}

function initSettings() {
	$('stSave').addEventListener('click', async function () {
		var body = {}
		SETTING_FIELDS.forEach(function (field) {
			var node = $(field[0])
			if (!node) return
			if (!body[field[1]]) body[field[1]] = {}
			if (node.type === 'checkbox') body[field[1]][field[2]] = node.checked
			else if (node.type === 'number') body[field[1]][field[2]] = Number(node.value)
			else body[field[1]][field[2]] = node.value
		})
		try {
			await api('/api/settings', { method: 'PATCH', body: body })
			toast('Settings disimpan', 'success')
			await loadBootstrap()
			await loadSettings()
		} catch (err) {
			toast(err.message, 'error')
		}
	})

	document.querySelectorAll('[data-test]').forEach(function (button) {
		button.addEventListener('click', async function () {
			var provider = button.getAttribute('data-test')
			button.disabled = true
			$('stResult').textContent = 'Mengetes ' + provider + '...'
			try {
				var data = await api('/api/settings/test/' + provider, { method: 'POST', body: {} })
				$('stResult').textContent = (data.ok ? '[OK] ' : '[GAGAL] ') + provider + ': ' + (data.message || data.mode || '')
				toast(provider + ': ' + (data.ok ? 'OK' : 'gagal'), data.ok ? 'success' : 'error')
			} catch (err) {
				$('stResult').textContent = '[GAGAL] ' + provider + ': ' + err.message
			} finally {
				button.disabled = false
			}
		})
	})

	$('stCleanup').addEventListener('click', async function () {
		try {
			var data = await api('/api/system/cleanup', { method: 'POST', body: {} })
			$('stResult').textContent = data.message + ' (' + data.removed + ' item temporary dihapus)'
			toast('Bersih-bersih selesai', 'success')
		} catch (err) {
			toast(err.message, 'error')
		}
	})
}

/* --------------------------------- logs --------------------------------- */

async function loadLogs() {
	var data = await api('/api/logs?limit=200')
	var node = $('logBox')
	if (!node) return
	var logs = data.logs || []
	node.textContent = logs.length
		? logs
				.map(function (entry) {
					var payload = entry.data || {}
					return '[' + String(entry.at || '').slice(11, 19) + '] ' + String(entry.type || '').padEnd(16, ' ') + ' ' + (payload.message || payload.name || payload.title || JSON.stringify(payload).slice(0, 160))
				})
				.join('\n')
		: 'Belum ada log.'
}

function initLogs() {
	if ($('logRefresh')) $('logRefresh').addEventListener('click', loadLogs)
}

/* --------------------------------- init --------------------------------- */

function initTopbar() {
	$('btnRefresh').addEventListener('click', async function () {
		try {
			await loadBootstrap()
			await refreshView(state.view)
			toast('Data diperbarui', 'info')
		} catch (err) {
			toast(err.message, 'error')
		}
	})
	$('btnPause').addEventListener('click', async function () {
		var paused = $('btnPause').textContent.indexOf('Lanjutkan') === -1
		try {
			var data = await api('/api/queue/pause', { method: 'POST', body: { paused: paused } })
			$('btnPause').textContent = data.paused ? 'Lanjutkan queue' : 'Pause queue'
			toast(data.paused ? 'Queue dipause' : 'Queue jalan lagi', 'info')
		} catch (err) {
			toast(err.message, 'error')
		}
	})
}

async function pollHealth() {
	try {
		var health = await api('/api/health')
		setDot('dotFlow', 'modeFlow', health.flowMode === 'flow', health.flowMode === 'flow' ? 'Flow Ultra' : 'Flow simulasi')
		setDot('dotTts', 'modeTts', health.ttsMode !== 'simulate', health.ttsMode !== 'simulate' ? 'Voice ' + health.ttsMode : 'Voice simulasi')
	} catch (err) {}
}

async function boot() {
	initRouter()
	initTopbar()
	initUgc()
	initPodcast()
	initVoice()
	initLive()
	initAutomation()
	initJobs()
	initLibrary()
	initBrand()
	initSettings()
	initLogs()
	try {
		await loadBootstrap()
	} catch (err) {
		toast('Gagal memuat konfigurasi: ' + err.message, 'error')
	}
	initSSE()
	loadProducts()
	go(location.hash.slice(1) || 'dashboard')
	setInterval(pollHealth, 30000)
	setInterval(function () {
		if (state.view === 'live') loadStreams()
	}, 20000)
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
else boot()
