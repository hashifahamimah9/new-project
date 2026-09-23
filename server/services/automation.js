'use strict'

/** Flow otomatis: watch folder, jadwal, interval, dan webhook. */

const fs = require('fs')
const path = require('path')

const { PATHS } = require('../lib/config')
const store = require('../lib/store')
const events = require('../lib/events')
const queue = require('../lib/queue')
const util = require('../lib/util')
const studio = require('./studio')
const streams = require('./stream')

const ACTIONS = ['ugc.render', 'podcast.render', 'voice.render', 'images.generate', 'stream.start', 'stream.restart']
const TRIGGERS = ['manual', 'schedule', 'interval', 'webhook', 'watch-folder']

let ticking = false

function create(input) {
	const o = input || {}
	const trigger = TRIGGERS.indexOf(o.trigger) === -1 ? 'manual' : o.trigger
	const action = ACTIONS.indexOf(o.action) === -1 ? 'ugc.render' : o.action
	const doc = store.insert(
		'automations',
		{
			name: o.name || 'Automation',
			action: action,
			trigger: trigger,
			enabled: o.enabled === undefined ? true : Boolean(o.enabled),
			payload: o.payload || {},
			streamId: o.streamId || null,
			schedule: { time: (o.schedule && o.schedule.time) || o.time || '08:00', days: (o.schedule && o.schedule.days) || o.days || [0, 1, 2, 3, 4, 5, 6] },
			intervalMinutes: Math.max(5, Number(o.intervalMinutes) || 120),
			watchFolder: o.watchFolder || PATHS.inbox,
			token: o.token || util.token(18),
			lastRunAt: null,
			nextRunAt: null,
			runs: 0,
			lastResult: null,
		},
		'atm',
	)
	const next = computeNextRun(doc)
	return store.update('automations', doc.id, { nextRunAt: next })
}

function update(id, patch) {
	const updated = store.update('automations', id, patch || {})
	if (!updated) return null
	return store.update('automations', id, { nextRunAt: computeNextRun(updated) })
}

function list() {
	return store.coll('automations').map(function (automation) {
		return Object.assign({}, automation, { webhookUrl: '/api/hooks/' + automation.token })
	})
}

function computeNextRun(automation) {
	if (!automation || !automation.enabled) return null
	const now = new Date()
	if (automation.trigger === 'interval') {
		const last = automation.lastRunAt ? new Date(automation.lastRunAt).getTime() : now.getTime()
		return new Date(last + Math.max(5, Number(automation.intervalMinutes) || 120) * 60000).toISOString()
	}
	if (automation.trigger === 'schedule') {
		const parts = String((automation.schedule && automation.schedule.time) || '08:00').split(':')
		const hour = Number(parts[0]) || 0
		const minute = Number(parts[1]) || 0
		const days = ((automation.schedule && automation.schedule.days) || [0, 1, 2, 3, 4, 5, 6]).map(Number)
		const target = new Date(now)
		target.setHours(hour, minute, 0, 0)
		if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1)
		for (let offset = 0; offset < 7; offset += 1) {
			if (days.indexOf(target.getDay()) !== -1) break
			target.setDate(target.getDate() + 1)
		}
		return target.toISOString()
	}
	return null
}

function titleFor(automation, payload) {
	if (automation.action === 'ugc.render') return 'UGC: ' + (payload.product || automation.name)
	if (automation.action === 'podcast.render') return 'Podcast: ' + (payload.topic || automation.name)
	if (automation.action === 'voice.render') return 'Voice: ' + automation.name
	if (automation.action === 'images.generate') return 'Gambar: ' + (payload.prompt || automation.name)
	return automation.name
}

const WEEKDAY_MAP = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

async function run(id, extraPayload, source) {
	const automation = store.get('automations', id)
	if (!automation) return { ok: false, error: 'Automation tidak ada' }
	const payload = Object.assign({}, automation.payload || {}, extraPayload || {})
	let result = null

	if (automation.action === 'stream.start' || automation.action === 'stream.restart') {
		const streamId = payload.streamId || automation.streamId
		if (!streamId) return { ok: false, error: 'Stream belum dipilih' }
		try {
			result = automation.action === 'stream.start' ? await streams.start(streamId, {}) : await streams.restart(streamId)
		} catch (err) {
			store.update('automations', id, { lastRunAt: util.nowIso(), lastResult: 'error: ' + err.message })
			return { ok: false, error: err.message }
		}
	} else {
		const job = queue.enqueue({
			type: automation.action,
			title: titleFor(automation, payload),
			payload: payload,
			lane: payload.lane || 'low',
			source: source || 'automation',
			automationId: id,
		})
		result = queue.summary(job)
	}

	const updated = store.update('automations', id, {
		lastRunAt: util.nowIso(),
		runs: (automation.runs || 0) + 1,
		lastResult: automation.action + ' dijalankan (' + (source || 'automation') + ')',
	})
	store.update('automations', id, { nextRunAt: computeNextRun(updated) })
	events.emit('automation:run', { automationId: id, name: automation.name, action: automation.action, source: source || 'automation' })
	return { ok: true, result: result }
}

function dueBySchedule(automation, now) {
	if (automation.trigger !== 'schedule') return false
	const timezone = (store.settings().workspace || {}).timezone
	const local = util.localTimeParts(now, timezone)
	const days = (automation.schedule && automation.schedule.days) || [0, 1, 2, 3, 4, 5, 6]
	const dayNum = WEEKDAY_MAP[local.weekday] !== undefined ? WEEKDAY_MAP[local.weekday] : now.getDay()
	const allowed = days.map(Number).indexOf(dayNum) !== -1
	if (!allowed) return false
	const parts = String((automation.schedule && automation.schedule.time) || '08:00').split(':')
	const targetMinutes = (Number(parts[0]) || 0) * 60 + (Number(parts[1]) || 0)
	const nowMinutes = local.hour * 60 + local.minute
	if (nowMinutes < targetMinutes || nowMinutes > targetMinutes + 2) return false
	if (automation.lastRunAt && now.getTime() - new Date(automation.lastRunAt).getTime() < 3 * 60000) return false
	return true
}

function dueByInterval(automation, now) {
	if (automation.trigger !== 'interval') return false
	const minutes = Math.max(5, Number(automation.intervalMinutes) || 120)
	if (!automation.lastRunAt) return true
	return now.getTime() - new Date(automation.lastRunAt).getTime() >= minutes * 60000
}

/** Ambil file baru dari folder inbox lalu daftarkan jadi aset. */
function scanInbox(folder) {
	const dir = util.ensureDir(folder || PATHS.inbox)
	const created = []
	let entries = []
	try {
		entries = fs.readdirSync(dir)
	} catch (err) {
		return created
	}
	for (const name of entries) {
		if (name.indexOf('.') === 0) continue
		const full = path.join(dir, name)
		let stat = null
		try {
			stat = fs.statSync(full)
		} catch (err) {
			continue
		}
		if (!stat.isFile()) continue
		if (Date.now() - stat.mtimeMs < 5000) continue
		const kind = util.kindOf(name)
		if (kind === 'other') continue
		const destination = path.join(util.ensureDir(PATHS.uploads), util.uid('', 6) + '_' + util.safeFileName(name))
		try {
			fs.renameSync(full, destination)
		} catch (err) {
			try {
				fs.copyFileSync(full, destination)
				fs.unlinkSync(full)
			} catch (e) {
				continue
			}
		}
		const asset = studio.registerAsset({ file: destination, kind: kind, name: name, source: 'inbox' })
		events.emit('asset:created', { assetId: asset.id, name: asset.name, kind: asset.kind })
		events.logger.info('automation', 'File baru dari inbox: ' + name)
		created.push(asset)
	}
	return created
}

async function tick() {
	if (ticking) return
	ticking = true
	try {
		const now = new Date()
		const automations = store.coll('automations').filter(function (automation) {
			return automation.enabled
		})

		const watchers = automations.filter(function (automation) {
			return automation.trigger === 'watch-folder'
		})
		for (const automation of watchers) {
			const assets = scanInbox(automation.watchFolder)
			for (const asset of assets) {
				const product = path.basename(asset.name, path.extname(asset.name)).replace(/[_-]+/g, ' ')
				await run(automation.id, { assetIds: [asset.id], product: (automation.payload || {}).product || product }, 'watch-folder')
			}
		}

		for (const automation of automations) {
			if (dueBySchedule(automation, now) || dueByInterval(automation, now)) {
				await run(automation.id, {}, automation.trigger)
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
	setInterval(function () {
		tick().catch(function () {})
	}, Math.max(10000, Number(intervalMs) || 20000))
}

module.exports = {
	ACTIONS: ACTIONS,
	TRIGGERS: TRIGGERS,
	create: create,
	update: update,
	list: list,
	run: run,
	tick: tick,
	scanInbox: scanInbox,
	handleWebhook: handleWebhook,
	startScheduler: startScheduler,
	computeNextRun: computeNextRun,
}
