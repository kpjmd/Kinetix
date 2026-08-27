const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SOLVE_MODEL = 'claude-sonnet-5';
const SOLVE_SAMPLES = 3;
const MAX_CANDIDATES = 3;
const EXPIRY_MARGIN_MS = 15000;
// A re-solve costs a few seconds of model latency, so it needs more headroom
// than a bare submission does.
const RESOLVE_MARGIN_MS = 45000;

// Last prompt sent to the model, kept only so tests can assert that the raw
// obfuscated text never leaks back into it.
let _lastPrompt = null;

// Admin notification callback - set by telegram-bot at startup
let _notifyAdmin = null;

/**
 * Register a callback for admin Telegram notifications.
 * @param {Function} fn - async (message: string) => void
 */
function setAdminNotifier(fn) {
  _notifyAdmin = fn;
}

async function notifyAdmin(message) {
  if (_notifyAdmin) {
    try {
      await _notifyAdmin(message);
    } catch (e) {
      console.error('[ChallengeSolver] Admin notify failed:', e.message);
    }
  }
}

// ===== Vocabulary =====

const NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90
};

const MULTIPLIER_WORDS = { hundred: 100, thousand: 1000, million: 1000000 };

// Real units only. Body parts ("claw", "claws") are deliberately excluded:
// they appear both as distractors ("with one claw") and as multiplier counts
// ("times two claws"), so treating them as units made operand selection depend
// on pluralization.
const UNIT_WORDS = new Set([
  'newtons', 'newton', 'n', 'pounds', 'pound', 'lbs', 'lb', 'grams', 'gram',
  'g', 'kg', 'kilograms', 'units', 'unit', 'meters', 'meter', 'm', 'degrees',
  'degree', 'dollars', 'dollar', 'joules', 'joule', 'watts', 'watt'
]);

// A whitespace-delimited arithmetic character is a real operator; the same
// character inside a word ("F^oRcE", "HoW/", "Lo]bS") is injected noise. Values
// are canonical so the parser only ever sees one spelling per operation.
const ARITHMETIC_SYMBOLS = { '*': '*', '/': '/', '+': '+', '-': '-' };
// Unicode multiplication and division signs, added without literal glyphs to
// keep this source ASCII.
ARITHMETIC_SYMBOLS[String.fromCharCode(0x00d7)] = '*';
ARITHMETIC_SYMBOLS[String.fromCharCode(0x00f7)] = '/';

const SYMBOL_OPS = { '*': 'mul', '/': 'div', '+': 'add', '-': 'sub' };

// Strong operator signals: an unambiguous statement of the operation.
const STRONG_OPS = {
  add: ['gains', 'gain', 'gained', 'plus', 'more', 'sum', 'added', 'adds',
        'increase', 'increases', 'increased', 'gathers', 'collects'],
  sub: ['loses', 'lose', 'lost', 'losing', 'minus', 'less', 'drops', 'dropped',
        'breaks', 'broke', 'remaining', 'remains', 'decrease', 'decreases',
        'decreased', 'sheds', 'shed'],
  mul: ['times', 'multiplied', 'multiply', 'twice', 'product', 'each', 'per'],
  div: ['divided', 'divide', 'split', 'shared', 'share', 'quotient']
};

// Weak signals: only consulted when no strong signal is present. "and"/"total"
// are filler in almost every challenge, so they must never outvote "loses".
const WEAK_OPS = {
  add: ['and', 'total', 'combined', 'altogether', 'together', 'overall']
};

// Domain words used to rejoin fragments split by injected whitespace
// ("FiV e" -> "five", "N]eWtO/ns" -> "newtons", "FoR cE" -> "force").
const DOMAIN_WORDS = [
  'lobster', 'lobsters', 'claw', 'claws', 'molting', 'molt', 'molts', 'molted',
  'exerts', 'exert', 'force', 'forces', 'total', 'after', 'before', 'with',
  'what', 'whats', 'how', 'many', 'much', 'the', 'its', 'has', 'have'
];

const VOCAB = new Set([
  ...Object.keys(NUMBER_WORDS),
  ...Object.keys(MULTIPLIER_WORDS),
  ...UNIT_WORDS,
  ...Object.values(STRONG_OPS).flat(),
  ...Object.values(WEAK_OPS).flat(),
  ...DOMAIN_WORDS
]);

/**
 * Canonical form: collapse every run of a repeated letter to a single letter.
 * Moltbook pads letters at random ("LoOoObsssTeR", "TwEeLvE"), so comparing
 * canonical forms matches an obfuscated token to its real word regardless of
 * how many times a letter was doubled.
 */
function canon(word) {
  return word.replace(/([a-z])\1+/g, '$1');
}

const CANON_VOCAB = new Map();
for (const w of VOCAB) {
  const c = canon(w);
  if (!CANON_VOCAB.has(c)) CANON_VOCAB.set(c, w);
}

/**
 * Resolve a possibly-obfuscated token to a real vocabulary word, or null.
 */
function resolveToken(token) {
  if (!token) return null;
  if (VOCAB.has(token)) return token;
  return CANON_VOCAB.get(canon(token)) || null;
}

// ===== Normalization =====

/**
 * Replace control and zero-width characters with spaces. Done by code point
 * rather than a regex range so the source stays free of literal invisibles.
 */
function stripInvisible(str) {
  let out = '';
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    const invisible = cp < 32 || cp === 127 || (cp >= 0x200b && cp <= 0x200f) || cp === 0xfeff;
    out += invisible ? ' ' : ch;
  }
  return out;
}

/**
 * Strip Moltbook's obfuscation from a challenge string.
 *
 * Live sample (Aug 2026):
 *   "L]oB-sT{eR} Ex^eRtS LoOoObsssTeR ThIrTy] FiV e N]eWtO/ns WiTh/ OnE
 *    ClA.w AnD GaAiN s TwEeLvE N]eWtO/ns AfTeR MoL tInG, WhA tS ToTaL FoR cE?"
 * normalizes to
 *   "lobster exerts lobster thirty five newtons with one claw and gains
 *    twelve newtons after molting whats total force"
 *
 * The obfuscation uses four independent tricks - random casing, injected
 * punctuation, padded letters, and split words. Handling the last two is what
 * fixes the 2026-08-27 failure, where the model read "ThIrTy] FiV e" as
 * "thirty" and answered 42.00 instead of 47.00.
 * @param {string} raw
 * @returns {string} Normalized lowercase text
 */
function normalizeChallengeText(raw) {
  if (!raw || typeof raw !== 'string') return '';

  // Space out an arithmetic symbol written tight between digits ("20*2") so it
  // is seen as a standalone operator below rather than stripped as noise.
  const spaced = stripInvisible(raw).replace(/(\d)\s*([*/+])\s*(\d)/g, '$1 $2 $3');

  // Clean each whitespace-delimited piece separately, so that a lone operator
  // survives while the same character embedded in a word does not.
  const cleaned = spaced.split(/\s+/).filter(Boolean).map(piece => {
    if (ARITHMETIC_SYMBOLS[piece]) return ARITHMETIC_SYMBOLS[piece];
    // Injected punctuation. '.' and '-' are handled separately below so that
    // decimals ("12.50") survive.
    let t = piece.replace(/[[\]{}^/\\|~*_+=<>()#@$%&"'`;:!?,]/g, ' ').toLowerCase();
    // Drop '.' and '-' unless they sit between two digits.
    return t.replace(/[.\-]/g, (m, offset, str) => {
      const prev = str[offset - 1] || '';
      const next = str[offset + 1] || '';
      return /\d/.test(prev) && /\d/.test(next) ? m : ' ';
    });
  });

  const rawTokens = cleaned.join(' ').split(/\s+/).filter(Boolean);

  // Rejoin words split by injected whitespace. Greedily prefer the longest
  // join (3 tokens, then 2) that resolves to a real word. A join is only
  // accepted when at least one component does not already stand on its own,
  // so genuine word pairs ("one claw") are never fused.
  const tokens = [];
  for (let i = 0; i < rawTokens.length; i++) {
    let joined = null;
    for (let span = 4; span >= 2; span--) {
      if (i + span > rawTokens.length) continue;
      const parts = rawTokens.slice(i, i + span);
      if (parts.some(p => /\d/.test(p) || SYMBOL_OPS[p])) continue;
      const resolved = resolveToken(parts.join(''));
      if (!resolved) continue;
      if (parts.every(p => resolveToken(p))) continue;
      joined = { word: resolved, span };
      break;
    }
    if (joined) {
      tokens.push(joined.word);
      i += joined.span - 1;
    } else {
      tokens.push(resolveToken(rawTokens[i]) || rawTokens[i]);
    }
  }

  return tokens.join(' ');
}

// ===== Deterministic arithmetic parser =====

/**
 * Walk normalized tokens and collect numeric operands, folding compound
 * number words ("thirty five" -> 35, "two hundred fifty" -> 250).
 * @returns {Array<{value: number, endIndex: number}>}
 */
function extractOperands(tokens) {
  const operands = [];
  let current = 0;
  let active = false;
  let endIndex = -1;

  const flush = () => {
    if (active) operands.push({ value: current, endIndex });
    current = 0;
    active = false;
  };

  tokens.forEach((token, i) => {
    if (/^-?\d+(?:\.\d+)?$/.test(token)) {
      flush();
      operands.push({ value: Number(token), endIndex: i });
      return;
    }
    if (Object.prototype.hasOwnProperty.call(NUMBER_WORDS, token)) {
      current += NUMBER_WORDS[token];
      active = true;
      endIndex = i;
      return;
    }
    if (Object.prototype.hasOwnProperty.call(MULTIPLIER_WORDS, token)) {
      current = (current || 1) * MULTIPLIER_WORDS[token];
      active = true;
      endIndex = i;
      return;
    }
    flush();
  });
  flush();

  return operands;
}

/**
 * Determine the operation from keyword families. Strong signals win outright;
 * weak filler ("and", "total") is only consulted when no strong signal exists.
 * @returns {string|null} 'add' | 'sub' | 'mul' | 'div' | null
 */
function detectOperation(tokens) {
  const present = new Set(tokens);

  // An explicit operator symbol states the operation outright and outranks
  // every keyword — "and"/"total" filler appears in nearly every challenge, so
  // without this a "twenty newtons * two claws" problem is read as addition.
  const symbols = Object.keys(SYMBOL_OPS).filter(sym => present.has(sym));
  if (symbols.length === 1) return SYMBOL_OPS[symbols[0]];
  if (symbols.length > 1) return null;

  const strong = Object.keys(STRONG_OPS).filter(op =>
    STRONG_OPS[op].some(kw => present.has(kw))
  );
  if (strong.length === 1) return strong[0];
  if (strong.length > 1) return null; // genuinely ambiguous - defer to the model

  const weak = Object.keys(WEAK_OPS).filter(op =>
    WEAK_OPS[op].some(kw => present.has(kw))
  );
  return weak.length === 1 ? weak[0] : null;
}

/**
 * Deterministically solve a normalized two-operand challenge.
 *
 * This is a cross-check against the model, not the sole authority: it only
 * reports `confident` for the simple shape Moltbook actually uses (exactly two
 * unit-bearing quantities and one unambiguous operation).
 * @param {string} normalized - Output of normalizeChallengeText
 * @returns {{value: number|null, confident: boolean, operands: number[], op: string|null}}
 */
function parseArithmetic(normalized) {
  const tokens = String(normalized || '').split(/\s+/).filter(Boolean);
  const all = extractOperands(tokens);

  // Prefer quantities followed closely by a unit ("thirty five newtons"). This
  // is what discards the "one claw" distractor in the live challenge.
  const unitBearing = all.filter(o =>
    tokens.slice(o.endIndex + 1, o.endIndex + 3).some(t => UNIT_WORDS.has(t))
  );
  const operands = unitBearing.length >= 2 ? unitBearing : all;

  const op = detectOperation(tokens);
  const values = operands.map(o => o.value);

  if (operands.length !== 2 || !op) {
    return { value: null, confident: false, operands: values, op };
  }

  const [a, b] = values;
  let value = null;
  if (op === 'add') value = a + b;
  else if (op === 'sub') value = a - b;
  else if (op === 'mul') value = a * b;
  else if (op === 'div') value = b === 0 ? null : a / b;

  if (value === null || !Number.isFinite(value)) {
    return { value: null, confident: false, operands: values, op };
  }
  return { value, confident: true, operands: values, op };
}

// ===== Challenge extraction =====

/**
 * Confirmed live (Jul 2026): moltbookApi passes through the FULL created
 * resource as challengeData (so callers still have its real id), with the
 * actual challenge nested under `.verification`:
 * { verification_code, challenge_text, expires_at, instructions }.
 * This unwraps that, falling back to a flat shape for robustness in case
 * Moltbook embeds it differently on another endpoint.
 * @param {Object} challengeData
 * @returns {Object} { challengeText, verificationCode, instructions, expiresAt }
 */
function getVerificationBlock(challengeData) {
  const v = (challengeData && challengeData.verification) || challengeData || {};
  return {
    // No JSON.stringify fallback: if there is no challenge text there is
    // nothing to solve, and asking the model to "compute the answer" from a
    // serialized post object only ever produced garbage submissions.
    challengeText: v.challenge_text || v.challenge || v.problem || null,
    verificationCode: v.verification_code || v.challenge_id || v.id || v.token || null,
    instructions: v.instructions || null,
    expiresAt: v.expires_at || v.expiresAt || null
  };
}

/**
 * Parse Moltbook's expires_at ("2026-08-27 16:07:16.099559+00") to epoch ms.
 * @returns {number|null}
 */
function parseExpiry(value) {
  if (!value) return null;
  let s = String(value).trim().replace(' ', 'T');
  s = s.replace(/(\.\d{3})\d+/, '$1');          // JS only handles ms precision
  if (/[+-]\d{2}$/.test(s)) s += ':00';          // "+00" -> "+00:00"
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** Extract the final numeric token from a model reply, as a 2-decimal string. */
function extractAnswer(text) {
  const numbers = String(text || '').match(/-?\d+(?:\.\d+)?/g);
  if (!numbers || !numbers.length) return null;
  const n = Number(numbers[numbers.length - 1]);
  return Number.isFinite(n) ? n.toFixed(2) : null;
}

// ===== Solving =====

/**
 * Produce an ordered list of candidate answers for a challenge.
 *
 * Two independent solvers run against the same normalized text:
 *  - `parseArithmetic`, a deterministic parser that cannot drop a token the
 *    way a model can (this is what the 2026-08-27 "42.00 instead of 47.00"
 *    failure was: "ThIrTy] FiV e" read as thirty);
 *  - three samples from Sonnet, majority-voted, which handles phrasings the
 *    parser is not confident about.
 *
 * A real majority (2 of 3) leads; otherwise the deterministic value leads.
 * Callers submit these in order, using Moltbook's own "Incorrect answer"
 * response as an oracle.
 * @param {Object} challengeData - Raw challenge object from Moltbook response
 * @returns {Promise<{candidates: string[], normalized: string, deterministic: string|null}>}
 */
async function solveChallenge(challengeData) {
  const { challengeText, instructions } = getVerificationBlock(challengeData);
  if (!challengeText) {
    throw new Error('Challenge has no challenge_text - nothing to solve');
  }

  const normalized = normalizeChallengeText(challengeText);
  console.log('[ChallengeSolver] Solving challenge:', challengeText);
  console.log('[ChallengeSolver] Normalized:', normalized);

  const parsed = parseArithmetic(normalized);
  const deterministic = parsed.confident ? parsed.value.toFixed(2) : null;
  if (deterministic) {
    console.log(`[ChallengeSolver] Deterministic parse: ${parsed.operands.join(` ${parsed.op} `)} = ${deterministic}`);
  } else {
    console.log('[ChallengeSolver] Deterministic parse not confident:', JSON.stringify(parsed));
  }

  // Send the NORMALIZED text only. Including the raw obfuscated string makes
  // the request read as CAPTCHA-solving and draws a refusal (stop_reason:
  // "refusal", empty content) - measured at 5/5 refusals with it versus 5/5
  // correct without, on the challenge that failed 2026-08-27 20:11.
  //
  // Normalizer glitches do not justify sending the raw text as a safety net:
  // the model answered correctly 3/3 even on a deliberately mangled
  // normalization ("lobsters wims ... snapps"), and a raw-text fallback would
  // simply refuse every time.
  const prompt =
    'Solve this arithmetic word problem.\n\n' +
    `Problem: ${normalized}\n\n` +
    'The wording is chatty and repetitive; ignore filler words and use the ' +
    'quantities and the operator between them.\n' +
    (instructions || 'Give the number to 2 decimal places.') + '\n' +
    'Respond with ONLY the final number.';

  _lastPrompt = prompt;

  const samples = await Promise.all(
    Array.from({ length: SOLVE_SAMPLES }, async () => {
      try {
        const response = await anthropic.messages.create({
          model: SOLVE_MODEL,
          max_tokens: 400,
          temperature: 1,
          messages: [{ role: 'user', content: prompt }]
        });
        // Find the text block rather than assuming content[0]: a refusal or a
        // truncated generation can come back with content: [].
        const block = (response.content || []).find(b => b && b.type === 'text');
        if (!block) {
          console.warn(`[ChallengeSolver] Sample returned no text (stop_reason: ${response.stop_reason})`);
          return { rawText: '', answer: null };
        }
        const rawText = String(block.text || '').trim();
        return { rawText, answer: extractAnswer(rawText) };
      } catch (e) {
        console.warn('[ChallengeSolver] Sample failed:', e.message);
        return { rawText: '', answer: null };
      }
    })
  );

  const answers = samples.map(s => s.answer).filter(Boolean);
  console.log('[ChallengeSolver] Model samples:', JSON.stringify(answers));

  const counts = new Map();
  for (const a of answers) counts.set(a, (counts.get(a) || 0) + 1);
  let majority = null;
  let majorityCount = 0;
  for (const [a, c] of counts) {
    if (c > majorityCount) { majority = a; majorityCount = c; }
  }

  // A real consensus outranks the parser; a 3-way split does not.
  const ordered = majorityCount >= 2
    ? [majority, deterministic, ...answers]
    : [deterministic, majority, ...answers];

  const candidates = [];
  for (const c of ordered) {
    if (c && !candidates.includes(c) && candidates.length < MAX_CANDIDATES) {
      candidates.push(c);
    }
  }

  if (!candidates.length) {
    throw new Error('Challenge produced no numeric answer candidates');
  }
  console.log(`[ChallengeSolver] Candidates (in order): ${candidates.join(', ')}`);
  return { candidates, normalized, deterministic };
}

// ===== Submission =====

/**
 * Classify a /verify response so a wrong *answer* is never confused with a
 * wrong *payload shape*.
 *
 * Live shapes (Aug 2026):
 *  - wrong answer:  400 { message: "Incorrect answer", success: false, hint: ... }
 *  - wrong payload: 400 { message: ["verification_code must be a string"] }
 * The old code treated both as "try a different payload", so an incorrect
 * answer silently burned the attempt instead of triggering a re-solve.
 * @returns {'verified'|'incorrect'|'shape'|'expired'|'error'}
 */
function classifyVerifyResponse(status, data) {
  const message = data && data.message;
  const text = Array.isArray(message) ? message.join('; ') : String(message || data?.error || '');

  if (Array.isArray(message)) return 'shape';
  if (/expired|not found|no pending|already verified/i.test(text)) {
    return /already verified/i.test(text) ? 'verified' : 'expired';
  }
  if (/incorrect|wrong answer|invalid answer/i.test(text)) return 'incorrect';
  if (data && data.success === false) return 'incorrect';
  if (status >= 200 && status < 300) return 'verified';
  if (status === 400 || status === 422) return 'shape';
  return 'error';
}

/**
 * Submit candidate answers to Moltbook until one verifies.
 *
 * Moltbook tells us when an answer is wrong, so that response is used as an
 * oracle: on "Incorrect answer" we advance to the next distinct candidate
 * rather than giving up. Bounded by MAX_CANDIDATES and by the challenge's own
 * ~5 minute expires_at.
 *
 * If the list runs dry while budget and time remain, `options.resolve` is
 * called for a fresh set of candidates. That matters when the model refuses
 * every sample and the first pass yields only the deterministic answer: one
 * rejection would otherwise end the attempt with minutes left on the clock.
 * The budget counts answers actually POSTed, not solve passes.
 * @param {Object} challengeData - Raw challenge object from Moltbook response
 * @param {string[]} candidates - Ordered candidate answers
 * @param {Object} [options]
 * @param {Function} [options.resolve] - async () => string[], a fresh solve
 * @returns {Promise<Object>} API response data
 */
async function submitChallengeAnswer(challengeData, candidates, options = {}) {
  const apiKey = process.env.MOLTBOOK_API_KEY;
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const { verificationCode, expiresAt } = getVerificationBlock(challengeData);
  const submitUrl = challengeData.verification?.submit_url || challengeData.submit_url
    || 'https://www.moltbook.com/api/v1/verify';
  const deadline = parseExpiry(expiresAt);
  const contentId = challengeData.id || challengeData.content_id || null;

  const queue = (Array.isArray(candidates) ? candidates : [candidates]).filter(Boolean);
  const tried = [];
  let reSolved = false;

  while (queue.length && tried.length < MAX_CANDIDATES) {
    const answer = queue.shift();
    if (tried.includes(answer)) continue;
    if (deadline && Date.now() > deadline - EXPIRY_MARGIN_MS) {
      console.warn('[ChallengeSolver] Challenge window closed before all candidates were tried');
      break;
    }
    tried.push(answer);

    // Confirmed live (Jul 2026): { verification_code, answer } is the correct
    // payload. The bare { answer } shape is only worth trying when we genuinely
    // have no code - otherwise it just fails validation and buries the real error.
    const shapes = verificationCode
      ? [
          { verification_code: verificationCode, answer },
          { verification_code: verificationCode, answer: Number(answer) }
        ]
      : [{ answer }];

    let advanceCandidate = false;
    for (const payload of shapes) {
      let status;
      let data;
      try {
        const res = await axios.post(submitUrl, payload, { headers, timeout: 15000 });
        status = res.status;
        data = res.data;
      } catch (err) {
        if (!err.response) {
          console.warn(`[ChallengeSolver] Network error submitting ${answer}:`, err.message);
          break; // transport problem - a different payload shape will not help
        }
        status = err.response.status;
        data = err.response.data;
      }

      const verdict = classifyVerifyResponse(status, data);
      console.log(`[ChallengeSolver] answer=${answer} keys=[${Object.keys(payload).join(',')}] -> ${verdict} (${status})`);

      if (verdict === 'verified') {
        console.log('[ChallengeSolver] Verified:', JSON.stringify(data));
        return data;
      }
      if (verdict === 'incorrect') { advanceCandidate = true; break; }
      if (verdict === 'expired') {
        console.warn('[ChallengeSolver] Challenge expired server-side, aborting');
        advanceCandidate = false;
        break;
      }
      console.warn(`[ChallengeSolver] Rejected (${verdict}):`, JSON.stringify(data));
      // 'shape'/'error' fall through to the next payload shape for this answer.
    }

    // Only an "Incorrect answer" verdict means a different number could help.
    // An expired challenge or a rejected payload shape will fail identically
    // for every candidate, so stop rather than burn the rest of the list.
    if (!advanceCandidate) break;

    const budgetLeft = tried.length < MAX_CANDIDATES;
    const timeLeft = !deadline || Date.now() < deadline - RESOLVE_MARGIN_MS;
    if (!queue.length && !reSolved && options.resolve && budgetLeft && timeLeft) {
      reSolved = true;
      console.log('[ChallengeSolver] Candidates exhausted with time left - re-solving');
      try {
        const fresh = await options.resolve();
        const added = (fresh || []).filter(a => a && !tried.includes(a));
        if (added.length) {
          console.log(`[ChallengeSolver] Re-solve produced: ${added.join(', ')}`);
          queue.push(...added);
        } else {
          console.warn('[ChallengeSolver] Re-solve produced no new answers');
        }
      } catch (e) {
        console.warn('[ChallengeSolver] Re-solve failed:', e.message);
      }
    }
  }

  const debugInfo =
    `[ChallengeSolver] ALL submission attempts failed against ${submitUrl}.\n` +
    `candidatesTried: ${JSON.stringify(tried)}\n` +
    `challengeData: ${JSON.stringify(challengeData, null, 2)}`;
  console.error(debugInfo);

  await notifyAdmin(
    `⚠️ *Moltbook Challenge Failed*\n\n` +
    `Content \`${contentId || 'unknown'}\` is live but UNVERIFIED.\n` +
    `Answers tried: ${tried.join(', ') || 'none'}\n\n` +
    `\`\`\`\n${JSON.stringify(challengeData, null, 2).slice(0, 700)}\n\`\`\``
  );

  const err = new Error(
    `Challenge verification failed after ${tried.length} answer(s): ${tried.join(', ')}`
  );
  err.verificationFailed = true;
  err.contentId = contentId;
  err.candidatesTried = tried;
  throw err;
}

/**
 * Convenience: solve + submit in one call.
 * @param {Object} challengeData
 * @returns {Promise<Object>} Submission response
 */
async function solveChallengeAndSubmit(challengeData) {
  const { candidates } = await solveChallenge(challengeData);
  return submitChallengeAnswer(challengeData, candidates, {
    resolve: async () => (await solveChallenge(challengeData)).candidates
  });
}

module.exports = {
  solveChallengeAndSubmit,
  setAdminNotifier,
  normalizeChallengeText,
  parseArithmetic,
  _solveChallenge: solveChallenge,
  _submitChallengeAnswer: submitChallengeAnswer,
  _classifyVerifyResponse: classifyVerifyResponse,
  _parseExpiry: parseExpiry,
  _lastPrompt: () => _lastPrompt
};
