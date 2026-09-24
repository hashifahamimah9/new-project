'use strict'

/**
 * UGC Flow Studio - server utama.
 * Semua fitur diakses lewat REST API sederhana + SSE untuk progres realtime.
 */

const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const childProcess = require('child_process')

const { PATHS, APP, RESOLUTIONS } = require('./lib/config')
const store = require('./lib/store')
const queue = require('./lib/queue')
const httpx = require('./lib/httpx')
const multipart = require('./lib/multipart')
const events = require('./lib/events')
const ff = require('./lib/ffmpeg')
const util = require('./lib/util')
const { getDownloadsDir } = require('./lib/downloads')
const flow = require('./providers/flow')
const tts = require('./providers/tts')
const llm = require('./providers/llm')
const studio = require('./services/studio')
const streams = require('./services/stream')
const automation = require('./services/automation')

store.load()

queue.register('ugc.render', studio.renderUgc)
queue.register('podcast.render', studio.renderPodcast)
queue.register('voice.render', studio.renderVoice)
queue.register('images.generate', studio.generateImagePack)

const START_TIME = Date.now()
const GENERIC_COLLECTIONS = ['products', 'templates', 'personas', 'playlists']
const SECRET_KEYS = ['apiKey', 'streamKey', 'password', 'fishAudioApiKey']
const VIDEO_EXTS = ['.mp4', '.webm', '.mov', '.mkv']

/* -------------------------------- helpers -------------------------------- */

function maskDeep(value) {
	if (!value || typeof value !== 'object') return value
	const out = Array.isArray(value) ? [] : {}
	for (const [key, val] of Object.entries(value)) {
		if (SECRET_KEYS.indexOf(key) !== -1 && typeof val === 'string' && val) out[key] = val.slice(0, 3) + '\u2022\u2022\u2022\u2022\u2022\u2022' + val.slice(-2)
		else if (val && typeof val === 'object') out[key] = maskDeep(val)
		else out[key] = val
	}
	return out
}

/** Buang field rahasia yang masih berupa mask supaya tidak menimpa nilai asli. */
function stripMasked(patch) {
	if (!patch || typeof patch !== 'object') return patch
	const out = Array.isArray(patch) ? [] : {}
	for (const [key, val] of Object.entries(patch)) {
		if (typeof val === 'string' && val.indexOf('\u2022') !== -1) continue
		if (val && typeof val === 'object') out[key] = stripMasked(val)
		else out[key] = val
	}
	return out
}

function dirSize(dir) {
	let total = 0
	let entries = []
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true })
	} catch (err) {
		return 0
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name)
		try {
			if (entry.isDirectory()) total += dirSize(full)
			else total += fs.statSync(full).size
		} catch (err) {}
	}
	return total
}

/** Mode suara yang benar-benar dipakai (Google gratis = "simulate" di UI supaya user diingatkan isi API key). */
function ttsModeInfo() {
	const active = tts.activeProvider()
	return {
		mode: active.provider === 'google' || active.provider === 'placeholder' ? 'simulate' : active.provider,
		provider: active.provider,
		label: active.label,
		reason: active.reason || '',
	}
}

function sortByCreated(a, b) {
	return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
}

function publicVideo(video) {
	return {
		id: video.id,
		title: video.title,
		type: video.type,
		url: video.url,
		thumbUrl: video.thumbUrl || null,
		duration: video.duration || 0,
		size: video.size || 0,
		width: video.width || 0,
		height: video.height || 0,
		aspect: video.aspect || '',
		caption: video.caption || '',
		hashtags: video.hashtags || '',
		voice: video.voice || '',
		lane: video.lane || '',
		simulated: Boolean(video.simulated),
		scriptId: video.scriptId || null,
		podcastId: video.podcastId || null,
		createdAt: video.createdAt,
		downloadUrl: '/api/download/video/' + video.id,
	}
}

function publicAudio(audio) {
	return {
		id: audio.id,
		title: audio.title,
		type: audio.type,
		url: audio.url,
		duration: audio.duration || 0,
		voice: audio.voice || '',
		preset: audio.preset || '',
		text: (audio.text || '').slice(0, 400),
		createdAt: audio.createdAt,
		downloadUrl: '/api/download/audio/' + audio.id,
	}
}

function publicAsset(asset) {
	return {
		id: asset.id,
		name: asset.name,
		kind: asset.kind,
		url: asset.url,
		size: asset.size || 0,
		source: asset.source || '',
		createdAt: asset.createdAt,
		downloadUrl: '/api/download/asset/' + asset.id,
	}
}

/* --------------------------------- router -------------------------------- */

const routes = []

function addRoute(method, pattern, handler, options) {
	const keys = []
	const regex = new RegExp(
		'^' +
			pattern
				.split('/')
				.map(function (part) {
					if (part.indexOf(':') === 0) {
						keys.push(part.slice(1))
						return '([^/]+)'
					}
					return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
				})
				.join('/') +
			'$',
	)
	routes.push({ method: method, regex: regex, keys: keys, handler: handler, open: Boolean(options && options.open) })
}

const GET = function (p, h, o) {
	addRoute('GET', p, h, o)
}
const POST = function (p, h, o) {
	addRoute('POST', p, h, o)
}
const PATCH = function (p, h, o) {
	addRoute('PATCH', p, h, o)
}
const DELETE = function (p, h, o) {
	addRoute('DELETE', p, h, o)
}

/* --------------------------------- health -------------------------------- */

GET(
	'/api/health',
	async function (req, res) {
		const voice = ttsModeInfo()
		httpx.ok(res, {
			name: APP.name,
			version: APP.version,
			uptimeSeconds: Math.round((Date.now() - START_TIME) / 1000),
			queue: queue.stats(),
			flowMode: flow.isSimulate() ? 'simulate' : 'flow',
			ttsMode: voice.mode,
			ttsProvider: voice.label,
			ttsReason: voice.reason,
			liveStreams: streams.statusAll().filter(function (s) {
				return s && s.live
			}).length,
		})
	},
	{ open: true },
)

GET('/api/bootstrap', async function (req, res) {
	const settings = store.settings()
	httpx.ok(res, {
		app: { name: APP.name, version: APP.version, timezone: APP.timezone, maxUploadMb: Math.round(APP.maxUploadBytes / 1024 / 1024) },
		settings: maskDeep(settings),
		brand: store.brand(),
		presets: {
			angles: llm.ANGLES,
			personas: llm.PERSONAS,
			motions: llm.MOTIONS,
			voices: tts.VOICE_PRESETS,
			naturalPresets: Object.keys(tts.NATURAL_PRESETS),
			resolutions: Object.keys(RESOLUTIONS).reduce(function (acc, aspect) {
				acc[aspect] = Object.keys(RESOLUTIONS[aspect])
				return acc
			}, {}),
			subtitleStyles: [
				{ id: 'none', label: 'Tanpa Subtitle (Bersih / Tanpa Teks)' },
				{ id: 'bold-center', label: 'Teks Tebal Tengah' },
				{ id: 'karaoke-box', label: 'Kotak Hitam' },
				{ id: 'minimal', label: 'Minimal Bawah' },
				{ id: 'yellow', label: 'Kuning Bold' },
			],
			musicMoods: ['none', 'lofi', 'upbeat', 'cinematic', 'calm'],
			automationActions: automation.ACTIONS,
			automationTriggers: automation.TRIGGERS,
			streamModes: ['auto', 'copy', 'encode'],
		},
		modes: (function () {
			const voice = ttsModeInfo()
			return { flow: flow.isSimulate() ? 'simulate' : 'flow', tts: voice.mode, ttsProvider: voice.label, ttsReason: voice.reason, llm: llm.isRemote() ? 'remote' : 'local' }
		})(),
		counts: store.stats(),
		queue: queue.stats(),
		inboxPath: PATHS.inbox,
	})
})

GET(
	'/api/events',
	async function (req, res) {
		res.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no',
		})
		const off = events.addClient(res)
		const ping = setInterval(function () {
			try {
				res.write(': ping' + String.fromCharCode(10) + String.fromCharCode(10))
			} catch (err) {}
		}, 20000)
		req.on('close', function () {
			clearInterval(ping)
			off()
		})
	},
)

/* --------------------------------- assets -------------------------------- */

POST('/api/uploads', async function (req, res) {
	const result = await multipart.parse(req, { dir: PATHS.uploads, maxBytes: APP.maxUploadBytes })
	const created = []
	for (const file of result.files) {
		const asset = studio.registerAsset({
			file: file.path,
			name: file.filename,
			kind: util.kindOf(file.filename),
			source: result.fields.source || 'upload',
			meta: { contentType: file.contentType },
		})
		created.push(publicAsset(asset))
		events.emit('asset:created', { assetId: asset.id, name: asset.name, kind: asset.kind })
	}
	httpx.ok(res, { uploaded: created.length, assets: created, fields: result.fields })
})

GET('/api/assets', async function (req, res, params, query) {
	const kind = query.kind
	const items = store
		.coll('assets')
		.filter(function (asset) {
			if (kind && asset.kind !== kind) return false
			return fs.existsSync(asset.file)
		})
		.sort(sortByCreated)
		.slice(0, Number(query.limit) || 200)
	httpx.ok(res, { assets: items.map(publicAsset), total: items.length })
})

DELETE('/api/assets/:id', async function (req, res, params) {
	const asset = store.get('assets', params.id)
	if (!asset) return httpx.notFound(res, 'Asset tidak ada')
	const meta = asset.meta || {}
	// File hasil render yang masih ada di Library tidak ikut dihapus (hanya entri aset-nya).
	const stillUsed = (meta.videoId && store.get('videos', meta.videoId)) || (meta.audioId && store.get('audios', meta.audioId))
	try {
		if (!stillUsed && asset.file && fs.existsSync(asset.file) && insideStorage(asset.file)) fs.unlinkSync(asset.file)
	} catch (err) {}
	store.remove('assets', params.id)
	httpx.ok(res, { deleted: params.id })
})

function insideStorage(file) {
	const rel = path.relative(PATHS.storage, path.resolve(String(file || '')))
	return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel)
}

GET('/api/download/:kind/:id', async function (req, res, params) {
	const maps = { video: 'videos', audio: 'audios', asset: 'assets' }
	const coll = maps[params.kind]
	if (!coll) return httpx.fail(res, 400, 'Tipe tidak dikenal')
	const doc = store.get(coll, params.id)
	if (!doc) return httpx.notFound(res, 'File tidak ada')
	const name = util.safeFileName((doc.title || doc.name || 'file') + path.extname(doc.file || ''))
	httpx.sendFile(req, res, doc.file, { download: name })
})

/* ------------------------------- UGC studio ------------------------------- */

let latestActiveScript = null
let flowSessionStartTime = 0
const processedDownloadFiles = new Set()

/** Hanya file video di dalam folder Downloads yang boleh di-import (bukan sembarang file di komputer). */
function resolveDownloadFile(file) {
	const resolved = path.resolve(String(file || ''))
	const rel = path.relative(getDownloadsDir(), resolved)
	if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return { error: 'Hanya file di folder Downloads (' + getDownloadsDir() + ') yang bisa di-import.' }
	if (VIDEO_EXTS.indexOf(path.extname(resolved).toLowerCase()) === -1) return { error: 'Format tidak didukung. Pakai video ' + VIDEO_EXTS.join(', ') }
	if (!fs.existsSync(resolved)) return { error: 'File video tidak ditemukan: ' + resolved }
	return { file: resolved }
}

/** Salin video dari Downloads ke storage lalu daftarkan sebagai aset. */
function importDownloadedVideo(file, source) {
	const name = path.basename(file)
	const destination = path.join(util.ensureDir(PATHS.uploads), util.uid('', 6) + '_' + util.safeFileName(name))
	fs.copyFileSync(file, destination)
	const asset = studio.registerAsset({ file: destination, name: name, kind: 'video', source: source || 'flow_download' })
	events.emit('asset:created', { assetId: asset.id, name: asset.name, kind: asset.kind })
	return asset
}

/** Payload render UGC dari skrip aktif (UGC Studio / ekstensi) + klip hasil Flow. */
function flowRenderPayload(assetIds, source) {
	const active = latestActiveScript || {}
	const brief = active.brief || {}
	const script = active.script || (active.scenes ? { scenes: active.scenes, title: active.title } : null)
	return {
		product: active.product || brief.product || 'Produk Flow',
		problem: active.problem || brief.problem || '',
		benefits: active.benefits || brief.benefits || '',
		voice: active.voice || brief.voice || 'nadia',
		script: script,
		assetIds: assetIds,
		mode: 'local',
		aspect: brief.aspect || '9:16',
		resolution: brief.resolution || '1080',
		fps: Number(brief.fps) || 30,
		subtitleStyle: brief.subtitleStyle || 'none',
		musicMood: brief.musicMood || 'lofi',
		naturalPreset: brief.naturalPreset || 'ugc-bright',
		watermark: brief.watermark || '',
		variants: 1,
		source: source,
	}
}

function scanDownloadsFolder(limitMinutes) {
	const dir = getDownloadsDir()
	const results = []
	if (!fs.existsSync(dir)) return results
	let entries = []
	try {
		entries = fs.readdirSync(dir)
	} catch (err) {
		return results
	}
	const now = Date.now()
	const maxAgeMs = limitMinutes ? Number(limitMinutes) * 60 * 1000 : 0
	for (const name of entries) {
		if (name.startsWith('.') || name.endsWith('.crdownload') || name.endsWith('.tmp') || name.endsWith('.part')) continue
		const ext = path.extname(name).toLowerCase()
		if (!VIDEO_EXTS.includes(ext)) continue
		const full = path.join(dir, name)
		try {
			const stat = fs.statSync(full)
			if (!stat.isFile() || stat.size < 1000) continue
			const ageMs = now - stat.mtimeMs
			if (!maxAgeMs || ageMs <= maxAgeMs) {
				results.push({
					name: name,
					file: full,
					size: stat.size,
					mtime: new Date(stat.mtimeMs).toISOString(),
					mtimeMs: stat.mtimeMs,
					ageSeconds: Math.round(ageMs / 1000),
				})
			}
		} catch (err) {}
	}
	results.sort(function (a, b) {
		return b.mtimeMs - a.mtimeMs
	})
	return results
}

POST('/api/ugc/script', async function (req, res) {
	const body = await httpx.readJson(req)
	const script = await llm.generateUgcScript(body)
	const scenesWithPrompts = (script.scenes || []).map(function (scene) {
		return {
			index: scene.index,
			narration: scene.narration,
			onScreenText: scene.onScreenText,
			visual: scene.visual,
			motion: scene.motion,
			duration: scene.duration,
			prompt: llm.videoPromptFor(scene, body.product, body.style),
		}
	})
	latestActiveScript = {
		product: body.product || 'Produk',
		problem: body.problem || '',
		benefits: body.benefits || '',
		voice: body.voice || 'nadia',
		title: script.title,
		hook: script.hook,
		brief: body,
		script: script,
		scenes: scenesWithPrompts,
		updatedAt: new Date().toISOString(),
	}
	httpx.ok(res, { script: script })
})

GET(
	'/api/extension/active-scenes',
	async function (req, res) {
		if (latestActiveScript) return httpx.ok(res, latestActiveScript)
		const jobs = store.coll('jobs').filter(function (j) {
			return j.type === 'ugc.render' && j.payload && j.payload.script
		})
		if (jobs.length) {
			const lastJob = jobs[0]
			const p = lastJob.payload
			const script = p.script || {}
			const scenes = (script.scenes || []).map(function (scene) {
				return {
					index: scene.index,
					narration: scene.narration,
					onScreenText: scene.onScreenText,
					visual: scene.visual,
					motion: scene.motion,
					duration: scene.duration,
					prompt: llm.videoPromptFor(scene, p.product, p.style),
				}
			})
			return httpx.ok(res, {
				product: p.product || 'Produk',
				title: script.title || lastJob.title,
				scenes: scenes,
				updatedAt: lastJob.createdAt,
			})
		}
		httpx.ok(res, { product: null, scenes: [], message: 'Belum ada skrip yang dibuat di UGC Studio' })
	},
	{ open: true },
)

POST(
	'/api/extension/active-scenes',
	async function (req, res) {
		const body = await httpx.readJson(req)
		if (body && body.scenes) {
			latestActiveScript = Object.assign({}, latestActiveScript || {}, body, { updatedAt: new Date().toISOString() })
		}
		httpx.ok(res, { ok: true, activeScript: latestActiveScript })
	},
)

POST('/api/ugc/flow-session', async function (req, res) {
	const body = await httpx.readJson(req)
	flowSessionStartTime = Date.now()
	if (body && (body.script || body.scenes)) {
		const sc = body.script || {}
		const scenes = (body.scenes || sc.scenes || []).map(function (s, i) {
			return Object.assign({}, s, {
				index: s.index || i + 1,
				prompt: s.prompt || llm.videoPromptFor(s, body.product || 'Produk', body.style),
			})
		})
		latestActiveScript = {
			product: body.product || (latestActiveScript && latestActiveScript.product) || 'Produk',
			problem: body.problem || (latestActiveScript && latestActiveScript.problem) || '',
			benefits: body.benefits || (latestActiveScript && latestActiveScript.benefits) || '',
			voice: body.voice || (latestActiveScript && latestActiveScript.voice) || 'nadia',
			brief: body,
			script: body.script || { title: body.title, scenes: scenes },
			scenes: scenes,
			updatedAt: new Date().toISOString(),
		}
	}
	events.emit('flow:session-started', { startedAt: flowSessionStartTime, product: (latestActiveScript || {}).product })
	httpx.ok(res, { sessionStartedAt: flowSessionStartTime, activeScript: latestActiveScript })
})

GET('/api/ugc/downloads/scan', async function (req, res, params, query) {
	const limitMinutes = Number(query.limitMinutes) || 0
	let files = scanDownloadsFolder(limitMinutes)
	if (!files.length && limitMinutes > 0) {
		files = scanDownloadsFolder(0)
	}
	httpx.ok(res, {
		downloadsFolder: getDownloadsDir(),
		sessionActive: flowSessionStartTime > 0,
		sessionStartTime: flowSessionStartTime,
		files: files.slice(0, 20),
	})
})

POST('/api/ugc/downloads/import', async function (req, res) {
	const body = await httpx.readJson(req)
	// Bisa satu file (file) atau beberapa klip sekaligus (files) -> digabung jadi satu video.
	let requested = Array.isArray(body.files) ? body.files.filter(Boolean) : body.file ? [body.file] : []
	if (!requested.length) {
		const recents = scanDownloadsFolder(0)
		if (!recents.length) return httpx.fail(res, 404, 'Tidak ada file video di folder Downloads (' + getDownloadsDir() + ').')
		requested = [recents[0].file]
	}
	const targets = []
	for (const item of requested.slice(0, 20)) {
		const checked = resolveDownloadFile(item)
		if (checked.error) return httpx.fail(res, 400, checked.error)
		if (targets.indexOf(checked.file) === -1) targets.push(checked.file)
	}

	const assets = []
	try {
		for (const file of targets) {
			// Supaya watcher auto-import tidak mengambil file yang sama lagi.
			processedDownloadFiles.add(file)
			assets.push(importDownloadedVideo(file, 'flow_download'))
		}
	} catch (err) {
		return httpx.fail(res, 500, 'Gagal menyalin file video: ' + err.message)
	}
	const asset = assets[0]

	let job = null
	if (body.autoRender !== false) {
		const payload = flowRenderPayload(
			assets.map(function (a) {
				return a.id
			}),
			'flow_download',
		)
		const enqueued = queue.enqueue({
			type: 'ugc.render',
			title: 'UGC Flow: ' + payload.product,
			payload: payload,
			lane: 'low',
			source: 'flow_download',
		})
		job = queue.summary(enqueued)
	}

	httpx.ok(res, {
		asset: asset,
		assets: assets,
		job: job,
		message: job
			? (assets.length > 1 ? assets.length + ' klip Flow' : 'Video Flow') + ' berhasil di-import & mulai di-render dengan suara + subtitle!'
			: assets.length + ' video berhasil di-import sebagai aset',
	})
})

POST('/api/ugc/render', async function (req, res) {
	const body = await httpx.readJson(req)
	const assetIds = Array.isArray(body.assetIds) ? body.assetIds : []
	const lane = body.lane || (store.settings().flow || {}).defaultLane || 'low'
	if (body.perAsset && assetIds.length > 1) {
		const jobs = assetIds.map(function (assetId, i) {
			const asset = store.get('assets', assetId) || {}
			const payload = Object.assign({}, body, { assetIds: [assetId], perAsset: false })
			if (!payload.product) payload.product = path.basename(asset.name || 'Produk ' + (i + 1), path.extname(asset.name || '')).replace(/[_-]+/g, ' ')
			return queue.summary(queue.enqueue({ type: 'ugc.render', title: 'UGC: ' + payload.product, payload: payload, lane: lane, source: 'batch' }))
		})
		return httpx.ok(res, { batch: true, jobs: jobs })
	}
	const copies = Math.max(1, Math.min(Number(body.variants) || 1, 10))
	const jobs = []
	for (let i = 0; i < copies; i += 1) {
		// Tiap salinan = variasi berbeda (hook, urutan gambar & gerak kamera lain), bukan video yang sama persis.
		const payload = copies > 1 ? Object.assign({}, body, { variant: i + 1, variantCount: copies }) : body
		jobs.push(queue.summary(queue.enqueue({ type: 'ugc.render', title: 'UGC: ' + (body.product || 'Produk') + (copies > 1 ? ' #' + (i + 1) : ''), payload: payload, lane: lane, source: body.source || 'manual' })))
	}
	httpx.ok(res, { jobs: jobs })
})

POST('/api/images/generate', async function (req, res) {
	const body = await httpx.readJson(req)
	const job = queue.enqueue({ type: 'images.generate', title: 'Gambar: ' + (body.title || body.prompt || 'Flow'), payload: body, lane: body.lane || 'low' })
	httpx.ok(res, { job: queue.summary(job) })
})

/* ----------------------------- podcast studio ---------------------------- */

POST('/api/podcast/script', async function (req, res) {
	const body = await httpx.readJson(req)
	const script = await llm.generatePodcastScript(body)
	httpx.ok(res, { script: script })
})

POST('/api/podcast/render', async function (req, res) {
	const body = await httpx.readJson(req)
	const job = queue.enqueue({ type: 'podcast.render', title: 'Podcast: ' + (body.topic || 'AI Podcast'), payload: body, lane: body.lane || 'low' })
	httpx.ok(res, { job: queue.summary(job) })
})

GET('/api/podcasts', async function (req, res) {
	httpx.ok(res, { podcasts: store.coll('podcasts').slice().sort(sortByCreated).slice(0, 100) })
})

/* ------------------------------ voice studio ----------------------------- */

POST('/api/voice/render', async function (req, res) {
	const body = await httpx.readJson(req)
	const title = body.mode === 'transform' ? 'Naturalize suara' : 'TTS: ' + String(body.text || '').slice(0, 30)
	const job = queue.enqueue({ type: 'voice.render', title: title, payload: body, lane: 'low' })
	httpx.ok(res, { job: queue.summary(job) })
})

/* --------------------------------- jobs ---------------------------------- */

GET('/api/jobs', async function (req, res, params, query) {
	const result = queue.list({ status: query.status, type: query.type, limit: Number(query.limit) || 60 })
	httpx.ok(res, result)
})

GET('/api/jobs/:id', async function (req, res, params) {
	const job = queue.detail(params.id)
	if (!job) return httpx.notFound(res, 'Job tidak ada')
	httpx.ok(res, { job: job })
})

POST('/api/jobs/:id/cancel', async function (req, res, params) {
	httpx.ok(res, { canceled: queue.cancel(params.id) })
})

POST('/api/jobs/:id/retry', async function (req, res, params) {
	const job = queue.retry(params.id)
	if (!job) return httpx.notFound(res, 'Job tidak ada')
	httpx.ok(res, { job: queue.summary(job) })
})

DELETE('/api/jobs/:id', async function (req, res, params) {
	httpx.ok(res, { deleted: store.remove('jobs', params.id) })
})

POST('/api/queue/pause', async function (req, res) {
	const body = await httpx.readJson(req)
	httpx.ok(res, { paused: queue.setPaused(Boolean(body.paused)) })
})

/* -------------------------------- library -------------------------------- */

GET('/api/library', async function (req, res, params, query) {
	const type = query.type || 'all'
	const videos = store
		.coll('videos')
		.filter(function (video) {
			if (type !== 'all' && type !== 'video' && video.type !== type) return false
			return fs.existsSync(video.file)
		})
		.sort(sortByCreated)
		.slice(0, 120)
	const audios = store
		.coll('audios')
		.filter(function (audio) {
			return fs.existsSync(audio.file)
		})
		.sort(sortByCreated)
		.slice(0, 120)
	httpx.ok(res, { videos: videos.map(publicVideo), audios: audios.map(publicAudio) })
})

GET('/api/library/script/:id', async function (req, res, params) {
	const script = store.get('scripts', params.id)
	if (!script) return httpx.notFound(res, 'Skrip tidak ada')
	httpx.ok(res, { script: script })
})

DELETE('/api/library/:type/:id', async function (req, res, params) {
	const maps = { video: 'videos', audio: 'audios', podcast: 'podcasts' }
	const coll = maps[params.type]
	if (!coll) return httpx.fail(res, 400, 'Tipe tidak dikenal')
	const doc = store.get(coll, params.id)
	if (!doc) return httpx.notFound(res, 'Item tidak ada')
	const docs = [{ coll: coll, doc: doc }]
	if (coll === 'podcasts') {
		// Hapus podcast = hapus juga video & audio hasilnya.
		store.coll('videos').forEach(function (video) {
			if (video.podcastId === doc.id) docs.push({ coll: 'videos', doc: video })
		})
		store.coll('audios').forEach(function (audio) {
			if (audio.podcastId === doc.id) docs.push({ coll: 'audios', doc: audio })
		})
	}
	for (const item of docs) {
		for (const file of [item.doc.file, item.doc.thumbFile, item.doc.videoFile, item.doc.audioFile]) {
			try {
				if (file && fs.existsSync(file) && insideStorage(file)) fs.unlinkSync(file)
			} catch (err) {}
		}
		store.remove(item.coll, item.doc.id)
	}
	// Entri aset yang menunjuk ke file yang sudah dihapus ikut dibersihkan.
	const removedIds = docs.map(function (item) {
		return item.doc.id
	})
	store.coll('assets').slice().forEach(function (asset) {
		const meta = asset.meta || {}
		if (removedIds.indexOf(meta.videoId) !== -1 || removedIds.indexOf(meta.audioId) !== -1) store.remove('assets', asset.id)
	})
	events.emit('library:updated', { type: params.type, id: params.id, deleted: true })
	httpx.ok(res, { deleted: params.id, removed: removedIds.length })
})

/* --------------------------------- live ---------------------------------- */

/** Stream untuk dikirim ke browser: stream key disamarkan. */
function publicStream(item) {
	const defaults = store.settings().stream || {}
	const own = String(item.streamKey || '')
	return Object.assign({}, item, {
		streamKey: own ? '\u2022\u2022\u2022\u2022\u2022\u2022' + own.slice(-4) : '',
		usesDefaultKey: !own && !streams.urlHasKey(item.rtmpUrl) && Boolean(defaults.streamKey),
	})
}

GET('/api/streams', async function (req, res) {
	httpx.ok(res, {
		streams: store.coll('streams').map(function (item) {
			return Object.assign(publicStream(item), { status: streams.status(item.id) })
		}),
		status: streams.statusAll(),
	})
})

POST('/api/streams', async function (req, res) {
	const body = await httpx.readJson(req)
	const settings = store.settings().stream || {}
	const rtmpUrl = String(body.rtmpUrl || settings.rtmpUrl || '').trim()
	const streamKey = String(body.streamKey || '').trim()
	if (!rtmpUrl) return httpx.fail(res, 400, 'RTMP URL wajib diisi')
	if (!/^(rtmps?|srt):\/\//i.test(rtmpUrl)) return httpx.fail(res, 400, 'RTMP URL harus diawali rtmp:// atau rtmps://')
	if (!streamKey && !settings.streamKey && !streams.urlHasKey(rtmpUrl) && !/^srt:/i.test(rtmpUrl)) {
		return httpx.fail(res, 400, 'Stream key wajib diisi (atau isi key default di Settings > Live / YT_STREAM_KEY di .env)')
	}
	const items = Array.isArray(body.items) ? body.items.filter(Boolean) : []
	const aspect = RESOLUTIONS[body.aspect] ? body.aspect : '16:9'
	const resolution = String(body.resolution || settings.resolution || '1080')
	const doc = store.insert(
		'streams',
		{
			name: String(body.name || 'Live 24 Jam').slice(0, 120),
			platform: body.platform || 'youtube',
			rtmpUrl: rtmpUrl,
			// Kosong = pakai key default dari Settings / .env saat live dinyalakan (ikut berubah kalau key default diganti).
			streamKey: streamKey,
			items: items,
			loop: body.loop === undefined ? true : Boolean(body.loop),
			mode: ['auto', 'copy', 'encode'].indexOf(body.mode) !== -1 ? body.mode : settings.mode || 'auto',
			resolution: RESOLUTIONS[aspect][resolution] ? resolution : '1080',
			aspect: aspect,
			fps: Number(body.fps) || settings.fps || 30,
			videoBitrate: body.videoBitrate || settings.videoBitrate,
			audioBitrate: body.audioBitrate || settings.audioBitrate,
			audioMode: streams.audioModeOf(body),
			musicAssetId: body.musicAssetId || null,
			autoStart: Boolean(body.autoStart),
			maxRestarts: body.maxRestarts === undefined ? settings.maxRestarts : Number(body.maxRestarts),
			status: 'stopped',
			totalUptimeSeconds: 0,
			restarts: 0,
			logs: [],
		},
		'stm',
	)
	httpx.ok(res, { stream: publicStream(doc) })
})

PATCH('/api/streams/:id', async function (req, res, params) {
	const body = stripMasked(await httpx.readJson(req))
	for (const key of ['id', 'createdAt', 'updatedAt', 'logs', 'status', 'pid', 'usesDefaultKey']) delete body[key]
	if (body.streamKey === '') delete body.streamKey
	if (body.audioMode !== undefined) body.audioMode = streams.audioModeOf(body)
	if (body.aspect !== undefined && !RESOLUTIONS[body.aspect]) delete body.aspect
	if (body.mode !== undefined && ['auto', 'copy', 'encode'].indexOf(body.mode) === -1) delete body.mode
	const updated = store.update('streams', params.id, body)
	if (!updated) return httpx.notFound(res, 'Stream tidak ada')
	httpx.ok(res, { stream: publicStream(updated) })
})

DELETE('/api/streams/:id', async function (req, res, params) {
	if (!store.get('streams', params.id)) return httpx.notFound(res, 'Stream tidak ada')
	await streams.stopNow(params.id)
	httpx.ok(res, { deleted: store.remove('streams', params.id) })
})

POST('/api/streams/:id/start', async function (req, res, params) {
	if (!store.get('streams', params.id)) return httpx.notFound(res, 'Stream tidak ada')
	httpx.ok(res, { status: await streams.start(params.id) })
})

POST('/api/streams/:id/stop', async function (req, res, params) {
	if (!store.get('streams', params.id)) return httpx.notFound(res, 'Stream tidak ada')
	httpx.ok(res, { status: await streams.stopNow(params.id) })
})

POST('/api/streams/:id/restart', async function (req, res, params) {
	httpx.ok(res, { status: await streams.restart(params.id) })
})

GET('/api/streams/:id/inspect', async function (req, res, params) {
	const info = await streams.inspect(params.id)
	if (!info) return httpx.notFound(res, 'Stream tidak ada')
	httpx.ok(res, info)
})

GET('/api/streams/:id/logs', async function (req, res, params) {
	const stream = store.get('streams', params.id)
	if (!stream) return httpx.notFound(res, 'Stream tidak ada')
	httpx.ok(res, { logs: (stream.logs || []).slice(-120).reverse() })
})

/* ------------------------------ automations ------------------------------ */

GET('/api/automations', async function (req, res) {
	httpx.ok(res, { automations: automation.list(), inbox: PATHS.inbox })
})

POST('/api/automations', async function (req, res) {
	const body = await httpx.readJson(req)
	httpx.ok(res, { automation: automation.decorate(automation.create(body)) })
})

PATCH('/api/automations/:id', async function (req, res, params) {
	const body = await httpx.readJson(req)
	const updated = automation.update(params.id, body)
	if (!updated) return httpx.notFound(res, 'Automation tidak ada')
	httpx.ok(res, { automation: automation.decorate(updated) })
})

DELETE('/api/automations/:id', async function (req, res, params) {
	httpx.ok(res, { deleted: store.remove('automations', params.id) })
})

POST('/api/automations/:id/run', async function (req, res, params) {
	const body = await httpx.readJson(req)
	const result = await automation.run(params.id, body || {}, 'manual')
	if (!result.ok) return httpx.fail(res, 400, result.error)
	httpx.ok(res, { result: result })
})

POST(
	'/api/hooks/:token',
	async function (req, res, params) {
		let body = {}
		try {
			body = await httpx.readJson(req)
		} catch (err) {
			body = {}
		}
		const result = await automation.handleWebhook(params.token, body)
		if (!result.ok) return httpx.fail(res, result.error === 'Webhook tidak dikenal' ? 404 : 400, result.error)
		httpx.ok(res, result)
	},
	{ open: true },
)

/* -------------------------- settings & brand kit ------------------------- */

GET('/api/settings', async function (req, res) {
	httpx.ok(res, { settings: maskDeep(store.settings()) })
})

PATCH('/api/settings', async function (req, res) {
	const body = stripMasked(await httpx.readJson(req))
	httpx.ok(res, { settings: maskDeep(store.updateSettings(body)) })
})

POST('/api/settings/test/:provider', async function (req, res, params) {
	if (params.provider === 'flow') return httpx.ok(res, await flow.testConnection())
	if (params.provider === 'tts') return httpx.ok(res, await tts.testConnection())
	if (params.provider === 'llm') {
		try {
			return httpx.ok(res, await llm.testConnection())
		} catch (err) {
			return httpx.ok(res, { ok: false, message: err.message })
		}
	}
	if (params.provider === 'ffmpeg') {
		try {
			return httpx.ok(res, { ok: true, message: await ff.version() })
		} catch (err) {
			return httpx.ok(res, { ok: false, message: err.message })
		}
	}
	httpx.fail(res, 400, 'Provider tidak dikenal')
})

GET('/api/brand', async function (req, res) {
	httpx.ok(res, { brand: store.brand() })
})

PATCH('/api/brand', async function (req, res) {
	const body = await httpx.readJson(req)
	httpx.ok(res, { brand: store.updateBrand(body) })
})

/* ---------------------- generic collections (presets) -------------------- */

GET('/api/collections/:name', async function (req, res, params) {
	if (GENERIC_COLLECTIONS.indexOf(params.name) === -1) return httpx.fail(res, 400, 'Koleksi tidak diizinkan')
	httpx.ok(res, { items: store.coll(params.name).slice().sort(sortByCreated) })
})

POST('/api/collections/:name', async function (req, res, params) {
	if (GENERIC_COLLECTIONS.indexOf(params.name) === -1) return httpx.fail(res, 400, 'Koleksi tidak diizinkan')
	const body = await httpx.readJson(req)
	httpx.ok(res, { item: store.insert(params.name, body, params.name.slice(0, 3)) })
})

PATCH('/api/collections/:name/:id', async function (req, res, params) {
	if (GENERIC_COLLECTIONS.indexOf(params.name) === -1) return httpx.fail(res, 400, 'Koleksi tidak diizinkan')
	const body = await httpx.readJson(req)
	httpx.ok(res, { item: store.update(params.name, params.id, body) })
})

DELETE('/api/collections/:name/:id', async function (req, res, params) {
	if (GENERIC_COLLECTIONS.indexOf(params.name) === -1) return httpx.fail(res, 400, 'Koleksi tidak diizinkan')
	httpx.ok(res, { deleted: store.remove(params.name, params.id) })
})

/* ------------------------------- analytics ------------------------------- */

GET('/api/analytics', async function (req, res) {
	const usage = store.raw().usage || {}
	const days = Object.keys(usage).sort().slice(-14)
	const videos = store.coll('videos')
	const totalSeconds = videos.reduce(function (sum, video) {
		return sum + (video.duration || 0)
	}, 0)
	httpx.ok(res, {
		daily: days.map(function (day) {
			return Object.assign({ day: day }, usage[day])
		}),
		totals: {
			videos: videos.length,
			ugc: videos.filter(function (v) {
				return v.type === 'ugc'
			}).length,
			podcasts: store.coll('podcasts').length,
			audios: store.coll('audios').length,
			assets: store.coll('assets').length,
			automations: store.coll('automations').length,
			streams: store.coll('streams').length,
			renderMinutes: Math.round(totalSeconds / 60),
		},
		storage: {
			uploads: dirSize(PATHS.uploads),
			renders: dirSize(PATHS.renders),
			audio: dirSize(PATHS.audio),
			thumbs: dirSize(PATHS.thumbs),
			tmp: dirSize(PATHS.tmp),
		},
		queue: queue.stats(),
		liveStatus: streams.statusAll(),
		topVideos: videos.slice().sort(sortByCreated).slice(0, 5).map(publicVideo),
	})
})

GET('/api/logs', async function (req, res, params, query) {
	httpx.ok(res, { logs: events.recent(Number(query.limit) || 150, query.type).reverse() })
})

/* --------------------------------- system -------------------------------- */

POST('/api/system/cleanup', async function (req, res) {
	let body = {}
	try {
		body = await httpx.readJson(req)
	} catch (err) {}
	let removed = 0
	let freedBytes = 0
	const activeJobs = queue.runningIds()
	const recentMs = 30 * 60 * 1000
	let entries = []
	try {
		entries = fs.readdirSync(PATHS.tmp)
	} catch (err) {}
	for (const name of entries) {
		// Jangan sentuh playlist live & folder kerja job yang masih jalan / baru dipakai.
		if (name.indexOf('playlist_') === 0) continue
		if (activeJobs.some((id) => name.indexOf(id) !== -1)) continue
		const full = path.join(PATHS.tmp, name)
		try {
			if (Date.now() - fs.statSync(full).mtimeMs < recentMs) continue
			const size = fs.statSync(full).isDirectory() ? dirSize(full) : fs.statSync(full).size
			fs.rmSync(full, { recursive: true, force: true })
			removed += 1
			freedBytes += size
		} catch (err) {}
	}
	// Cache suara TTS lama (opsional, default > 30 hari).
	let cacheRemoved = 0
	if (body.cache !== false) {
		const maxAgeDays = Number(body.cacheDays) || 30
		for (const dir of [PATHS.cache, path.join(PATHS.storage, 'cache')]) {
			let files = []
			try {
				files = fs.readdirSync(dir)
			} catch (err) {
				continue
			}
			for (const name of files) {
				const full = path.join(dir, name)
				try {
					const stat = fs.statSync(full)
					if (!stat.isFile() || Date.now() - stat.mtimeMs < maxAgeDays * 86400000) continue
					fs.unlinkSync(full)
					cacheRemoved += 1
					freedBytes += stat.size
				} catch (err) {}
			}
		}
	}
	let orphans = 0
	for (const coll of ['videos', 'audios', 'assets']) {
		store.coll(coll).slice().forEach(function (doc) {
			if (doc.file && !fs.existsSync(doc.file)) {
				store.remove(coll, doc.id)
				orphans += 1
			}
		})
	}
	store.pruneJobs(200)
	events.pruneLogs()
	httpx.ok(res, {
		removed: removed,
		cacheRemoved: cacheRemoved,
		orphans: orphans,
		freedMb: Math.round((freedBytes / 1024 / 1024) * 10) / 10,
		message: 'Bersih-bersih selesai: ' + removed + ' folder sementara, ' + cacheRemoved + ' cache suara, ' + orphans + ' data yatim dihapus (' + Math.round(freedBytes / 1024 / 1024) + ' MB)',
	})
})

POST('/api/system/reset', async function (req, res) {
	const body = await httpx.readJson(req)
	if (body.confirm !== 'RESET') return httpx.fail(res, 400, 'Kirim { "confirm": "RESET" } untuk reset')
	streams.stopAll()
	store.resetAll()
	httpx.ok(res, { message: 'Database direset. Silakan atur ulang Settings.' })
})

/* -------------------------------- handler -------------------------------- */

async function handler(req, res) {
	const pathname = httpx.pathnameOf(req.url || '/')
	const query = httpx.parseQuery(req.url || '/')

	// Proteksi: website lain (atau DNS rebinding) tidak boleh mengontrol studio lewat browser kamu.
	if (!httpx.hostAllowed(req)) {
		return httpx.fail(res, 403, 'Host "' + String(req.headers.host || '') + '" tidak diizinkan. Tambahkan ke ALLOWED_HOSTS di .env atau aktifkan login (AUTH_ENABLED + AUTH_PASSWORD).')
	}
	const origin = httpx.applyCors(req, res)
	if (req.method === 'OPTIONS') {
		res.writeHead(origin.trusted ? 204 : 403)
		res.end()
		return
	}
	const writes = req.method !== 'GET' && req.method !== 'HEAD'
	// Browser modern menandai request dari website lain dengan Sec-Fetch-Site: cross-site (walau tanpa header Origin).
	const crossSite = !origin.present && String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site'
	if (writes && (!origin.trusted || crossSite) && pathname.indexOf('/api/hooks/') !== 0) {
		return httpx.fail(res, 403, 'Permintaan dari website lain (' + (origin.origin || 'tanpa Origin') + ') ditolak. Tambahkan ke CORS_ORIGINS di .env kalau memang perlu.')
	}

	// File storage (video, audio, gambar hasil render)
	if (pathname.indexOf('/api/files/') === 0) {
		if (APP.auth.enabled && !httpx.checkAuth(req)) return httpx.unauthorized(res)
		const rel = httpx.safeDecode(pathname.slice('/api/files/'.length))
		if (rel === null) return httpx.fail(res, 400, 'Path tidak valid')
		const target = path.resolve(PATHS.storage, rel)
		const relDiff = path.relative(PATHS.storage, target)
		if (relDiff.startsWith('..') || path.isAbsolute(relDiff)) return httpx.fail(res, 400, 'Path tidak valid')
		return httpx.sendFile(req, res, target)
	}

	// Static extension files for Chrome extension / bookmarklet
	if (pathname.indexOf('/extension/') === 0) {
		const rel = httpx.safeDecode(pathname.slice('/extension/'.length))
		if (rel === null) return httpx.fail(res, 400, 'Path tidak valid')
		const extDir = path.resolve(PATHS.root, 'extension')
		const target = path.resolve(extDir, rel)
		const relDiff = path.relative(extDir, target)
		if (!relDiff || relDiff.startsWith('..') || path.isAbsolute(relDiff)) return httpx.fail(res, 400, 'Path tidak valid')
		if (fs.existsSync(target) && !fs.statSync(target).isDirectory()) {
			return httpx.sendFile(req, res, target, { cache: 'no-cache' })
		}
	}

	for (const route of routes) {
		if (route.method !== req.method) continue
		const match = route.regex.exec(pathname)
		if (!match) continue
		if (!route.open && APP.auth.enabled && !httpx.checkAuth(req)) return httpx.unauthorized(res)
		const params = {}
		let badParam = false
		route.keys.forEach(function (key, i) {
			const value = httpx.safeDecode(match[i + 1])
			if (value === null) badParam = true
			params[key] = value
		})
		if (badParam) return httpx.fail(res, 400, 'URL tidak valid')
		try {
			await route.handler(req, res, params, query)
		} catch (err) {
			const status = Number(err && (err.status || err.statusCode)) || 500
			if (status >= 500) events.logger.error('http', req.method + ' ' + pathname + ' - ' + err.message)
			if (!res.headersSent) httpx.fail(res, status >= 400 && status < 600 ? status : 500, err.message)
			else
				try {
					res.end()
				} catch (e) {}
		}
		return
	}

	if (pathname.indexOf('/api/') === 0) return httpx.notFound(res, 'Endpoint tidak ada')
	if (APP.auth.enabled && !httpx.checkAuth(req)) return httpx.unauthorized(res)
	if (httpx.serveStatic(req, res, pathname)) return
	httpx.sendFile(req, res, path.join(PATHS.public, 'index.html'), { cache: 'no-cache' })
}

const server = http.createServer(function (req, res) {
	handler(req, res).catch(function (err) {
		events.logger.error('http', 'Unhandled: ' + err.message)
		try {
			if (!res.headersSent) httpx.fail(res, 500, err.message)
		} catch (e) {}
	})
})
server.requestTimeout = 0
server.headersTimeout = 0
server.timeout = 0

/* ------------------------ auto-import download Flow ------------------------ */

// Setelah file pertama terdeteksi, tunggu sebentar supaya semua klip scene ikut terkumpul lalu digabung jadi 1 video.
const INGEST_SETTLE_MS = Math.max(5, Number(process.env.FLOW_INGEST_SETTLE_SECONDS) || 20) * 1000
const pendingIngest = { assetIds: [], names: [], lastAt: 0 }

function downloadsBusy() {
	try {
		return fs.readdirSync(getDownloadsDir()).some(function (name) {
			return name.endsWith('.crdownload') || name.endsWith('.part') || name.endsWith('.download')
		})
	} catch (err) {
		return false
	}
}

function flushPendingIngest() {
	const assetIds = pendingIngest.assetIds.slice()
	pendingIngest.assetIds = []
	pendingIngest.names = []
	pendingIngest.lastAt = 0
	flowSessionStartTime = 0
	if (!assetIds.length || !latestActiveScript) return
	const payload = flowRenderPayload(assetIds, 'flow_auto_ingest')
	const job = queue.enqueue({ type: 'ugc.render', title: 'UGC: ' + payload.product, payload: payload, lane: 'low', source: 'flow_auto_ingest' })
	events.logger.info('flow', 'Render otomatis dimulai dengan ' + assetIds.length + ' klip Flow')
	events.emit('flow:auto-render-started', { job: queue.summary(job), clips: assetIds.length })
}

function watchFlowDownloads() {
	if (!flowSessionStartTime) return
	try {
		// Download lama (sebelum sesi Flow dimulai) tidak ikut diproses.
		const recents = scanDownloadsFolder(0)
			.filter(function (item) {
				return item.mtimeMs >= flowSessionStartTime - 3000 && !processedDownloadFiles.has(item.file)
			})
			.sort(function (a, b) {
				return a.mtimeMs - b.mtimeMs
			})
		for (const item of recents) {
			processedDownloadFiles.add(item.file)
			events.logger.info('flow', 'Video Flow baru terdeteksi di Downloads: ' + item.name)
			events.emit('flow:download-detected', { file: item.name, path: item.file, size: item.size })
			const asset = importDownloadedVideo(item.file, 'flow_download_auto')
			pendingIngest.assetIds.push(asset.id)
			pendingIngest.names.push(item.name)
			pendingIngest.lastAt = Date.now()
		}
		if (!pendingIngest.assetIds.length) return
		const scenes = ((latestActiveScript || {}).scenes || []).length
		const complete = scenes > 0 && pendingIngest.assetIds.length >= scenes
		const settled = Date.now() - pendingIngest.lastAt >= INGEST_SETTLE_MS && !downloadsBusy()
		if (complete || settled) flushPendingIngest()
	} catch (err) {
		events.logger.error('flow', 'Watcher error: ' + err.message)
	}
}

/* ------------------------------- start server ------------------------------ */

function lanAddresses() {
	const out = []
	const nets = os.networkInterfaces()
	for (const name of Object.keys(nets)) {
		for (const item of nets[name] || []) {
			if (item.family === 'IPv4' && !item.internal) out.push(item.address)
		}
	}
	return out
}

function openBrowser(url) {
	try {
		let child = null
		if (process.platform === 'win32') child = childProcess.spawn('cmd', ['/c', 'start', '""', '"' + url + '"'], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true })
		else if (process.platform === 'darwin') child = childProcess.spawn('open', [url], { detached: true, stdio: 'ignore' })
		else child = childProcess.spawn('xdg-open', [url], { detached: true, stdio: 'ignore' })
		child.on('error', function () {})
		child.unref()
	} catch (err) {}
}

function maintenance() {
	try {
		store.backupDaily()
		events.pruneLogs()
	} catch (err) {
		events.logger.warn('server', 'Maintenance gagal: ' + err.message)
	}
}

function portBusyExit() {
	console.error(
		String.fromCharCode(10) +
			'  [X] Port ' + APP.port + ' sudah dipakai program lain (mungkin studio ini sudah jalan).' + String.fromCharCode(10) +
			'      Buka http://localhost:' + APP.port + ' di browser, atau tutup jendela server yang lama,' + String.fromCharCode(10) +
			'      atau ganti PORT di file .env lalu jalankan lagi.' + String.fromCharCode(10),
	)
	process.exit(1)
}

/** Launcher diklik 2x? Kalau yang memakai port adalah studio ini sendiri, cukup buka browser. */
function handlePortInUse() {
	let finished = false
	const done = function (sameApp) {
		if (finished) return
		finished = true
		if (!sameApp) return portBusyExit()
		const localUrl = 'http://localhost:' + APP.port
		console.log(String.fromCharCode(10) + '  [i] ' + APP.name + ' sudah berjalan di ' + localUrl + ' - tidak perlu dijalankan 2x.' + String.fromCharCode(10))
		if (process.env.OPEN_BROWSER === '1' || String(process.env.OPEN_BROWSER).toLowerCase() === 'true') openBrowser(localUrl)
		setTimeout(function () {
			process.exit(0)
		}, 1500)
	}
	const probe = http.get({ host: '127.0.0.1', port: APP.port, path: '/api/health', timeout: 2500 }, function (res) {
		let body = ''
		res.setEncoding('utf8')
		res.on('data', function (chunk) {
			if (body.length < 20000) body += chunk
		})
		res.on('end', function () {
			let data = null
			try {
				data = JSON.parse(body)
			} catch (err) {}
			done(Boolean(data && data.name === APP.name))
		})
		res.on('error', function () {
			done(false)
		})
	})
	probe.on('timeout', function () {
		probe.destroy()
		done(false)
	})
	probe.on('error', function () {
		done(false)
	})
}

server.on('error', function (err) {
	if (err && err.code === 'EADDRINUSE') return handlePortInUse()
	if (err && err.code === 'EACCES') {
		console.error('  [X] Tidak punya izin membuka port ' + APP.port + '. Ganti PORT di .env (misal 8787).')
		process.exit(1)
	}
	console.error('Server error:', err)
	process.exit(1)
})

server.listen(APP.port, APP.host, function () {
	const localUrl = 'http://localhost:' + APP.port
	const voice = ttsModeInfo()
	const allInterfaces = APP.host === '0.0.0.0' || APP.host === '::'
	const lan = allInterfaces ? lanAddresses() : []
	const NL = String.fromCharCode(10)
	const lines = [
		'',
		'  ' + APP.name + ' v' + APP.version,
		'  Buka: ' + localUrl,
	]
	if (lan.length) lines.push('  Dari HP / laptop lain (Wi-Fi sama): http://' + lan[0] + ':' + APP.port)
	lines.push(
		'  Flow : ' + (flow.isSimulate() ? 'SIMULATE (isi API key Flow di Settings)' : 'terhubung'),
		'  Suara: ' + voice.label + (voice.reason ? ' - ' + voice.reason : ''),
		'  Skrip: ' + (llm.isRemote() ? 'AI (LLM remote)' : 'template lokal (gratis)'),
		'  Inbox otomatis: ' + PATHS.inbox,
		'  Folder Downloads: ' + getDownloadsDir(),
		'',
	)
	console.log(lines.join(NL))
	if (APP.auth.enabled && !APP.auth.password) console.warn('  [!] AUTH_ENABLED=true tapi AUTH_PASSWORD kosong. Isi AUTH_PASSWORD di .env supaya login aman.' + NL)
	else if (!APP.auth.enabled && lan.length) console.log('  Tips: kalau dibuka dari perangkat lain, aktifkan login (AUTH_ENABLED=true + AUTH_PASSWORD) di .env.' + NL)

	const loadInfo = store.info() || {}
	if (loadInfo.corrupt) {
		const note = loadInfo.restoredFrom ? 'dipulihkan dari backup ' + loadInfo.restoredFrom : 'mulai dengan database kosong'
		console.warn('  [!] data/db.json rusak, ' + note + '. Salinan file rusak: ' + (loadInfo.brokenCopy || '-') + NL)
		events.logger.warn('store', 'Database rusak, ' + note)
	}
	if (loadInfo.missing && loadInfo.restoredFrom) {
		console.warn('  [!] data/db.json tidak ditemukan, data dipulihkan otomatis dari backup ' + loadInfo.restoredFrom + NL)
		events.logger.warn('store', 'db.json hilang, dipulihkan dari backup ' + loadInfo.restoredFrom)
	}
	if (loadInfo.envApplied && loadInfo.envApplied.length) events.logger.info('store', 'Nilai baru dari .env dipakai: ' + loadInfo.envApplied.join(', '))

	events.logger.info('server', APP.name + ' v' + APP.version + ' jalan di port ' + APP.port)
	const recovered = queue.recover()
	if (recovered) events.logger.info('queue', recovered + ' job dilanjutkan setelah restart')
	streams.bootstrap()
	automation.startScheduler(20000)
	setInterval(function () {
		queue.tick()
	}, 5000)
	setInterval(watchFlowDownloads, 3000)
	maintenance()
	setInterval(maintenance, 6 * 60 * 60 * 1000)

	if (process.env.OPEN_BROWSER === '1' || String(process.env.OPEN_BROWSER).toLowerCase() === 'true') openBrowser(localUrl)
})

let shuttingDown = false
function shutdown(signal) {
	if (shuttingDown) return
	shuttingDown = true
	console.log(String.fromCharCode(10) + 'Menutup (' + signal + ')...')
	try {
		const stopped = queue.shutdown()
		if (stopped.jobs) console.log('  ' + stopped.jobs + ' job dihentikan, akan dilanjutkan saat server nyala lagi.')
	} catch (err) {}
	try {
		streams.shutdown()
	} catch (err) {}
	setTimeout(function () {
		try {
			store.flush()
		} catch (err) {}
		server.close(function () {
			process.exit(0)
		})
		setTimeout(function () {
			process.exit(0)
		}, 2500)
	}, 400)
}

process.on('SIGINT', function () {
	shutdown('SIGINT')
})
process.on('SIGTERM', function () {
	shutdown('SIGTERM')
})
process.on('uncaughtException', function (err) {
	events.logger.error('server', 'Uncaught: ' + err.message)
	console.error(err)
})
process.on('unhandledRejection', function (err) {
	events.logger.error('server', 'Rejection: ' + (err && err.message ? err.message : String(err)))
})

module.exports = server
