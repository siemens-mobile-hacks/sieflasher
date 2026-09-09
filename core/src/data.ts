// Parsing of the binary data values used in the V_KLay phone driver (.vkd) files.
// Port of V_KLay's getdata()/ParseEscapeString() from V_Utilites.cpp.
//
// Supported formats:
//   - Plain hex string: "A55AA5A5"
//   - Comma separated groups of the above: "120000EA,00000000"
//   - Escape string: "0sAT\r\n\xFF" (C-style escapes, octal and \xNN, \uNNNN)
//   - Binary blob: "0b10110" (little endian, byte-aligned groups)
//   - Number with size: "0x1F" (little endian, byte-aligned)

import { Buffer } from "buffer";

export function parseIntAuto(str: string | undefined, def: number = 0): number {
	if (str === undefined || str === null || str === "")
		return def;
	str = str.trim();
	if (/^0x/i.test(str) || /^0b/i.test(str) || /^0o/i.test(str))
		return parseInt(str, 16) || def;
	const num = parseInt(str, 10);
	return isNaN(num) ? def : num;
}

export function parseHexOrDec(str: string | undefined): number | undefined {
	if (str === undefined || str === null)
		return undefined;
	str = str.trim();
	if (!str)
		return undefined;
	const num = /^0x/i.test(str) ? parseInt(str.slice(2), 16) : (/^\d+$/.test(str) ? parseInt(str, 10) : NaN);
	return isNaN(num) ? undefined : num;
}

// Parses an escape string (starting right after "0s" or after a quote) into bytes.
// String escape handling follows V_KLay: \a \b \t \r \v \f \n \e \xNN \NNN (octal) \uNNNN.
// All other characters map to themselves (latin1, since vkd files are in cp1251).
export function parseEscapeString(str: string): Buffer {
	const out: number[] = [];
	let i = 0;
	while (i < str.length) {
		let ch = str[i];
		if (ch == '"')
			break;
		if (ch != "\\") {
			out.push(ch.charCodeAt(0) & 0xFF);
			i++;
			continue;
		}
		i++;
		if (i >= str.length)
			break;
		const c = str[i];
		if (c >= "0" && c <= "7") {
			// Octal, up to 3 digits
			let oct = "";
			while (i < str.length && oct.length < 3 && str[i] >= "0" && str[i] <= "7") {
				oct += str[i];
				i++;
			}
			out.push(parseInt(oct, 8) & 0xFF);
			continue;
		}
		switch (c) {
			case "x": {
				let hex = "";
				while (i + 1 < str.length && hex.length < 2 && /[0-9a-fA-F]/.test(str[i + 1])) {
					hex += str[i + 1];
					i++;
				}
				if (hex.length == 2)
					out.push(parseInt(hex, 16));
				else
					out.push("x".charCodeAt(0));
				i++;
				break;
			}
			case "u": {
				let hex = "";
				while (i + 1 < str.length && hex.length < 4 && /[0-9a-fA-F]/.test(str[i + 1])) {
					hex += str[i + 1];
					i++;
				}
				if (hex.length == 4) {
					// Unicode char, encode as cp1251 single byte when possible
					out.push(...unicodeToCp1251(parseInt(hex, 16)));
				} else {
					out.push("u".charCodeAt(0));
				}
				i++;
				break;
			}
			case "a": out.push(0x07); i++; break;
			case "b": out.push(0x08); i++; break;
			case "t": out.push(0x09); i++; break;
			case "r": out.push(0x0D); i++; break;
			case "v": out.push(0x0B); i++; break;
			case "f": out.push(0x0C); i++; break;
			case "n": out.push(0x0A); i++; break;
			case "e": out.push(0x1B); i++; break;
			default:
				out.push(c.charCodeAt(0) & 0xFF);
				i++;
		}
	}
	return Buffer.from(out);
}

const CP1251_EXTRA: Record<number, number> = {
	0x402: 0x80, 0x403: 0x81, 0x201A: 0x82, 0x453: 0x83, 0x201E: 0x84, 0x2026: 0x85, 0x2020: 0x86,
	0x2021: 0x87, 0x20AC: 0x88, 0x2030: 0x89, 0x409: 0x8A, 0x2039: 0x8B, 0x40A: 0x8C, 0x40C: 0x8D,
	0x40B: 0x8E, 0x40F: 0x8F, 0x452: 0x90, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94,
	0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x00: 0x98, 0x2122: 0x99, 0x459: 0x9A, 0x203A: 0x9B,
	0x45A: 0x9C, 0x45C: 0x9D, 0x45B: 0x9E, 0x45F: 0x9F, 0xA0: 0xA0, 0x40E: 0xA1, 0x45E: 0xA2,
	0x408: 0xA3, 0xA4: 0xA4, 0x490: 0xA5, 0xA6: 0xA6, 0xA7: 0xA7, 0x401: 0xA8, 0xA9: 0xA9,
	0x404: 0xAA, 0xAB: 0xAB, 0xAC: 0xAC, 0xAD: 0xAD, 0xAE: 0xAE, 0x407: 0xAF, 0xB0: 0xB0,
	0xB1: 0xB1, 0x406: 0xB2, 0x456: 0xB3, 0x491: 0xB4, 0xB5: 0xB5, 0xB6: 0xB6, 0xB7: 0xB7,
	0x451: 0xB8, 0x2116: 0xB9, 0x454: 0xBA, 0xBB: 0xBB, 0x458: 0xBC, 0x405: 0xBD, 0x455: 0xBE,
	0x457: 0xBF,
};

function unicodeToCp1251(code: number): number[] {
	if (code < 0x80)
		return [code];
	if (code >= 0x410 && code <= 0x44F)
		return [code - 0x410 + 0xC0];
	const cp = CP1251_EXTRA[code];
	if (cp !== undefined && cp != 0)
		return [cp];
	return [0x3F]; // '?'
}

// Parses the data value from the vkd file. Returns null on error.
export function parseVkdData(value: string | undefined): Buffer | null {
	if (value === undefined || value === null)
		return null;
	value = value.trim();
	if (!value)
		return Buffer.alloc(0);

	if (value.startsWith("0s") || value.startsWith("0S"))
		return parseEscapeString(value.slice(2));

	return parseHexGroups(value);
}

function parseHexGroups(str: string): Buffer | null {
	const chunks: Buffer[] = [];
	let i = 0;

	const isHex = (c: string) => /[0-9a-fA-F]/.test(c);

	while (i < str.length) {
		const c = str[i];
		if (!isHex(c)) {
			if (c == "," && (isHex(str[i + 1] ?? "") || str[i + 1] == '"')) {
				i++;
				continue;
			} else if (c == '"') {
				// Quoted escape string inside data: find the closing quote,
				// skipping the escaped characters.
				let end = -1;
				for (let j = i + 1; j < str.length; j++) {
					if (str[j] == "\\") {
						j++;
						continue;
					}
					if (str[j] == '"') {
						end = j;
						break;
					}
				}
				const body = end == -1 ? str.slice(i + 1) : str.slice(i + 1, end);
				chunks.push(parseEscapeString(body));
				i = (end == -1) ? str.length : end + 1;
				continue;
			}
			return null; // Bad symbol
		}

		if (c == "0" && (str[i + 1] == "b" || str[i + 1] == "x")) {
			const isBin = str[i + 1] == "b";
			i += 2;
			let num = "";
			while (i < str.length && (isBin ? /[01]/.test(str[i]) : isHex(str[i]))) {
				num += str[i];
				i++;
			}
			if (!num)
				return null;
			if (isBin) {
				const len = Math.ceil(num.length / 8);
				chunks.push(numberToLeBuffer(BigInt("0b" + num), len));
			} else {
				const len = Math.ceil(num.length / 2);
				chunks.push(numberToLeBuffer(BigInt("0x" + num), len));
			}
			continue;
		}

		// Plain hex byte
		if (!isHex(str[i + 1] ?? ""))
			return null;
		chunks.push(Buffer.from([parseInt(str.slice(i, i + 2), 16)]));
		i += 2;
	}

	return Buffer.concat(chunks);
}

function numberToLeBuffer(value: bigint, len: number): Buffer {
	const buf = Buffer.alloc(len);
	for (let i = 0; i < len; i++) {
		buf[i] = Number((value >> BigInt(i * 8)) & 0xFFn);
	}
	return buf;
}
