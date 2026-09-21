// Tests of `sieflasher apply` / `sieflasher revert`.
//
// Everything runs against fullflash dump files (--file), so no phone and no
// emulator is needed; the phone path shares the whole code with it apart from
// opening the device. SIEFLASHER_HOME points the patch history and the
// recovery patches into the temporary directory of each test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const cliDist = path.join(import.meta.dirname, '..', 'dist', 'index.js');

// The dump: 256 bytes, "AAAA" at 0x10 and "ZZZZ" at 0x20. The V_KLay
// "_From_40" name suffix places it at 0x400000 in the flash.
const DUMP_NAME = 'S55_2020-01-01_From_40.bin';
const DUMP_SIZE = 256;

// A patch matching the dump: AAAA -> BBBB.
const PATCH = ';Test patch title\r\n0x400010: 41414141 42424242\r\n';
// A patch whose old data is not in the dump (0x20 holds ZZZZ, not AAAA).
const MISMATCH_PATCH = ';Mismatching patch\r\n0x400020: 41414141 43434343\r\n';
// A patch without old data: undoing it is impossible.
const NO_OLD_PATCH = ';No old data\r\n0x400030: 44444444\r\n';

function makeCase() {
	const dir = mkdtempSync(path.join(tmpdir(), 'sieflasher-patch-'));
	const dump = Buffer.alloc(DUMP_SIZE, 0);
	dump.write('AAAA', 0x10);
	dump.write('ZZZZ', 0x20);
	writeFileSync(path.join(dir, DUMP_NAME), dump);
	writeFileSync(path.join(dir, 'test.vkp'), PATCH, 'latin1');
	writeFileSync(path.join(dir, 'mismatch.vkp'), MISMATCH_PATCH, 'latin1');
	writeFileSync(path.join(dir, 'noold.vkp'), NO_OLD_PATCH, 'latin1');
	return {
		dir,
		home: path.join(dir, 'home'),
		dump: path.join(dir, DUMP_NAME),
		patch: path.join(dir, 'test.vkp'),
		mismatch: path.join(dir, 'mismatch.vkp'),
		noold: path.join(dir, 'noold.vkp'),
	};
}

// Runs the CLI with an empty (non-terminal) stdin unless input is given.
function run(env, args, input = '') {
	const result = spawnSync('node', [cliDist, ...args], {
		encoding: 'utf8',
		input,
		env: { ...process.env, SIEFLASHER_HOME: env.home },
	});
	assert.equal(result.error, undefined);
	return result;
}

const dumpAt = (file, offset, size) =>
	readFileSync(file).subarray(offset, offset + size).toString('latin1');

// The history entries (the JSON sidecars), newest last.
function history(env) {
	const root = path.join(env.home, 'history');
	if (!existsSync(root))
		return [];
	const entries = [];
	for (const month of readdirSync(root).sort()) {
		for (const file of readdirSync(path.join(root, month)).sort()) {
			if (!file.endsWith('.json'))
				continue;
			const meta = JSON.parse(readFileSync(path.join(root, month, file), 'utf8'));
			meta.textFile = path.join(root, month, meta.patchFile);
			entries.push(meta);
		}
	}
	return entries;
}

const recoveryPatches = (env) => {
	const root = path.join(env.home, 'recovery');
	return existsSync(root) ? readdirSync(root).sort().map((file) => path.join(root, file)) : [];
};

test('apply writes the new data and logs the run into the history', (t) => {
	const env = makeCase();
	t.after(() => rmSync(env.dir, { recursive: true, force: true }));

	const result = run(env, ['apply', '--file', env.dump, env.patch]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(dumpAt(env.dump, 0x10, 4), 'BBBB');
	// Nothing outside of the patched range changed.
	assert.equal(dumpAt(env.dump, 0x20, 4), 'ZZZZ');
	assert.equal(readFileSync(env.dump).length, DUMP_SIZE);
	assert.match(result.stdout, /1 applied, 0 skipped, 0 failed/);

	const entries = history(env);
	assert.equal(entries.length, 1);
	const entry = entries[0];
	assert.equal(entry.action, 'apply');
	assert.equal(entry.status, 'ok');
	assert.equal(entry.source, 'file');
	assert.equal(entry.model, 'S55');
	assert.equal(entry.deviceName, 'S55_2020-01-01_From_40');
	assert.equal(entry.target, env.dump);
	assert.equal(entry.patchName, 'test.vkp');
	assert.equal(entry.patchTitle, 'Test patch title');
	assert.equal(entry.writes, 1);
	assert.equal(entry.written, 4);
	assert.equal(entry.recoveryPatch, undefined);
	assert.match(entry.info, /Dump 0x400000 \+ 256 B/);
	assert.match(entry.date, /^\d{4}-\d{2}-\d{2}T/);
	// The patch text is stored next to the entry (V_KLay's log.vkp).
	assert.equal(readFileSync(entry.textFile, 'latin1'), PATCH);
	// The file name carries the date, the action, the device and the patch.
	assert.match(path.basename(entry.textFile),
		/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_apply_S55_2020-01-01_From_40_test\.vkp$/);
});

test('revert restores the old data', (t) => {
	const env = makeCase();
	t.after(() => rmSync(env.dir, { recursive: true, force: true }));

	assert.equal(run(env, ['apply', '--file', env.dump, env.patch]).status, 0);
	const original = readFileSync(env.dump);
	const result = run(env, ['revert', '--file', env.dump, env.patch]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(dumpAt(env.dump, 0x10, 4), 'AAAA');
	assert.match(result.stdout, /1 reverted, 0 skipped, 0 failed/);
	assert.notEqual(original.toString('latin1'), readFileSync(env.dump).toString('latin1'));

	const entries = history(env);
	assert.equal(entries.length, 2);
	assert.equal(entries[1].action, 'revert');
	assert.equal(entries[1].status, 'ok');
	assert.equal(entries[1].written, 4);
});

test('applying an applied patch (and reverting a reverted one) does nothing', (t) => {
	const env = makeCase();
	t.after(() => rmSync(env.dir, { recursive: true, force: true }));

	assert.equal(run(env, ['apply', '--file', env.dump, env.patch]).status, 0);
	const applied = run(env, ['apply', '--file', env.dump, env.patch]);
	assert.equal(applied.status, 0, applied.stderr);
	assert.match(applied.stdout, /the patch is already applied/);
	assert.equal(dumpAt(env.dump, 0x10, 4), 'BBBB');

	assert.equal(run(env, ['revert', '--file', env.dump, env.patch]).status, 0);
	const reverted = run(env, ['revert', '--file', env.dump, env.patch]);
	assert.equal(reverted.status, 0, reverted.stderr);
	assert.match(reverted.stdout, /the patch is not applied/);
	assert.equal(dumpAt(env.dump, 0x10, 4), 'AAAA');
	// The no-op runs are logged as well.
	assert.equal(history(env).length, 4);
});

test('the patch is read from stdin without a path (and with "-")', (t) => {
	const env = makeCase();
	t.after(() => rmSync(env.dir, { recursive: true, force: true }));

	const applied = run(env, ['apply', '--file', env.dump], PATCH);
	assert.equal(applied.status, 0, applied.stderr);
	assert.equal(dumpAt(env.dump, 0x10, 4), 'BBBB');
	assert.match(applied.stderr, /patch: <stdin>: 1 write\(s\)/);
	assert.equal(history(env)[0].patchName, 'apply_from_stdin.vkp');

	const reverted = run(env, ['revert', '--file', env.dump, '-'], PATCH);
	assert.equal(reverted.status, 0, reverted.stderr);
	assert.equal(dumpAt(env.dump, 0x10, 4), 'AAAA');
});

test('an empty stdin patch fails', (t) => {
	const env = makeCase();
	t.after(() => rmSync(env.dir, { recursive: true, force: true }));

	const result = run(env, ['apply', '--file', env.dump]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /<stdin> is empty/);
	assert.equal(dumpAt(env.dump, 0x10, 4), 'AAAA');
});

test('--dry-run writes nothing and is not logged', (t) => {
	const env = makeCase();
	t.after(() => rmSync(env.dir, { recursive: true, force: true }));

	const result = run(env, ['apply', '--file', env.dump, env.patch, '--dry-run']);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(dumpAt(env.dump, 0x10, 4), 'AAAA');
	assert.match(result.stdout, /dry run: nothing was written/);
	assert.deepEqual(history(env), []);
});

test('a mismatching patch is not applied without a confirmation', (t) => {
	const env = makeCase();
	t.after(() => rmSync(env.dir, { recursive: true, force: true }));

	// Without a terminal to ask on the warning is declined, like answering NO.
	const result = run(env, ['apply', '--file', env.dump, env.mismatch]);
	assert.equal(result.status, 1);
	assert.equal(dumpAt(env.dump, 0x20, 4), 'ZZZZ');
	assert.match(result.stderr, /WARNING: the old data of 1 of 1 block\(s\)/);
	assert.match(result.stderr, /First mismatch at 0x400020 \(patch line 2\)/);
	assert.match(result.stderr, /re-run with --yes/);
	assert.match(result.stderr, /cancelled, nothing was written/);
	assert.deepEqual(recoveryPatches(env), []);

	const entries = history(env);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].status, 'cancelled');
	assert.equal(entries[0].written, 0);
});

test('--yes applies a mismatching patch and saves a revertable recovery patch', (t) => {
	const env = makeCase();
	t.after(() => rmSync(env.dir, { recursive: true, force: true }));

	const result = run(env, ['apply', '--file', env.dump, env.mismatch, '--yes']);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(dumpAt(env.dump, 0x20, 4), 'CCCC');

	const recovery = recoveryPatches(env);
	assert.equal(recovery.length, 1);
	assert.match(path.basename(recovery[0]), /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_mismatch_REPAIR\.vkp$/);
	assert.match(result.stderr, new RegExp(`recovery patch saved: ${recovery[0].replace(/[/\\]/g, '\\$&')}`));
	assert.equal(history(env)[0].recoveryPatch, recovery[0]);

	// The recovery patch holds the original device data as its old data:
	// reverting it restores the dump.
	const text = readFileSync(recovery[0], 'latin1');
	assert.match(text, /\*\*\* REPAIR PATCH \*\*\*/);
	assert.match(text, /400020: 5A5A5A5A\s+43434343\s+;41414141/);

	const restored = run(env, ['revert', '--file', env.dump, recovery[0]]);
	assert.equal(restored.status, 0, restored.stderr);
	assert.equal(dumpAt(env.dump, 0x20, 4), 'ZZZZ');
});

test('--force applies a mismatching patch without a recovery patch', (t) => {
	const env = makeCase();
	t.after(() => rmSync(env.dir, { recursive: true, force: true }));

	const result = run(env, ['apply', '--file', env.dump, env.mismatch, '--force']);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(dumpAt(env.dump, 0x20, 4), 'CCCC');
	assert.deepEqual(recoveryPatches(env), []);
	assert.equal(history(env)[0].recoveryPatch, undefined);
});

test('a patch without old data warns, saves a recovery patch and cannot be reverted', (t) => {
	const env = makeCase();
	t.after(() => rmSync(env.dir, { recursive: true, force: true }));

	const applied = run(env, ['apply', '--file', env.dump, env.noold, '--yes']);
	assert.equal(applied.status, 0, applied.stderr);
	assert.match(applied.stderr, /WARNING: some blocks of the patch have no old data/);
	assert.equal(dumpAt(env.dump, 0x30, 4), 'DDDD');
	assert.equal(recoveryPatches(env).length, 1);

	// Undoing such a write is impossible: it is skipped after the warning.
	const reverted = run(env, ['revert', '--file', env.dump, env.noold, '--yes']);
	assert.equal(reverted.status, 0, reverted.stderr);
	assert.match(reverted.stderr, /cannot be undone/);
	assert.equal(dumpAt(env.dump, 0x30, 4), 'DDDD');
});

test('a cp1251 patch is stored in the history as it was', (t) => {
	const env = makeCase();
	t.after(() => rmSync(env.dir, { recursive: true, force: true }));

	// The canonical VKP encoding: a comment in cp1251 ("Привет") is not valid
	// UTF-8, so it must be decoded and written back as cp1251, byte for byte.
	const comment = Buffer.from([0x3B, 0xCF, 0xF0, 0xE8, 0xE2, 0xE5, 0xF2, 0x0D, 0x0A]);
	const raw = Buffer.concat([comment, Buffer.from(PATCH.replace(';Test patch title\r\n', ''), 'latin1')]);
	const patch = path.join(env.dir, 'cp1251.vkp');
	writeFileSync(patch, raw);

	const result = run(env, ['apply', '--file', env.dump, patch]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(dumpAt(env.dump, 0x10, 4), 'BBBB');

	const entry = history(env)[0];
	assert.equal(entry.patchTitle, 'Привет');
	assert.deepEqual(readFileSync(entry.textFile), raw);
});

test('--no-history keeps the history untouched', (t) => {
	const env = makeCase();
	t.after(() => rmSync(env.dir, { recursive: true, force: true }));

	const result = run(env, ['apply', '--file', env.dump, env.patch, '--no-history']);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(dumpAt(env.dump, 0x10, 4), 'BBBB');
	assert.equal(existsSync(env.home), false);
});

test('--base_addr overrides the dump start address of the file name', (t) => {
	const env = makeCase();
	t.after(() => rmSync(env.dir, { recursive: true, force: true }));

	// With the dump placed at 0 the patch addresses are out of its range.
	const outside = run(env, ['apply', '--file', env.dump, '--base_addr', '0', env.patch]);
	assert.equal(outside.status, 1);
	assert.match(outside.stderr, /1 of 1 write\(s\) are outside \[0x400010 \(4 B, line 2\)\] of the dump/);
	assert.equal(dumpAt(env.dump, 0x10, 4), 'AAAA');

	// A patch addressing the same bytes relative to 0 applies then.
	const patch = path.join(env.dir, 'zero.vkp');
	writeFileSync(patch, '0x000010: 41414141 42424242\r\n', 'latin1');
	const applied = run(env, ['apply', '--file', env.dump, '--base_addr', '0', patch]);
	assert.equal(applied.status, 0, applied.stderr);
	assert.equal(dumpAt(env.dump, 0x10, 4), 'BBBB');
});

test('a big patch lists only the writes that need attention', (t) => {
	const env = makeCase();
	t.after(() => rmSync(env.dir, { recursive: true, force: true }));

	// 40 writes: more than the CLI prints one by one.
	const lines = [';Big patch'];
	for (let i = 0; i < 40; i++)
		lines.push(`0x${(0x400040 + i).toString(16)}: 00 ${(i + 1).toString(16).padStart(2, '0')}`);
	const big = path.join(env.dir, 'big.vkp');
	writeFileSync(big, lines.join('\r\n') + '\r\n', 'latin1');

	const result = run(env, ['apply', '--file', env.dump, big]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /40 of 40 write\(s\) applied/);
	assert.match(result.stdout, /40 applied, 0 skipped, 0 failed/);
	assert.equal(dumpAt(env.dump, 0x40, 3), '\x01\x02\x03');
});

test('a patch reaching outside of the flash is rejected before the phone is opened', (t) => {
	const env = makeCase();
	t.after(() => rmSync(env.dir, { recursive: true, force: true }));

	const vkd = path.join(env.dir, 'test.vkd');
	writeFileSync(vkd, [
		'[PhoneCommonInfo]', 'Name=Test Driver', 'MCUMemFuBu= fullflash, 0x400000, 0xC00000',
		'', '[Phone01]', 'Name=S55', 'Type=Test', 'Boots=Connect',
		'', '[Boot01]', 'Name=Connect', 'Data=0sAT', 'Answer=B0', 'NoSendLen=1', 'NoSendCheckSum=1',
	].join('\n'), 'latin1');
	const patch = path.join(env.dir, 'far.vkp');
	writeFileSync(patch, '0x1000000: 41414141 42424242\r\n', 'latin1');

	// The serial port is never opened: the addresses are checked first.
	// The flash is mapped at 0x400000 on this phone, but a patch addresses it
	// by the offset, so the range it is checked against is 0x0..0xBFFFFF.
	const result = run(env, ['apply', '--serial', 'tcp://127.0.0.1:1', '--loader', vkd, patch]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /1 of 1 write\(s\) are outside .* of the fullflash 0x0\.\.0xBFFFFF/);
	assert.doesNotMatch(result.stderr, /cannot open/);
	assert.deepEqual(history(env), []);
});

test('a broken patch is reported with its location', (t) => {
	const env = makeCase();
	t.after(() => rmSync(env.dir, { recursive: true, force: true }));

	const broken = path.join(env.dir, 'broken.vkp');
	writeFileSync(broken, ';Broken\r\nnot a patch line\r\n', 'latin1');
	const result = run(env, ['apply', '--file', env.dump, broken]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /broken\.vkp:2:\d+: error:/);
	assert.match(result.stderr, /is not a valid patch/);
	assert.deepEqual(history(env), []);
});

test('an empty patch has nothing to apply', (t) => {
	const env = makeCase();
	t.after(() => rmSync(env.dir, { recursive: true, force: true }));

	const empty = path.join(env.dir, 'empty.vkp');
	writeFileSync(empty, ';Just a comment\r\n', 'latin1');
	const result = run(env, ['apply', '--file', env.dump, empty]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /no data blocks/);
	assert.deepEqual(history(env), []);
});

test('a missing patch or dump file fails', (t) => {
	const env = makeCase();
	t.after(() => rmSync(env.dir, { recursive: true, force: true }));

	const patch = run(env, ['apply', '--file', env.dump, path.join(env.dir, 'nope.vkp')]);
	assert.equal(patch.status, 1);
	assert.match(patch.stderr, /cannot read the patch/);

	const dump = run(env, ['apply', '--file', path.join(env.dir, 'nope.bin'), env.patch]);
	assert.equal(dump.status, 1);
	assert.match(dump.stderr, /cannot read the dump/);
});

test('the argument errors of apply and revert', (t) => {
	const env = makeCase();
	t.after(() => rmSync(env.dir, { recursive: true, force: true }));

	const cases = [
		[['apply', env.patch], /--serial or --file is required/],
		[['revert', env.patch], /--serial or --file is required/],
		[['apply', '--serial', 'tcp://127.0.0.1:1', '--file', env.dump, env.patch], /mutually exclusive/],
		[['apply', '--serial', 'tcp://127.0.0.1:1', env.patch], /--loader is required with --serial/],
		[['apply', '--file', env.dump, '--loader', 'x.vkd', env.patch], /--loader is only used with --serial/],
		[['apply', '--file', env.dump, '--phone', 'S55', env.patch], /--phone is only used with --serial/],
		[['apply', '--file', env.dump, '--baud', '115200', env.patch], /--baud is only used with --serial/],
		[['apply', '--serial', 'tcp://127.0.0.1:1', '--loader', 'x.vkd', '--base_addr', '0', env.patch],
			/--base_addr is only used with --file/],
		[['apply', '--file', env.dump, env.patch, env.patch], /at most one patch file path/],
		[['apply', '--file', env.dump, '--nope', env.patch], /unknown option --nope/],
		[['apply', '--file', env.dump, '--baud'], /missing value for --baud/],
		[['apply', '--file', env.dump, '--base_addr', 'zz', env.patch], /invalid --base_addr/],
		[['apply', '--file', env.dump, '--yes=false', env.patch], /--yes takes no value/],
	];
	for (const [args, expected] of cases) {
		const result = run(env, args);
		assert.equal(result.status, 2, `expected a usage error: ${args.join(' ')}`);
		assert.match(result.stderr, expected);
		assert.match(result.stderr, /usage: sieflasher (apply|revert)/);
	}
	assert.equal(dumpAt(env.dump, 0x10, 4), 'AAAA');
});

test('the loader is validated before the phone is opened', (t) => {
	const env = makeCase();
	t.after(() => rmSync(env.dir, { recursive: true, force: true }));

	const result = run(env, ['apply', '--serial', 'tcp://127.0.0.1:1',
		'--loader', path.join(env.dir, 'nope.vkd'), env.patch]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /cannot read the loader/);
});

test('help lists the patch commands', () => {
	const result = spawnSync('node', [cliDist, 'help'], { encoding: 'utf8' });
	assert.equal(result.status, 0);
	assert.match(result.stdout, /apply \[options\] \[patch\]/);
	assert.match(result.stdout, /revert \[options\] \[patch\]/);
	assert.match(result.stdout, /~\/\.sieflasher\/history/);
	assert.match(result.stdout, /~\/\.sieflasher\/recovery/);
});
