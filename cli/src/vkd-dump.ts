// sieflasher vkd-dump: parse a V_KLay phone driver (.vkd) and dump its
// contents (the phones, the memory areas, the geometry, the boots).

import { readFileSync } from "node:fs";
import { parseVkd, phoneDisplayName } from "@sie-js/flasher";
import { formatRange, formatSize, hex } from "./util.js";

export function cmdVkdDump(fileName: string): number {
	let text: string;
	try {
		text = readFileSync(fileName, "latin1");
	} catch (error) {
		console.error(`sieflasher: cannot read ${fileName}: ${(error as Error).message}`);
		return 1;
	}

	const vkd = parseVkd(text);
	console.log(`${fileName}: ${vkd.phones.length} phone(s), ${vkd.boots.size} boot(s)`);
	if (vkd.copyright)
		console.log(`copyright: ${vkd.copyright}`);
	console.log();

	for (const phone of vkd.phones) {
		console.log(`${phone.id}: ${phoneDisplayName(phone)}`);
		console.log(`  fullflash: ${formatRange(phone.fullflash.addr, phone.fullflash.size)}`);

		const areas = phone.memAreas.filter(
			(area) => !(area.name === phone.fullflash.name && area.addr === phone.fullflash.addr && area.size === phone.fullflash.size),
		);
		if (areas.length) {
			console.log("  areas:");
			for (const area of areas) {
				const flags = [
					area.isBootcore ? "bootcore" : undefined,
					area.isNoWrite ? "nowrite" : undefined,
					area.isNoRead ? "noread" : undefined,
				].filter(Boolean).join(", ");
				console.log(`    ${area.name.padEnd(16)} ${formatRange(area.addr, area.size)}${flags ? `  [${flags}]` : ""}`);
			}
		}

		if (phone.memGeometry.length) {
			console.log("  geometry:");
			for (const g of phone.memGeometry)
				console.log(`    ${hex(g.startAddr)}: ${formatSize(g.pageSize)}`);
		}

		if (phone.memFlashBase !== undefined)
			console.log(`  flash base: ${hex(phone.memFlashBase)}`);
		console.log(`  boots: ${phone.boots.join(", ")}`);
		console.log();
	}

	return 0;
}
