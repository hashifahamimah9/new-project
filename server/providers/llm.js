'use strict'

/**
 * Script engine. Kalau LLM API diisi -> pakai LLM. Kalau tidak -> generator lokal
 * (template copywriting UGC bahasa Indonesia) supaya app tetap jalan offline.
 */

const store = require('../lib/store')
const { request } = require('../lib/httpclient')
const { estimateSpeechSeconds } = require('../lib/util')

const ANGLES = [
	{ id: 'review-jujur', label: 'Review jujur' },
	{ id: 'unboxing', label: 'Unboxing' },
	{ id: 'problem-solution', label: 'Masalah - solusi' },
	{ id: 'storytelling', label: 'Storytelling' },
	{ id: 'before-after', label: 'Before - after' },
	{ id: 'tutorial', label: 'Tutorial / cara pakai' },
	{ id: 'testimoni', label: 'Testimoni pelanggan' },
	{ id: 'hard-sell', label: 'Hard sell / promo' },
]

const PERSONAS = [
	{ id: 'gen-z-casual', label: 'Gen Z santai', voice: 'sari', style: 'ceplas ceplos, banyak slang, energik' },
	{ id: 'ibu-rumah-tangga', label: 'Ibu rumah tangga', voice: 'nadia', style: 'hangat, praktis, fokus hemat & aman' },
	{ id: 'pro-reviewer', label: 'Reviewer profesional', voice: 'bima', style: 'tenang, detail, banyak data' },
	{ id: 'beauty-enthusiast', label: 'Beauty enthusiast', voice: 'aira', style: 'lembut, deskriptif tekstur & hasil' },
	{ id: 'tech-savvy', label: 'Tech savvy', voice: 'raka', style: 'spek-oriented, to the point' },
	{ id: 'olshop-owner', label: 'Owner olshop', voice: 'nadia', style: 'persuasif, penuh penawaran' },
]

const HOOKS = {
	'review-jujur': ['Aku beli {product} pakai duit sendiri, jadi review ini jujur banget.', 'Katanya {product} bagus. Aku tes 7 hari, ini hasilnya.', 'Jangan beli {product} sebelum lihat video ini.'],
	unboxing: ['Paket {product} baru sampai, kita buka bareng ya.', 'Isi paket {product} ini bikin aku kaget.', 'Unboxing {product}, ada bonus yang gak disangka.'],
	'problem-solution': ['Capek banget sama {problem}? Aku juga, sampai nemu {product}.', 'Masalah {problem} akhirnya kelar gara-gara ini.', 'Kalau kamu masih {problem}, wajib lihat ini.'],
	storytelling: ['Tiga bulan lalu aku hampir nyerah sama {problem}.', 'Awalnya aku ragu beli {product}, sampai kejadian ini.', 'Cerita singkat kenapa aku sekarang stok {product} terus.'],
	'before-after': ['Ini kondisi sebelum pakai {product}. Siap-siap kaget.', 'Before after 14 hari pakai {product}, bedanya keliatan.', 'Perbedaan sebelum dan sesudah pakai {product} nyata banget.'],
	tutorial: ['Cara pakai {product} biar hasilnya maksimal, catat ya.', 'Banyak yang salah pakai {product}. Urutan benarnya gini.', '3 langkah pakai {product} buat hasil terbaik.'],
	testimoni: ['Pelanggan aku kirim chat ini setelah pakai {product}.', 'Testimoni asli pembeli {product}, gak dibayar.', 'Kata pembeli, {product} bikin mereka repeat order.'],
	'hard-sell': ['Promo {product} hari ini bahaya banget buat dompet.', 'Stok {product} tinggal sedikit dan harganya turun.', 'Kalau nunggu besok, promo {product} udah habis.'],
}

const AGITATE = [
	'Aku udah coba banyak cara, hasilnya cuma buang-buang uang.',
	'Masalahnya bukan cuma bikin ribet, tapi juga bikin gak percaya diri.',
	'Awalnya aku pikir semua produk sejenis sama saja, ternyata beda jauh.',
	'Yang bikin capek itu harus ngulang terus tanpa hasil kelihatan.',
]

const REVEAL = [
	'Sampai akhirnya aku nemu {product}, dan cara kerjanya beda.',
	'Terus aku dikenalin {product} sama teman yang udah pakai lama.',
	'Aku putuskan coba {product}, dan langsung berasa di pemakaian pertama.',
]

const PROOF = [
	'Hasilnya: {benefit}. Itu bukan klaim, aku rasain sendiri.',
	'Yang paling aku suka, {benefit} tanpa ribet.',
	'Setelah rutin dipakai, {benefit}. Ini yang bikin aku repeat order.',
	'Bonusnya, {benefit}. Buat harga segini, worth it banget.',
]

const CTAS = [
	'Link ada di keranjang kuning, checkout sekarang sebelum stok habis.',
	'Klik keranjangnya sekarang, promonya cuma hari ini.',
	'Cek link di bio, ada potongan buat pembeli pertama.',
	'Simpan video ini, terus langsung checkout sebelum harga naik.',
]

const VISUALS = [
	'close up produk di tangan dengan cahaya jendela lembut',
	'produk di atas meja kayu dengan properti pendukung minimal',
	'tangan memegang produk lalu memutar perlahan menunjukkan detail',
	'produk sedang dipakai, fokus ke bagian hasil',
	'perbandingan sisi kiri dan kanan menampilkan perbedaan hasil',
	'produk dengan latar warna solid, gaya iklan bersih',
	'flat lay produk beserta kemasan dan bonus',
	'ekspresi puas setelah memakai produk, cahaya hangat',
]

const MOTIONS = ['zoomin', 'panright', 'zoomout', 'panleft', 'panup', 'still', 'pandown']

function fill(template, vars) {
	return String(template || '').replace(/\{(\w+)\}/g, function (all, key) {
		return vars[key] === undefined || vars[key] === null || vars[key] === '' ? '' : String(vars[key])
	})
}

function pickIndex(list, index) {
	return list[Math.abs(index) % list.length]
}

function cfg() {
	return store.settings().llm || {}
}

function isRemote() {
	const c = cfg()
	return Boolean(c.apiKey && c.baseUrl)
}

/** Panggil LLM OpenAI-compatible dan minta output JSON. */
async function chatJson(system, user) {
	const c = cfg()
	const base = String(c.baseUrl || '').replace(/\/+$/, '')
	const res = await request(base + '/chat/completions', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.apiKey },
		body: {
			model: c.model || 'gpt-4o-mini',
			temperature: 0.8,
			response_format: { type: 'json_object' },
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: user },
			],
		},
		timeoutMs: 90000,
		retries: 1,
	})
	const content = res.data && res.data.choices && res.data.choices[0] && res.data.choices[0].message ? res.data.choices[0].message.content : ''
	return JSON.parse(content)
}

function brandContext() {
	const b = store.brand() || {}
	return Object.assign({}, b, {
		brandName: b.name || '',
		cta: b.ctaText || b.cta || '',
		tone: b.tone || 'santai tapi meyakinkan',
		audience: b.audience || 'anak muda 18-34 di Indonesia',
		bannedWords: b.bannedWords || '',
		hashtags: b.hashtags || '',
	})
}

/* ------------------------------- UGC SCRIPT ------------------------------- */

function localUgcScript(input) {
	const o = input || {}
	const brand = brandContext()
	const product = o.product || 'produk ini'
	const benefits = (o.benefits || '')
		.split(/[,;\n]/)
		.map(function (b) {
			return b.trim()
		})
		.filter(Boolean)
	const problem = o.problem || 'masalah yang bikin ribet tiap hari'
	const angle = o.angle || 'review-jujur'
	const persona = PERSONAS.find(function (p) {
		return p.id === (o.persona || 'gen-z-casual')
	}) || PERSONAS[0]
	const sceneCount = Math.max(3, Math.min(Number(o.sceneCount) || 5, 10))
	const sceneDuration = Math.max(2, Math.min(Number(o.sceneDuration) || 5, 12))
	const seed = product.length + sceneCount
	const hookList = HOOKS[angle] || HOOKS['review-jujur']
	const hook = fill(pickIndex(hookList, seed), { product: product, problem: problem })
	const lines = [hook]
	lines.push(fill(pickIndex(AGITATE, seed + 1), { product: product, problem: problem }))
	lines.push(fill(pickIndex(REVEAL, seed + 2), { product: product }))
	const proofCount = Math.max(1, sceneCount - 4)
	for (let i = 0; i < proofCount; i += 1) {
		const benefit = benefits.length ? benefits[i % benefits.length] : 'hasilnya kelihatan lebih rapi dan praktis'
		lines.push(fill(pickIndex(PROOF, seed + 3 + i), { benefit: benefit, product: product }))
	}
	lines.push(brand.cta || fill(pickIndex(CTAS, seed + 9), { product: product }))
	while (lines.length < sceneCount) {
		lines.splice(lines.length - 1, 0, fill(pickIndex(PROOF, lines.length + seed), { benefit: benefits.length ? benefits[lines.length % benefits.length] : 'kualitasnya di atas harga', product: product }))
	}
	const scenes = lines.slice(0, sceneCount).map(function (narration, i) {
		const visual = pickIndex(VISUALS, i + seed)
		return {
			index: i + 1,
			narration: narration,
			onScreenText: i === 0 ? String(narration).slice(0, 46) : String(narration).split(' ').slice(0, 7).join(' '),
			visual: visual,
			motion: o.motion && o.motion !== 'auto' ? o.motion : pickIndex(MOTIONS, i + seed),
			duration: Math.max(sceneDuration, Math.ceil(estimateSpeechSeconds(narration) + 0.6)),
		}
	})
	const title = product + ' - ' + (ANGLES.find(function (a) {
		return a.id === angle
	}) || ANGLES[0]).label
	return {
		source: 'local',
		title: title,
		hook: hook,
		angle: angle,
		persona: persona.id,
		voice: o.voice || persona.voice,
		scenes: scenes,
		caption: hook + ' ' + (benefits[0] ? benefits[0] + '. ' : '') + (brand.cta || 'Cek link sekarang.'),
		hashtags: brand.hashtags || '#fyp #review #racunbelanja #' + String(product).toLowerCase().replace(/[^a-z0-9]/g, ''),
		cta: brand.cta || pickIndex(CTAS, seed),
	}
}

async function generateUgcScript(input) {
	if (!isRemote()) return localUgcScript(input)
	const brand = brandContext()
	const o = input || {}
	const system =
		'Kamu copywriter UGC Indonesia. Balas HANYA JSON valid dengan bentuk: ' +
		'{"title":string,"hook":string,"caption":string,"hashtags":string,"cta":string,"scenes":[{"narration":string,"onScreenText":string,"visual":string,"motion":"zoomin|zoomout|panleft|panright|panup|still"}]}. ' +
		'Bahasa Indonesia natural, gaya orang biasa bukan iklan korporat, tiap narration 1-2 kalimat pendek.'
	const user =
		'Produk: ' + (o.product || '-') + String.fromCharCode(10) +
		'Deskripsi/benefit: ' + (o.benefits || '-') + String.fromCharCode(10) +
		'Masalah audiens: ' + (o.problem || '-') + String.fromCharCode(10) +
		'Angle: ' + (o.angle || 'review-jujur') + String.fromCharCode(10) +
		'Persona: ' + (o.persona || 'gen-z-casual') + String.fromCharCode(10) +
		'Jumlah scene: ' + (o.sceneCount || 5) + String.fromCharCode(10) +
		'Durasi per scene: ' + (o.sceneDuration || 5) + ' detik' + String.fromCharCode(10) +
		'Brand: ' + (brand.brandName || '-') + ', tone: ' + (brand.tone || '-') + ', audiens: ' + (brand.audience || '-') + String.fromCharCode(10) +
		'CTA wajib: ' + (brand.cta || '-') + String.fromCharCode(10) +
		'Hindari kata: ' + (brand.bannedWords || '-')
	try {
		const data = await chatJson(system, user)
		const scenes = (data.scenes || []).map(function (scene, i) {
			return {
				index: i + 1,
				narration: scene.narration || '',
				onScreenText: scene.onScreenText || String(scene.narration || '').slice(0, 40),
				visual: scene.visual || pickIndex(VISUALS, i),
				motion: scene.motion || pickIndex(MOTIONS, i),
				duration: Math.max(Number(o.sceneDuration) || 5, Math.ceil(estimateSpeechSeconds(scene.narration) + 0.6)),
			}
		})
		if (!scenes.length) return localUgcScript(input)
		return {
			source: 'llm',
			title: data.title || o.product,
			hook: data.hook || scenes[0].narration,
			angle: o.angle || 'review-jujur',
			persona: o.persona || 'gen-z-casual',
			voice: o.voice || 'nadia',
			scenes: scenes,
			caption: data.caption || '',
			hashtags: data.hashtags || brand.hashtags || '',
			cta: data.cta || brand.cta || '',
		}
	} catch (err) {
		const fallback = localUgcScript(input)
		fallback.warning = 'LLM gagal (' + err.message + '), pakai generator lokal'
		return fallback
	}
}

/* ----------------------------- PODCAST SCRIPT ----------------------------- */

function localPodcastScript(input) {
	const o = input || {}
	const topic = o.topic || 'topik hari ini'
	const hosts = (o.hosts && o.hosts.length ? o.hosts : [{ name: 'Host A', voice: 'host-a' }, { name: 'Host B', voice: 'host-b' }]).slice(0, 4)
	const minutes = Math.max(1, Math.min(Number(o.minutes) || 5, 60))
	const turns = Math.max(4, Math.round(minutes * 4))
	const outline = [
		'Pembukaan dan kenapa ' + topic + ' penting sekarang',
		'Fakta atau data yang bikin kaget soal ' + topic,
		'Pengalaman pribadi dan kesalahan umum',
		'Cara praktis yang bisa langsung dicoba',
		'Kesimpulan dan ajakan diskusi',
	]
	const templates = [
		'Oke, hari ini kita ngobrolin {topic}. Menurut kamu kenapa ini rame dibahas?',
		'Kalau aku lihat, {topic} itu menarik karena efeknya langsung kerasa di keseharian.',
		'Ada satu hal soal {topic} yang sering disalahpahami orang.',
		'Aku pernah salah langkah waktu pertama coba, dan itu bikin aku belajar banyak.',
		'Kalau mau mulai, langkah paling gampang itu ambil satu bagian kecil dulu.',
		'Poin pentingnya jangan buru-buru. Konsistensi lebih penting daripada cepat.',
		'Jadi kesimpulannya soal {topic}: mulai kecil, ukur hasilnya, lalu perbesar.',
		'Setuju. Buat kamu yang dengar, coba satu langkah dari obrolan ini hari ini.',
	]
	const segments = []
	for (let i = 0; i < turns; i += 1) {
		const host = hosts[i % hosts.length]
		segments.push({
			speaker: host.name,
			voice: host.voice || (i % 2 === 0 ? 'host-a' : 'host-b'),
			text: fill(pickIndex(templates, i), { topic: topic }),
		})
	}
	return {
		source: 'local',
		title: 'Obrolan soal ' + topic,
		description: 'Podcast AI membahas ' + topic + ' secara santai bareng ' + hosts.map(function (h) {
			return h.name
		}).join(' dan ') + '.',
		outline: outline,
		segments: segments,
	}
}

async function generatePodcastScript(input) {
	if (!isRemote()) return localPodcastScript(input)
	const o = input || {}
	const hosts = o.hosts && o.hosts.length ? o.hosts : [{ name: 'Host A', voice: 'host-a' }, { name: 'Host B', voice: 'host-b' }]
	const system =
		'Kamu penulis skrip podcast Indonesia. Balas HANYA JSON: ' +
		'{"title":string,"description":string,"outline":[string],"segments":[{"speaker":string,"text":string}]}. ' +
		'Dialog natural, ada jeda pikir, tidak kaku, hindari istilah teknis berlebihan.'
	const user =
		'Topik: ' + (o.topic || '-') + String.fromCharCode(10) +
		'Host: ' + hosts.map(function (h) {
			return h.name
		}).join(', ') + String.fromCharCode(10) +
		'Durasi target: ' + (o.minutes || 5) + ' menit' + String.fromCharCode(10) +
		'Gaya: ' + (o.tone || 'santai tapi informatif') + String.fromCharCode(10) +
		'Catatan tambahan: ' + (o.notes || '-')
	try {
		const data = await chatJson(system, user)
		const segments = (data.segments || []).map(function (segment, i) {
			const host = hosts[i % hosts.length]
			return {
				speaker: segment.speaker || host.name,
				voice: (hosts.find(function (h) {
					return h.name === segment.speaker
				}) || host).voice || 'host-a',
				text: segment.text || '',
			}
		})
		if (!segments.length) return localPodcastScript(input)
		return { source: 'llm', title: data.title || o.topic, description: data.description || '', outline: data.outline || [], segments: segments }
	} catch (err) {
		const fallback = localPodcastScript(input)
		fallback.warning = 'LLM gagal (' + err.message + '), pakai generator lokal'
		return fallback
	}
}

/* ------------------------------ PROMPT HELPER ------------------------------ */

const MOTION_MAP_ID = {
	zoomin: 'gerakan kamera zoom perlahan mendekati produk',
	zoomout: 'gerakan kamera zoom menjauh perlahan memperlihatkan produk secara utuh',
	panright: 'gerakan kamera bergeser perlahan ke arah kanan',
	panleft: 'gerakan kamera bergeser perlahan ke arah kiri',
	panup: 'gerakan kamera perlahan dari bawah ke atas memperlihatkan kemasan produk',
	pandown: 'gerakan kamera perlahan dari atas ke bawah',
	still: 'posisi kamera stabil dengan fokus sangat tajam ke produk',
	cinematic: 'gerakan kamera sinematik yang sangat halus',
}

function videoPromptFor(scene, product, style) {
	const brand = brandContext()
	const motionText = MOTION_MAP_ID[scene.motion] || scene.motion || 'gerakan kamera halus'
	return [
		'Video vertikal 9:16 gaya video ulasan pengguna asli',
		(scene.visual || 'rekaman produk dari dekat dipegang tangan wanita Indonesia'),
		'produk: ' + (product || 'produk kecantikan'),
		'rekaman kamera ponsel natural dan stabil',
		motionText,
		'pencahayaan alami siang hari dari jendela',
		'suasana ' + (style || brand.tone || 'realistis, hangat, segar, dan autentik'),
		'detail kemasan dan tekstur produk sangat tajam dan jernih, warna kulit dan produk natural, tanpa teks tulisan grafis di layar, tanpa watermark, kualitas video sinematik realistis',
	].join(', ')
}

function imagePromptFor(scene, product, style) {
	return [
		'Foto produk realistis, ' + (scene.visual || 'produk dipegang tangan dengan latar ruangan rapi'),
		'produk: ' + (product || 'produk'),
		'gaya foto ulasan asli, kamera ponsel jernih, cahaya alami, efek bokeh latar belakang lembut',
		'komposisi estetik dan rapi, ' + (style || 'warna hangat, tampak nyata bukan iklan 3D'),
	].join(', ')
}

function captionFor(script, extra) {
	const brand = brandContext()
	const hook = script && script.hook ? script.hook : ''
	const benefit = script && script.scenes && script.scenes[2] ? script.scenes[2].narration : ''
	return {
		title: (script && script.title) || 'Video UGC',
		caption: [hook, benefit, brand.cta || '', extra || ''].filter(Boolean).join(' '),
		hashtags: (script && script.hashtags) || brand.hashtags || '#fyp #review',
	}
}

module.exports = {
	ANGLES: ANGLES,
	PERSONAS: PERSONAS,
	MOTIONS: MOTIONS,
	isRemote: isRemote,
	generateUgcScript: generateUgcScript,
	localUgcScript: localUgcScript,
	generatePodcastScript: generatePodcastScript,
	localPodcastScript: localPodcastScript,
	videoPromptFor: videoPromptFor,
	imagePromptFor: imagePromptFor,
	captionFor: captionFor,
}
