// sieflasher write: boot the phone and write a file (a fullflash dump or a
// part of it) into its flash memory. The loader protocol erases and
// reprograms whole flash blocks; the pages around an unaligned range are
// read back first and rewritten with their untouched parts preserved (the
// read-modify-write of the core library).

import { readFileSync } from "node:fs";
import { Buffer } from "buffer";
import { PhoneDevice, phoneDisplayName, VkdFile, VkdPhone, FlasherTransport } from "@sie-js/flasher";
import { openSerialTransport } from "./transport.js";
import { CliProgress, formatPhoneInfo, formatRange, formatSize, loadLoaderPhone, parsePhoneFileArgs, PhoneFileOptions } from "./util.js";

const USAGE = "sieflasher write --serial <device> --loader <file.vkd> [--phone <name>] [--base_addr <hex>] [--length <size>] [--baud <rate>] <input>";

export async function cmdWrite(args: string[]): Promise<number> {
	let options: PhoneFileOptions;
	try {
		options = parsePhoneFileArgs(args, "input");
	} catch (error) {
		console.error(`sieflasher: ${(error as Error).message}`);
		console.error(`usage: ${USAGE}`);
		return 2;
	}

	let loaded: { vkd: VkdFile; phone: VkdPhone };
	try {
		loaded = loadLoaderPhone(options.loader, options.phone);
	} catch (error) {
		console.error(`sieflasher: ${(error as Error).message}`);
		return 1;
	}
	const { vkd, phone } = loaded;

	let input: Buffer;
	try {
		input = readFileSync(options.file);
	} catch (error) {
		console.error(`sieflasher: cannot read the input ${options.file}: ${(error as Error).message}`);
		return 1;
	}

	const baseAddr = options.baseAddr ?? 0;
	const length = options.length ?? input.length;
	if (baseAddr < 0 || baseAddr >= phone.fullflash.size || length <= 0 || baseAddr + length > phone.fullflash.size) {
		console.error(`sieflasher: the write range 0x${baseAddr.toString(16)}+0x${length.toString(16)} is outside of the fullflash ${formatRange(0, phone.fullflash.size)} of ${phoneDisplayName(phone)}`);
		return 1;
	}
	if (length > input.length) {
		console.error(`sieflasher: --length ${formatSize(length)} exceeds the input file size (${formatSize(input.length)})`);
		return 1;
	}

	console.error(`loader: ${options.loader}: ${phoneDisplayName(phone)}, fullflash ${formatRange(phone.fullflash.addr, phone.fullflash.size)}`);
	console.error(`serial: ${options.serial}`);

	const progress = new CliProgress();
	let transport: FlasherTransport;
	try {
		transport = await openSerialTransport(options.serial);
	} catch (error) {
		console.error(`sieflasher: cannot open ${options.serial}: ${(error as Error).message}`);
		return 1;
	}
	const device = new PhoneDevice(transport, phone, vkd, {
		onStatus: (status) => console.error(`  ${status}`),
	});
	device.onProgress = (p) => progress.update(p);

	try {
		const started = Date.now();
		await device.open(options.baud);
		const info = device.getFlashInfo();
		if (info)
			console.error(`phone: ${formatPhoneInfo(info)}`);

		console.error(`writing ${options.file} -> ${formatRange(baseAddr, length)}`);
		await device.writeFlash(baseAddr, input.subarray(0, length));
		progress.finish();

		const seconds = (Date.now() - started) / 1000;
		console.log(`${options.file}: ${formatSize(length)} written to 0x${baseAddr.toString(16).toUpperCase()} in ${seconds.toFixed(1)}s`);
	} finally {
		await device.disconnect().catch(() => {});
	}
	return 0;
}
