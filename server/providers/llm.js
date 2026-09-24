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
	'problem-solution': ['Capek banget sama {problem}? Aku juga, sampai nemu {product}.', 'Akhirnya {problem} kelar gara-gara ini.', 'Kalau kamu masih ngalamin {problem}, wajib lihat ini.'],
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
	if (String(c.provider || '').toLowerCase() === 'local') return false
	return Boolean(c.apiKey && c.baseUrl)
}

/** Base URL OpenAI-compatible -> endpoint /chat/completions. */
function chatEndpoint(baseUrl) {
	let base = String(baseUrl || '').trim().replace(/\/+$/, '')
	if (/\/chat\/completions$/.test(base)) return base
	try {
		const u = new URL(base)
		if (!u.pathname || u.pathname === '/') base += '/v1'
	} catch (err) {}
	return base + '/chat/completions'
}

/** Ambil objek JSON dari jawaban LLM (tahan terhadap ```json ... ``` dan teks tambahan). */
function parseJsonLoose(content) {
	const text = String(content || '').trim()
	if (!text) throw new Error('LLM mengembalikan jawaban kosong')
	const fenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')
	try {
		return JSON.parse(fenced)
	} catch (err) {}
	const start = fenced.indexOf('{')
	const end = fenced.lastIndexOf('}')
	if (start !== -1 && end > start) {
		try {
			return JSON.parse(fenced.slice(start, end + 1))
		} catch (err) {}
	}
	throw new Error('Jawaban LLM bukan JSON valid: ' + text.slice(0, 120))
}

/** Panggil LLM OpenAI-compatible dan minta output JSON. */
async function chatJson(system, user, options) {
	const o = options || {}
	const c = cfg()
	const url = chatEndpoint(c.baseUrl)
	const body = {
		model: c.model || 'gpt-4o-mini',
		temperature: o.temperature === undefined ? 0.8 : o.temperature,
		response_format: { type: 'json_object' },
		messages: [
			{ role: 'system', content: system },
			{ role: 'user', content: user },
		],
	}
	const send = function (payload) {
		return request(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.apiKey },
			body: payload,
			timeoutMs: o.timeoutMs || 90000,
			retries: o.retries === undefined ? 1 : o.retries,
		})
	}
	let res
	try {
		res = await send(body)
	} catch (err) {
		// Sebagian provider tidak mendukung response_format -> ulang tanpa itu.
		if (err.status === 400 && /response_format|json_object|not supported/i.test(err.message)) {
			const copy = Object.assign({}, body)
			delete copy.response_format
			res = await send(copy)
		} else {
			throw err
		}
	}
	const data = res.data
	if (typeof data === 'string') throw new Error('Respons LLM bukan JSON (cek Base URL): ' + data.slice(0, 120))
	const choice = data && data.choices && data.choices[0]
	const content = choice && choice.message ? choice.message.content : choice && choice.text
	return parseJsonLoose(content)
}

/** Tes koneksi LLM (dipakai tombol Tes di Settings). */
async function testConnection() {
	const c = cfg()
	if (!isRemote()) {
		if (c.apiKey && c.baseUrl) return { ok: true, mode: 'local', message: 'Provider masih "local" (template bawaan). Pilih "remote" supaya API key LLM dipakai.' }
		return { ok: true, mode: 'local', message: 'Mode local (template bawaan) aktif - tidak butuh API. Isi Base URL + API key dan pilih "remote" untuk memakai LLM.' }
	}
	try {
		const data = await chatJson('Balas HANYA JSON valid.', 'Balas {"ok":true,"pesan":"halo"}', { temperature: 0, retries: 0, timeoutMs: 30000 })
		return { ok: true, mode: 'remote', message: 'Koneksi LLM OK (model ' + (c.model || 'gpt-4o-mini') + ')' + (data && data.pesan ? '' : '') }
	} catch (err) {
		return { ok: false, mode: 'remote', message: 'LLM gagal: ' + String(err.message || err).slice(0, 200) }
	}
}

/** Potong teks untuk teks di layar: utamakan batas kalimat/klausa, lalu batas kata. */
function shortText(text, maxChars) {
	const clean = String(text || '').replace(/\s+/g, ' ').trim()
	if (clean.length <= maxChars) return clean.replace(/[,;:]$/, '')
	const clause = clean.split(/(?<=[.!?,;:])\s/)[0].replace(/[,;:]$/, '')
	if (clause.length <= maxChars && clause.length >= 12) return clause
	const words = clean.split(' ')
	let out = ''
	for (const word of words) {
		if ((out + ' ' + word).trim().length > maxChars - 3) break
		out = (out + ' ' + word).trim()
	}
	return (out || clean.slice(0, maxChars - 3)).replace(/[,;:.]$/, '') + '...'
}

function hashString(value) {
	let h = 0
	const s = String(value || '')
	for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0
	return h
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
	const product = String(o.product || 'produk ini').trim() || 'produk ini'
	const benefits = String(o.benefits || '')
		.split(/[,;\n]/)
		.map(function (b) {
			return b.trim()
		})
		.filter(Boolean)
	const problem = o.problem || 'masalah yang bikin ribet tiap hari'
	const variant = Math.max(1, Number(o.variant) || 1)
	const seed = hashString(product) + (Number(o.seed) || 0) + (variant - 1) * 7
	let angle = o.angle || 'review-jujur'
	if (angle === 'auto' || angle === 'random' || !HOOKS[angle]) {
		angle = ANGLES[(seed + variant - 1) % ANGLES.length].id
	}
	const persona = PERSONAS.find(function (p) {
		return p.id === (o.persona || 'gen-z-casual')
	}) || PERSONAS[0]
	const sceneCount = Math.max(3, Math.min(Number(o.sceneCount) || 5, 10))
	const sceneDuration = Math.max(2, Math.min(Number(o.sceneDuration) || 5, 12))
	const vars = { product: product, problem: problem }
	const hook = fill(pickIndex(HOOKS[angle], seed), vars)
	const cta = brand.cta || fill(pickIndex(CTAS, seed + 3), vars)
	const benefitAt = function (i) {
		return benefits.length ? benefits[i % benefits.length] : pickIndex(['hasilnya kelihatan lebih rapi dan praktis', 'kualitasnya di atas harga', 'pemakaiannya gampang banget', 'hasilnya tahan lama'], seed + i)
	}
	// Struktur: hook -> (masalah) -> solusi -> bukti -> CTA. Hook selalu pertama, CTA selalu terakhir.
	const middleCount = sceneCount - 2
	const middle = []
	if (sceneCount >= 5) middle.push(fill(pickIndex(AGITATE, seed + 1), vars))
	middle.push(fill(pickIndex(REVEAL, seed + 2), vars))
	let proofIndex = 0
	while (middle.length < middleCount) {
		middle.push(fill(pickIndex(PROOF, seed + 3 + proofIndex), { benefit: benefitAt(proofIndex), product: product }))
		proofIndex += 1
	}
	const lines = [hook].concat(middle.slice(0, middleCount), [cta])
	const scenes = lines.map(function (narration, i) {
		return {
			index: i + 1,
			narration: narration,
			onScreenText: i === 0 ? shortText(narration, 46) : shortText(narration, 40),
			visual: pickIndex(VISUALS, i + seed),
			motion: o.motion && o.motion !== 'auto' ? o.motion : pickIndex(MOTIONS, i + seed),
			duration: Math.max(sceneDuration, Math.ceil(estimateSpeechSeconds(narration) + 0.6)),
		}
	})
	const title = product + ' - ' + (ANGLES.find(function (a) {
		return a.id === angle
	}) || ANGLES[0]).label + (variant > 1 ? ' (variasi ' + variant + ')' : '')
	const tag = String(product).toLowerCase().replace(/[^a-z0-9]/g, '')
	return {
		source: 'local',
		title: title,
		hook: hook,
		angle: angle,
		persona: persona.id,
		voice: o.voice || persona.voice,
		variant: variant,
		scenes: scenes,
		caption: hook + ' ' + (benefits[0] ? benefits[0] + '. ' : '') + (brand.cta || 'Cek link sekarang.'),
		hashtags: brand.hashtags || '#fyp #review #racunbelanja' + (tag ? ' #' + tag : ''),
		cta: cta,
	}
}

/** Hook alternatif untuk variasi ke-N (dipakai saat skrip sudah diedit manual). */
function altHook(input, variant) {
	const o = input || {}
	const product = String(o.product || 'produk ini').trim() || 'produk ini'
	const angle = HOOKS[o.angle] ? o.angle : ANGLES[(hashString(product) + (Number(variant) || 1)) % ANGLES.length].id
	const list = HOOKS[angle] || HOOKS['review-jujur']
	const seed = hashString(product) + (Math.max(1, Number(variant) || 1) - 1)
	return fill(pickIndex(list, seed), { product: product, problem: o.problem || 'masalah yang bikin ribet tiap hari' })
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
		'Hindari kata: ' + (brand.bannedWords || '-') +
		(Number(o.variant) > 1
			? String.fromCharCode(10) + 'Ini variasi ke-' + Number(o.variant) + ' dari ' + (Number(o.variantCount) || Number(o.variant)) + ': buat hook, kalimat, dan urutan visual yang BERBEDA dari versi lain.'
			: '')
	const sceneCount = Math.max(2, Math.min(Number(o.sceneCount) || 5, 10))
	try {
		const data = await chatJson(system, user, { temperature: Number(o.variant) > 1 ? 0.95 : 0.8 })
		const scenes = (Array.isArray(data.scenes) ? data.scenes : [])
			.filter(function (scene) {
				return scene && String(scene.narration || '').trim()
			})
			.slice(0, sceneCount)
			.map(function (scene, i) {
				const narration = String(scene.narration).trim()
				return {
					index: i + 1,
					narration: narration,
					onScreenText: String(scene.onScreenText || '').trim() || shortText(narration, 40),
					visual: scene.visual || pickIndex(VISUALS, i),
					motion: MOTIONS.indexOf(scene.motion) !== -1 ? scene.motion : pickIndex(MOTIONS, i),
					duration: Math.max(Number(o.sceneDuration) || 5, Math.ceil(estimateSpeechSeconds(narration) + 0.6)),
				}
			})
		if (!scenes.length) {
			const fallback = localUgcScript(input)
			fallback.warning = 'LLM tidak mengembalikan scene, pakai generator lokal'
			return fallback
		}
		const persona = PERSONAS.find(function (p) {
			return p.id === o.persona
		})
		return {
			source: 'llm',
			title: data.title || o.product,
			hook: data.hook || scenes[0].narration,
			angle: o.angle || 'review-jujur',
			persona: o.persona || 'gen-z-casual',
			voice: o.voice || (persona && persona.voice) || 'nadia',
			variant: Number(o.variant) || 1,
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

const PODCAST_LINES = {
	opening: [
		'Halo semuanya, balik lagi bareng kita. Hari ini kita mau ngobrolin {topic}.',
		'Oke, topik kita kali ini {topic}. Jujur ini lagi sering banget aku denger.',
		'Selamat datang lagi. Kita bahas {topic} ya, soalnya banyak yang nanya.',
	],
	openingReply: [
		'Iya, dan menurutku ini pas banget dibahas sekarang, karena efeknya kerasa ke keseharian.',
		'Setuju. Banyak yang penasaran, tapi informasinya sering setengah-setengah.',
		'Betul, apalagi yang baru mulai, pasti bingung harus mulai dari mana.',
	],
	facts: [
		'Satu hal yang sering disalahpahami soal {topic}: hasilnya jarang instan.',
		'Yang bikin aku kaget, ternyata banyak orang berhenti justru di tahap awal.',
		'Kalau dilihat dari pengalaman banyak orang, kuncinya ada di kebiasaan kecil.',
		'Faktanya, yang paling berpengaruh itu bukan alatnya, tapi cara kita konsisten.',
	],
	experience: [
		'Aku pernah salah langkah waktu pertama coba, terlalu semangat di awal terus capek sendiri.',
		'Dulu aku kira harus sempurna dari awal. Ternyata malah bikin gak jalan-jalan.',
		'Pengalamanku, begitu targetnya dibuat kecil, justru lebih gampang dijalanin.',
		'Aku sempat bandingin diri sama orang lain, dan itu bikin semangat turun.',
	],
	tips: [
		'Kalau mau mulai, ambil satu langkah paling kecil dulu, misalnya lima belas menit sehari.',
		'Tips dari aku: catat progresnya, biar kelihatan perubahannya walau sedikit.',
		'Coba cari teman atau komunitas, biar ada yang ngingetin dan saling dukung.',
		'Jangan lupa evaluasi tiap minggu. Yang gak jalan, ganti caranya, bukan tujuannya.',
	],
	closing: [
		'Jadi kesimpulannya soal {topic}: mulai kecil, konsisten, lalu perbesar pelan-pelan.',
		'Intinya, {topic} itu perjalanan. Gak apa-apa pelan, asal gak berhenti.',
		'Oke, itu obrolan kita soal {topic} hari ini. Semoga ada yang bisa langsung dicoba.',
	],
	closingReply: [
		'Setuju. Buat kamu yang dengar, tulis di komentar langkah pertama yang mau kamu coba ya.',
		'Makasih udah dengerin sampai akhir. Sampai jumpa di episode berikutnya!',
		'Jangan lupa share ke teman yang butuh. Sampai ketemu lagi!',
	],
	reactions: ['Wah, bener juga.', 'Hmm, menarik.', 'Nah, ini penting.', 'Iya, aku relate banget.', 'Oke, masuk akal.', 'Setuju banget.'],
}

function localPodcastScript(input) {
	const o = input || {}
	const topic = String(o.topic || 'topik hari ini').trim() || 'topik hari ini'
	const hosts = (o.hosts && o.hosts.length ? o.hosts : [{ name: 'Host A', voice: 'host-a' }, { name: 'Host B', voice: 'host-b' }]).slice(0, 4)
	const minutes = Math.max(1, Math.min(Number(o.minutes) || 5, 60))
	const turns = Math.max(6, Math.round(minutes * 5))
	const seed = hashString(topic) + (Number(o.seed) || 0)
	const outline = [
		'Pembukaan dan kenapa ' + topic + ' penting sekarang',
		'Fakta yang sering disalahpahami soal ' + topic,
		'Pengalaman pribadi dan kesalahan umum',
		'Cara praktis yang bisa langsung dicoba',
		'Kesimpulan dan ajakan diskusi',
	]
	const used = {}
	const take = function (kind, i) {
		const list = PODCAST_LINES[kind]
		used[kind] = used[kind] || 0
		const line = list[(seed + i + used[kind]) % list.length]
		used[kind] += 1
		return fill(line, { topic: topic })
	}
	const bodyKinds = ['facts', 'experience', 'tips']
	const segments = []
	for (let i = 0; i < turns; i += 1) {
		let text
		if (i === 0) text = take('opening', i)
		else if (i === 1) text = take('openingReply', i)
		else if (i === turns - 2) text = take('closing', i)
		else if (i === turns - 1) text = take('closingReply', i)
		else {
			const phase = bodyKinds[Math.min(bodyKinds.length - 1, Math.floor(((i - 2) / Math.max(1, turns - 4)) * bodyKinds.length))]
			text = take(phase, i)
			if (i % 3 === 0) text = pickIndex(PODCAST_LINES.reactions, seed + i) + ' ' + text
		}
		const host = hosts[i % hosts.length]
		segments.push({ speaker: host.name, voice: host.voice || (i % 2 === 0 ? 'host-a' : 'host-b'), text: text })
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
		const segments = (Array.isArray(data.segments) ? data.segments : []).filter(function (segment) {
			return segment && String(segment.text || '').trim()
		}).map(function (segment, i) {
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
	testConnection: testConnection,
	generateUgcScript: generateUgcScript,
	localUgcScript: localUgcScript,
	generatePodcastScript: generatePodcastScript,
	localPodcastScript: localPodcastScript,
	videoPromptFor: videoPromptFor,
	imagePromptFor: imagePromptFor,
	captionFor: captionFor,
	altHook: altHook,
	shortText: shortText,
}
