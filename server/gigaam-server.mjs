/**
 * GigaAM v3 CTC (with punctuation) speech recognition server.
 *
 * Speaks exactly the contract that @goodandready/dsh-voice expects from its
 * `sensevoice` provider (lib/providers.js):
 *   POST <url>            multipart/form-data, field "file" = 16 kHz mono WAV
 *   -> 200 {"text": "..."}
 *   GET  /                200, used as the provider's health probe
 *
 * Runs on plain Node with the sherpa-onnx native runtime copied next to it,
 * so it does not depend on Electron, asar internals or the DSH host.
 */
import { createServer, request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';

const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');

const MODEL_DIR = process.env.GIGAAM_DIR || '<DSH_VOICE>/models/gigaam-ctc-punct';
const MODEL = `${MODEL_DIR}/model.int8.onnx`;
const TOKENS = `${MODEL_DIR}/tokens.txt`;
const DICT_FILE = process.env.GIGAAM_DICT || `${import.meta.dirname}/ru-frequency.txt`;
const PORT = Number(process.env.GIGAAM_PORT || 6006);
const PUNCT_PORT = Number(process.env.PUNCT_PORT || 6008);
const HOST = process.env.GIGAAM_HOST || '127.0.0.1';
const THREADS = Number(process.env.GIGAAM_THREADS || 4);
const MAX_BYTES = Number(process.env.GIGAAM_MAX_BYTES || 32 * 1024 * 1024);

/**
 * Russian word frequencies, used to repair words the recogniser heard almost right.
 * Only a small set of typical confusions is tried (vowels е/и, о/а, я/е, ё/е,
 * soft sign, doubled letters), because those are what speech recognition actually
 * produces - a general edit-distance search would happily invent other words.
 */
const dictionary = new Map();
try {
  for (const line of readFileSync(DICT_FILE, 'utf8').split('\n')) {
    const [word, count] = line.trim().split(' ');
    if (!word || !count) continue;
    if (!/^[а-яё-]{2,}$/i.test(word)) continue;
    dictionary.set(word.toLowerCase(), Number(count));
  }
  logDict(dictionary.size);
} catch {
  logDict(0);
}

function logDict(size) {
  process.stdout.write(`[gigaam] spellcheck dictionary: ${size} words\n`);
}

const VOWELS = [['е', 'и'], ['о', 'а'], ['я', 'е'], ['ё', 'е'], ['и', 'е'], ['а', 'о']];
const LETTERS = 'аеёиоуыэюябвгджзклмнпрстфхцчшщьъ';

function candidates(word) {
  const set = new Set();
  for (const [from, to] of VOWELS) {
    for (let i = 0; i < word.length; i += 1) {
      if (word[i] === from) set.add(word.slice(0, i) + to + word.slice(i + 1));
      if (word[i] === to) set.add(word.slice(0, i) + from + word.slice(i + 1));
    }
  }
  // Speech recognition drops, doubles and splits letters; try both directions.
  for (let i = 0; i < word.length; i += 1) {
    set.add(word.slice(0, i) + word.slice(i + 1));
    for (const letter of LETTERS) set.add(word.slice(0, i) + letter + word.slice(i));
  }
  return set;
}

/** Replace a word only when exactly one plausible dictionary form fits. */
function fixWord(word) {
  if (dictionary.size === 0) return word;
  const lower = word.toLowerCase();
  if (lower.length < 4) return word;
  if (dictionary.has(lower)) return word;
  let best = null;
  let bestCount = 0;
  let ties = 0;
  for (const candidate of candidates(lower)) {
    const count = dictionary.get(candidate);
    if (!count) continue;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
      ties = 1;
    } else if (count === bestCount) {
      ties += 1;
    }
  }
  if (!best || ties > 1) return word;
  // A rare "fix" is more likely to be a name or a term than a mistake.
  if (bestCount < 300) return word;
  if (word[0] === word[0].toUpperCase()) return best[0].toUpperCase() + best.slice(1);
  return best;
}

function spellcheck(text) {
  return text.replace(/[А-Яа-яЁё-]+/g, (word) => fixWord(word));
}

/**
 * Вопросительный знак вместо точки, когда фраза явно вопрос.
 *
 * Модель ставит пунктуацию сама, но иногда заканчивает вопрос точкой.
 * Проверяется последнее предложение реплики (вопрос обычно идёт после
 * утверждения) и в нём — начало, частица «ли», союз с вопросным словом в
 * последнем придаточном и глагол во втором лице в конце. Знаки внутри, кроме
 * конца фразы, не трогаются.
 */
const QUESTION_START = /^(?:что|кто|как|где|когда|куда|откуда|почему|зачем|сколько|какой|какая|какие|каким|чей|чья|чьё|можно|нужно|стоит|есть|будет|будут|можешь|может|хочешь|хотите|правда|верно|разве|неужели)(?=[\s,.!?]|$)/iu;
const HAS_LI = /(^|\s)ли([,.!?]|\s|$)/i;
// Второе лицо в конце фразы тоже выдаёт вопрос: «ты меня слышишь», «можешь».
const SECOND_PERSON_END = /(?:ешь|ишь|ете|ите|ёшь)$/iu;
// Вопрос с союзом в последнем придаточном: «Всё хорошо, а как у тебя».
// Смотрим только последнее придаточное, иначе «Это было давно, но где —
// не помню» тоже стало бы вопросом.
const CONJUNCTION_QUESTION = /^(?:а|но|и)\s+(?:что|кто|как|где|когда|куда|откуда|почему|зачем|сколько|какой|какая|какие|каким|чей|чья|чьё|можно|нужно|стоит|есть|будет|будут|можешь|может|хочешь|хотите|правда|верно|разве|неужели)(?=[\s,.!?]|$)/iu;
const CLAUSE_SEP = /[,;:]\s+|\s+[—–-]\s+/g;

/** Начало последнего предложения: всё после последней точки, «?», «!» или «…». */
function lastSentenceStart(text) {
  let start = 0;
  const re = /[.!?…]+["»)]?\s+/g;
  let match;
  while ((match = re.exec(text)) !== null) start = match.index + match[0].length;
  return start;
}

/** Последнее придаточное: после последней запятой, двоеточия или тире. */
function lastClause(text) {
  let start = 0;
  CLAUSE_SEP.lastIndex = 0;
  let match;
  while ((match = CLAUSE_SEP.exec(text)) !== null) start = match.index + match[0].length;
  return text.slice(start).trim();
}

function fixQuestion(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return trimmed;
  // Реплика бывает из нескольких предложений, и вопрос обычно последний
  // («Настя, привет. Я начал новую сессию. Как меня слышно.»). Смотрим именно
  // последнее предложение: раньше проверялось начало всей реплики, и такой
  // вопрос оставался с точкой.
  const tail = trimmed.slice(lastSentenceStart(trimmed)).replace(/[.,!?…]+$/, '').trim();
  const words = tail.split(/\s+/);
  const lastWord = words[words.length - 1] || '';
  const looksLikeQuestion = QUESTION_START.test(tail)
    || HAS_LI.test(tail)
    || CONJUNCTION_QUESTION.test(lastClause(tail))
    || SECOND_PERSON_END.test(lastWord);
  if (/[?!…]$/.test(trimmed)) return trimmed;
  if (trimmed.endsWith('.')) return looksLikeQuestion ? `${trimmed.slice(0, -1)}?` : trimmed;
  return trimmed + (looksLikeQuestion ? '?' : '.');
}


function log(...args) {
  process.stdout.write(`[gigaam] ${args.join(' ')}\n`);
}

log(`loading model: ${MODEL_DIR}`);
const recognizer = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    nemoCtc: { model: MODEL },
    tokens: TOKENS,
    numThreads: THREADS,
    provider: 'cpu',
    debug: 0,
  },
});
log('model ready');

// The native recognizer is not safe to drive from parallel callers, so the
// server serialises inference while still accepting concurrent connections.
let queue = Promise.resolve();
function serialize(task) {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Parse a RIFF/WAVE buffer into float samples.
 * The package exposes `readWave` (path only) but no binary reader, so the
 * canonical 16 kHz mono PCM16 file produced by ffmpeg is parsed directly.
 * @param {Buffer} bytes
 * @returns {{samples: Float32Array, sampleRate: number}}
 */
function decodeWave(bytes) {
  const bad = (message) => Object.assign(new Error(message), { status: 400 });
  if (bytes.length < 44) throw bad('audio is too short to be a WAV file');
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw bad('expected a RIFF/WAVE file');
  }

  let format = null;
  let data = null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= bytes.length) {
      format = {
        audioFormat: bytes.readUInt16LE(body),
        channels: bytes.readUInt16LE(body + 2),
        sampleRate: bytes.readUInt32LE(body + 4),
        bitsPerSample: bytes.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = bytes.subarray(body, Math.min(body + size, bytes.length));
    }
    offset = body + size + (size % 2);
  }

  if (!format) throw bad('WAV has no fmt chunk');
  if (!data || data.length === 0) throw bad('WAV has no audio data');
  if (format.audioFormat !== 1) throw bad(`expected uncompressed PCM, got format ${format.audioFormat}`);
  if (format.channels !== 1) throw bad(`expected mono audio, got ${format.channels} channels`);
  if (format.bitsPerSample !== 16) throw bad(`expected 16-bit audio, got ${format.bitsPerSample} bits`);
  if (format.sampleRate !== 16000) throw bad(`expected 16 kHz audio, got ${format.sampleRate} Hz`);

  const count = Math.floor(data.length / 2);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i += 1) samples[i] = data.readInt16LE(i * 2) / 32768;
  return { samples, sampleRate: format.sampleRate };
}

/**
 * Отдаёт текст пунктуатору (RUPunct, порт 6008): он расставляет запятые,
 * точки, вопросы и заглавные буквы. Если сервис не отвечает — возвращаем
 * текст как есть, чтобы распознавание не ломалось.
 */
function punctuate(text) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ text });
    let done = false;
    const finish = (value) => {
      if (!done) {
        done = true;
        resolve(value);
      }
    };
    const request = httpRequest({
      host: '127.0.0.1',
      port: PUNCT_PORT,
      path: '/',
      method: 'POST',
      timeout: 1500,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (answer) => {
      let data = '';
      answer.on('data', (chunk) => { data += chunk; });
      answer.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          finish(parsed && parsed.text ? parsed.text : text);
        } catch (_e) {
          finish(text);
        }
      });
    });
    request.on('error', () => finish(text));
    request.on('timeout', () => { request.destroy(); finish(text); });
    request.end(payload);
  });
}

async function transcribe(wavBytes) {
  const wave = decodeWave(wavBytes);
  const started = Date.now();
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples });
  recognizer.decode(stream);
  const raw = String(recognizer.getResult(stream).text || '').replace(/\s+/g, ' ').trim();
  const text = fixQuestion(spellcheck(raw));  // своя пунктуация + вопрос
  return { text, raw, tookMs: Date.now() - started, sampleCount: wave.samples.length };
}

function sendJson(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readMultipartFile(req) {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) {
    throw Object.assign(new Error('expected multipart/form-data'), { status: 415 });
  }
  const web = new Request('http://127.0.0.1/', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: Readable.toWeb(req),
    duplex: 'half',
  });
  const form = await web.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string') {
    throw Object.assign(new Error('multipart field "file" is missing'), { status: 400 });
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length < 44) throw Object.assign(new Error('audio is empty or truncated'), { status: 400 });
  if (bytes.length > MAX_BYTES) throw Object.assign(new Error(`audio exceeds ${MAX_BYTES} bytes`), { status: 413 });
  return bytes;
}

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}`);

  // Health probe used by dsh-voice before it calls the provider.
  if (req.method === 'GET') {
    sendJson(res, 200, { ok: true, provider: 'gigaam-v3-ctc-punct', path: url.pathname });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  (async () => {
    try {
      const bytes = await readMultipartFile(req);
      const result = await serialize(() => transcribe(bytes));
      log(`transcribed ${(bytes.length / 1024).toFixed(0)} KiB in ${result.tookMs} ms -> ${result.text.length} chars`);
      sendJson(res, 200, { text: result.text });
    } catch (error) {
      const status = error && error.status ? error.status : 500;
      if (status >= 500) log(`ERROR ${error && error.message ? error.message : error}`);
      sendJson(res, status, { error: error && error.message ? error.message : String(error) });
    }
  })();
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
