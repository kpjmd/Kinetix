// Regression test for the Aug 2026 wrong-answer bug. Moltbook's challenge
// obfuscates text four ways at once: random casing, injected punctuation,
// padded letters, and words split by spaces. On 2026-08-27 the solver read
// "ThIrTy] FiV e" as "thirty" and submitted 42.00 (30 + 12) for a challenge
// whose answer was 47.00 (35 + 12) — the split-off "e" was dropped.
//
// These tests exercise the deobfuscator and the deterministic parser with no
// model in the loop, so the arithmetic itself is pinned.

const {
  normalizeChallengeText,
  parseArithmetic
} = require('../utils/challenge-solver');

// The exact challenge_text from the failing 2026-08-27 16:02 heartbeat.
const LIVE_CHALLENGE =
  'L]oB-sT{eR} Ex^eRtS LoOoObsssTeR ThIrTy] FiV e N]eWtO/ns WiTh/ OnE ClA.w ' +
  'AnD GaAiN s TwEeLvE N]eWtO/ns AfTeR MoL tInG, WhA tS ToTaL FoR cE?';

// ...and from the 2026-08-27 20:11 heartbeat, which answered 22.00 (20 + 2)
// for a problem whose "*" had been stripped as if it were injected noise.
// From the 2026-08-28 20:00 heartbeat. "fOuR tEeN" normalized to "four ten"
// because canon("teen") === "ten", a real vocabulary word, so the rejoin guard
// treated both halves as standalone and never formed "fourteen".
const LIVE_FOURTEEN =
  "A] lO b-StEr'S^ cLaW- eXeRrT S^tWeN tYy sIiX- nEwToNs] , aNd- ThE/ oThEr^ " +
  'cLaW- eXeRrTs^ fOuR tEeN- nEeWtOnS~ hOw/ mAnY^ nEwToNs- ToTaL? umm lxobqstwer';

const LIVE_MULTIPLY =
  'Lo]bS-tEr S^wImS Um, LiKe, LoOooObSsStEr, AnD iT sNaPpS ClAwS LiKe ThIs: ' +
  'C lA]w F^oRcE Is TwEnTy ~ NeWtOnS * TwO { ClAwS } Um, HoW/ MuCh ToTaL FoRcE?';

const solve = text => parseArithmetic(normalizeChallengeText(text));

describe('normalizeChallengeText', () => {
  it('deobfuscates the live 2026-08-27 challenge', () => {
    expect(normalizeChallengeText(LIVE_CHALLENGE)).toBe(
      'lobster exerts lobster thirty five newtons with one claw and gains ' +
      'twelve newtons after molting whats total force'
    );
  });

  it('rejoins a number word split by an injected space ("FiV e" -> "five")', () => {
    expect(normalizeChallengeText('ThIrTy] FiV e')).toBe('thirty five');
  });

  it('collapses padded letters ("LoOoObsssTeR" -> "lobster")', () => {
    expect(normalizeChallengeText('LoOoObsssTeR')).toBe('lobster');
  });

  it('collapses a doubled letter that is not doubled in the real word', () => {
    expect(normalizeChallengeText('TwEeLvE')).toBe('twelve');
  });

  it('rejoins a word split into four fragments ("L]oB-sT{eR}")', () => {
    expect(normalizeChallengeText('L]oB-sT{eR}')).toBe('lobster');
  });

  it('preserves decimals while stripping injected dots', () => {
    expect(normalizeChallengeText('ClA.w 12.50 N]eWtO/ns')).toBe('claw 12.50 newtons');
  });

  it('returns an empty string for missing or non-string input', () => {
    expect(normalizeChallengeText(null)).toBe('');
    expect(normalizeChallengeText(undefined)).toBe('');
    expect(normalizeChallengeText(42)).toBe('');
  });
});

describe('parseArithmetic', () => {
  it('solves the live 2026-08-27 challenge as 47, not 42', () => {
    const result = solve(LIVE_CHALLENGE);
    expect(result.confident).toBe(true);
    expect(result.value).toBe(47);
    expect(result.op).toBe('add');
  });

  it('ignores the "one claw" distractor by preferring unit-bearing operands', () => {
    expect(solve(LIVE_CHALLENGE).operands).toEqual([35, 12]);
  });

  it('folds compound number words including hundreds', () => {
    const result = solve('LoBsTeR ExErTs TwO HuNdReD FiFtY NeWtOnS aNd GaInS ThReE NeWtOnS');
    expect(result.value).toBe(253);
  });

  it('subtracts when a strong signal outranks the "and" filler', () => {
    const result = solve('A LoBsTeR hAs FoRtY N]eWtO/ns aNd LoOoSeS tWeElVe NeWtOnS, hOw MaNy ReMaIn?');
    expect(result).toMatchObject({ value: 28, op: 'sub', confident: true });
  });

  it('multiplies on "each"', () => {
    const result = solve('EaCh Of SiX lObStErS eXeRtS sE vE n NeWtOnS, WhAtS tHe ToTaL?');
    expect(result).toMatchObject({ value: 42, op: 'mul', confident: true });
  });

  it('divides on "divided"', () => {
    const result = solve('FoRtY EiGhT NeWtOnS dIvIdEd By SiX NeWtOnS');
    expect(result).toMatchObject({ value: 8, op: 'div', confident: true });
  });

  it('handles bare numerals as operands', () => {
    expect(solve('lobster exerts 32 newtons and gains 16 newtons').value).toBe(48);
  });

  it('is not confident when two strong operations conflict', () => {
    const result = solve('lobster gains ten newtons and loses four newtons');
    expect(result.confident).toBe(false);
    expect(result.op).toBeNull();
  });

  it('is not confident when there are not exactly two operands', () => {
    expect(solve('lobster gains ten newtons').confident).toBe(false);
    expect(solve('lobster has no claws').confident).toBe(false);
  });

  it('is not confident with no operator signal at all', () => {
    expect(solve('ten newtons twelve newtons').confident).toBe(false);
  });
});

describe('arithmetic operators survive normalization', () => {
  it('keeps a standalone operator but drops the same character mid-word', () => {
    // "*" is a real operator; "^" in F^oRcE and "/" in HoW/ are injected noise.
    expect(normalizeChallengeText('F^oRcE Is TwEnTy * TwO HoW/ MuCh'))
      .toBe('force is twenty * two how much');
  });

  it('drops a standalone character that is not an arithmetic operator', () => {
    expect(normalizeChallengeText('TwEnTy ~ NeWtOnS')).toBe('twenty newtons');
  });

  it('separates an operator written tight between digits', () => {
    expect(normalizeChallengeText('20*2 NeWtOnS')).toBe('20 * 2 newtons');
  });

  it('keeps each of the four operators', () => {
    expect(normalizeChallengeText('two + two')).toBe('two + two');
    expect(normalizeChallengeText('two - two')).toBe('two - two');
    expect(normalizeChallengeText('two / two')).toBe('two / two');
    expect(normalizeChallengeText('two * two')).toBe('two * two');
  });
});

describe('parseArithmetic operator symbols', () => {
  it('solves the live 2026-08-27 20:11 challenge as 40, not 22', () => {
    const result = solve(LIVE_MULTIPLY);
    expect(result).toMatchObject({ value: 40, op: 'mul', confident: true });
  });

  it('lets an operator symbol outrank the "and"/"total" filler', () => {
    // "and" and "total" are both present and both say add; "*" wins.
    expect(solve('lobster and it has twenty newtons * two claws total').op).toBe('mul');
  });

  it('reads each symbol as its own operation', () => {
    expect(solve('forty eight newtons / six').value).toBe(8);
    expect(solve('forty newtons - twelve newtons and total').value).toBe(28);
    expect(solve('thirty two newtons + sixteen newtons total').value).toBe(48);
  });

  it('is not confident when two different symbols appear', () => {
    expect(solve('two + two * two').confident).toBe(false);
  });
});

describe('compound number words split by a space', () => {
  it('rebuilds "fourteen" from the live 2026-08-28 challenge', () => {
    expect(normalizeChallengeText(LIVE_FOURTEEN)).toContain('exerts fourteen newtons');
  });

  it('solves that challenge as 40, not 66', () => {
    expect(solve(LIVE_FOURTEEN)).toMatchObject({ value: 40, op: 'add', confident: true });
  });

  it('joins a teen even though its halves both resolve on their own', () => {
    // "four" is vocabulary and "teen" canon-resolves to "ten", so the
    // stand-alone guard would otherwise skip this join.
    expect(normalizeChallengeText('fOuR tEeN')).toBe('fourteen');
    expect(normalizeChallengeText('sIiX tEeN')).toBe('sixteen');
    expect(normalizeChallengeText('tHiR tEeN')).toBe('thirteen');
  });

  it('still refuses to fuse number words that form no single word', () => {
    expect(normalizeChallengeText('ThIrTy FiV e')).toBe('thirty five');
    expect(normalizeChallengeText('TwO HuNdReD FiFtY')).toBe('two hundred fifty');
  });
});

// 2026-09-03: the obfuscator began substituting letters rather than repeating
// them, which canon() cannot undo. "nOoToNs" became "nootons" (unit lost) and
// "xBy" became "xby" (operator word lost), so the parse fell back to the
// "total" filler and answered 32 + 2 = 34.00 for a 32 x 2 = 64.00 problem.
// Since only the first answer is evaluated, the parse must not lead here.
const LIVE_SUBSTITUTED =
  'ThE] lOoObSst-Er- ClAw^ FoR cE] Is^ tH iR tY tWo~ nOoToNs/ xBy^ tWo, ' +
  'WhAt] Is^ tHe ToTaL- FoR cE?';

describe('parse confidence tiers', () => {
  it('grades the 2026-09-03 challenge weak: filler operation, no units', () => {
    const result = solve(LIVE_SUBSTITUTED);
    expect(result).toMatchObject({
      value: 34, confident: true, tier: 'weak', via: 'filler', unitBearing: 0
    });
  });

  it('grades a symbol-derived operation strong even without units', () => {
    const result = solve(LIVE_MULTIPLY);
    expect(result).toMatchObject({ tier: 'strong', via: 'symbol' });
    expect(result.unitBearing).toBeLessThan(2);
  });

  it('grades a keyword-derived operation strong', () => {
    expect(solve(LIVE_CHALLENGE)).toMatchObject({ tier: 'strong', via: 'keyword' });
  });

  it('grades filler strong when both quantities carry recognized units', () => {
    expect(solve(LIVE_FOURTEEN)).toMatchObject({
      tier: 'strong', via: 'filler', unitBearing: 2
    });
  });

  it('reports no tier when the parse is not confident', () => {
    expect(solve('lobster gains ten newtons')).toMatchObject({ confident: false, tier: null });
  });

  // Recovering "nootons" -> "newtons" would give two unit-bearing operands,
  // promote this parse to strong, and put the wrong 34.00 first again.
  it('does not fuzzy-recover a letter-substituted unit', () => {
    expect(normalizeChallengeText('nOoToNs')).toBe('nootons');
  });
});
