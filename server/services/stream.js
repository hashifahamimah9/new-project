'use strict'

/** Live 24 jam ke YouTube (atau RTMP lain) dengan auto-reconnect. */

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const { PATHS, dimensionsFor } = require('../lib/config')
const store = require('../lib/store')
const events = require('../lib/events')
const ff = require('../lib/ffmpeg')
const util = require('../lib/util')

const procs = new Map()
const timers = new Map()
const starting = new Set()
let shuttingDown = false

/** Error karena input/pengaturan user (bukan bug server) -> dikirim ke browser sebagai 4xx. */
function userError(message, status) {
	const err = new Error(message)
	err.status = status || 400
	return err
}

/** "4500k" / "6M" / "6000" -> kbps (angka). */
function kbps(value, fallback) {
	const text = String(value || '').trim().toLowerCase()
	const num = parseFloat(text)
	if (!isFinite(num) || num <= 0) return fallback
	if (text.endsWith('m')) return Math.round(num * 1000)
	if (text.endsWith('k')) return Math.round(num)
	return num > 100000 ? Math.round(num / 1000) : Math.round(num)
}

function sizeFor(stream) {
	const dims = dimensionsFor(stream.aspect || '16:9', String(stream.resolution || '1080'))
	return [dims.width, dims.height]
}

/** Mode audio live: "source" (audio asli video), "music" (musik loop) atau "silent" (tanpa suara). */
function audioModeOf(stream) {
	const value = String((stream && stream.audioMode) || '').trim().toLowerCase()
	if (value === 'music' || value === 'musik') return 'music'
	if (value === 'silent' || value === 'none' || value === 'mute' || value === 'muted' || value === 'tanpa suara') return 'silent'
	return 'source'
}

function streamsDir() {
	return util.ensureDir(path.join(PATHS.tmp, 'streams'))
}

function log(stream, message, level) {
	const entry = { at: util.nowIso(), level: level || 'info', message: String(message).slice(0, 400) }
	const current = store.get('streams', stream.id)
	const logs = ((current && current.logs) || []).concat([entry]).slice(-200)
	store.update('streams', stream.id, { logs: logs })
	events.emit('stream:log', { streamId: stream.id, name: stream.name, entry: entry })
}

function resolveItems(stream) {
	const files = []
	const items = stream.items || []
	items.forEach(function (item) {
		let file = null
		if (typeof item === 'string') {
			const video = store.get('videos', item)
			const asset = video ? null : store.get('assets', item)
			file = (video && video.file) || (asset && asset.file) || (fs.existsSync(item) ? item : null)
		} else if (item && item.file) {
			file = item.file
		} else if (item && item.videoId) {
			const video = store.get('videos', item.videoId)
			file = video && video.file
		} else if (item && item.assetId) {
			const asset = store.get('assets', item.assetId)
			file = asset && asset.file
		}
		if (file && fs.existsSync(file)) files.push(file)
	})
	return files
}

function writePlaylist(stream, files) {
	const file = path.join(streamsDir(), 'playlist_' + stream.id + '.txt')
	const body = files
		.map(function (item) {
			const safe = String(item).split('\\').join('/').split("'").join("'\\''")
			return "file '" + safe + "'"
		})
		.join(String.fromCharCode(10))
	fs.writeFileSync(file, body + String.fromCharCode(10))
	return file
}

/**
 * Mode auto: "copy" (hemat CPU) hanya kalau SEMUA video h264, ukurannya sama persis dengan
 * resolusi + rasio yang dipilih, dan audionya seragam. Selain itu wajib "encode" supaya hasil live
 * sesuai pilihan dan tidak putus di pergantian video.
 * Hasil: { mode, reason }.
 */
async function decide(stream, files) {
	const wanted = stream.mode || 'auto'
	if (wanted === 'copy' || wanted === 'encode') return { mode: wanted, reason: 'dipilih manual' }
	try {
		const size = sizeFor(stream)
		let first = null
		for (const file of files.slice(0, 60)) {
			const info = await ff.mediaInfo(file)
			const name = path.basename(file)
			if (info.videoCodec !== 'h264') return { mode: 'encode', reason: name + ' bukan H.264 (' + (info.videoCodec || '?') + ')' }
			if (!first) {
				first = info
				if (info.width !== size[0] || info.height !== size[1]) {
					return { mode: 'encode', reason: 'ukuran video ' + info.width + 'x' + info.height + ' beda dengan target ' + size[0] + 'x' + size[1] }
				}
				continue
			}
			if (info.width !== first.width || info.height !== first.height) return { mode: 'encode', reason: 'ukuran video di playlist tidak seragam (' + name + ')' }
			if (audioModeOf(stream) === 'source' && Boolean(info.hasAudio) !== Boolean(first.hasAudio)) {
				return { mode: 'encode', reason: 'sebagian video tidak punya audio (' + name + ')' }
			}
		}
		return first ? { mode: 'copy', reason: 'semua video sudah sesuai target' } : { mode: 'encode', reason: 'video tidak terbaca' }
	} catch (err) {
		return { mode: 'encode', reason: 'gagal membaca info video' }
	}
}

/** Stream key yang dipakai: key milik stream ini, kalau kosong pakai key default (Settings / YT_STREAM_KEY). */
function keyFor(stream) {
	return String(stream.streamKey || '').trim()
}

function defaultKey() {
	return String((store.settings().stream || {}).streamKey || '').trim()
}

/** URL sudah berisi stream key (rtmp://server/app/KEY)? */
function urlHasKey(url) {
	const pathPart = String(url || '').trim().replace(/\/+$/, '').replace(/^[a-z]+:\/\/[^/]+/i, '').split('?')[0]
	return pathPart.split('/').filter(Boolean).length >= 2
}

function target(stream) {
	const base = String(stream.rtmpUrl || '').trim().replace(/\/+$/, '')
	if (!base) throw userError('RTMP URL belum diisi')
	if (!/^rtmps?:\/\//i.test(base) && !/^srt:\/\//i.test(base)) throw userError('RTMP URL harus diawali rtmp:// atau rtmps://')
	const own = keyFor(stream)
	if (own) return base + '/' + own
	// URL lengkap yang sudah berisi stream key (rtmp://server/app/KEY) atau SRT (key ada di streamid).
	if (urlHasKey(base) || /^srt:\/\//i.test(base)) return base
	const fallback = defaultKey()
	if (fallback) return base + '/' + fallback
	throw userError('Stream key belum diisi (Settings > Live / YT_STREAM_KEY di .env, atau di pengaturan stream)')
}

function buildArgs(stream, playlist, mode) {
	const fps = Number(stream.fps) || 30
	const size = sizeFor(stream)
	const audioMode = audioModeOf(stream)
	const args = ['-hide_banner', '-loglevel', 'error', '-stats', '-re']
	if (stream.loop !== false) args.push('-stream_loop', '-1')
	args.push('-f', 'concat', '-safe', '0', '-i', playlist)

	let musicFile = null
	if (audioMode === 'music') {
		const asset = stream.musicAssetId ? store.get('assets', stream.musicAssetId) : null
		musicFile = (asset && asset.file) || stream.musicFile || null
		if (musicFile && fs.existsSync(musicFile)) args.push('-stream_loop', '-1', '-i', musicFile)
		else musicFile = null
	}
	if (audioMode === 'silent' || (audioMode === 'music' && !musicFile)) {
		args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100')
	}

	const externalAudio = audioMode !== 'source'
	args.push('-map', '0:v:0')
	args.push('-map', externalAudio ? '1:a:0' : '0:a:0?')

	const audioKbps = kbps(stream.audioBitrate, 128) + 'k'
	if (mode === 'copy') {
		args.push('-c:v', 'copy')
		args.push('-c:a', 'aac', '-b:a', audioKbps, '-ar', '44100', '-ac', '2')
	} else {
		const videoKbps = kbps(stream.videoBitrate, 4500)
		const bitrate = videoKbps + 'k'
		args.push(
			'-vf', 'scale=' + size[0] + ':' + size[1] + ':force_original_aspect_ratio=decrease,pad=' + size[0] + ':' + size[1] + ':(ow-iw)/2:(oh-ih)/2,fps=' + fps + ',format=yuv420p',
			'-c:v', 'libx264',
			'-preset', stream.preset || 'veryfast',
			'-tune', 'zerolatency',
			'-b:v', bitrate,
			'-maxrate', bitrate,
			'-bufsize', String(videoKbps * 2) + 'k',
			'-g', String(fps * 2),
			'-keyint_min', String(fps),
			'-sc_threshold', '0',
			'-c:a', 'aac',
			'-b:a', audioKbps,
			'-ar', '44100',
			'-ac', '2',
		)
	}
	const out = target(stream)
	if (/^srt:\/\//i.test(out)) args.push('-f', 'mpegts', out)
	else args.push('-flvflags', 'no_duration_filesize', '-f', 'flv', out)
	return args
}

function parseStats(line) {
	const out = {}
	const frame = /frame=\s*(\d+)/.exec(line)
	const fps = /fps=\s*([\d.]+)/.exec(line)
	const bitrate = /bitrate=\s*([\w./]+)/.exec(line)
	const speed = /speed=\s*([\d.]+)x/.exec(line)
	const time = /time=\s*([\d:.]+)/.exec(line)
	if (frame) out.frame = Number(frame[1])
	if (fps) out.fps = Number(fps[1])
	if (bitrate) out.bitrate = bitrate[1]
	if (speed) out.speed = Number(speed[1])
	if (time) out.time = time[1]
	return Object.keys(out).length ? out : null
}

async function start(id, options) {
	const o = options || {}
	if (shuttingDown) throw userError('Server sedang dimatikan', 503)
	const stream = store.get('streams', id)
	if (!stream) throw userError('Stream tidak ditemukan', 404)
	if (starting.has(id)) throw userError('Stream sedang dinyalakan, tunggu sebentar', 409)
	starting.add(id)
	try {
		const pendingTimer = timers.get(id)
		if (pendingTimer) {
			clearTimeout(pendingTimer)
			timers.delete(id)
		}
		// Pastikan proses lama benar-benar berhenti dulu (hindari 2 ffmpeg kirim ke stream key yang sama).
		if (procs.has(id)) await stopAndWait(id)
		return await launch(id, stream, o)
	} finally {
		starting.delete(id)
	}
}

async function launch(id, stream, o) {
	const files = resolveItems(stream)
	if (!files.length) throw userError('Belum ada video di playlist (file video mungkin sudah dihapus)')
	const playlist = writePlaylist(stream, files)
	const decision = await decide(stream, files)
	const mode = decision.mode
	const args = buildArgs(stream, playlist, mode)
	const restarts = o.restarts || 0
	if ((stream.mode || 'auto') === 'auto' && !restarts) log(stream, 'Mode auto memilih ' + mode + ': ' + decision.reason)

	const proc = spawn(ff.FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
	const self = { proc: proc, startedAt: Date.now(), restarts: restarts, stats: null, stopping: false, failed: false, mode: mode }
	procs.set(id, self)
	store.update('streams', id, {
		status: 'live',
		startedAt: util.nowIso(),
		stoppedAt: null,
		pid: proc.pid,
		modeUsed: mode,
		itemsResolved: files.length,
		restarts: restarts,
		lastError: null,
	})
	log(stream, 'Streaming dimulai (' + mode + ', ' + files.length + ' video)')
	events.emit('stream:started', { streamId: id, name: stream.name, mode: mode, files: files.length })

	proc.stderr.on('data', function (chunk) {
		const text = String(chunk)
		const stats = parseStats(text)
		if (stats) {
			self.stats = stats
			events.emit('stream:stats', { streamId: id, stats: stats })
			return
		}
		const clean = text.trim()
		if (clean && clean.indexOf('frame=') === -1) log(stream, clean.slice(0, 300), 'warn')
	})

	proc.on('error', function (err) {
		// Biasanya ffmpeg tidak ditemukan. Jangan reconnect terus-menerus.
		self.failed = true
		if (procs.get(id) === self) procs.delete(id)
		log(stream, 'Gagal menjalankan ffmpeg: ' + err.message, 'error')
		store.update('streams', id, { status: 'error', pid: null, lastError: 'Gagal menjalankan ffmpeg: ' + err.message })
		events.emit('stream:stopped', { streamId: id, name: stream.name, error: err.message })
	})

	proc.on('close', function (code) {
		if (self.closed) return
		self.closed = true
		const entry = self
		// Proses lama yang sudah diganti proses baru tidak boleh menghapus / me-restart proses baru.
		if (procs.get(id) === self) procs.delete(id)
		if (self.failed) return
		const current = store.get('streams', id)
		if (!current) return
		const uptime = Math.round((Date.now() - entry.startedAt) / 1000)
		store.update('streams', id, { totalUptimeSeconds: (current.totalUptimeSeconds || 0) + uptime, pid: null })
		if (entry.keepStatus) {
			log(current, 'Server dimatikan, live akan lanjut otomatis saat server nyala lagi')
			return
		}
		if (entry.stopping) {
			store.update('streams', id, { status: 'stopped', stoppedAt: util.nowIso() })
			log(current, 'Streaming dihentikan')
			events.emit('stream:stopped', { streamId: id, name: current.name })
			return
		}
		const maxRestarts = current.maxRestarts === undefined ? 0 : Number(current.maxRestarts)
		// Sudah jalan stabil > 10 menit -> hitungan restart direset (putus sesekali tidak dihitung menumpuk).
		const nextRestart = (uptime > 600 ? 0 : entry.restarts) + 1
		if (maxRestarts > 0 && nextRestart > maxRestarts) {
			store.update('streams', id, { status: 'error', stoppedAt: util.nowIso(), lastError: 'Melebihi batas restart (' + maxRestarts + ')' })
			log(current, 'Berhenti: melebihi batas restart', 'error')
			notifyDown(current, 'melebihi batas restart')
			return
		}
		const settings = store.settings().stream || {}
		const backoff = Math.min(Number(settings.restartBackoffMs) || 5000, 60000) * Math.min(nextRestart, 6)
		store.update('streams', id, { status: 'reconnecting', restarts: nextRestart, lastError: 'ffmpeg keluar dengan kode ' + code })
		log(current, 'Koneksi putus (kode ' + code + '), reconnect dalam ' + Math.round(backoff / 1000) + ' detik', 'warn')
		events.emit('stream:reconnecting', { streamId: id, name: current.name, inSeconds: Math.round(backoff / 1000) })
		notifyDown(current, 'reconnect otomatis')
		const timer = setTimeout(function () {
			if (timers.get(id) === timer) timers.delete(id)
			if (shuttingDown) return
			start(id, { restarts: nextRestart }).catch(function (err) {
				store.update('streams', id, { status: 'error', lastError: err.message })
				log(current, 'Restart gagal: ' + err.message, 'error')
			})
		}, backoff)
		timers.set(id, timer)
	})

	return status(id)
}

function notifyDown(stream, reason) {
	const settings = store.settings().notifications || {}
	if (!settings.webhookUrl || settings.onStreamDown === false) return
	try {
		const { request } = require('../lib/httpclient')
		request(settings.webhookUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: { event: 'stream_down', stream: stream.name, reason: reason, at: util.nowIso() },
			timeoutMs: 10000,
			retries: 0,
		}).catch(function () {})
	} catch (err) {}
}

function stillRunning(proc) {
	return proc.exitCode === null && proc.signalCode === null
}

function stop(id, silent, options) {
	const o = options || {}
	const timer = timers.get(id)
	if (timer) {
		clearTimeout(timer)
		timers.delete(id)
	}
	const entry = procs.get(id)
	if (entry) {
		entry.stopping = true
		if (o.keepStatus) entry.keepStatus = true
		try {
			entry.proc.kill('SIGINT')
		} catch (err) {}
		// proc.killed sudah true begitu sinyal terkirim, jadi cek exitCode untuk tahu proses masih hidup.
		setTimeout(function () {
			try {
				if (stillRunning(entry.proc)) entry.proc.kill('SIGKILL')
			} catch (err) {}
		}, 4000)
	} else if (!silent) {
		store.update('streams', id, { status: 'stopped', stoppedAt: util.nowIso(), pid: null })
	}
	return true
}

/** Hentikan proses lalu tunggu sampai benar-benar keluar (maks ~6 detik). */
function stopAndWait(id) {
	const entry = procs.get(id)
	stop(id, true)
	if (!entry || !stillRunning(entry.proc)) return Promise.resolve()
	return new Promise(function (resolve) {
		const done = setTimeout(resolve, 6000)
		entry.proc.once('close', function () {
			clearTimeout(done)
			resolve()
		})
	})
}

/** Tombol Stop: hentikan lalu tunggu proses keluar, supaya status yang dikembalikan sudah "stopped". */
async function stopNow(id) {
	const entry = procs.get(id)
	stop(id)
	if (entry && stillRunning(entry.proc)) {
		await new Promise(function (resolve) {
			const done = setTimeout(resolve, 6000)
			entry.proc.once('close', function () {
				clearTimeout(done)
				resolve()
			})
		})
	}
	return status(id)
}

async function restart(id) {
	await stopAndWait(id)
	return start(id, { restarts: 0 })
}

function status(id) {
	const stream = store.get('streams', id)
	if (!stream) return null
	const entry = procs.get(id)
	return {
		id: id,
		name: stream.name,
		status: stream.status || 'stopped',
		live: Boolean(entry),
		pid: entry ? entry.proc.pid : null,
		mode: stream.modeUsed || stream.mode || 'auto',
		uptimeSeconds: entry ? Math.round((Date.now() - entry.startedAt) / 1000) : 0,
		totalUptimeSeconds: stream.totalUptimeSeconds || 0,
		restarts: stream.restarts || 0,
		stats: entry ? entry.stats : null,
		items: (stream.items || []).length,
		lastError: stream.lastError || null,
	}
}

function statusAll() {
	return store.coll('streams').map(function (stream) {
		return status(stream.id)
	})
}

async function inspect(id) {
	const stream = store.get('streams', id)
	if (!stream) return null
	const files = resolveItems(stream)
	const details = []
	let total = 0
	for (const file of files) {
		let info = {}
		try {
			info = await ff.mediaInfo(file)
		} catch (err) {}
		total += info.duration || 0
		details.push({
			name: path.basename(file),
			duration: info.duration || 0,
			durationText: util.formatDuration(info.duration || 0),
			width: info.width || 0,
			height: info.height || 0,
			fps: info.fps || 0,
			videoCodec: info.videoCodec || '-',
			audioCodec: info.audioCodec || '-',
			size: info.size || 0,
		})
	}
	const bitrateKbps = kbps(stream.videoBitrate, 4500) + kbps(stream.audioBitrate, 128)
	const decision = files.length ? await decide(stream, files) : { mode: stream.mode || 'auto', reason: 'playlist kosong' }
	const readyMode = decision.mode
	const size = sizeFor(stream)
	let keySource = 'belum ada'
	if (keyFor(stream)) keySource = 'key stream ini'
	else if (urlHasKey(stream.rtmpUrl)) keySource = 'ada di RTMP URL'
	else if (defaultKey()) keySource = 'key default (Settings / .env)'
	return {
		modeReason: decision.reason,
		target: size[0] + 'x' + size[1],
		audioMode: audioModeOf(stream),
		keySource: keySource,
		files: details,
		totalDuration: total,
		totalDurationText: util.formatDuration(total),
		loopCountPerDay: total > 0 ? Math.round((86400 / total) * 10) / 10 : 0,
		estimatedGbPerDay: Math.round(((bitrateKbps * 1000 * 86400) / 8 / 1024 / 1024 / 1024) * 10) / 10,
		readyMode: readyMode,
		missing: (stream.items || []).length - files.length,
	}
}

/** Cek kesehatan tiap 30 detik: hidupkan lagi stream yang harusnya live. */
function tick() {
	if (shuttingDown) return
	store.coll('streams').forEach(function (stream) {
		if (stream.status !== 'live') return
		if (procs.has(stream.id) || timers.has(stream.id) || starting.has(stream.id)) return
		log(stream, 'Proses hilang, menyalakan ulang', 'warn')
		start(stream.id, { restarts: (stream.restarts || 0) + 1 }).catch(function (err) {
			store.update('streams', stream.id, { status: 'error', lastError: err.message })
		})
	})
}

function bootstrap() {
	setTimeout(function () {
		store.coll('streams').forEach(function (stream) {
			// Lanjutkan live yang masih jalan saat server mati + stream yang diset auto start.
			const resume = stream.status === 'live' || stream.status === 'reconnecting'
			if (!stream.autoStart && !resume) {
				if (stream.status === 'starting') store.update('streams', stream.id, { status: 'stopped', pid: null })
				return
			}
			start(stream.id, { restarts: 0 }).catch(function (err) {
				store.update('streams', stream.id, { status: 'error', lastError: err.message })
				events.logger.warn('stream', 'Auto start gagal (' + stream.name + '): ' + err.message)
			})
		})
	}, 2000)
	setInterval(tick, 30000)
}

function stopAll() {
	Array.from(procs.keys()).forEach(function (id) {
		stop(id, true)
	})
}

/** Dipakai saat server dimatikan: hentikan ffmpeg tapi status live disimpan supaya dilanjutkan saat start. */
function shutdown() {
	shuttingDown = true
	timers.forEach(function (timer) {
		clearTimeout(timer)
	})
	timers.clear()
	Array.from(procs.keys()).forEach(function (id) {
		stop(id, true, { keepStatus: true })
	})
}

module.exports = {
	start: start,
	stop: stop,
	stopNow: stopNow,
	restart: restart,
	status: status,
	statusAll: statusAll,
	bootstrap: bootstrap,
	stopAll: stopAll,
	shutdown: shutdown,
	tick: tick,
	inspect: inspect,
	resolveItems: resolveItems,
	audioModeOf: audioModeOf,
	urlHasKey: urlHasKey,
}
