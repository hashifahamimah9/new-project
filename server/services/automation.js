'use strict'

/** Flow otomatis: watch folder, jadwal, interval, dan webhook. */

const fs = require('fs')
const path = require('path')

const { PATHS, APP } = require('../lib/config')
const store = require('../lib/store')
const events = require('../lib/events')
const queue = require('../lib/queue')
const util = require('../lib/util')
const studio = require('./studio')
const streams = require('./stream')

const ACTIONS = ['ugc.render', 'podcast.render', 'voice.render', 'images.generate', 'stream.start', 'stream.restart']
const TRIGGERS = ['manual', 'schedule', 'interval', 'webhook', 'watch-folder']
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]

/** Nama hari (Inggris & Indonesia) -> indeks hari (0 = Minggu). */
const DAY_ALIASES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, min: 0, sen: 1, sel: 2, rab: 3, kam: 4, jum: 5, sab: 6 }

/** Jenis file di watch folder yang dipakai tiap aksi. File lain dibiarkan di tempatnya. */
const WATCH_KINDS = {
	'ugc.render': ['image', 'video'],
	'podcast.render': ['text'],
	'voice.render': ['audio', 'video', 'text'],
	'images.generate': ['image', 'text'],
	'stream.start': [],
	'stream.restart': [],
}
const TEXT_EXTS = ['.txt', '.md']
const PARTIAL_EXTS = ['.crdownload', '.part', '.partial', '.download', '.tmp']
/** File harus "diam" (tidak berubah) selama ini sebelum diambil, supaya file yang masih disalin tidak terpotong. */
const SETTLE_MS = 5000
/** Maksimal file per video UGC dari satu grup watch folder. */
const MAX_GROUP_FILES = 12
/** Jadwal yang terlewat (mis. PC mati) masih dijalankan kalau telatnya belum lewat batas ini. */
const SCHEDULE_GRACE_MS = 3 * 60 * 60 * 1000

let ticking = false
let timer = null

/* ------------------------------ normalisasi ------------------------------ */

function parseTime(value) {
	const match = /^(\d{1,2})[:.](\d{2})(?::\d{2})?$/.exec(String(value === undefined || value === null ? '' : value).trim())
	if (!match) return null
	const hour = Number(match[1])
	const minute = Number(match[2])
	if (hour > 23 || minute > 59) return null
	return { hour: hour, minute: minute, text: String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0') }
}

function normalizeDays(value) {
	let list = value
	if (typeof list === 'string') list = list.split(/[\s,;]+/)
	if (typeof list === 'number') list = [list]
	if (!Array.isArray(list)) return ALL_DAYS.slice()
	const out = []
	list.forEach(function (item) {
		if (item === '' || item === null || item === undefined) return
		let day = Number(item)
		if (!Number.isInteger(day)) day = DAY_ALIASES[String(item).trim().toLowerCase().slice(0, 3)]
		if (day === 7) day = 0
		if (Number.isInteger(day) && day >= 0 && day <= 6 && out.indexOf(day) === -1) out.push(day)
	})
	return out.length
		? out.sort(function (a, b) {
				return a - b
		  })
		: ALL_DAYS.slice()
}

function badRequest(message) {
	const err = new Error(message)
	err.status = 400
	err.statusCode = 400
	return err
}

/** Gabungkan input jadwal (bisa sebagian) dengan jadwal lama. Lempar error kalau jam tidak valid. */
function normalizeSchedule(input, current) {
	const base = current || {}
	const o = input || {}
	const rawTime = o.time !== undefined && o.time !== '' ? o.time : base.time || '08:00'
	const time = parseTime(rawTime)
	if (!time) throw badRequest('Format jam jadwal tidak valid: "' + rawTime + '". Pakai HH:MM, contoh 08:00')
	return { time: time.text, days: normalizeDays(o.days !== undefined ? o.days : base.days) }
}

function intervalOf(automation) {
	return Math.max(5, Math.round(Number(automation && automation.intervalMinutes) || 120))
}

function resolveFolder(folder) {
	const raw = String(folder || '').trim()
	if (!raw) return PATHS.inbox
	const resolved = path.resolve(PATHS.root, raw)
	// Jangan izinkan folder penyimpanan internal (file akan dipindah ke sana -> berputar terus)
	const internal = [PATHS.uploads, PATHS.renders, PATHS.audio, PATHS.tmp, PATHS.thumbs, PATHS.cache, PATHS.storageCache, PATHS.data]
	for (const dir of internal) {
		const rel = path.relative(dir, resolved)
		if (rel === '' || (rel && rel.indexOf('..') !== 0 && !path.isAbsolute(rel))) {
			throw badRequest('Folder pantauan tidak boleh folder internal aplikasi (' + dir + '). Pakai folder lain, mis. ' + PATHS.inbox)
		}
	}
	return resolved
}

function cleanPayload(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
	const out = {}
	Object.keys(value).forEach(function (key) {
		if (key === '__proto__' || key === 'constructor' || key === 'prototype') return
		out[key] = value[key]
	})
	return out
}

/** Payload dari luar (webhook) tidak boleh menunjuk file lokal sembarang. */
function externalPayload(value) {
	const out = cleanPayload(value)
	Object.keys(out).forEach(function (key) {
		if (key === 'file' || key === 'outDir' || /(File|Path|Dir)$/.test(key)) delete out[key]
	})
	return out
}

function timezone() {
	return (store.settings().workspace || {}).timezone || APP.timezone
}

/* ---------------------------------- CRUD ---------------------------------- */

function create(input) {
	const o = input || {}
	const trigger = TRIGGERS.indexOf(o.trigger) === -1 ? 'manual' : o.trigger
	const action = ACTIONS.indexOf(o.action) === -1 ? 'ugc.render' : o.action
	const schedule = normalizeSchedule({ time: (o.schedule && o.schedule.time) || o.time, days: (o.schedule && o.schedule.days) || o.days })
	const doc = store.insert(
		'automations',
		{
			name: String(o.name || '').trim() || 'Automation',
			action: action,
			trigger: trigger,
			enabled: o.enabled === undefined ? true : Boolean(o.enabled),
			payload: cleanPayload(o.payload),
			streamId: o.streamId || null,
			schedule: schedule,
			intervalMinutes: intervalOf(o),
			watchFolder: resolveFolder(o.watchFolder),
			token: o.token || util.token(18),
			lastRunAt: null,
			nextRunAt: null,
			runs: 0,
			lastResult: null,
		},
		'atm',
	)
	if (trigger === 'watch-folder') util.ensureDir(doc.watchFolder)
	return store.update('automations', doc.id, { nextRunAt: computeNextRun(doc) })
}

function update(id, patch) {
	const current = store.get('automations', id)
	if (!current) return null
	const o = cleanPayload(patch)
	const clean = {}
	if (o.name !== undefined) clean.name = String(o.name || '').trim() || current.name
	if (o.enabled !== undefined) clean.enabled = Boolean(o.enabled)
	if (o.trigger !== undefined && TRIGGERS.indexOf(o.trigger) !== -1) clean.trigger = o.trigger
	if (o.action !== undefined && ACTIONS.indexOf(o.action) !== -1) clean.action = o.action
	if (o.payload !== undefined) clean.payload = cleanPayload(o.payload)
	if (o.streamId !== undefined) clean.streamId = o.streamId || null
	if (o.intervalMinutes !== undefined) clean.intervalMinutes = intervalOf(o)
	if (o.watchFolder !== undefined) clean.watchFolder = resolveFolder(o.watchFolder)
	if (o.schedule !== undefined || o.time !== undefined || o.days !== undefined) {
		const s = o.schedule || {}
		clean.schedule = normalizeSchedule({ time: s.time !== undefined ? s.time : o.time, days: s.days !== undefined ? s.days : o.days }, current.schedule)
	}
	// payload diganti utuh (bukan digabung) supaya kunci lama bisa dihapus
	if (clean.payload) store.update('automations', id, { payload: null })
	const updated = store.update('automations', id, clean)
	if (!updated) return null
	let next = computeNextRun(updated)
	// Interval yang baru diaktifkan lagi mulai menghitung dari sekarang, tidak langsung jalan
	if (updated.trigger === 'interval' && clean.enabled === true && !current.enabled) {
		next = new Date(Date.now() + intervalOf(updated) * 60000).toISOString()
	}
	if (updated.trigger === 'watch-folder' && updated.enabled) util.ensureDir(updated.watchFolder || PATHS.inbox)
	return store.update('automations', id, { nextRunAt: next })
}

/** Data automation untuk API/UI: ditambah URL webhook dan jenis file yang dipantau. */
function decorate(automation) {
	if (!automation) return automation
	return Object.assign({}, automation, { webhookUrl: '/api/hooks/' + automation.token, watchKinds: WATCH_KINDS[automation.action] || [] })
}

function list() {
	return store.coll('automations').map(decorate)
}

/** Jadwal berikutnya. Jam jadwal dihitung di zona waktu workspace (Pengaturan > Timezone). */
function computeNextRun(automation, fromDate) {
	if (!automation || !automation.enabled) return null
	const now = fromDate || new Date()
	if (automation.trigger === 'interval') {
		const baseIso = automation.lastRunAt || automation.createdAt
		let base = baseIso ? Date.parse(baseIso) : now.getTime()
		if (!Number.isFinite(base)) base = now.getTime()
		return new Date(base + intervalOf(automation) * 60000).toISOString()
	}
	if (automation.trigger === 'schedule') {
		let schedule = null
		try {
			schedule = normalizeSchedule(automation.schedule)
		} catch (err) {
			schedule = normalizeSchedule({ time: '08:00', days: (automation.schedule || {}).days })
		}
		const time = parseTime(schedule.time)
		const tz = timezone()
		const today = util.localDateParts(now, tz)
		for (let offset = 0; offset <= 7; offset += 1) {
			// aritmatika kalender murni (jam 12 UTC) supaya aman dari pergantian DST
			const day = new Date(Date.UTC(today.year, today.month - 1, today.day + offset, 12))
			if (schedule.days.indexOf(day.getUTCDay()) === -1) continue
			const candidate = util.zonedTimeToDate(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), time.hour, time.minute, tz)
			if (candidate.getTime() > now.getTime()) return candidate.toISOString()
		}
		return null
	}
	return null
}

function titleFor(automation, payload) {
	if (automation.action === 'ugc.render') return 'UGC: ' + (payload.product || automation.name)
	if (automation.action === 'podcast.render') return 'Podcast: ' + (payload.topic || automation.name)
	if (automation.action === 'voice.render') return 'Voice: ' + (payload.title || automation.name)
	if (automation.action === 'images.generate') return 'Gambar: ' + String(payload.prompt || automation.name).slice(0, 60)
	return automation.name
}

function buildPayload(automation, extra) {
	const payload = Object.assign({}, cleanPayload(automation.payload), cleanPayload(extra))
	if (automation.action === 'podcast.render' && !payload.topic && payload.product) payload.topic = payload.product
	if (automation.action === 'images.generate' && !payload.prompt && payload.product) payload.prompt = payload.product
	if (automation.action === 'voice.render') {
		if (payload.assetId && !payload.text) payload.mode = payload.mode || 'transform'
		if (!payload.mode) payload.mode = 'tts'
	}
	return payload
}

/* ----------------------------------- run ---------------------------------- */

function finish(automation, source, ok, message) {
	const updated = store.update('automations', automation.id, {
		lastRunAt: util.nowIso(),
		runs: (automation.runs || 0) + (ok ? 1 : 0),
		lastResult: (ok ? '' : 'error: ') + message,
	})
	if (updated) store.update('automations', automation.id, { nextRunAt: computeNextRun(updated) })
	if (!ok) events.logger.warn('automation', automation.name + ': ' + message)
}

async function run(id, extraPayload, source) {
	const automation = store.get('automations', id)
	if (!automation) return { ok: false, error: 'Automation tidak ada' }
	const from = source || 'automation'
	const extra = from === 'webhook' ? externalPayload(extraPayload) : cleanPayload(extraPayload)

	// "Run sekarang" pada watch folder = cek folder sekarang juga
	if (from === 'manual' && automation.trigger === 'watch-folder' && !Object.keys(extra).length) {
		const count = await processWatchFolder(automation)
		if (!count) return { ok: false, error: 'Belum ada file baru yang cocok di ' + (automation.watchFolder || PATHS.inbox) }
		return { ok: true, result: { processed: count } }
	}

	const payload = buildPayload(automation, extra)
	let result = null

	if (automation.action === 'stream.start' || automation.action === 'stream.restart') {
		const streamId = payload.streamId || automation.streamId
		if (!streamId) {
			finish(automation, from, false, 'Channel live belum dipilih')
			return { ok: false, error: 'Channel live belum dipilih' }
		}
		const current = streams.status(streamId)
		if (!current) {
			finish(automation, from, false, 'Channel live tidak ditemukan')
			return { ok: false, error: 'Channel live tidak ditemukan' }
		}
		if (automation.action === 'stream.start' && current.live) {
			finish(automation, from, true, 'Stream sudah live, tidak dinyalakan ulang')
			return { ok: true, result: { skipped: true, message: 'Stream sudah live' } }
		}
		try {
			result = automation.action === 'stream.start' ? await streams.start(streamId, {}) : await streams.restart(streamId)
		} catch (err) {
			finish(automation, from, false, err.message)
			return { ok: false, error: err.message }
		}
	} else {
		if (automation.action === 'voice.render') {
			const hasText = String(payload.text || '').trim()
			if (payload.mode === 'transform' ? !payload.assetId : !hasText) {
				const message = payload.mode === 'transform' ? 'Voice transform butuh file audio/video' : 'Voice butuh teks: isi "text" di payload, atau taruh file .txt di watch folder'
				finish(automation, from, false, message)
				return { ok: false, error: message }
			}
		}
		const job = queue.enqueue({
			type: automation.action,
			title: titleFor(automation, payload),
			payload: payload,
			lane: payload.lane || 'low',
			source: from,
			automationId: id,
		})
		result = queue.summary(job)
	}

	finish(automation, from, true, automation.action + ' dijalankan (' + from + ')')
	events.emit('automation:run', { automationId: id, name: automation.name, action: automation.action, source: from })
	return { ok: true, result: result }
}

/** Sudah waktunya jalan? Sumber kebenaran: nextRunAt (dihitung sesuai zona waktu). */
function isDue(automation, now) {
	if (automation.trigger !== 'schedule' && automation.trigger !== 'interval') return false
	const next = automation.nextRunAt ? Date.parse(automation.nextRunAt) : NaN
	if (!Number.isFinite(next)) {
		store.update('automations', automation.id, { nextRunAt: computeNextRun(automation, now) })
		return false
	}
	if (now.getTime() < next) {
		// jadwal masa depan: hitung ulang kalau zona waktu / jadwal berubah
		if (automation.trigger === 'schedule') {
			const expected = computeNextRun(automation, now)
			if (expected && expected !== automation.nextRunAt) store.update('automations', automation.id, { nextRunAt: expected })
		}
		return false
	}
	if (automation.trigger === 'schedule' && now.getTime() - next > SCHEDULE_GRACE_MS) {
		const skipped = new Date(next).toLocaleString('id-ID', { timeZone: timezone() })
		store.update('automations', automation.id, {
			nextRunAt: computeNextRun(automation, now),
			lastResult: 'Jadwal ' + skipped + ' terlewat (server mati), lanjut ke jadwal berikutnya',
		})
		events.logger.warn('automation', automation.name + ': jadwal ' + skipped + ' terlewat, dilewati')
		return false
	}
	return true
}

/* ------------------------------ watch folder ------------------------------ */

function fileKind(name) {
	const ext = path.extname(name).toLowerCase()
	if (TEXT_EXTS.indexOf(ext) !== -1) return 'text'
	return util.kindOf(name)
}

/** "sepatu-lari (2).jpg" / "sepatu_lari_02.png" -> "sepatu lari" */
function productFromName(name) {
	const raw = path.basename(name, path.extname(name))
	const cleaned = raw
		.replace(/[\s_-]*\(\d+\)$/, '')
		.replace(/[\s_-]+\d{1,3}$/, '')
		.replace(/[_-]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
	return cleaned || raw.replace(/[_-]+/g, ' ').trim() || 'Produk'
}

function statSafe(file) {
	try {
		return fs.statSync(file)
	} catch (err) {
		return null
	}
}

function readdirSafe(dir) {
	try {
		return fs.readdirSync(dir)
	} catch (err) {
		return []
	}
}

function isPartial(name) {
	return PARTIAL_EXTS.indexOf(path.extname(name).toLowerCase()) !== -1
}

function moveInto(dir, full, name) {
	const destination = path.join(util.ensureDir(dir), util.uid('', 6) + '_' + util.safeFileName(name))
	try {
		fs.renameSync(full, destination)
	} catch (err) {
		try {
			fs.copyFileSync(full, destination)
			fs.unlinkSync(full)
		} catch (e) {
			try {
				fs.unlinkSync(destination)
			} catch (x) {}
			return null
		}
	}
	return destination
}

function takeFile(full, name, kind, group, product) {
	if (kind === 'text') {
		let text = ''
		try {
			text = fs.readFileSync(full, 'utf8').replace(/^\uFEFF/, '').slice(0, 20000).trim()
		} catch (err) {
			return null
		}
		if (!moveInto(PATHS.uploads, full, name)) return null
		if (!text) return null
		return { kind: kind, name: name, group: group, product: product, text: text }
	}
	const destination = moveInto(PATHS.uploads, full, name)
	if (!destination) return null
	const asset = studio.registerAsset({ file: destination, kind: kind, name: name, source: 'inbox' })
	events.emit('asset:created', { assetId: asset.id, name: asset.name, kind: asset.kind })
	return { kind: kind, name: name, group: group, product: product, asset: asset }
}

/**
 * Ambil file baru dari folder pantauan. Hanya jenis di `acceptKinds` yang diambil (default: gambar,
 * video, audio). Subfolder (1 tingkat) dianggap satu produk: nama folder = nama produk.
 * Nama yang diawali "." atau "_" diabaikan.
 */
function scanInbox(folder, acceptKinds) {
	const kinds = Array.isArray(acceptKinds) ? acceptKinds : ['image', 'video', 'audio']
	const dir = util.ensureDir(folder || PATHS.inbox)
	const items = []
	if (!kinds.length) return items
	const now = Date.now()

	for (const name of readdirSafe(dir)) {
		if (name.indexOf('.') === 0 || name.indexOf('_') === 0) continue
		const full = path.join(dir, name)
		const stat = statSafe(full)
		if (!stat) continue

		if (stat.isDirectory()) {
			const children = readdirSafe(full).filter(function (child) {
				return child.indexOf('.') !== 0
			})
			if (!children.length) continue
			// tunggu sampai seluruh isi folder selesai disalin
			let busy = now - stat.mtimeMs < SETTLE_MS
			const ready = []
			children.forEach(function (child) {
				const childFull = path.join(full, child)
				const childStat = statSafe(childFull)
				if (!childStat || !childStat.isFile()) return
				if (isPartial(child) || now - childStat.mtimeMs < SETTLE_MS) busy = true
				ready.push({ full: childFull, name: child, kind: fileKind(child) })
			})
			if (busy) continue
			const product = name.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Produk'
			let taken = 0
			ready
				.sort(function (a, b) {
					return a.name.localeCompare(b.name, undefined, { numeric: true })
				})
				.forEach(function (entry) {
					if (kinds.indexOf(entry.kind) === -1) return
					const item = takeFile(entry.full, entry.name, entry.kind, 'dir:' + name, product)
					if (item) {
						items.push(item)
						taken += 1
					}
				})
			if (taken) {
				try {
					fs.rmdirSync(full) // hanya berhasil kalau folder sudah kosong
				} catch (err) {}
				events.logger.info('automation', 'Folder "' + name + '" diambil dari watch folder (' + taken + ' file)')
			}
			continue
		}

		if (!stat.isFile() || isPartial(name)) continue
		if (now - stat.mtimeMs < SETTLE_MS) continue
		const kind = fileKind(name)
		if (kinds.indexOf(kind) === -1) continue
		const product = productFromName(name)
		const item = takeFile(full, name, kind, 'name:' + product.toLowerCase(), product)
		if (item) {
			items.push(item)
			events.logger.info('automation', 'File baru dari watch folder: ' + name)
		}
	}
	return items
}

/** Ubah file yang diambil jadi daftar payload job untuk aksi automation. */
function watchPayloads(automation, items) {
	const base = automation.payload || {}
	const out = []
	if (automation.action === 'ugc.render') {
		// foto/video dengan nama produk sama (sepatu-1.jpg, sepatu-2.jpg) atau satu subfolder -> 1 video
		const groups = new Map()
		items.forEach(function (item) {
			if (!item.asset) return
			if (!groups.has(item.group)) groups.set(item.group, { product: item.product, ids: [] })
			groups.get(item.group).ids.push(item.asset.id)
		})
		groups.forEach(function (group) {
			for (let i = 0; i < group.ids.length; i += MAX_GROUP_FILES) {
				out.push({ assetIds: group.ids.slice(i, i + MAX_GROUP_FILES), product: base.product || group.product })
			}
		})
		return out
	}
	items.forEach(function (item) {
		if (automation.action === 'voice.render') {
			if (item.text) out.push({ text: item.text, mode: 'tts', title: item.product })
			else if (item.asset) out.push({ assetId: item.asset.id, mode: 'transform', title: item.product })
		} else if (automation.action === 'podcast.render') {
			if (!item.text) return
			const lines = item.text.split(/\r?\n/)
			const topic = (lines.shift() || '').replace(/^#+\s*/, '').trim().slice(0, 160) || item.product
			const notes = lines.join('\n').trim().slice(0, 4000)
			out.push(notes ? { topic: topic, notes: notes } : { topic: topic })
		} else if (automation.action === 'images.generate') {
			if (item.text) out.push({ prompt: item.text.slice(0, 1500), title: item.product })
			else if (item.asset) out.push({ assetIds: [item.asset.id], prompt: base.prompt || item.product, title: item.product })
		}
	})
	return out
}

async function processWatchFolder(automation) {
	const kinds = WATCH_KINDS[automation.action] || []
	if (!kinds.length) return 0
	const items = scanInbox(automation.watchFolder || PATHS.inbox, kinds)
	if (!items.length) return 0
	const payloads = watchPayloads(automation, items)
	for (const extra of payloads) {
		await run(automation.id, extra, 'watch-folder')
	}
	return payloads.length
}

/* --------------------------------- ticker --------------------------------- */

async function tick() {
	if (ticking) return
	ticking = true
	try {
		const now = new Date()
		const automations = store.coll('automations').filter(function (automation) {
			return automation.enabled
		})
		for (const automation of automations) {
			if (automation.trigger !== 'watch-folder') continue
			try {
				await processWatchFolder(automation)
			} catch (err) {
				events.logger.error('automation', automation.name + ': watch folder gagal: ' + err.message)
			}
		}
		for (const automation of automations) {
			if (!isDue(automation, now)) continue
			try {
				await run(automation.id, {}, automation.trigger)
			} catch (err) {
				events.logger.error('automation', automation.name + ': gagal jalan: ' + err.message)
			}
		}
	} catch (err) {
		events.logger.error('automation', 'Tick gagal: ' + err.message)
	} finally {
		ticking = false
	}
}

async function handleWebhook(token, body) {
	const automation = store.find('automations', function (item) {
		return item.token === token
	})
	if (!automation) return { ok: false, error: 'Webhook tidak dikenal' }
	if (!automation.enabled) return { ok: false, error: 'Automation dinonaktifkan' }
	return run(automation.id, body || {}, 'webhook')
}

function startScheduler(intervalMs) {
	util.ensureDir(PATHS.inbox)
	if (timer) clearInterval(timer)
	timer = setInterval(function () {
		tick().catch(function () {})
	}, Math.max(5000, Number(intervalMs) || 20000))
	// cek pertama agak cepat setelah server nyala (jadwal terlewat, file yang sudah menunggu)
	setTimeout(function () {
		tick().catch(function () {})
	}, 4000)
}

function stopScheduler() {
	if (timer) clearInterval(timer)
	timer = null
}

module.exports = {
	ACTIONS: ACTIONS,
	TRIGGERS: TRIGGERS,
	WATCH_KINDS: WATCH_KINDS,
	create: create,
	update: update,
	list: list,
	decorate: decorate,
	run: run,
	tick: tick,
	scanInbox: scanInbox,
	handleWebhook: handleWebhook,
	startScheduler: startScheduler,
	stopScheduler: stopScheduler,
	computeNextRun: computeNextRun,
	parseTime: parseTime,
	normalizeDays: normalizeDays,
}
