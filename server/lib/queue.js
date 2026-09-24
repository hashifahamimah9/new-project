'use strict'

/** Job queue: antrian render, concurrency, retry, cancel, progress realtime. */

const store = require('./store')
const jobctx = require('./jobctx')
const { emit, logger } = require('./events')
const { nowIso, uid } = require('./util')

const handlers = new Map()
const running = new Map() // jobId -> { canceled: boolean, ctx: jobctx }
const MAX_LOG = 300
const MAX_LOG_FINISHED = 150
const MAX_RECOVERIES = 2
let stopping = false

function register(type, handler) {
	handlers.set(type, handler)
}

function concurrency() {
	const q = store.settings().queue || {}
	return Math.max(1, Number(q.concurrency) || 2)
}

function isPaused() {
	return Boolean((store.settings().queue || {}).paused)
}

function setPaused(paused) {
	store.saveSettings({ queue: { paused: Boolean(paused) } })
	emit('queue:paused', { paused: Boolean(paused) })
	if (!paused) tick()
	return Boolean(paused)
}

function jobLog(jobId, message) {
	const job = store.get('jobs', jobId)
	if (!job) return
	job.logs = (job.logs || []).concat([{ at: nowIso(), message: String(message).slice(0, 500) }]).slice(-MAX_LOG)
	store.touch()
	emit('job:log', { jobId: jobId, message: String(message).slice(0, 500), at: nowIso() })
}

function jobProgress(jobId, percent, note) {
	const job = store.get('jobs', jobId)
	if (!job) return
	job.progress = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)))
	if (note) job.stage = String(note).slice(0, 120)
	store.touch()
	emit('job:progress', { jobId: jobId, progress: job.progress, stage: job.stage || '' })
}

function enqueue(input) {
	const job = store.insert('jobs', {
		id: uid('job', 10),
		type: input.type,
		title: input.title || input.type,
		status: 'queued',
		progress: 0,
		stage: 'Menunggu antrian',
		lane: input.lane || 'low',
		priority: Number(input.priority) || 0,
		payload: input.payload || {},
		logs: [],
		result: null,
		error: null,
		retries: 0,
		maxRetries: input.maxRetries === undefined ? Number((store.settings().queue || {}).maxRetries || 0) : input.maxRetries,
		source: input.source || 'manual',
		automationId: input.automationId || null,
	})
	emit('job:created', { job: summary(job) })
	logger.info('queue', 'Job masuk antrian: ' + job.title)
	store.pruneJobs()
	setTimeout(tick, 10)
	return job
}

function summary(job) {
	if (!job) return null
	return {
		id: job.id,
		type: job.type,
		title: job.title,
		status: job.status,
		progress: job.progress || 0,
		stage: job.stage || '',
		lane: job.lane,
		createdAt: job.createdAt,
		startedAt: job.startedAt || null,
		finishedAt: job.finishedAt || null,
		error: job.error || null,
		result: job.result || null,
		retries: job.retries || 0,
		source: job.source || 'manual',
		automationId: job.automationId || null,
		logCount: (job.logs || []).length,
	}
}

function nextJob() {
	const queued = store.filter('jobs', function (job) {
		return job.status === 'queued'
	})
	queued.sort(function (a, b) {
		if ((b.priority || 0) !== (a.priority || 0)) return (b.priority || 0) - (a.priority || 0)
		return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
	})
	return queued[0] || null
}

async function runJob(job) {
	const handler = handlers.get(job.type)
	if (!handler) {
		store.update('jobs', job.id, { status: 'failed', error: 'Tidak ada handler untuk tipe ' + job.type, finishedAt: nowIso() })
		emit('job:failed', { job: summary(store.get('jobs', job.id)) })
		return
	}
	const state = { canceled: false, ctx: jobctx.create(job.id) }
	running.set(job.id, state)
	store.update('jobs', job.id, { status: 'running', startedAt: nowIso(), stage: 'Mulai', progress: 1, error: null })
	emit('job:started', { job: summary(store.get('jobs', job.id)) })
	const ctx = {
		job: store.get('jobs', job.id),
		jobId: job.id,
		payload: job.payload || {},
		log: function (message) {
			jobLog(job.id, message)
		},
		progress: function (percent, note) {
			jobProgress(job.id, percent, note)
		},
		isCanceled: function () {
			return state.canceled
		},
		throwIfCanceled: function () {
			if (state.canceled) {
				const err = new Error('Dibatalkan oleh user')
				err.canceled = true
				throw err
			}
		},
	}
	try {
		const result = await jobctx.run(state.ctx, function () {
			return handler(ctx)
		})
		if (state.canceled) {
			store.update('jobs', job.id, { status: 'canceled', finishedAt: nowIso(), stage: 'Dibatalkan' })
			emit('job:canceled', { job: summary(store.get('jobs', job.id)) })
		} else {
			store.update('jobs', job.id, { status: 'done', progress: 100, stage: 'Selesai', result: result || null, finishedAt: nowIso() })
			emit('job:done', { job: summary(store.get('jobs', job.id)) })
			logger.info('queue', 'Job selesai: ' + job.title)
			notify('job_done', job)
		}
	} catch (err) {
		if (stopping && !state.canceled) {
			// Server dimatikan: biarkan status "running" supaya recover() melanjutkan job saat server nyala lagi.
			jobLog(job.id, 'Server dimatikan, job akan dilanjutkan otomatis saat server nyala lagi')
		} else if (state.canceled || (err && err.canceled)) {
			store.update('jobs', job.id, { status: 'canceled', finishedAt: nowIso(), stage: 'Dibatalkan' })
			emit('job:canceled', { job: summary(store.get('jobs', job.id)) })
		} else {
			const current = store.get('jobs', job.id) || job
			const retries = (current.retries || 0) + 1
			const maxRetries = current.maxRetries || 0
			jobLog(job.id, 'ERROR: ' + err.message)
			if (retries <= maxRetries) {
				store.update('jobs', job.id, { status: 'queued', retries: retries, stage: 'Retry ' + retries + '/' + maxRetries, progress: 0 })
				emit('job:retry', { job: summary(store.get('jobs', job.id)) })
				logger.warn('queue', 'Retry job ' + job.title + ' (' + retries + '/' + maxRetries + ')')
			} else {
				store.update('jobs', job.id, { status: 'failed', error: err.message, finishedAt: nowIso(), stage: 'Gagal' })
				emit('job:failed', { job: summary(store.get('jobs', job.id)) })
				logger.error('queue', 'Job gagal: ' + job.title + ' - ' + err.message)
				notify('job_failed', job, err.message)
			}
		}
	} finally {
		running.delete(job.id)
		const finished = store.get('jobs', job.id)
		if (finished && finished.status !== 'queued' && (finished.logs || []).length > MAX_LOG_FINISHED) {
			finished.logs = finished.logs.slice(-MAX_LOG_FINISHED)
		}
		store.save()
		setTimeout(tick, 10)
	}
}

function notify(event, job, message) {
	const settings = store.settings().notifications || {}
	if (!settings.webhookUrl) return
	if (event === 'job_done' && !settings.onJobDone) return
	if (event === 'job_failed' && !settings.onJobFailed) return
	fetch(settings.webhookUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ event: event, job: job.title, type: job.type, message: message || null, at: nowIso() }),
	}).catch(function () {})
}

function tick() {
	if (stopping || isPaused()) return
	while (running.size < concurrency()) {
		const job = nextJob()
		if (!job) return
		store.update('jobs', job.id, { status: 'running' })
		runJob(job)
	}
}

function cancel(jobId) {
	const job = store.get('jobs', jobId)
	if (!job) return false
	const state = running.get(jobId)
	if (state) {
		state.canceled = true
		const killed = jobctx.cancel(state.ctx)
		jobLog(jobId, 'Permintaan cancel diterima' + (killed ? ', menghentikan ' + killed + ' proses ffmpeg' : '') + '...')
		store.update('jobs', jobId, { stage: 'Membatalkan...' })
		emit('job:progress', { jobId: jobId, progress: job.progress || 0, stage: 'Membatalkan...' })
		return true
	}
	if (job.status === 'queued') {
		store.update('jobs', jobId, { status: 'canceled', finishedAt: nowIso(), stage: 'Dibatalkan' })
		emit('job:canceled', { job: summary(store.get('jobs', jobId)) })
		return true
	}
	return false
}

function retry(jobId) {
	const job = store.get('jobs', jobId)
	if (!job) return null
	if (running.has(jobId) || job.status === 'queued') return job
	store.update('jobs', jobId, { status: 'queued', error: null, progress: 0, stage: 'Menunggu antrian', retries: 0, finishedAt: null })
	emit('job:updated', { job: summary(store.get('jobs', jobId)) })
	setTimeout(tick, 10)
	return store.get('jobs', jobId)
}

function list(options) {
	const o = options || {}
	let jobs = store.coll('jobs')
	if (o.status) {
		jobs = jobs.filter(function (job) {
			return job.status === o.status
		})
	}
	if (o.type) {
		jobs = jobs.filter(function (job) {
			return job.type === o.type
		})
	}
	return jobs.slice(0, o.limit || 60).map(summary)
}

function detail(jobId) {
	const job = store.get('jobs', jobId)
	if (!job) return null
	return Object.assign(summary(job), { logs: job.logs || [], payload: job.payload || {} })
}

/**
 * Job yang menggantung (status running saat server mati) dimasukkan lagi ke antrian
 * supaya otomatis dilanjutkan. Kalau sudah 2x terputus, job ditandai gagal.
 */
function recover() {
	let count = 0
	store.coll('jobs').forEach(function (job) {
		if (job.status !== 'running') return
		const recoveries = (job.recoveries || 0) + 1
		if (recoveries > MAX_RECOVERIES) {
			job.status = 'failed'
			job.error = 'Server berhenti saat job berjalan (' + (recoveries - 1) + 'x). Klik Retry untuk mencoba lagi.'
			job.stage = 'Gagal'
			job.finishedAt = nowIso()
		} else {
			job.status = 'queued'
			job.stage = 'Dilanjutkan setelah server restart'
			job.progress = 0
			job.recoveries = recoveries
			job.logs = (job.logs || []).concat([{ at: nowIso(), message: 'Server restart, job dimasukkan lagi ke antrian' }]).slice(-MAX_LOG)
		}
		count += 1
	})
	if (count) store.save()
	setTimeout(tick, 1500)
	return count
}

/** ID job yang sedang berjalan (dipakai bersih-bersih supaya folder kerja aktif tidak terhapus). */
function runningIds() {
	return Array.from(running.keys())
}

/** Batalkan semua job yang sedang jalan. */
function cancelAllRunning() {
	running.forEach(function (state) {
		state.canceled = true
		jobctx.cancel(state.ctx)
	})
}

/** Server dimatikan: hentikan proses ffmpeg tanpa menandai job batal (dilanjutkan saat start berikutnya). */
function shutdown() {
	stopping = true
	let count = 0
	running.forEach(function (state) {
		count += jobctx.cancel(state.ctx) || 0
	})
	return { jobs: running.size, processes: count }
}

function stats() {
	const jobs = store.coll('jobs')
	const by = function (status) {
		return jobs.filter(function (job) {
			return job.status === status
		}).length
	}
	return {
		running: running.size,
		queued: by('queued'),
		done: by('done'),
		failed: by('failed'),
		canceled: by('canceled'),
		concurrency: concurrency(),
		paused: isPaused(),
	}
}

module.exports = {
	register: register,
	enqueue: enqueue,
	tick: tick,
	cancel: cancel,
	retry: retry,
	list: list,
	detail: detail,
	summary: summary,
	stats: stats,
	recover: recover,
	cancelAllRunning: cancelAllRunning,
	runningIds: runningIds,
	shutdown: shutdown,
	setPaused: setPaused,
	isPaused: isPaused,
}
