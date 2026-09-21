// sieflasher read: boot the phone, read a range of its flash memory into a
// file.

import { writeFileSync } from "node:fs";
import { PhoneDevice, phoneDisplayName, VkdFile, VkdPhone, FlasherTransport } from "@sie-js/flasher";
import { openSerialTransport } from "./transport.js";
import { CliProgress, formatPhoneInfo, formatRange, formatSize, loadLoaderPhone, parsePhoneFileArgs, PhoneFileOptions } from "./util.js";

const USAGE = "sieflasher read --serial <device> --loader <file.vkd> [--phone <name>] [--base_addr <hex>] [--length <size>] [--baud <rate>] <output>";

export async function cmdRead(args: string[]): Promise<number> {
	let options: PhoneFileOptions;
	try {
		options = parsePhoneFileArgs(args, "output");
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
	const baseAddr = options.baseAddr ?? 0;
	const length = options.length ?? phone.fullflash.size - baseAddr;
	if (baseAddr < 0 || baseAddr >= phone.fullflash.size || length <= 0 || baseAddr + length > phone.fullflash.size) {
		console.error(`sieflasher: the read range 0x${baseAddr.toString(16)}+0x${length.toString(16)} is outside of the fullflash ${formatRange(0, phone.fullflash.size)} of ${phoneDisplayName(phone)}`);
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

		console.error(`reading ${formatRange(baseAddr, length)} -> ${options.file}`);
		const data = await device.readFlash(baseAddr, length);
		progress.finish();
		writeFileSync(options.file, data);

		const seconds = (Date.now() - started) / 1000;
		console.log(`${options.file}: ${formatSize(length)} read from 0x${baseAddr.toString(16).toUpperCase()} in ${seconds.toFixed(1)}s`);
	} finally {
		await device.disconnect().catch(() => {});
	}
	return 0;
}
