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
