'use strict'

/**
 * Adapter Flow Ultra: generate video + generate gambar.
 * lane "low" = LOWER PRIORITY (unlimited di akun Flow Ultra), lane "standard" = prioritas normal.
 * Kalau API belum diisi, otomatis mode simulate (render lokal ffmpeg) supaya flow tetap bisa dites.
 */

const fs = require('fs')
const path = require('path')
const store = require('../lib/store')
const ff = require('../lib/ffmpeg')
const { request, download, saveBase64 } = require('../lib/httpclient')
const { PATHS, dimensionsFor } = require('../lib/config')
const { uid, ensureDir, sleep, dayKey } = require('../lib/util')

function config() {
	return store.settings().flow || {}
}

function isSimulate() {
	const c = config()
	return c.provider !== 'flow' || !c.apiKey || !c.baseUrl
}

function priorityFor(lane) {
	return lane === 'standard' ? 'standard' : 'lower'
}

function headers(lane) {
	return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config().apiKey, 'X-Priority': priorityFor(lane) }
}

function endpoint(suffix) {
	return String(config().baseUrl || '').replace(/\/+$/, '') + suffix
}

function extractUrl(data) {
	if (!data) return null
	if (typeof data === 'string') return data
	return (
		data.url || data.video_url || data.videoUrl || data.image_url || data.output_url ||
		(data.output && (data.output.url || data.output.video_url)) ||
		(data.result && (data.result.url || data.result.video_url)) ||
		(Array.isArray(data.data) && data.data[0] && (data.data[0].url || data.data[0].video_url)) ||
		(Array.isArray(data.outputs) && data.outputs[0] && (data.outputs[0].url || data.outputs[0])) || null
	)
}

function extractBase64(data) {
	if (!data) return null
	return data.b64_json || data.base64 || data.image_base64 || data.video_base64 ||
		(Array.isArray(data.data) && data.data[0] && (data.data[0].b64_json || data.data[0].base64)) || null
}

function jobIdOf(data) {
	if (!data) return null
	return data.id || data.job_id || data.jobId || data.task_id || data.taskId || data.request_id || null
}

function statusOf(data) {
	const raw = String((data && (data.status || data.state || data.job_status)) || '').toLowerCase()
	if (['succeeded', 'success', 'completed', 'complete', 'done', 'finished'].indexOf(raw) !== -1) return 'done'
	if (['failed', 'error', 'canceled', 'cancelled'].indexOf(raw) !== -1) return 'failed'
	if (!raw) return extractUrl(data) || extractBase64(data) ? 'done' : 'pending'
	return 'pending'
}

async function pollJob(jobId, options) {
	const c = config()
	const o = options || {}
	const statusPath = String(c.statusPath || '/v1/jobs/{id}').replace('{id}', encodeURIComponent(jobId))
	const deadline = Date.now() + (Number(c.maxWaitMs) || 900000)
	let delay = Number(c.pollIntervalMs) || 5000
	while (Date.now() < deadline) {
		if (o.isCanceled && o.isCanceled()) throw Object.assign(new Error('Dibatalkan oleh user'), { canceled: true })
		await sleep(delay)
		const res = await request(endpoint(statusPath), { method: 'GET', headers: headers(o.lane), retries: 2 })
		const state = statusOf(res.data)
		if (o.log) o.log('Flow job ' + jobId + ': ' + state)
		if (state === 'done') return res.data
		if (state === 'failed') throw new Error('Flow job gagal: ' + JSON.stringify(res.data).slice(0, 300))
		delay = Math.min(Math.round(delay * 1.15), 20000)
	}
	throw new Error('Timeout menunggu Flow job ' + jobId)
}

async function saveOutput(data, destination) {
	const url = extractUrl(data)
	if (url) {
		await download(url, destination, { headers: { Authorization: 'Bearer ' + config().apiKey } })
		return destination
	}
	const b64 = extractBase64(data)
	if (b64) return saveBase64(b64, destination)
	throw new Error('Respons Flow tidak berisi file yang bisa diunduh')
}

function imageDataUri(file) {
	const ext = path.extname(file).toLowerCase().replace('.', '') || 'jpeg'
	const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
	return 'data:' + mime + ';base64,' + fs.readFileSync(file).toString('base64')
}

const SIM_GRADES = [
	'eq=contrast=1.06:saturation=1.12:brightness=0.02',
	'eq=contrast=1.02:saturation=0.95:brightness=0.04,colorbalance=rm=0.05:bm=-0.03',
	'eq=contrast=1.1:saturation=1.2,vignette=PI/5',
	'eq=contrast=0.98:saturation=1.05:gamma=1.05,colorbalance=rs=-0.05:bs=0.06',
	'eq=contrast=1.08:saturation=1:unsharp=5:5:0.8',
]

/** Generate banyak gambar dari 1 foto produk / prompt. */
async function generateImages(options) {
	const o = options || {}
	const count = Math.max(1, Math.min(Number(o.count) || 1, 12))
	const dims = dimensionsFor(o.aspect || '9:16', o.resolution || '1080')
	const outDir = ensureDir(path.join(PATHS.renders, 'images'))
	const files = []
	store.addUsage(dayKey(new Date(), store.settings().workspace.timezone), { images: count })

	if (isSimulate()) {
		for (let i = 0; i < count; i += 1) {
			const out = path.join(outDir, 'img_' + uid('', 8) + '.jpg')
			if (o.refImage && fs.existsSync(o.refImage)) {
				const grade = SIM_GRADES[i % SIM_GRADES.length]
				const vf =
					i % 2 === 0
						? 'scale=' + dims.width + ':' + dims.height + ':force_original_aspect_ratio=increase,crop=' + dims.width + ':' + dims.height + ',' + grade
						: 'scale=' + dims.width + ':' + dims.height + ':force_original_aspect_ratio=decrease,pad=' + dims.width + ':' + dims.height + ':(ow-iw)/2:(oh-ih)/2:color=0x15161A,' + grade
				await ff.run(['-i', o.refImage, '-vf', vf, '-frames:v', '1', '-q:v', '3', out])
			} else {
				await ff.textCardImage({ out: out, width: dims.width, height: dims.height, title: String(o.title || 'Scene').slice(0, 26), subtitle: String(o.prompt || '').slice(0, 60) })
			}
			files.push({ file: out, prompt: o.prompt, simulated: true })
			if (o.log) o.log('Gambar ' + (i + 1) + '/' + count + ' selesai (simulate)')
		}
		return files
	}

	const c = config()
	const body = {
		model: c.imageModel || 'flow-ultra-image',
		prompt: o.prompt,
		n: count,
		count: count,
		aspect_ratio: o.aspect || '9:16',
		size: dims.width + 'x' + dims.height,
		priority: priorityFor(o.lane),
		mode: priorityFor(o.lane) === 'lower' ? 'lower_priority' : 'standard',
	}
	if (o.refImage && fs.existsSync(o.refImage)) body.image = imageDataUri(o.refImage)
	if (o.negativePrompt) body.negative_prompt = o.negativePrompt
	const res = await request(endpoint(c.imagePath || '/v1/images'), { method: 'POST', headers: headers(o.lane), body: body, timeoutMs: 180000, retries: 1 })
	let data = res.data
	const jid = jobIdOf(data)
	if (jid && statusOf(data) !== 'done') data = await pollJob(jid, o)
	const list = Array.isArray(data.data) ? data.data : Array.isArray(data.images) ? data.images : [data]
	for (const item of list) {
		const out = path.join(outDir, 'img_' + uid('', 8) + '.jpg')
		await saveOutput(item, out)
		files.push({ file: out, prompt: o.prompt, simulated: false })
	}
	return files
}

/** Generate 1 clip video (image-to-video kalau ada foto produk). */
async function generateVideo(options) {
	const o = options || {}
	const dims = dimensionsFor(o.aspect || '9:16', o.resolution || '1080')
	const outDir = ensureDir(path.join(PATHS.renders, 'scenes'))
	const out = o.out || path.join(outDir, 'scene_' + uid('', 8) + '.mp4')
	const duration = Math.max(1.5, Number(o.duration) || 5)
	const lane = o.lane || config().defaultLane || 'low'
	store.addUsage(dayKey(new Date(), store.settings().workspace.timezone), { videos: 1, low: lane === 'low' ? 1 : 0, standard: lane === 'standard' ? 1 : 0 })

	if (isSimulate()) {
		if (o.refImage && fs.existsSync(o.refImage)) {
			await ff.imageToClip({
				image: o.refImage, out: out, duration: duration, width: dims.width, height: dims.height, fps: o.fps || 30,
				motion: o.motion || 'zoomin', fit: o.fit || 'blur', preset: o.preset, crf: o.crf, badge: o.badge, caption: o.caption,
			})
		} else {
			await ff.textCardClip({ out: out, duration: duration, width: dims.width, height: dims.height, fps: o.fps || 30, title: String(o.title || 'Scene').slice(0, 30), subtitle: String(o.prompt || '').slice(0, 70) })
		}
		return { file: out, simulated: true, duration: await ff.durationOf(out), lane: lane }
	}

	const c = config()
	const body = {
		model: c.videoModel || 'flow-ultra-video',
		prompt: o.prompt,
		duration: duration,
		duration_seconds: duration,
		aspect_ratio: o.aspect || '9:16',
		resolution: dims.width + 'x' + dims.height,
		fps: o.fps || 30,
		priority: priorityFor(lane),
		mode: priorityFor(lane) === 'lower' ? 'lower_priority' : 'standard',
		motion: o.motion || undefined,
		negative_prompt: o.negativePrompt || undefined,
	}
	if (o.refImage && fs.existsSync(o.refImage)) body.image = imageDataUri(o.refImage)
	if (o.log) o.log('Kirim job ke Flow (' + priorityFor(lane) + ' priority, ' + duration + 's)')
	try {
		const res = await request(endpoint(c.videoPath || '/v1/videos'), { method: 'POST', headers: headers(lane), body: body, timeoutMs: 240000, retries: 1 })
		let data = res.data
		const jid = jobIdOf(data)
		if (jid && statusOf(data) !== 'done') {
			if (o.log) o.log('Flow job dibuat: ' + jid + ', menunggu render')
			data = await pollJob(jid, Object.assign({}, o, { lane: lane }))
		}
		await saveOutput(Array.isArray(data.data) ? data.data[0] : data, out)
		return { file: out, simulated: false, duration: await ff.durationOf(out), lane: lane, jobId: jid }
	} catch (err) {
		if (lane === 'standard' && c.autoFallbackToLow) {
			if (o.log) o.log('Lane standard gagal (' + err.message + '), fallback ke lower priority')
			return generateVideo(Object.assign({}, o, { lane: 'low' }))
		}
		throw err
	}
}

async function testConnection() {
	if (isSimulate()) {
		return { ok: true, mode: 'simulate', message: 'Mode simulate aktif. Isi Flow Base URL + API Key di Settings untuk memakai akun Flow Ultra.' }
	}
	try {
		const res = await request(endpoint('/v1/models'), { method: 'GET', headers: headers('low'), retries: 0, timeoutMs: 20000 })
		const list = res.data && (res.data.data || res.data.models)
		return { ok: true, mode: 'flow', message: 'Koneksi Flow OK', models: Array.isArray(list) ? list.length : undefined }
	} catch (err) {
		return { ok: false, mode: 'flow', message: err.message }
	}
}

module.exports = { isSimulate: isSimulate, priorityFor: priorityFor, generateImages: generateImages, generateVideo: generateVideo, testConnection: testConnection }
