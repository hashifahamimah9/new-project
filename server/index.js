'use strict'

/**
 * UGC Flow Studio - server utama.
 * Semua fitur diakses lewat REST API sederhana + SSE untuk progres realtime.
 */

const http = require('http')
const fs = require('fs')
const path = require('path')

const { PATHS, APP, RESOLUTIONS } = require('./lib/config')
const store = require('./lib/store')
const queue = require('./lib/queue')
const httpx = require('./lib/httpx')
const multipart = require('./lib/multipart')
const events = require('./lib/events')
const ff = require('./lib/ffmpeg')
const util = require('./lib/util')
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
const SECRET_KEYS = ['apiKey', 'streamKey', 'password']

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
		httpx.ok(res, {
			name: APP.name,
			version: APP.version,
			uptimeSeconds: Math.round((Date.now() - START_TIME) / 1000),
			queue: queue.stats(),
			flowMode: flow.isSimulate() ? 'simulate' : 'flow',
			ttsMode: (store.settings().tts || {}).provider || 'simulate',
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
		modes: { flow: flow.isSimulate() ? 'simulate' : 'flow', tts: (settings.tts || {}).provider || 'simulate', llm: llm.isRemote() ? 'remote' : 'local' },
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
	{ open: true },
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
	try {
		if (asset.file && fs.existsSync(asset.file) && asset.file.indexOf(PATHS.storage) === 0) fs.unlinkSync(asset.file)
	} catch (err) {}
	store.remove('assets', params.id)
	httpx.ok(res, { deleted: params.id })
})

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

function getDownloadsDir() {
	return path.join(process.env.USERPROFILE || 'C:\\Users\\HP', 'Downloads')
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
	const validExts = ['.mp4', '.webm', '.mov', '.mkv']
	for (const name of entries) {
		if (name.startsWith('.') || name.endsWith('.crdownload') || name.endsWith('.tmp')) continue
		const ext = path.extname(name).toLowerCase()
		if (!validExts.includes(ext)) continue
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
	{ open: true },
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
	let targetFile = body.file
	if (!targetFile) {
		const recents = scanDownloadsFolder(0)
		if (!recents.length) return httpx.fail(res, 404, 'Tidak ada file video di folder Downloads.')
		targetFile = recents[0].file
	}
	if (!fs.existsSync(targetFile)) return httpx.fail(res, 404, 'File video tidak ditemukan: ' + targetFile)

	const name = path.basename(targetFile)
	const destName = util.uid('', 6) + '_' + util.safeFileName(name)
	const destination = path.join(util.ensureDir(PATHS.uploads), destName)
	try {
		fs.copyFileSync(targetFile, destination)
	} catch (err) {
		return httpx.fail(res, 500, 'Gagal menyalin file video: ' + err.message)
	}

	const asset = studio.registerAsset({
		file: destination,
		name: name,
		kind: 'video',
		source: 'flow_download',
	})
	events.emit('asset:created', { assetId: asset.id, name: asset.name, kind: asset.kind })

	let job = null
	if (body.autoRender !== false) {
		const active = latestActiveScript || {}
		const brief = active.brief || {}
		const script = active.script || (active.scenes ? { scenes: active.scenes, title: active.title } : null)
		const payload = {
			product: active.product || brief.product || 'Produk Flow',
			problem: active.problem || brief.problem || '',
			benefits: active.benefits || brief.benefits || '',
			voice: active.voice || brief.voice || 'nadia',
			script: script,
			assetIds: [asset.id],
			mode: 'local',
			aspect: brief.aspect || '9:16',
			resolution: brief.resolution || '1080',
			fps: 30,
			subtitleStyle: brief.subtitleStyle || 'none',
			musicMood: brief.musicMood || 'lofi',
			naturalPreset: brief.naturalPreset || 'casual',
			variants: 1,
			source: 'flow_download',
		}
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
		job: job,
		message: job ? 'Video Flow berhasil di-import & mulai di-render dengan suara + subtitle!' : 'Video berhasil di-import sebagai aset',
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
		jobs.push(queue.summary(queue.enqueue({ type: 'ugc.render', title: 'UGC: ' + (body.product || 'Produk') + (copies > 1 ? ' #' + (i + 1) : ''), payload: body, lane: lane, source: body.source || 'manual' })))
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
	httpx.ok(res, { podcasts: store.coll('podcasts').sort(sortByCreated).slice(0, 100) })
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
	for (const file of [doc.file, doc.thumbFile, doc.videoFile, doc.audioFile]) {
		try {
			if (file && fs.existsSync(file) && file.indexOf(PATHS.storage) === 0) fs.unlinkSync(file)
		} catch (err) {}
	}
	store.remove(coll, params.id)
	httpx.ok(res, { deleted: params.id })
})

/* --------------------------------- live ---------------------------------- */

GET('/api/streams', async function (req, res) {
	httpx.ok(res, {
		streams: store.coll('streams').map(function (item) {
			return Object.assign({}, item, { streamKey: item.streamKey ? '\u2022\u2022\u2022\u2022\u2022\u2022' + String(item.streamKey).slice(-4) : '', status: streams.status(item.id) })
		}),
		status: streams.statusAll(),
	})
})

POST('/api/streams', async function (req, res) {
	const body = await httpx.readJson(req)
	const settings = store.settings().stream || {}
	const doc = store.insert(
		'streams',
		{
			name: body.name || 'Live 24 Jam',
			platform: body.platform || 'youtube',
			rtmpUrl: body.rtmpUrl || settings.rtmpUrl,
			streamKey: body.streamKey || settings.streamKey || '',
			items: body.items || [],
			loop: body.loop === undefined ? true : Boolean(body.loop),
			mode: body.mode || settings.mode || 'auto',
			resolution: body.resolution || settings.resolution || '1080',
			fps: Number(body.fps) || settings.fps || 30,
			videoBitrate: body.videoBitrate || settings.videoBitrate,
			audioBitrate: body.audioBitrate || settings.audioBitrate,
			audioMode: body.audioMode || 'source',
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
	httpx.ok(res, { stream: doc })
})

PATCH('/api/streams/:id', async function (req, res, params) {
	const body = stripMasked(await httpx.readJson(req))
	const updated = store.update('streams', params.id, body)
	if (!updated) return httpx.notFound(res, 'Stream tidak ada')
	httpx.ok(res, { stream: Object.assign({}, updated, { streamKey: updated.streamKey ? '\u2022\u2022\u2022\u2022\u2022\u2022' + String(updated.streamKey).slice(-4) : '' }) })
})

DELETE('/api/streams/:id', async function (req, res, params) {
	streams.stop(params.id)
	httpx.ok(res, { deleted: store.remove('streams', params.id) })
})

POST('/api/streams/:id/start', async function (req, res, params) {
	httpx.ok(res, { status: await streams.start(params.id) })
})

POST('/api/streams/:id/stop', async function (req, res, params) {
	streams.stop(params.id)
	httpx.ok(res, { status: streams.status(params.id) })
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
	httpx.ok(res, { automation: automation.create(body) })
})

PATCH('/api/automations/:id', async function (req, res, params) {
	const body = await httpx.readJson(req)
	const updated = automation.update(params.id, body)
	if (!updated) return httpx.notFound(res, 'Automation tidak ada')
	httpx.ok(res, { automation: updated })
})

DELETE('/api/automations/:id', async function (req, res, params) {
	httpx.ok(res, { deleted: store.remove('automations', params.id) })
})

POST('/api/automations/:id/run', async function (req, res, params) {
	const body = await httpx.readJson(req)
	httpx.ok(res, { result: await automation.run(params.id, body || {}, 'manual') })
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
		if (!result.ok) return httpx.fail(res, 404, result.error)
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
			const script = await llm.generateUgcScript({ product: 'Tes koneksi', sceneCount: 2 })
			return httpx.ok(res, { ok: true, mode: script.source, message: script.warning || 'Koneksi LLM OK (' + script.source + ')' })
		} catch (err) {
			return httpx.ok(res, { ok: false, message: err.message })
		}
	}
	if (params.provider === 'ffmpeg') {
		try {
			const out = await ff.run(['-version'])
			return httpx.ok(res, { ok: true, message: String(out.stdout || out.stderr || '').split(String.fromCharCode(10))[0] })
		} catch (err) {
			return httpx.ok(res, { ok: false, message: 'ffmpeg tidak ditemukan: ' + err.message })
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
	httpx.ok(res, { items: store.coll(params.name).sort(sortByCreated) })
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
		topVideos: videos.sort(sortByCreated).slice(0, 5).map(publicVideo),
	})
})

GET('/api/logs', async function (req, res, params, query) {
	httpx.ok(res, { logs: events.recent(Number(query.limit) || 150, query.type).reverse() })
})

/* --------------------------------- system -------------------------------- */

POST('/api/system/cleanup', async function (req, res) {
	let removed = 0
	const targets = [PATHS.tmp]
	for (const dir of targets) {
		let entries = []
		try {
			entries = fs.readdirSync(dir)
		} catch (err) {
			continue
		}
		for (const name of entries) {
			if (name.indexOf('playlist_') === 0) continue
			try {
				fs.rmSync(path.join(dir, name), { recursive: true, force: true })
				removed += 1
			} catch (err) {}
		}
	}
	store.coll('videos').forEach(function (video) {
		if (video.file && !fs.existsSync(video.file)) store.remove('videos', video.id)
	})
	store.coll('assets').forEach(function (asset) {
		if (asset.file && !fs.existsSync(asset.file)) store.remove('assets', asset.id)
	})
	store.pruneJobs(200)
	httpx.ok(res, { removed: removed, message: 'Bersih-bersih selesai' })
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

	if (req.method === 'OPTIONS') {
		res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' })
		res.end()
		return
	}

	// File storage (video, audio, gambar hasil render)
	if (pathname.indexOf('/api/files/') === 0) {
		if (APP.auth.enabled && !httpx.checkAuth(req)) return httpx.unauthorized(res)
		const rel = decodeURIComponent(pathname.slice('/api/files/'.length))
		const target = path.resolve(PATHS.storage, rel)
		const relDiff = path.relative(PATHS.storage, target)
		if (relDiff.startsWith('..') || path.isAbsolute(relDiff)) return httpx.fail(res, 400, 'Path tidak valid')
		return httpx.sendFile(req, res, target)
	}

	// Static extension files for Chrome extension / bookmarklet
	if (pathname.indexOf('/extension/') === 0) {
		const rel = decodeURIComponent(pathname.slice('/extension/'.length))
		const extDir = path.resolve(PATHS.root, 'extension')
		const target = path.resolve(extDir, rel)
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
		route.keys.forEach(function (key, i) {
			params[key] = decodeURIComponent(match[i + 1])
		})
		try {
			await route.handler(req, res, params, query)
		} catch (err) {
			events.logger.error('http', req.method + ' ' + pathname + ' - ' + err.message)
			if (!res.headersSent) httpx.fail(res, 500, err.message)
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

server.listen(APP.port, APP.host, function () {
	const banner = [
		'',
		'  ' + APP.name + ' v' + APP.version,
		'  Buka: http://localhost:' + APP.port,
		'  Flow: ' + (flow.isSimulate() ? 'SIMULATE (isi API key Flow di Settings)' : 'terhubung'),
		'  TTS : ' + ((store.settings().tts || {}).provider || 'simulate'),
		'  Inbox otomatis: ' + PATHS.inbox,
		'',
	].join(String.fromCharCode(10))
	console.log(banner)
	events.logger.info('server', APP.name + ' jalan di port ' + APP.port)
	queue.recover()
	streams.bootstrap()
	automation.startScheduler(20000)
	setInterval(function () {
		queue.tick()
	}, 5000)

	// Pantau otomatis file download dari Google Flow
	setInterval(async function () {
		if (!flowSessionStartTime) return
		try {
			const recents = scanDownloadsFolder(15)
			for (const item of recents) {
				if (item.mtimeMs >= flowSessionStartTime - 3000 && !processedDownloadFiles.has(item.name)) {
					processedDownloadFiles.add(item.name)
					events.logger.info('flow', 'Video Flow baru terdeteksi di Downloads: ' + item.name)
					events.emit('flow:download-detected', { file: item.name, path: item.file, size: item.size })

					const destName = util.uid('', 6) + '_' + util.safeFileName(item.name)
					const destination = path.join(util.ensureDir(PATHS.uploads), destName)
					fs.copyFileSync(item.file, destination)
					const asset = studio.registerAsset({
						file: destination,
						name: item.name,
						kind: 'video',
						source: 'flow_download_auto',
					})
					events.emit('asset:created', { assetId: asset.id, name: asset.name, kind: asset.kind })

					if (latestActiveScript) {
						const active = latestActiveScript
						const brief = active.brief || {}
						const script = active.script || (active.scenes ? { scenes: active.scenes, title: active.title } : null)
						const payload = {
							product: active.product || brief.product || 'Produk Flow',
							problem: active.problem || brief.problem || '',
							benefits: active.benefits || brief.benefits || '',
							voice: active.voice || brief.voice || 'nadia',
							script: script,
							assetIds: [asset.id],
							mode: 'local',
							aspect: brief.aspect || '9:16',
							resolution: brief.resolution || '1080',
							fps: 30,
							subtitleStyle: brief.subtitleStyle || 'none',
							musicMood: brief.musicMood || 'lofi',
							naturalPreset: brief.naturalPreset || 'casual',
							variants: 1,
							source: 'flow_auto_ingest',
						}
						const job = queue.enqueue({
							type: 'ugc.render',
							title: 'UGC: ' + payload.product,
							payload: payload,
							lane: 'low',
							source: 'flow_auto_ingest',
						})
						events.emit('flow:auto-render-started', { job: queue.summary(job), file: item.name })
					}
					flowSessionStartTime = 0
					break
				}
			}
		} catch (err) {
			events.logger.error('flow', 'Watcher error: ' + err.message)
		}
	}, 3000)
})

function shutdown(signal) {
	console.log(String.fromCharCode(10) + 'Menutup (' + signal + ')...')
	try {
		streams.stopAll()
		store.flush()
	} catch (err) {}
	server.close(function () {
		process.exit(0)
	})
	setTimeout(function () {
		process.exit(0)
	}, 3000)
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
