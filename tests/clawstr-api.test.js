// tests/clawstr-api.test.js
// Tests nak binary resolution and secret redaction. child_process is mocked,
// so no nak binary and no relay traffic are involved.

jest.mock('child_process');

const { EventEmitter } = require('events');
const fsSync = require('fs');
const { spawn } = require('child_process');
const clawstrApi = require('../utils/clawstr-api');

const GO_BIN_NAK = require('path').join(require('os').homedir(), 'go', 'bin', 'nak');

/**
 * A fake child process that emits `stdout` then closes with `code`.
 */
function fakeProc({ stdout = '', stderr = '', code = 0 } = {}) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = jest.fn();

  process.nextTick(() => {
    if (stdout) proc.stdout.emit('data', stdout);
    if (stderr) proc.stderr.emit('data', stderr);
    proc.emit('close', code);
  });

  return proc;
}

describe('nak path resolution', () => {
  const originalNakPath = process.env.NAK_PATH;

  beforeEach(() => {
    jest.clearAllMocks();
    clawstrApi._resetNakPathCache();
    delete process.env.NAK_PATH;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    clawstrApi._resetNakPathCache();
    if (originalNakPath === undefined) delete process.env.NAK_PATH;
    else process.env.NAK_PATH = originalNakPath;
  });

  it('honours an explicit NAK_PATH even when it is not executable', () => {
    // An explicit setting is an operator decision: a typo must fail loudly
    // rather than silently fall through to some other binary.
    process.env.NAK_PATH = '/custom/nak';
    jest.spyOn(fsSync, 'accessSync').mockImplementation(() => { throw new Error('ENOENT'); });

    expect(clawstrApi.resolveNakPath()).toBe('/custom/nak');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('not executable'));
  });

  it('prefers the Railway install location over the local go path', () => {
    // Regression lock: scripts/install-nak-railway.sh installs to /app/bin,
    // but this module used to look only in ~/go/bin. On Railway that meant
    // every nak call failed and getFeed silently returned [].
    jest.spyOn(fsSync, 'accessSync').mockImplementation(p => {
      if (p === '/app/bin/nak' || p === GO_BIN_NAK) return true;
      throw new Error('ENOENT');
    });

    expect(clawstrApi.resolveNakPath()).toBe('/app/bin/nak');
  });

  it('falls back to the local go path when the Railway one is absent', () => {
    jest.spyOn(fsSync, 'accessSync').mockImplementation(p => {
      if (p === GO_BIN_NAK) return true;
      throw new Error('ENOENT');
    });

    expect(clawstrApi.resolveNakPath()).toBe(GO_BIN_NAK);
  });

  it('falls back to a bare PATH lookup, loudly, when nothing is found', () => {
    jest.spyOn(fsSync, 'accessSync').mockImplementation(() => { throw new Error('ENOENT'); });

    expect(clawstrApi.resolveNakPath()).toBe('nak');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('No nak binary'));
  });

  it('memoises the result and does not re-probe the filesystem', () => {
    const accessSync = jest.spyOn(fsSync, 'accessSync').mockImplementation(() => true);

    clawstrApi.resolveNakPath();
    const callsAfterFirst = accessSync.mock.calls.length;
    clawstrApi.resolveNakPath();

    expect(accessSync.mock.calls.length).toBe(callsAfterFirst);
  });

  it('exposes the resolved path through the CONFIG getter', () => {
    process.env.NAK_PATH = '/custom/nak';
    jest.spyOn(fsSync, 'accessSync').mockImplementation(() => true);

    expect(clawstrApi.CONFIG.nakPath).toBe('/custom/nak');
  });
});

describe('spawned nak process', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clawstrApi._resetNakPathCache();
    process.env.NAK_PATH = '/custom/nak';
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(fsSync, 'accessSync').mockImplementation(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    clawstrApi._resetNakPathCache();
    delete process.env.NAK_PATH;
  });

  it('spawns the resolved binary and adds both install dirs to PATH', async () => {
    // Lazily, so the fake only starts emitting once spawnNak has attached
    // its listeners.
    spawn.mockImplementation(() => fakeProc({ stdout: '[]' }));

    await clawstrApi.getFeed('/c/ai-freedom', 5);

    const [binary, , options] = spawn.mock.calls[0];
    expect(binary).toBe('/custom/nak');
    expect(options.env.PATH).toContain('/app/bin');
    expect(options.env.PATH).toContain('go/bin');
  });

  it('does not leak the secret key into an error message', async () => {
    // getHexPublicKey passes the secret as argv (`key public <secret>`), and
    // the failure path interpolates argv into the thrown message.
    const secret = 'nsec1supersecretvalue';
    process.env.CLAWSTR_SECRET_KEY = secret;
    spawn.mockImplementation(() => fakeProc({ stderr: 'bad key', code: 1 }));

    const error = await clawstrApi.getHexPublicKey().then(
      () => { throw new Error('expected a rejection'); },
      e => e
    );

    expect(error.message).not.toContain(secret);
    expect(error.message).toContain('***');

    delete process.env.CLAWSTR_SECRET_KEY;
  });

  it('derives the npub through the resolved binary rather than execFile', async () => {
    process.env.CLAWSTR_SECRET_KEY = 'nsec1abc';
    spawn
      .mockImplementationOnce(() => fakeProc({ stdout: 'a'.repeat(64) }))  // key public
      .mockImplementationOnce(() => fakeProc({ stdout: 'npub1result' })); // encode npub

    await expect(clawstrApi.getPublicKey()).resolves.toBe('npub1result');
    expect(spawn.mock.calls.every(([binary]) => binary === '/custom/nak')).toBe(true);

    delete process.env.CLAWSTR_SECRET_KEY;
  });
});

describe('normalizeNostrPubkey', () => {
  const NPUB = 'npub1xpxr0awey3j9q3p9ss3lfsm5hue2wdzgkkthz04js6vl0qe6af2s39ufc5';
  const HEX = '304c37f5d924645044258423f4c374bf32a73448b597713eb28699f7833aea55';

  it('decodes an npub to the hex relays actually return', () => {
    // Known vector, cross-checked against `nak decode`.
    expect(clawstrApi.normalizeNostrPubkey(NPUB)).toBe(HEX);
  });

  it('accepts the 0x-prefixed and bare hex forms, normalising case', () => {
    expect(clawstrApi.normalizeNostrPubkey(`0x${HEX}`)).toBe(HEX);
    expect(clawstrApi.normalizeNostrPubkey(HEX.toUpperCase())).toBe(HEX);
    expect(clawstrApi.normalizeNostrPubkey(`  ${NPUB}  `)).toBe(HEX);
  });

  it('throws rather than passing through something that can never match', () => {
    // Returning the input unchanged is what made a raw npub collect zero
    // evidence while the commitment looked perfectly valid.
    expect(() => clawstrApi.normalizeNostrPubkey('npub1testhandle')).toThrow(/bech32|Invalid/);
    expect(() => clawstrApi.normalizeNostrPubkey('nsec1' + 'q'.repeat(58))).toThrow();
    expect(() => clawstrApi.normalizeNostrPubkey('abc123')).toThrow(/64-character hex/);
    expect(() => clawstrApi.normalizeNostrPubkey('')).toThrow();
    expect(() => clawstrApi.normalizeNostrPubkey(null)).toThrow();
  });
});

describe('getEventsByAuthor', () => {
  const HEX = '304c37f5d924645044258423f4c374bf32a73448b597713eb28699f7833aea55';
  const OK_STDERR = ['relay.ditto.pub', 'relay.primal.net', 'nos.lol']
    .map(r => `connecting to wss://${r}... ok.`).join('\n');

  const event = (id, createdAt) => JSON.stringify({ id, pubkey: HEX, created_at: createdAt, sig: 'x' });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NAK_PATH = '/custom/nak';
    clawstrApi._resetNakPathCache();
  });

  afterEach(() => { delete process.env.NAK_PATH; });

  it('builds an author-scoped kind-1111 filter with the window bounds', async () => {
    spawn.mockImplementation(() => fakeProc({ stdout: '', stderr: OK_STDERR }));

    await clawstrApi.getEventsByAuthor(HEX, { since: 100, until: 200, limit: 7 });

    const args = spawn.mock.calls[0][1];
    expect(args.slice(0, 6)).toEqual(['req', '-k', '1111', '-a', HEX, '-s']);
    expect(args).toContain('-u');
    expect(args).toContain('200');
    expect(args[args.indexOf('-l') + 1]).toBe('7');
  });

  it('omits an unset since/until rather than sending a 1969 timestamp', async () => {
    spawn.mockImplementation(() => fakeProc({ stdout: '', stderr: OK_STDERR }));

    await clawstrApi.getEventsByAuthor(HEX);

    const args = spawn.mock.calls[0][1];
    expect(args).not.toContain('-s');
    expect(args).not.toContain('-u');
  });

  it('refuses a non-hex pubkey before spawning anything', async () => {
    await expect(clawstrApi.getEventsByAuthor('npub1whatever')).rejects.toThrow(/64-char hex/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('returns events oldest-first, deduped, and without slicing to the limit', async () => {
    // nak applies -l per relay, so the union legitimately exceeds it. Slicing
    // (as getFeed does) would discard real evidence from a paid verification.
    spawn.mockImplementation(() => fakeProc({
      stdout: [event('b', 200), event('a', 100), event('b', 200), event('c', 300)].join('\n'),
      stderr: OK_STDERR
    }));

    const { events } = await clawstrApi.getEventsByAuthor(HEX, { limit: 2 });

    expect(events.map(e => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('reports how many relays answered, so an outage is not read as inactivity', async () => {
    spawn.mockImplementation(() => fakeProc({
      stdout: event('a', 100),
      // nak exits 0 when at least one relay answers, naming the failures only
      // on stderr. A caller that ignores it cannot tell empty from broken.
      stderr: 'connecting to wss://nos.lol... ok.\nconnecting to wss://relay.down... no such host',
      code: 0
    }));

    const result = await clawstrApi.getEventsByAuthor(HEX);

    expect(result.relaysOk).toBe(1);
    expect(result.relaysTotal).toBe(3);
  });

  it('skips an unparseable line instead of failing the whole collection', async () => {
    spawn.mockImplementation(() => fakeProc({
      stdout: [event('a', 100), 'not json', event('b', 200)].join('\n'),
      stderr: OK_STDERR
    }));

    const { events } = await clawstrApi.getEventsByAuthor(HEX);

    expect(events.map(e => e.id)).toEqual(['a', 'b']);
  });

  it('throws when every relay is unreachable, rather than returning []', async () => {
    // getFeed's swallow-and-return-[] is right for a heartbeat and wrong here:
    // it is indistinguishable from an agent that did nothing.
    spawn.mockImplementation(() => fakeProc({
      stderr: 'failed to connect to any of the given relays.', code: 3
    }));

    await expect(clawstrApi.getEventsByAuthor(HEX)).rejects.toThrow(/author query failed/i);
  });
});
