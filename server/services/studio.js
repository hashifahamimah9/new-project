'use strict'

/** Studio: UGC video, podcast AI, voice over, dan generate gambar. */

const fs = require('fs')
const path = require('path')

const { PATHS, dimensionsFor } = require('../lib/config')
const store = require('../lib/store')
const events = require('../lib/events')
const ff = require('../lib/ffmpeg')
const util = require('../lib/util')
const flow = require('../providers/flow')
const tts = require('../providers/tts')
const llm = require('../providers/llm')

const MP4 = '.mp4'

function storageUrl(file) {
	const rel = path.relative(PATHS.storage, file).split(path.sep).join('/')
	return '/api/files/' + rel
}

function fileSize(file) {
	try {
		return fs.statSync(file).size
	} catch (err) {
		return 0
	}
}

function registerAsset(input) {
	const o = input || {}
	return store.insert(
		'assets',
		{
			name: o.name || path.basename(o.file || 'file'),
			kind: o.kind || util.kindOf(o.file),
			file: o.file,
			url: storageUrl(o.file),
			size: fileSize(o.file),
			source: o.source || 'render',
			tags: o.tags || [],
			meta: o.meta || {},
		},
		'as',
	)
}

function assetFile(assetId) {
	const asset = store.get('assets', assetId)
	if (asset && asset.file && fs.existsSync(asset.file)) return asset.file
	const video = store.get('videos', assetId)
	if (video && video.file && fs.existsSync(video.file)) return video.file
	const audio = store.get('audios', assetId)
	if (audio && audio.file && fs.existsSync(audio.file)) return audio.file
	return null
}

function pickAssets(payload) {
	const ids = Array.isArray(payload.assetIds) ? payload.assetIds : []
	const files = []
	ids.forEach(function (id) {
		const file = assetFile(id)
		if (file) files.push(file)
	})
	if (payload.imageFile && fs.existsSync(payload.imageFile)) files.push(payload.imageFile)
	return files
}

function workDir(prefix, jobId) {
	return util.ensureDir(path.join(PATHS.tmp, prefix + '_' + jobId))
}

function cleanup(dir) {
	try {
		fs.rmSync(dir, { recursive: true, force: true })
	} catch (err) {}
}

function progressFn(ctx, from, span, note) {
	return function (value) {
		const pct = typeof value === 'number' ? value : value && typeof value.percent === 'number' ? value.percent : 0
		ctx.progress(from + Math.round((Math.max(0, Math.min(100, pct)) / 100) * span), note)
	}
}

async function musicBed(mood, duration) {
	if (!mood || mood === 'none') return null
	const seconds = Math.max(60, Math.ceil((Number(duration) || 60) / 30) * 30)
	const out = path.join(util.ensureDir(PATHS.music), 'bed_' + mood + '_' + seconds + 's.mp3')
	if (fs.existsSync(out)) return out
	try {
		await ff.makeMusicBed({ mood: mood, duration: seconds, out: out })
		return out
	} catch (err) {
		return null
	}
}

/** Samakan ukuran, fps, dan durasi clip apa pun. */
async function fitClip(input, out, o) {
	let info = { hasAudio: false, duration: 0 }
	try {
		info = await ff.mediaInfo(input)
	} catch (err) {}
	const offset = (Number(o.offset) || 0) % Math.max(1, info.duration || 10)
	const vf =
		'tpad=stop_mode=clone:stop_duration=4,scale=' +
		o.width +
		':' +
		o.height +
		':force_original_aspect_ratio=increase,crop=' +
		o.width +
		':' +
		o.height +
		',fps=' +
		o.fps +
		',setsar=1,format=yuv420p'
	const args = []
	if (offset > 0) args.push('-ss', String(offset))
	args.push('-i', input)
	if (!info.hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000')
	args.push('-vf', vf, '-map', '0:v:0', '-map', info.hasAudio ? '0:a:0' : '1:a', '-t', String(o.duration))
	await ff.run(args.concat(ff.encodeArgs({ preset: o.preset, crf: o.crf, fps: o.fps }), [out]))
	return out
}

async function padAudio(input, out, duration) {
	await ff.run(['-i', input, '-af', 'apad', '-t', String(duration), '-ar', '48000', '-ac', '2', out])
	return out
}

/* --------------------------------- UGC ----------------------------------- */

async function renderUgc(ctx) {
	const p = ctx.payload || {}
	const settings = store.settings()
	const render = settings.render || {}
	const aspect = p.aspect || render.aspect || '9:16'
	const resolution = String(p.resolution || render.resolution || '1080')
	const fps = Number(p.fps) || Number(render.fps) || 30
	const dims = dimensionsFor(aspect, resolution)
	const preset = p.preset || render.preset || 'veryfast'
	const crf = p.crf === undefined ? (render.crf === undefined ? 21 : render.crf) : p.crf
	const mode = p.mode || 'flow-video'
	const lane = p.lane || (settings.flow || {}).defaultLane || 'low'
	const dir = workDir('work', ctx.jobId)
	const images = pickAssets(p)

	ctx.progress(4, 'Menyiapkan skrip')
	const script = p.script && p.script.scenes && p.script.scenes.length ? p.script : await llm.generateUgcScript(p)
	if (script.warning) ctx.log(script.warning)
	ctx.log('Skrip siap: ' + script.scenes.length + ' scene (sumber: ' + script.source + ')')
	ctx.throwIfCanceled()

	const voice = p.voice || script.voice || 'nadia'
	ctx.progress(10, 'Membuat voice over')
	const voices = await tts.synthesizeMany(
		script.scenes.map(function (scene) {
			return { text: scene.narration, voice: voice }
		}),
		{
			voice: voice,
			naturalPreset: p.naturalPreset || undefined,
			naturalize: true,
			denoise: true,
			room: Number(p.room) || 0,
			outDir: dir,
			onProgress: function (i, total) {
				ctx.progress(10 + Math.round((i / Math.max(1, total)) * 22), 'Voice over ' + (i + 1) + '/' + total)
			},
		},
	)
	ctx.throwIfCanceled()

	const durations = script.scenes.map(function (scene, i) {
		const vo = (voices[i] && voices[i].duration) || 0
		const base = Number(scene.duration) || Number(p.sceneDuration) || 5
		return Math.round(Math.max(base, vo + 0.6) * 10) / 10
	})
	const totalDuration = durations.reduce(function (a, b) {
		return a + b
	}, 0)

	const clips = []
	let simulated = false
	for (let i = 0; i < script.scenes.length; i += 1) {
		ctx.throwIfCanceled()
		const scene = script.scenes[i]
		const duration = durations[i]
		const refImage = images.length ? images[i % images.length] : null
		const clipOut = path.join(dir, 'clip_' + String(i).padStart(2, '0') + MP4)
		ctx.progress(33 + Math.round((i / script.scenes.length) * 38), 'Scene ' + (i + 1) + '/' + script.scenes.length)

		if (mode === 'flow-video') {
			const raw = path.join(dir, 'raw_' + i + MP4)
			const result = await flow.generateVideo({
				prompt: llm.videoPromptFor(scene, p.product, p.style),
				refImage: refImage,
				duration: duration,
				aspect: aspect,
				resolution: resolution,
				fps: fps,
				lane: lane,
				motion: scene.motion,
				fit: p.fit || 'blur',
				out: raw,
				title: scene.onScreenText,
				preset: preset,
				crf: crf,
				log: ctx.log,
			})
			if (result.simulated) simulated = true
			await fitClip(result.file, clipOut, { width: dims.width, height: dims.height, fps: fps, duration: duration, preset: preset, crf: crf })
		} else if (mode === 'flow-image') {
			const generated = await flow.generateImages({
				count: 1,
				prompt: llm.imagePromptFor(scene, p.product, p.style),
				aspect: aspect,
				resolution: resolution,
				refImage: refImage,
				lane: lane,
				title: scene.onScreenText,
				log: ctx.log,
			})
			const image = (generated[0] && generated[0].file) || refImage
			if (generated[0] && generated[0].simulated) simulated = true
			if (image) {
				await ff.imageToClip({
					image: image,
					out: clipOut,
					duration: duration,
					width: dims.width,
					height: dims.height,
					fps: fps,
					motion: scene.motion || 'zoomin',
					fit: p.fit || 'blur',
					preset: preset,
					crf: crf,
				})
			} else {
				await ff.textCardClip({ out: clipOut, duration: duration, width: dims.width, height: dims.height, fps: fps, title: scene.onScreenText, subtitle: scene.visual, preset: preset, crf: crf })
			}
		} else if (refImage && util.kindOf(refImage) === 'image') {
			await ff.imageToClip({
				image: refImage,
				out: clipOut,
				duration: duration,
				width: dims.width,
				height: dims.height,
				fps: fps,
				motion: scene.motion || 'zoomin',
				fit: p.fit || 'blur',
				preset: preset,
				crf: crf,
			})
		} else if (refImage) {
			const startOffset = durations.slice(0, i).reduce(function (a, b) { return a + b }, 0)
			await fitClip(refImage, clipOut, { width: dims.width, height: dims.height, fps: fps, duration: duration, offset: startOffset, preset: preset, crf: crf })
		} else {
			await ff.textCardClip({ out: clipOut, duration: duration, width: dims.width, height: dims.height, fps: fps, title: scene.onScreenText, subtitle: scene.visual, preset: preset, crf: crf })
		}
		clips.push(clipOut)
	}

	ctx.throwIfCanceled()
	ctx.progress(73, 'Menggabung scene')
	const silentVideo = path.join(dir, 'video' + MP4)
	await ff.concatClips({ clips: clips, out: silentVideo, fps: fps, preset: preset, crf: crf, totalDuration: totalDuration })

	ctx.progress(80, 'Menyusun audio')
	const padded = []
	for (let i = 0; i < voices.length; i += 1) {
		const out = path.join(dir, 'vo_' + String(i).padStart(2, '0') + '.wav')
		await padAudio(voices[i].file, out, durations[i])
		padded.push(out)
	}
	const voiceTrack = path.join(dir, 'voice.wav')
	await ff.concatAudio({ inputs: padded, gapSeconds: 0, out: voiceTrack })

	const subtitleStyle = p.subtitleStyle || render.subtitleStyle || 'none'
	const srtFile = path.join(dir, 'subs.srt')
	if (subtitleStyle && subtitleStyle !== 'none') {
		const srtData = util.buildSrtFromSegments(
			script.scenes.map(function (scene, i) {
				return { text: scene.narration, duration: durations[i] }
			}),
			{ gap: 0, maxChars: 34 },
		)
		fs.writeFileSync(srtFile, srtData.srt)
	}

	const music = await musicBed(p.musicMood || p.music, totalDuration)
	const brand = store.brand()
	ctx.progress(86, 'Render final')
	const finalFile = path.join(util.ensureDir(path.join(PATHS.renders, 'final')), 'ugc_' + util.uid('', 8) + MP4)
	await ff.finalMix({
		video: silentVideo,
		voice: voiceTrack,
		music: music,
		srt: subtitleStyle !== 'none' ? srtFile : null,
		subtitleStyle: subtitleStyle,
		watermarkText: p.watermark || (render.watermark ? render.watermarkText || brand.watermarkText : ''),
		musicVolume: p.musicVolume === undefined ? render.musicVolume : p.musicVolume,
		voiceVolume: render.voiceVolume === undefined ? 1.4 : render.voiceVolume,
		fps: fps,
		preset: preset,
		crf: crf,
		out: finalFile,
		totalDuration: totalDuration,
		onProgress: progressFn(ctx, 86, 10, 'Render final'),
	})

	ctx.progress(97, 'Menyimpan')
	const thumbFile = path.join(util.ensureDir(PATHS.thumbs), 'thumb_' + util.uid('', 8) + '.jpg')
	try {
		await ff.extractThumb({ video: finalFile, out: thumbFile, at: Math.max(0.5, Math.min(2, totalDuration / 3)) })
	} catch (err) {}
	let info = {}
	try {
		info = await ff.mediaInfo(finalFile)
	} catch (err) {}
	const caption = llm.captionFor(script, p.extraCaption)
	const scriptDoc = store.insert(
		'scripts',
		{
			title: script.title,
			product: p.product || '',
			angle: script.angle,
			persona: script.persona,
			source: script.source,
			hook: script.hook,
			scenes: script.scenes,
			caption: caption.caption,
			hashtags: caption.hashtags,
			jobId: ctx.jobId,
		},
		'scr',
	)
	const video = store.insert(
		'videos',
		{
			title: script.title || p.product || 'Video UGC',
			type: 'ugc',
			file: finalFile,
			url: storageUrl(finalFile),
			thumbFile: fs.existsSync(thumbFile) ? thumbFile : null,
			thumbUrl: fs.existsSync(thumbFile) ? storageUrl(thumbFile) : null,
			duration: info.duration || totalDuration,
			size: fileSize(finalFile),
			width: info.width || dims.width,
			height: info.height || dims.height,
			aspect: aspect,
			caption: caption.caption,
			hashtags: caption.hashtags,
			voice: voice,
			lane: lane,
			mode: mode,
			simulated: simulated,
			scriptId: scriptDoc.id,
			jobId: ctx.jobId,
		},
		'vid',
	)
	registerAsset({ file: finalFile, kind: 'video', name: util.safeFileName((script.title || 'ugc') + MP4), source: 'ugc', meta: { videoId: video.id } })
	store.addUsage(util.dayKey(new Date(), (store.settings().workspace || {}).timezone), { renderSeconds: Math.round(info.duration || totalDuration) })
	cleanup(dir)
	events.emit('library:updated', { type: 'video', id: video.id })
	ctx.progress(100, 'Selesai')
	return { videoId: video.id, url: video.url, title: video.title, duration: video.duration, thumbUrl: video.thumbUrl, caption: caption.caption, hashtags: caption.hashtags, scriptId: scriptDoc.id, simulated: simulated }
}

/* ------------------------------- PODCAST --------------------------------- */

async function renderPodcast(ctx) {
	const p = ctx.payload || {}
	const settings = store.settings()
	const render = settings.render || {}
	const aspect = p.aspect || '16:9'
	const resolution = String(p.resolution || render.resolution || '1080')
	const dims = dimensionsFor(aspect, resolution)
	const fps = Number(p.fps) || 25
	const preset = p.preset || render.preset || 'veryfast'
	const crf = p.crf === undefined ? 23 : p.crf
	const gap = p.gap === undefined ? 0.35 : Number(p.gap)
	const dir = workDir('pod', ctx.jobId)

	ctx.progress(5, 'Menyiapkan skrip')
	const script = p.script && p.script.segments && p.script.segments.length ? p.script : await llm.generatePodcastScript(p)
	if (script.warning) ctx.log(script.warning)
	ctx.log('Skrip podcast: ' + script.segments.length + ' dialog (sumber: ' + script.source + ')')
	ctx.throwIfCanceled()

	ctx.progress(12, 'Merekam suara host')
	const voices = await tts.synthesizeMany(
		script.segments.map(function (segment) {
			return { text: segment.text, voice: segment.voice || 'host-a' }
		}),
		{
			naturalPreset: p.naturalPreset || 'podcast-warm',
			naturalize: true,
			denoise: true,
			room: p.room === undefined ? 0.1 : Number(p.room),
			outDir: dir,
			onProgress: function (i, total) {
				ctx.progress(12 + Math.round((i / Math.max(1, total)) * 45), 'Dialog ' + (i + 1) + '/' + total)
			},
		},
	)
	ctx.throwIfCanceled()

	ctx.progress(60, 'Menggabung audio')
	const audioFile = path.join(util.ensureDir(PATHS.audio), 'podcast_' + util.uid('', 8) + '.wav')
	await ff.concatAudio({
		inputs: voices.map(function (v) {
			return v.file
		}),
		gapSeconds: gap,
		out: audioFile,
	})
	const totalDuration = await ff.durationOf(audioFile)

	const subtitleStyle = p.subtitle === false ? 'none' : p.subtitleStyle || 'minimal'
	const srtFile = path.join(dir, 'subs.srt')
	if (subtitleStyle !== 'none') {
		const srtData = util.buildSrtFromSegments(
			script.segments.map(function (segment, i) {
				return { text: (segment.speaker ? segment.speaker + ': ' : '') + segment.text, duration: (voices[i] && voices[i].duration) || 2 }
			}),
			{ gap: gap, maxChars: 42 },
		)
		fs.writeFileSync(srtFile, srtData.srt)
	}

	ctx.progress(66, 'Membuat visual')
	const cover = p.coverAssetId ? assetFile(p.coverAssetId) : null
	const brand = store.brand()
	const waveFile = path.join(dir, 'wave' + MP4)
	await ff.waveformVideo({
		audio: audioFile,
		out: waveFile,
		width: dims.width,
		height: dims.height,
		fps: fps,
		duration: totalDuration,
		title: script.title || p.topic || 'Podcast AI',
		subtitle: (script.description || '').slice(0, 70),
		style: p.style || 'wave',
		cover: cover,
		waveColor: (brand.primaryColor || '#5E9FE8').replace('#', '0x'),
		preset: preset,
		crf: crf,
		onProgress: progressFn(ctx, 66, 18, 'Membuat visual'),
	})

	ctx.progress(86, 'Render final')
	const music = await musicBed(p.musicMood || p.music, totalDuration)
	const finalFile = path.join(util.ensureDir(path.join(PATHS.renders, 'final')), 'podcast_' + util.uid('', 8) + MP4)
	await ff.finalMix({
		video: waveFile,
		voice: audioFile,
		music: music,
		srt: subtitleStyle !== 'none' ? srtFile : null,
		subtitleStyle: subtitleStyle,
		watermarkText: p.watermark || brand.watermarkText || '',
		musicVolume: p.musicVolume === undefined ? 0.07 : p.musicVolume,
		voiceVolume: 1,
		fps: fps,
		preset: preset,
		crf: crf,
		out: finalFile,
		totalDuration: totalDuration,
		onProgress: progressFn(ctx, 86, 8, 'Render final'),
	})

	ctx.progress(95, 'Export MP3')
	const mp3File = path.join(util.ensureDir(PATHS.audio), 'podcast_' + util.uid('', 8) + '.mp3')
	try {
		await ff.toMp3({ input: audioFile, out: mp3File, bitrate: '192k' })
	} catch (err) {
		ctx.log('Export MP3 gagal: ' + err.message)
	}
	const thumbFile = path.join(util.ensureDir(PATHS.thumbs), 'thumb_' + util.uid('', 8) + '.jpg')
	try {
		await ff.extractThumb({ video: finalFile, out: thumbFile, at: Math.min(3, totalDuration / 2) })
	} catch (err) {}

	const podcast = store.insert(
		'podcasts',
		{
			title: script.title || p.topic || 'Podcast AI',
			topic: p.topic || '',
			description: script.description || '',
			outline: script.outline || [],
			segments: script.segments,
			duration: totalDuration,
			source: script.source,
			jobId: ctx.jobId,
		},
		'pod',
	)
	const video = store.insert(
		'videos',
		{
			title: script.title || p.topic || 'Podcast AI',
			type: 'podcast',
			file: finalFile,
			url: storageUrl(finalFile),
			thumbFile: fs.existsSync(thumbFile) ? thumbFile : null,
			thumbUrl: fs.existsSync(thumbFile) ? storageUrl(thumbFile) : null,
			duration: totalDuration,
			size: fileSize(finalFile),
			width: dims.width,
			height: dims.height,
			aspect: aspect,
			caption: script.description || '',
			podcastId: podcast.id,
			jobId: ctx.jobId,
		},
		'vid',
	)
	const audioDoc = store.insert(
		'audios',
		{
			title: (script.title || 'Podcast') + ' (audio)',
			type: 'podcast',
			file: fs.existsSync(mp3File) ? mp3File : audioFile,
			url: storageUrl(fs.existsSync(mp3File) ? mp3File : audioFile),
			duration: totalDuration,
			podcastId: podcast.id,
			jobId: ctx.jobId,
		},
		'aud',
	)
	registerAsset({ file: finalFile, kind: 'video', name: util.safeFileName((script.title || 'podcast') + MP4), source: 'podcast', meta: { videoId: video.id } })
	store.addUsage(util.dayKey(new Date(), (store.settings().workspace || {}).timezone), { renderSeconds: Math.round(totalDuration) })
	cleanup(dir)
	events.emit('library:updated', { type: 'video', id: video.id })
	ctx.progress(100, 'Selesai')
	return { videoId: video.id, url: video.url, audioId: audioDoc.id, audioUrl: audioDoc.url, podcastId: podcast.id, duration: totalDuration, title: video.title }
}

/* -------------------------------- VOICE ---------------------------------- */

async function renderVoice(ctx) {
	const p = ctx.payload || {}
	const dir = workDir('voice', ctx.jobId)
	let result = null
	let title = ''

	if (p.mode === 'transform') {
		const input = p.file && fs.existsSync(p.file) ? p.file : assetFile(p.assetId)
		if (!input) throw new Error('File audio/video tidak ditemukan')
		ctx.progress(20, 'Memproses suara')
		result = await tts.transformUpload({
			input: input,
			preset: p.naturalPreset || 'podcast-warm',
			pitch: Number(p.pitch) || 0,
			speed: Number(p.speed) || 1,
			room: Number(p.room) || 0,
			denoise: p.denoise !== false,
		})
		title = 'Natural: ' + path.basename(input)
	} else {
		const text = String(p.text || '').trim()
		if (!text) throw new Error('Teks kosong')
		ctx.progress(15, 'Membuat suara')
		const chunks = text.length > 1200 ? util.chunkText(text, 900) : [text]
		if (chunks.length === 1) {
			result = await tts.synthesize({
				text: chunks[0],
				voice: p.voice || 'nadia',
				naturalPreset: p.naturalPreset,
				naturalize: true,
				pitch: p.pitch === undefined ? undefined : Number(p.pitch),
				speed: Number(p.speed) || undefined,
				room: Number(p.room) || 0,
				denoise: p.denoise !== false,
			})
		} else {
			const parts = await tts.synthesizeMany(
				chunks.map(function (chunk) {
					return { text: chunk, voice: p.voice || 'nadia' }
				}),
				{
					voice: p.voice || 'nadia',
					naturalPreset: p.naturalPreset,
					naturalize: true,
					denoise: p.denoise !== false,
					room: Number(p.room) || 0,
					outDir: dir,
					onProgress: function (i, total) {
						ctx.progress(15 + Math.round((i / Math.max(1, total)) * 60), 'Bagian ' + (i + 1) + '/' + total)
					},
				},
			)
			const joined = path.join(util.ensureDir(PATHS.audio), 'voice_' + util.uid('', 8) + '.wav')
			await ff.concatAudio({
				inputs: parts.map(function (part) {
					return part.file
				}),
				gapSeconds: 0.25,
				out: joined,
			})
			result = { file: joined, duration: await ff.durationOf(joined) }
		}
		title = 'Voice over: ' + text.slice(0, 40)
	}

	let finalFile = result.file
	if (p.mp3 !== false) {
		ctx.progress(88, 'Export MP3')
		const mp3 = path.join(util.ensureDir(PATHS.audio), 'voice_' + util.uid('', 8) + '.mp3')
		try {
			await ff.toMp3({ input: result.file, out: mp3, bitrate: '192k' })
			finalFile = mp3
		} catch (err) {
			ctx.log('Export MP3 gagal: ' + err.message)
		}
	}

	const audio = store.insert(
		'audios',
		{
			title: title,
			type: p.mode === 'transform' ? 'natural' : 'tts',
			file: finalFile,
			url: storageUrl(finalFile),
			duration: result.duration || (await ff.durationOf(finalFile)),
			voice: p.voice || '',
			preset: p.naturalPreset || '',
			text: p.text || '',
			jobId: ctx.jobId,
		},
		'aud',
	)
	registerAsset({ file: finalFile, kind: 'audio', name: util.safeFileName(title + path.extname(finalFile)), source: 'voice', meta: { audioId: audio.id } })
	cleanup(dir)
	ctx.progress(100, 'Selesai')
	return { audioId: audio.id, url: audio.url, duration: audio.duration, title: title }
}

/* ------------------------------- IMAGES ---------------------------------- */

async function generateImagePack(ctx) {
	const p = ctx.payload || {}
	const refs = pickAssets(p)
	const count = Math.max(1, Math.min(Number(p.count) || 4, 12))
	ctx.progress(10, 'Generate gambar')
	const files = await flow.generateImages({
		count: count,
		prompt: p.prompt || p.title || 'foto produk gaya UGC',
		aspect: p.aspect || '9:16',
		resolution: p.resolution || '1080',
		refImage: refs[0] || null,
		lane: p.lane || 'low',
		title: p.title || p.prompt,
		negativePrompt: p.negativePrompt,
		log: ctx.log,
	})
	ctx.progress(75, 'Menyimpan aset')
	const assets = files.map(function (item, i) {
		const asset = registerAsset({ file: item.file, kind: 'image', name: util.safeFileName((p.title || 'flow-image') + '-' + (i + 1) + '.jpg'), source: 'flow', meta: { prompt: item.prompt, simulated: item.simulated } })
		events.emit('asset:created', { assetId: asset.id, name: asset.name, kind: 'image' })
		return { id: asset.id, url: asset.url, name: asset.name }
	})
	ctx.progress(100, 'Selesai')
	return { count: assets.length, assets: assets }
}

module.exports = {
	renderUgc: renderUgc,
	renderPodcast: renderPodcast,
	renderVoice: renderVoice,
	generateImagePack: generateImagePack,
	registerAsset: registerAsset,
	assetFile: assetFile,
	storageUrl: storageUrl,
}
