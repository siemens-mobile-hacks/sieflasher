import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const cliDir = path.join(import.meta.dirname, "..");
const cliDist = path.join(cliDir, "dist", "index.js");
const cliPackage = JSON.parse(readFileSync(path.join(cliDir, "package.json"), "utf8"));

const run = (args) => execFileAsync('node', [cliDist, ...args], { encoding: 'utf8' });

// Like run(), but asserts a non-zero exit code and returns the error.
const runFail = async (args) => {
	try {
		await run(args);
	} catch (error) {
		assert.notEqual(error.code, 0);
		return error;
	}
	assert.fail(`expected a non-zero exit code: sieflasher ${args.join(' ')}`);
};

const VKD = `
[PhoneCommonInfo]
Name=Test Driver
MCUMemFuBu= fullflash, 0x400000, 0xC00000
MCUMemArea01= bootcore, 0x800000, 0x010000, bootcore

[Phone01]
Name=S55
Type=Test
Boots=Connect

[Boot01]
Name=Connect
Data=0sAT
Answer=B0
NoSendLen=1
NoSendCheckSum=1
`;

test('help', async () => {
	const { stdout } = await run(['--help']);
	assert.match(stdout, /Usage:/);
	assert.match(stdout, /vkd-dump/);
});

test('version', async () => {
	const { stdout } = await run(['--version']);
	assert.equal(stdout.trim(), cliPackage.version);
});

test('no arguments prints the usage and fails', async () => {
	const error = await runFail([]);
	assert.match(error.stderr, /Usage:/);
});

test('unknown command fails', async () => {
	const error = await runFail(['nope']);
	assert.match(error.stderr, /unknown command 'nope'/);
});

test('planned commands are not implemented yet', async () => {
	const error = await runFail(['info']);
	assert.match(error.stderr, /not implemented yet/);
});

test('read requires the serial and the loader', async () => {
	const error = await runFail(['read']);
	assert.match(error.stderr, /--serial is required/);
	assert.match(error.stderr, /usage: sieflasher read/);
});

test('read validates its arguments', async () => {
	const noLoader = await runFail(['read', '--serial', '/dev/ttyUSB0', 'out.bin']);
	assert.match(noLoader.stderr, /--loader is required/);
	const noOutput = await runFail(['read', '--serial', '/dev/ttyUSB0', '--loader', '/nonexistent.vkd']);
	assert.match(noOutput.stderr, /exactly one output file path/);
	const unknown = await runFail(['read', '--nope=1', '--serial', 'x', '--loader', 'y', 'out.bin']);
	assert.match(unknown.stderr, /unknown option --nope/);
	const badAddr = await runFail(['read', '--serial', 'x', '--loader', 'y', '--base_addr', 'zz', 'out.bin']);
	assert.match(badAddr.stderr, /invalid --base_addr/);
	const badLength = await runFail(['read', '--serial', 'x', '--loader', 'y', '--length', '1X', 'out.bin']);
	assert.match(badLength.stderr, /invalid --length/);
});

test('read fails on a missing loader or serial port', async () => {
	const missingLoader = await runFail(['read', '--serial', 'tcp://127.0.0.1:1', '--loader', '/nonexistent.vkd', 'out.bin']);
	assert.match(missingLoader.stderr, /cannot read the loader/);

	const dir = mkdtempSync(path.join(tmpdir(), 'sieflasher-cli-'));
	try {
		const vkd = path.join(dir, 'test.vkd');
		writeFileSync(vkd, VKD, 'latin1');

		// The range check happens before the serial port is touched.
		const range = await runFail(['read', '--serial', 'tcp://127.0.0.1:1', '--loader', vkd, '--base_addr', 'C00000', '--length', '1M', 'out.bin']);
		assert.match(range.stderr, /outside of the fullflash/);

		// Unknown phone of the loader.
		const phone = await runFail(['read', '--serial', 'tcp://127.0.0.1:1', '--loader', vkd, '--phone', 'C35', 'out.bin']);
		assert.match(phone.stderr, /has no phone "C35" \(available: S55\)/);

		// Bad baudrate.
		const baud = await runFail(['read', '--serial', 'tcp://127.0.0.1:1', '--loader', vkd, '--baud', 'fast', 'out.bin']);
		assert.match(baud.stderr, /invalid --baud/);

		// Nothing listens on this port.
		const refused = await runFail(['read', '--serial', 'tcp://127.0.0.1:1', '--loader', vkd, '--length', '1', path.join(dir, 'out.bin')]);
		assert.match(refused.stderr, /cannot open tcp:\/\/127\.0\.0\.1:1/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('vkd-dump requires exactly one file', async () => {
	await runFail(['vkd-dump']);
	await runFail(['vkd-dump', 'a.vkd', 'b.vkd']);
});

test('vkd-dump on a missing file fails', async () => {
	const error = await runFail(['vkd-dump', '/nonexistent/x65.vkd']);
	assert.match(error.stderr, /cannot read/);
});

test('vkd-dump prints the phones, areas and boots', async () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'sieflasher-cli-'));
	try {
		const vkd = path.join(dir, 'test.vkd');
		writeFileSync(vkd, VKD, 'latin1');

		const { stdout } = await run(['vkd-dump', vkd]);
		assert.match(stdout, /1 phone\(s\), 1 boot\(s\)/);
		assert.match(stdout, /Phone01: S55 \(Test\)/);
		assert.match(stdout, /fullflash: 0x400000\.\.0xFFFFFF \(12 MiB\)/);
		assert.match(stdout, /bootcore\s+0x800000\.\.0x80FFFF \(64 KiB\)  \[bootcore\]/);
		assert.match(stdout, /boots: Connect/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
