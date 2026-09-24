'use strict'

/** Media engine: semua render video/audio dilakukan lokal dengan ffmpeg (tanpa dependency npm). */

const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const { PATHS } = require('./config')
const { ensureDir, uid, findFont, escapeDrawText, clamp } = require('./util')
const jobctx = require('./jobctx')

function findBinary(name) {
	const envKey = name.toUpperCase() + '_PATH'
	if (process.env[envKey] && fs.existsSync(process.env[envKey])) return process.env[envKey]
	const candidates = [
		path.join(PATHS.root, 'tools', 'ffmpeg', 'bin', name + '.exe'),
		path.join(PATHS.root, 'tools', 'ffmpeg', name + '.exe'),
		path.join(PATHS.root, 'tools', name + '.exe'),
		path.join(PATHS.root, 'tools', name, 'bin', name + '.exe'),
		path.join(PATHS.root, 'tools', name, name + '.exe'),
	]
	const ffmpegBase = path.join(PATHS.root, 'tools', 'ffmpeg')
	if (fs.existsSync(ffmpegBase)) {
		try {
			const subdirs = fs.readdirSync(ffmpegBase)
			for (const sub of subdirs) {
				candidates.push(path.join(ffmpegBase, sub, 'bin', name + '.exe'))
				candidates.push(path.join(ffmpegBase, sub, name + '.exe'))
			}
		} catch (e) {}
	}
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) return candidate
	}
	// Tidak ada file lokal: pakai yang ada di PATH sistem.
	return name
}

const FFMPEG = findBinary('ffmpeg')
const FFPROBE = findBinary('ffprobe')
const NL = String.fromCharCode(10)
const SQ = String.fromCharCode(39)

function tmpFile(ext, prefix) {
	ensureDir(PATHS.tmp)
	return path.join(PATHS.tmp, (prefix || 'tmp') + '_' + uid('', 8) + '.' + ext)
}

function run(args, options) {
	const opts = options || {}
	const base = ['-hide_banner', '-nostdin', '-y']
	const full = opts.onProgress ? base.concat(['-progress', 'pipe:1', '-loglevel', 'error'], args) : base.concat(args)
	if (jobctx.isCanceled()) return Promise.reject(jobctx.canceledError())
	return new Promise(function (resolve, reject) {
		const child = spawn(FFMPEG, full, { cwd: opts.cwd || ensureDir(PATHS.tmp), windowsHide: true })
		jobctx.track(child)
		let stderr = ''
		let killer = null
		if (opts.timeoutMs) {
			killer = setTimeout(function () {
				try {
					child.kill('SIGKILL')
				} catch (e) {}
			}, opts.timeoutMs)
		}
		child.stdout.on('data', function (chunk) {
			if (!opts.onProgress) return
			const text = chunk.toString()
			const match = /out_time_ms=(\d+)/.exec(text)
			if (match && opts.totalDuration) {
				const seconds = Number(match[1]) / 1000000
				opts.onProgress(clamp((seconds / opts.totalDuration) * 100, 0, 100))
			}
		})
		child.stderr.on('data', function (chunk) {
			stderr += chunk.toString()
			if (stderr.length > 12000) stderr = stderr.slice(-12000)
		})
		child.on('error', function (err) {
			if (killer) clearTimeout(killer)
			reject(new Error('ffmpeg tidak bisa dijalankan: ' + err.message))
		})
		child.on('close', function (code) {
			if (killer) clearTimeout(killer)
			if (code === 0) return resolve({ ok: true, stderr: stderr })
			if (jobctx.isCanceled()) return reject(jobctx.canceledError())
			reject(new Error('ffmpeg exit ' + code + ': ' + stderr.slice(-800)))
		})
	})
}

/** Baris pertama `ffmpeg -version`, mis. "ffmpeg version 7.1 ...". */
function version() {
	return new Promise(function (resolve, reject) {
		let out = ''
		let child = null
		try {
			child = spawn(FFMPEG, ['-hide_banner', '-version'], { windowsHide: true })
		} catch (err) {
			return reject(new Error('ffmpeg tidak bisa dijalankan: ' + err.message))
		}
		child.stdout.on('data', function (chunk) {
			out += chunk.toString()
		})
		child.on('error', function (err) {
			reject(new Error('ffmpeg tidak ditemukan (' + FFMPEG + '): ' + err.message))
		})
		child.on('close', function (code) {
			if (code !== 0) return reject(new Error('ffmpeg -version keluar dengan kode ' + code))
			resolve(out.split(/\r?\n/)[0].trim())
		})
	})
}

function probe(file) {
	return new Promise(function (resolve, reject) {
		const child = spawn(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { windowsHide: true })
		let out = ''
		let err = ''
		child.stdout.on('data', function (c) {
			out += c.toString()
		})
		child.stderr.on('data', function (c) {
			err += c.toString()
		})
		child.on('error', reject)
		child.on('close', function (code) {
			if (code !== 0) return reject(new Error('ffprobe gagal: ' + err.slice(-300)))
			try {
				resolve(JSON.parse(out))
			} catch (e) {
				reject(new Error('ffprobe output tidak valid'))
			}
		})
	})
}

async function mediaInfo(file) {
	const data = await probe(file)
	const streams = data.streams || []
	const video = streams.find(function (s) {
		return s.codec_type === 'video'
	})
	const audio = streams.find(function (s) {
		return s.codec_type === 'audio'
	})
	const fpsRaw = video && video.r_frame_rate ? video.r_frame_rate.split('/') : null
	return {
		duration: Number(data.format && data.format.duration) || 0,
		size: Number(data.format && data.format.size) || 0,
		bitrate: Number(data.format && data.format.bit_rate) || 0,
		width: video ? video.width : 0,
		height: video ? video.height : 0,
		fps: fpsRaw && Number(fpsRaw[1]) ? Math.round((Number(fpsRaw[0]) / Number(fpsRaw[1])) * 100) / 100 : 0,
		videoCodec: video ? video.codec_name : null,
		audioCodec: audio ? audio.codec_name : null,
		hasVideo: Boolean(video),
		hasAudio: Boolean(audio),
	}
}

async function durationOf(file) {
	try {
		const info = await mediaInfo(file)
		return info.duration
	} catch (err) {
		return 0
	}
}

function encodeArgs(options) {
	const o = options || {}
	const fps = Number(o.fps) || 30
	return [
		'-c:v', 'libx264',
		'-preset', o.preset || 'veryfast',
		'-crf', String(o.crf === undefined ? 21 : o.crf),
		'-pix_fmt', 'yuv420p',
		'-r', String(fps),
		'-g', String(Math.round(fps * 2)),
		'-movflags', '+faststart',
		'-c:a', 'aac',
		'-b:a', '160k',
		'-ar', '48000',
		'-ac', '2',
	]
}

function motionFilter(motion, width, height, duration, fps) {
	const frames = Math.max(2, Math.round(duration * fps))
	const center = "x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
	const presets = {
		zoomin: "zoompan=z='min(zoom+0.0014,1.25)':" + center,
		zoomout: "zoompan=z='if(lte(on,1),1.25,max(1.001,zoom-0.0014))':" + center,
		panright: "zoompan=z=1.16:x='(iw-iw/zoom)*(on/" + frames + ")':y='ih/2-(ih/zoom/2)'",
		panleft: "zoompan=z=1.16:x='(iw-iw/zoom)*(1-on/" + frames + ")':y='ih/2-(ih/zoom/2)'",
		panup: "zoompan=z=1.16:x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*(1-on/" + frames + ")'",
		pandown: "zoompan=z=1.16:x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*(on/" + frames + ")'",
		still: 'zoompan=z=1:' + center,
	}
	const chosen = presets[motion] || presets.zoomin
	return chosen + ':d=' + frames + ':s=' + width + 'x' + height + ':fps=' + fps
}

function formatFontPath(font) {
	if (!font) return ''
	const normalized = String(font).split('\\').join('/')
	return normalized.replace(/^([a-zA-Z]):/, '$1\\:')
}

function drawText(label, out, text, options) {
	const o = options || {}
	const font = findFont()
	if (!font || !text) return null
	const parts = [
		'drawtext=fontfile=' + SQ + formatFontPath(font) + SQ,
		'text=' + SQ + escapeDrawText(text) + SQ,
		// expansion=none: teks seperti "diskon 50%" tampil apa adanya (bukan dianggap ekspresi)
		'expansion=none',
		'fontcolor=' + (o.color || 'white'),
		'fontsize=' + (o.size || 48),
		'x=' + (o.x || '(w-text_w)/2'),
		'y=' + (o.y || '(h-text_h)/2'),
	]
	if (o.box) parts.push('box=1', 'boxcolor=' + (o.boxColor || 'black@0.55'), 'boxborderw=' + (o.boxPad || 18))
	if (o.borderw) parts.push('borderw=' + o.borderw, 'bordercolor=' + (o.borderColor || 'black@0.8'))
	if (o.shadow) parts.push('shadowx=2', 'shadowy=2', 'shadowcolor=black@0.6')
	return '[' + label + ']' + parts.join(':') + '[' + out + ']'
}

/** Foto produk -> clip video bergerak (Ken Burns) + audio senyap. */
async function imageToClip(options) {
	const o = options || {}
	const width = o.width || 1080
	const height = o.height || 1920
	const fps = o.fps || 30
	const duration = Math.max(1, Number(o.duration) || 5)
	// Gambar diperbesar dulu supaya zoom/pan halus. Untuk 4K cukup 1.5x (hemat RAM & waktu).
	const factor = width * height > 2500000 ? 1.5 : 2
	const even = function (n) {
		return Math.round(n / 2) * 2
	}
	const big = { w: even(width * factor), h: even(height * factor) }
	const chain = []
	if (o.fit === 'crop') {
		chain.push('[0:v]scale=' + big.w + ':' + big.h + ':force_original_aspect_ratio=increase,crop=' + big.w + ':' + big.h + '[base]')
	} else {
		chain.push(
			'[0:v]scale=' + big.w + ':' + big.h + ':force_original_aspect_ratio=increase,crop=' + big.w + ':' + big.h + ',gblur=sigma=34,eq=brightness=-0.04[bg]',
		)
		chain.push('[0:v]scale=' + big.w + ':' + big.h + ':force_original_aspect_ratio=decrease[fg]')
		chain.push('[bg][fg]overlay=(W-w)/2:(H-h)/2[base]')
	}
	let label = 'base'
	chain.push('[' + label + ']' + motionFilter(o.motion || 'zoomin', width, height, duration, fps) + ',setsar=1[mv]')
	label = 'mv'
	if (o.grain !== false) {
		chain.push('[' + label + ']noise=alls=5:allf=t+u,eq=contrast=1.04:saturation=1.06[gr]')
		label = 'gr'
	}
	if (o.badge) {
		const badge = drawText(label, 'bd', o.badge, {
			size: Math.round(height * 0.026),
			box: true,
			boxColor: 'black@0.5',
			x: Math.round(width * 0.06),
			y: Math.round(height * 0.07),
		})
		if (badge) {
			chain.push(badge)
			label = 'bd'
		}
	}
	if (o.caption) {
		const caption = drawText(label, 'cp', o.caption, {
			size: Math.round(height * 0.03),
			box: true,
			boxColor: 'black@0.45',
			y: 'h-text_h-' + Math.round(height * 0.14),
		})
		if (caption) {
			chain.push(caption)
			label = 'cp'
		}
	}
	chain.push('[' + label + ']format=yuv420p[vout]')
	const args = [
		'-loop', '1', '-t', String(duration), '-i', o.image,
		'-f', 'lavfi', '-t', String(duration), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
		'-filter_complex', chain.join(';'),
		'-map', '[vout]', '-map', '1:a', '-t', String(duration),
	]
	await run(args.concat(encodeArgs({ preset: o.preset, crf: o.crf, fps: fps }), [o.out]))
	return o.out
}

/** Kartu teks (hook / cover / outro). */
async function textCardClip(options) {
	const o = options || {}
	const width = o.width || 1080
	const height = o.height || 1920
	const fps = o.fps || 30
	const duration = Math.max(1, Number(o.duration) || 3)
	const chain = ['[0:v]format=yuv420p[base]']
	let label = 'base'
	const title = drawText(label, 't1', o.title, {
		size: Math.round(height * 0.052),
		borderw: 3,
		y: Math.round(height * 0.42),
		shadow: true,
	})
	if (title) {
		chain.push(title)
		label = 't1'
	}
	const subtitle = drawText(label, 't2', o.subtitle, {
		size: Math.round(height * 0.026),
		color: '0xC9CDD4',
		y: Math.round(height * 0.5),
	})
	if (subtitle) {
		chain.push(subtitle)
		label = 't2'
	}
	chain.push('[' + label + ']format=yuv420p[vout]')
	const args = [
		'-f', 'lavfi', '-i', 'color=c=' + (o.bg || '0x15161A') + ':s=' + width + 'x' + height + ':r=' + fps + ':d=' + duration,
		'-f', 'lavfi', '-t', String(duration), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
		'-filter_complex', chain.join(';'),
		'-map', '[vout]', '-map', '1:a', '-t', String(duration),
	]
	await run(args.concat(encodeArgs({ preset: o.preset, crf: o.crf, fps: fps }), [o.out]))
	return o.out
}

async function textCardImage(options) {
	const o = options || {}
	const width = o.width || 1080
	const height = o.height || 1920
	const chain = ['[0:v]format=yuv420p[base]']
	let label = 'base'
	const title = drawText(label, 't1', o.title, { size: Math.round(height * 0.05), borderw: 3, y: Math.round(height * 0.44) })
	if (title) {
		chain.push(title)
		label = 't1'
	}
	const subtitle = drawText(label, 't2', o.subtitle, { size: Math.round(height * 0.024), color: '0xC9CDD4', y: Math.round(height * 0.52) })
	if (subtitle) {
		chain.push(subtitle)
		label = 't2'
	}
	chain.push('[' + label + ']format=yuv420p[vout]')
	await run([
		'-f', 'lavfi', '-i', 'color=c=' + (o.bg || '0x15161A') + ':s=' + width + 'x' + height,
		'-filter_complex', chain.join(';'), '-map', '[vout]', '-frames:v', '1', '-q:v', '3', o.out,
	])
	return o.out
}

/** Samakan ukuran/fps clip apa pun supaya aman digabung. */
async function normalizeClip(options) {
	const o = options || {}
	const width = o.width
	const height = o.height
	const fps = o.fps || 30
	let info = { hasAudio: false }
	try {
		info = await mediaInfo(o.input)
	} catch (err) {}
	const filter =
		o.fit === 'crop'
			? '[0:v]scale=' + width + ':' + height + ':force_original_aspect_ratio=increase,crop=' + width + ':' + height + ',fps=' + fps + ',setsar=1,format=yuv420p[vout]'
			: '[0:v]scale=' + width + ':' + height + ':force_original_aspect_ratio=increase,crop=' + width + ':' + height + ',gblur=sigma=28[bg];' +
				'[0:v]scale=' + width + ':' + height + ':force_original_aspect_ratio=decrease[fg];' +
				'[bg][fg]overlay=(W-w)/2:(H-h)/2,fps=' + fps + ',setsar=1,format=yuv420p[vout]'
	const args = ['-i', o.input]
	if (!info.hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000')
	args.push('-filter_complex', filter, '-map', '[vout]', '-map', info.hasAudio ? '0:a:0' : '1:a', '-shortest')
	await run(args.concat(encodeArgs({ preset: o.preset, crf: o.crf, fps: fps }), [o.out]))
	return o.out
}

async function concatClips(options) {
	const o = options || {}
	const clips = o.clips || []
	if (!clips.length) throw new Error('Tidak ada clip untuk digabung')
	if (clips.length === 1) {
		fs.copyFileSync(clips[0], o.out)
		return o.out
	}
	const dir = ensureDir(path.join(PATHS.tmp, 'concat_' + uid('', 6)))
	try {
		const names = []
		clips.forEach(function (clip, i) {
			const name = 'part' + String(i).padStart(3, '0') + (path.extname(clip) || '.mp4')
			const target = path.join(dir, name)
			// Hardlink lebih hemat disk daripada copy (fallback ke copy kalau beda drive).
			try {
				fs.linkSync(clip, target)
			} catch (err) {
				fs.copyFileSync(clip, target)
			}
			names.push(name)
		})
		fs.writeFileSync(
			path.join(dir, 'list.txt'),
			names
				.map(function (n) {
					return 'file ' + SQ + n + SQ
				})
				.join(NL),
		)
		await run(['-f', 'concat', '-safe', '0', '-i', 'list.txt'].concat(encodeArgs({ preset: o.preset, crf: o.crf, fps: o.fps || 30 }), [o.out]), {
			cwd: dir,
			onProgress: o.onProgress,
			totalDuration: o.totalDuration,
		})
	} finally {
		try {
			fs.rmSync(dir, { recursive: true, force: true })
		} catch (err) {}
	}
	return o.out
}

const SUB_STYLES = function (width, height) {
	const size = Math.round(height * 0.026)
	const marginV = Math.round(height * 0.08)
	// PlayResX & PlayResY harus sama dengan ukuran video, kalau tidak huruf subtitle jadi gepeng/melebar.
	const res = 'PlayResX=' + width + ',PlayResY=' + height + ',WrapStyle=0,MarginL=' + Math.round(width * 0.07) + ',MarginR=' + Math.round(width * 0.07)
	return {
		'bold-center': res + ',FontName=Arial,FontSize=' + size + ',Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=3,Shadow=1,Alignment=2,MarginV=' + marginV,
		'karaoke-box': res + ',FontName=Arial,FontSize=' + size + ',Bold=1,PrimaryColour=&H00FFFFFF,BackColour=&HB0000000,BorderStyle=3,Outline=0,Shadow=0,Alignment=2,MarginV=' + marginV,
		minimal: res + ',FontName=Arial,FontSize=' + Math.round(height * 0.022) + ',PrimaryColour=&H00FFFFFF,OutlineColour=&H80000000,BorderStyle=1,Outline=2,Alignment=2,MarginV=' + marginV,
		yellow: res + ',FontName=Arial,FontSize=' + size + ',Bold=1,PrimaryColour=&H0000E5FF,OutlineColour=&H00000000,BorderStyle=1,Outline=3,Alignment=2,MarginV=' + marginV,
		none: null,
	}
}

/** Mix akhir: voice over + musik loop + subtitle burn-in + watermark. */
async function finalMix(options) {
	const o = options || {}
	let width = Number(o.width) || 0
	let height = Number(o.height) || 0
	if (!width || !height) {
		try {
			const info = await mediaInfo(o.video)
			width = width || info.width
			height = height || info.height
		} catch (err) {}
	}
	height = height || 1920
	width = width || Math.round((height * 9) / 16)
	const fps = o.fps || 30
	const inputs = ['-i', o.video]
	let index = 1
	let voiceIdx = null
	let musicIdx = null
	if (o.voice) {
		inputs.push('-i', o.voice)
		voiceIdx = index
		index += 1
	}
	if (o.music) {
		inputs.push('-stream_loop', '-1', '-i', o.music)
		musicIdx = index
		index += 1
	}
	const chain = []
	let vLabel = '0:v'
	if (o.srt && o.subtitleStyle && o.subtitleStyle !== 'none') {
		const styles = SUB_STYLES(width, height)
		const key = o.subtitleStyle
		const style = styles[key]
		if (style) {
			chain.push('[0:v]subtitles=filename=' + path.basename(o.srt) + ':force_style=' + SQ + style + SQ + '[subbed]')
			vLabel = 'subbed'
		}
	}
	if (o.watermarkText) {
		const size = Math.round(height * 0.018)
		const wm = drawText(vLabel, 'wm', o.watermarkText, {
			size: size,
			color: 'white@0.7',
			x: 'w-text_w-' + size * 2,
			y: 'h-text_h-' + size * 2,
		})
		if (wm) {
			chain.push(wm)
			vLabel = 'wm'
		}
	}
	if (vLabel === '0:v') {
		chain.push('[0:v]copy[vfinal]')
		vLabel = 'vfinal'
	}
	const audioParts = []
	if (voiceIdx !== null) {
		chain.push('[' + voiceIdx + ':a]volume=' + (o.voiceVolume === undefined ? 1.4 : o.voiceVolume) + ',aresample=48000[vo]')
		audioParts.push('[vo]')
	}
	if (musicIdx !== null) {
		chain.push('[' + musicIdx + ':a]volume=' + (o.musicVolume === undefined ? 0.12 : o.musicVolume) + ',aresample=48000[bgm]')
		audioParts.push('[bgm]')
	}
	let aLabel = null
	if (audioParts.length === 2) {
		chain.push(audioParts.join('') + 'amix=inputs=2:duration=first:dropout_transition=3,alimiter=limit=0.95[aout]')
		aLabel = 'aout'
	} else if (audioParts.length === 1) {
		chain.push(audioParts[0] + 'alimiter=limit=0.95[aout]')
		aLabel = 'aout'
	}
	const args = inputs.concat(['-filter_complex', chain.join(';'), '-map', '[' + vLabel + ']'])
	if (aLabel) args.push('-map', '[' + aLabel + ']', '-shortest')
	else args.push('-map', '0:a?')
	await run(args.concat(encodeArgs({ preset: o.preset, crf: o.crf, fps: fps }), [o.out]), {
		cwd: o.srt ? path.dirname(o.srt) : PATHS.tmp,
		onProgress: o.onProgress,
		totalDuration: o.totalDuration,
	})
	return o.out
}

async function extractThumb(options) {
	const o = options || {}
	await run(['-ss', String(o.at || 1), '-i', o.video, '-frames:v', '1', '-vf', 'scale=720:-2', '-q:v', '4', o.out])
	return o.out
}

/** Visual podcast: waveform / bar / spectrum + cover + judul. */
async function waveformVideo(options) {
	const o = options || {}
	const width = o.width || 1920
	const height = o.height || 1080
	const fps = o.fps || 25
	const duration = Math.max(1, Number(o.duration) || 30)
	const waveH = Math.round(height * 0.2)
	const inputs = ['-i', o.audio]
	if (o.cover) inputs.push('-loop', '1', '-i', o.cover)
	const chain = ['color=c=' + (o.bgColor || '0x14161B') + ':s=' + width + 'x' + height + ':r=' + fps + ':d=' + duration + '[bg]']
	let label = 'bg'
	if (o.cover) {
		const cs = Math.round(height * 0.38)
		chain.push('[1:v]scale=' + cs + ':' + cs + ':force_original_aspect_ratio=increase,crop=' + cs + ':' + cs + '[cov]')
		chain.push('[' + label + '][cov]overlay=(W-w)/2:' + Math.round(height * 0.1) + ':shortest=0[withcov]')
		label = 'withcov'
	}
	const wave =
		o.style === 'bars'
			? '[0:a]showfreqs=s=' + width + 'x' + waveH + ':mode=bar:ascale=log:colors=' + (o.waveColor || '0x5E9FE8') + '[wave]'
			: o.style === 'spectrum'
				? '[0:a]showspectrum=s=' + width + 'x' + waveH + ':slide=scroll:color=intensity:scale=cbrt[wave]'
				: '[0:a]showwaves=s=' + width + 'x' + waveH + ':mode=cline:colors=' + (o.waveColor || '0x5E9FE8') + ':draw=full[wave]'
	chain.push(wave)
	chain.push('[' + label + '][wave]overlay=0:' + (height - waveH - Math.round(height * 0.06)) + ':format=auto[waved]')
	label = 'waved'
	const title = drawText(label, 'ti', o.title, { size: Math.round(height * 0.05), y: Math.round(height * 0.56), borderw: 2 })
	if (title) {
		chain.push(title)
		label = 'ti'
	}
	const subtitle = drawText(label, 'su', o.subtitle, { size: Math.round(height * 0.026), color: '0x9AA0A6', y: Math.round(height * 0.64) })
	if (subtitle) {
		chain.push(subtitle)
		label = 'su'
	}
	chain.push('[' + label + ']format=yuv420p[vout]')
	await run(
		inputs.concat(
			['-filter_complex', chain.join(';'), '-map', '[vout]', '-map', '0:a', '-t', String(duration)],
			encodeArgs({ preset: o.preset, crf: o.crf || 23, fps: fps }),
			[o.out],
		),
		{ onProgress: o.onProgress, totalDuration: duration },
	)
	return o.out
}

const NATURAL_PRESETS = {
	'podcast-warm':
		'highpass=f=85,lowpass=f=15000,equalizer=f=220:t=q:w=1.2:g=2.5,equalizer=f=3200:t=q:w=1.6:g=2,acompressor=threshold=-20dB:ratio=3:attack=8:release=180:makeup=2,loudnorm=I=-16:TP=-1.5:LRA=11',
	'ugc-bright':
		'highpass=f=110,equalizer=f=4200:t=q:w=1.4:g=3,equalizer=f=300:t=q:w=1.2:g=-1.5,acompressor=threshold=-18dB:ratio=3.5:attack=5:release=150:makeup=3,loudnorm=I=-14:TP=-1:LRA=9',
	'radio-clean':
		'highpass=f=90,lowpass=f=16000,acompressor=threshold=-24dB:ratio=4:attack=5:release=200:makeup=4,equalizer=f=120:t=q:w=1:g=1.5,loudnorm=I=-15:TP=-1.5:LRA=8',
	'asmr-soft':
		'highpass=f=70,equalizer=f=180:t=q:w=1.4:g=2,lowpass=f=12000,acompressor=threshold=-26dB:ratio=2.2:attack=15:release=250:makeup=2,loudnorm=I=-18:TP=-2:LRA=12',
	'voice-over-tv':
		'highpass=f=95,equalizer=f=2500:t=q:w=1.5:g=2.5,equalizer=f=8000:t=q:w=1.2:g=1.5,acompressor=threshold=-22dB:ratio=3.2:attack=6:release=160:makeup=3,loudnorm=I=-16:TP=-1.5:LRA=10',
	none: null,
}

/** Ubah suara jadi natural: denoise, EQ, kompresor, loudness, pitch, room. */
async function naturalizeAudio(options) {
	const o = options || {}
	const parts = []
	if (o.denoise) parts.push('afftdn=nf=-25')
	const semitones = clamp(Number(o.pitch) || 0, -12, 12)
	// Samakan sample rate dulu: asetrate di bawah mengasumsikan input 48 kHz.
	parts.push('aresample=48000')
	if (semitones !== 0) {
		const ratio = Math.pow(2, semitones / 12)
		parts.push('asetrate=' + Math.round(48000 * ratio), 'aresample=48000', 'atempo=' + (1 / ratio).toFixed(6))
	}
	const tempo = clamp(o.speed === undefined ? 1 : Number(o.speed), 0.5, 2)
	if (Math.abs(tempo - 1) > 0.01) parts.push('atempo=' + tempo.toFixed(3))
	const key = o.preset || 'podcast-warm'
	const chain = NATURAL_PRESETS[key] === undefined ? NATURAL_PRESETS['podcast-warm'] : NATURAL_PRESETS[key]
	if (chain) parts.push(chain)
	const room = Number(o.room) || 0
	if (room > 0) parts.push('aecho=0.8:0.75:' + Math.round(24 + clamp(room, 0, 1) * 60) + ':' + (0.06 + clamp(room, 0, 1) * 0.16).toFixed(3))
	if (!parts.length) parts.push('anull')
	await run(['-i', o.input, '-vn', '-af', parts.join(','), '-ar', '48000', '-ac', '2', o.out])
	return o.out
}

async function concatAudio(options) {
	const o = options || {}
	const inputs = o.inputs || []
	if (!inputs.length) throw new Error('Tidak ada audio untuk digabung')
	const gap = o.gapSeconds === undefined ? 0.3 : o.gapSeconds
	const args = []
	inputs.forEach(function (file) {
		args.push('-i', file)
	})
	const pad = gap > 0 ? ',apad=pad_dur=' + gap : ''
	const prep = inputs
		.map(function (_, i) {
			return '[' + i + ':a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo' + pad + '[a' + i + ']'
		})
		.join(';')
	const joined = inputs
		.map(function (_, i) {
			return '[a' + i + ']'
		})
		.join('')
	await run(args.concat(['-filter_complex', prep + ';' + joined + 'concat=n=' + inputs.length + ':v=0:a=1[aout]', '-map', '[aout]', '-ar', '48000', '-ac', '2', o.out]))
	return o.out
}

async function silence(options) {
	const o = options || {}
	await run(['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', String(o.duration || 1), o.out])
	return o.out
}

/** Narasi placeholder untuk mode simulate (kalau API TTS belum diisi). */
async function placeholderNarration(options) {
	const o = options || {}
	const duration = Math.max(1, Number(o.duration) || 3)
	const freq = 150 + ((Number(o.seed) || 1) % 5) * 12
	await run([
		'-f', 'lavfi', '-i', 'sine=frequency=' + freq + ':sample_rate=48000:duration=' + duration,
		'-f', 'lavfi', '-i', 'anoisesrc=color=brown:sample_rate=48000:amplitude=0.06:duration=' + duration,
		'-filter_complex',
		'[0:a]volume=0.05,tremolo=f=5.5:d=0.8[t];[1:a]volume=0.3,highpass=f=180,lowpass=f=3200[n];[t][n]amix=inputs=2:duration=first,volume=0.6,loudnorm=I=-20:TP=-3:LRA=11[aout]',
		'-map', '[aout]', '-ar', '48000', '-ac', '2', o.out,
	])
	return o.out
}

async function toMp3(options) {
	const o = options || {}
	await run(['-i', o.input, '-vn', '-c:a', 'libmp3lame', '-b:a', o.bitrate || '192k', o.out])
	return o.out
}

/** Generator music bed bebas royalti (dibuat lokal). */
async function makeMusicBed(options) {
	const o = options || {}
	const duration = Math.max(5, Number(o.duration) || 60)
	const moods = {
		lofi: { notes: [220, 277, 330, 392], vol: 0.16 },
		upbeat: { notes: [262, 330, 392, 523], vol: 0.18 },
		cinematic: { notes: [147, 196, 220, 294], vol: 0.14 },
		calm: { notes: [196, 247, 294, 370], vol: 0.12 },
	}
	const conf = moods[o.mood] || moods.lofi
	const inputs = []
	const chains = []
	conf.notes.forEach(function (freq, i) {
		inputs.push('-f', 'lavfi', '-i', 'sine=frequency=' + freq + ':sample_rate=48000:duration=' + duration)
		chains.push('[' + i + ':a]volume=' + (conf.vol / (i + 1)).toFixed(3) + ',tremolo=f=' + (0.4 + i * 0.22).toFixed(2) + ':d=0.6[n' + i + ']')
	})
	const mix =
		conf.notes
			.map(function (_, i) {
				return '[n' + i + ']'
			})
			.join('') + 'amix=inputs=' + conf.notes.length + ':duration=first,lowpass=f=2400,aecho=0.8:0.9:60:0.25,loudnorm=I=-22:TP=-3:LRA=11[aout]'
	await run(inputs.concat(['-filter_complex', chains.join(';') + ';' + mix, '-map', '[aout]', '-t', String(duration), '-c:a', 'libmp3lame', '-b:a', '160k', o.out]))
	return o.out
}

module.exports = {
	FFMPEG: FFMPEG,
	FFPROBE: FFPROBE,
	NL: NL,
	run: run,
	version: version,
	SUB_STYLES: SUB_STYLES,
	probe: probe,
	mediaInfo: mediaInfo,
	durationOf: durationOf,
	encodeArgs: encodeArgs,
	tmpFile: tmpFile,
	motionFilter: motionFilter,
	imageToClip: imageToClip,
	textCardClip: textCardClip,
	textCardImage: textCardImage,
	normalizeClip: normalizeClip,
	concatClips: concatClips,
	finalMix: finalMix,
	extractThumb: extractThumb,
	waveformVideo: waveformVideo,
	naturalizeAudio: naturalizeAudio,
	NATURAL_PRESETS: NATURAL_PRESETS,
	concatAudio: concatAudio,
	silence: silence,
	placeholderNarration: placeholderNarration,
	toMp3: toMp3,
	makeMusicBed: makeMusicBed,
}
