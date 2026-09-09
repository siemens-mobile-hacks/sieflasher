// V_KLay phone driver (.vkd) file support.
// Port of VPhoneLoaderOptions::Load(), VPhoneBoot::ReadInfo() and
// VDevicePhone::LoadPhoneInfo() from VDevicePhone.cpp.

import { IniFile } from "./ini.js";
import { parseIntAuto, parseHexOrDec, parseVkdData } from "./data.js";
import { Buffer } from "buffer";

export const DEFAULT_BAUD_CODES = "57600: 0x00, 115200: 0x01, 230400: 0x02, 460800: 0x03, 921600: 0x04";

export interface MemArea {
	name: string;
	addr: number; // Absolute address
	size: number;
	isBootcore: boolean;
	isNoWrite: boolean;
	isNoRead: boolean;
}

export interface MemGeometry {
	startAddr: number; // Absolute address
	pageSize: number;
}

export interface LoaderOptions {
	isInfoCmdDis: boolean;
	isBaudCmdDis: boolean;
	baudsCodes: Map<number, number>;
	isRstBootcoreCmdEn: boolean;
	keepAliveInterval: number; // in keepalive ticks (250ms each), 0 = disabled
	authorization: number;
	cmdAddrAndSizeLen: number;

	readCmdSkipBytesAfterCmdParameters: number;
	isExistReadCmdSkipBytesAfterData: boolean;
	readCmdSkipBytesAfterData: number;
	isExistReadCmdSkipBytesAfterOK: boolean;
	readCmdSkipBytesAfterOK: number;
	isExistReadCmdSkipBytesAfterCheckSum: boolean;
	readCmdSkipBytesAfterCheckSum: number;
	readCmdAnswerOK: Buffer;
	isExistReadCmdAnswerOK: boolean;
	readCmdAnswerCheckSumType: number;
	readCmdAnswerOrderCheckSumThenOK: boolean;

	writeCmdVersion: number;

	loaderUploadTryCount: number; // -1 = infinite
	loaderUploadDelay: number; // ms between retries
	isExistWriteCmdSkipBytesAfterCmdParameters: boolean;
	writeCmdSkipBytesAfterCmdParameters: number;
	isExistWriteCmdSkipBytesAfterBlockSize: boolean;
	writeCmdSkipBytesAfterBlockSize: number;
	isExistWriteCmdSkipBytesAfterDataWithCheckSum: boolean;
	writeCmdSkipBytesAfterDataWithCheckSum: number;
	isExistWriteCmdSkipBytesAfterEraseStep: boolean;
	writeCmdSkipBytesAfterEraseStep: number;
	isExistWriteCmdSkipBytesAfterWriteStep: boolean;
	writeCmdSkipBytesAfterWriteStep: number;
	isExistWriteCmdSkipBytesAfterWittenCheckSum: boolean;
	writeCmdSkipBytesAfterWittenCheckSum: number;
}

export interface VkdBoot {
	name: string;
	data: Buffer;
	answer?: Buffer;
	noSendLen: boolean;
	noSendCheckSum: boolean;
	sizeLen: number;
	baud?: number;
	delayBefore?: number;
	delayAfter?: number;
	answerTimeout: number;
	useIgnition: boolean;
	tryCount: number;
}

export interface VkdPhone {
	id: string; // Section name, e.g. "Phone01"
	name: string;
	type: string;
	comments: string;
	boots: string[];
	fullflash: MemArea;
	memAreas: MemArea[];
	memGeometry: MemGeometry[];
	memFlashBase: number | undefined;
	opts: LoaderOptions;
}

export interface VkdFile {
	name: string;
	comments: string;
	copyright: string;
	phones: VkdPhone[];
	boots: Map<string, VkdBoot>;
	// Case-insensitive boot lookup (like V_KLay's CompareNoCase).
	getBoot(name: string): VkdBoot | undefined;
}

export function makeDefaultOptions(): LoaderOptions {
	return {
		isInfoCmdDis: false,
		isBaudCmdDis: false,
		baudsCodes: parseBaudCodes(DEFAULT_BAUD_CODES),
		isRstBootcoreCmdEn: false,
		keepAliveInterval: 0,
		authorization: 0,
		cmdAddrAndSizeLen: 3,

		readCmdSkipBytesAfterCmdParameters: 0,
		isExistReadCmdSkipBytesAfterData: false,
		readCmdSkipBytesAfterData: 0,
		isExistReadCmdSkipBytesAfterOK: false,
		readCmdSkipBytesAfterOK: 0,
		isExistReadCmdSkipBytesAfterCheckSum: false,
		readCmdSkipBytesAfterCheckSum: 0,
		readCmdAnswerOK: Buffer.from("OK", "latin1"),
		isExistReadCmdAnswerOK: false,
		readCmdAnswerCheckSumType: 1,
		readCmdAnswerOrderCheckSumThenOK: false,

		writeCmdVersion: 1,
		loaderUploadTryCount: 0,
		loaderUploadDelay: 0,
		isExistWriteCmdSkipBytesAfterCmdParameters: false,
		writeCmdSkipBytesAfterCmdParameters: 0,
		isExistWriteCmdSkipBytesAfterBlockSize: false,
		writeCmdSkipBytesAfterBlockSize: 0,
		isExistWriteCmdSkipBytesAfterDataWithCheckSum: false,
		writeCmdSkipBytesAfterDataWithCheckSum: 0,
		isExistWriteCmdSkipBytesAfterEraseStep: false,
		writeCmdSkipBytesAfterEraseStep: 0,
		isExistWriteCmdSkipBytesAfterWriteStep: false,
		writeCmdSkipBytesAfterWriteStep: 0,
		isExistWriteCmdSkipBytesAfterWittenCheckSum: false,
		writeCmdSkipBytesAfterWittenCheckSum: 0,
	};
}

export function parseBaudCodes(str: string | undefined): Map<number, number> {
	const result = new Map<number, number>();
	if (!str)
		return result;
	str = str.trim();
	if (!str || str == "0")
		return result;
	const parts = splitParamsList(str);
	for (let i = 0; i + 1 < parts.length; i += 2) {
		const baud = parseIntAuto(parts[i]);
		const code = parseIntAuto(parts[i + 1]);
		if (i == 0 && baud == 0)
			return new Map();
		result.set(baud, code);
	}
	return result;
}

// Port of VGetParameterFromList(): splits the list on ',' and ':' separators,
// respecting the double-quoted entries.
export function splitParamsList(value: string): string[] {
	const parts: string[] = [];
	let i = 0;
	while (i < value.length) {
		while (i < value.length && /\s/.test(value[i]))
			i++;
		if (i >= value.length)
			break;
		let part: string;
		if (value[i] == '"') {
			const end = value.indexOf('"', i + 1);
			const stop = end == -1 ? value.length : end;
			part = value.slice(i + 1, stop);
			i = stop + 1;
			while (i < value.length && value[i] != "," && value[i] != ":")
				i++;
		} else {
			const start = i;
			while (i < value.length && value[i] != "," && value[i] != ":")
				i++;
			part = value.slice(start, i);
		}
		parts.push(part.trim());
		if (i < value.length)
			i++;
	}
	return parts.filter((p) => p.length > 0);
}

// "name, addr, size, flags..." (as in MCUMemFuBu / MCUMemAreaXX)
export function parseMemArea(value: string | undefined): MemArea | undefined {
	if (!value)
		return undefined;
	const parts = splitParamsList(value);
	if (parts.length < 3)
		return undefined;
	const name = parts[0];
	const addr = parseHexOrDec(parts[1]);
	const size = parseHexOrDec(parts[2]);
	if (addr === undefined || size === undefined)
		return undefined;
	const area: MemArea = {
		name,
		addr,
		size,
		isBootcore: false,
		isNoWrite: false,
		isNoRead: false,
	};
	for (let i = 3; i < parts.length; i++) {
		switch (parts[i].toLowerCase()) {
			case "bootcore": area.isBootcore = true; break;
			case "nowrite": area.isNoWrite = true; break;
			case "noread": area.isNoRead = true; break;
		}
	}
	return area;
}

// "0x000000: 0x010000, 0x400000: 0x020000" or "0"
export function parseMemGeometry(value: string | undefined): MemGeometry[] {
	if (!value)
		return [];
	value = value.trim();
	if (!value || value == "0")
		return [];
	const parts = splitParamsList(value);
	const result: MemGeometry[] = [];
	for (let i = 0; i + 1 < parts.length; i += 2) {
		const startAddr = parseHexOrDec(parts[i]);
		const pageSize = parseHexOrDec(parts[i + 1]);
		if (startAddr === undefined || pageSize === undefined)
			return [];
		result.push({ startAddr, pageSize });
	}
	result.sort((a, b) => a.startAddr - b.startAddr);
	return result;
}

function loadOptions(ini: IniFile, section: string): LoaderOptions {
	const opts = makeDefaultOptions();
	const get = (key: string): string | undefined => ini.getString(section, "opt" + key);
	const getHex = (key: string, def: number): number => {
		const v = get(key);
		return v === undefined ? def : (parseHexOrDec(v) ?? def);
	};

	opts.isInfoCmdDis = !!getHex("InfoCmdDisable", 0);
	opts.isBaudCmdDis = !!getHex("BaudCmdDisable", 0);
	opts.baudsCodes = parseBaudCodes(get("BaudCmdCodes") ?? DEFAULT_BAUD_CODES);
	opts.isRstBootcoreCmdEn = !!getHex("RestoreBootcoreCmdEnable", 0);

	const keepAlive = getHex("KeepAliveCmdEnableAndSetInterval", 0);
	opts.keepAliveInterval = Math.max(1, Math.round(keepAlive / 250)) * (keepAlive ? 1 : 0);
	if (!keepAlive)
		opts.keepAliveInterval = 0;

	opts.cmdAddrAndSizeLen = getHex("CmdAddrAndSizeLen", 3);
	opts.authorization = getHex("Authorization", 0);

	opts.readCmdSkipBytesAfterCmdParameters = getHex("ReadCmdSkipBytesAfterCmdParameters", 0);
	const skipData = get("ReadCmdSkipBytesAfterData");
	if (skipData !== undefined) {
		opts.isExistReadCmdSkipBytesAfterData = true;
		opts.readCmdSkipBytesAfterData = parseHexOrDec(skipData) ?? 0;
	}
	const skipOK = get("ReadCmdSkipBytesAfterOK");
	if (skipOK !== undefined) {
		opts.isExistReadCmdSkipBytesAfterOK = true;
		opts.readCmdSkipBytesAfterOK = parseHexOrDec(skipOK) ?? 0;
	}
	const skipCS = get("ReadCmdSkipBytesAfterCheckSum");
	if (skipCS !== undefined) {
		opts.isExistReadCmdSkipBytesAfterCheckSum = true;
		opts.readCmdSkipBytesAfterCheckSum = parseHexOrDec(skipCS) ?? 0;
	}
	const answerOK = get("ReadCmdAnswerOK");
	if (answerOK !== undefined) {
		opts.isExistReadCmdAnswerOK = true;
		const data = parseVkdData(answerOK);
		if (data !== null)
			opts.readCmdAnswerOK = data;
	}
	opts.readCmdAnswerCheckSumType = getHex("ReadCmdAnswerCheckSumType", 1);
	opts.readCmdAnswerOrderCheckSumThenOK = !!getHex("ReadCmdAnswerOrderCheckSumThenOK", 0);

	opts.writeCmdVersion = getHex("WriteCmdVersion", 1);
	opts.loaderUploadTryCount = getHex("LoaderUploadTryCount", 0);
	opts.loaderUploadDelay = getHex("LoaderUploadDelay", 0);
	const skipCmdParams = get("WriteCmdSkipBytesAfterCmdPatameters");
	if (skipCmdParams !== undefined) {
		opts.isExistWriteCmdSkipBytesAfterCmdParameters = true;
		opts.writeCmdSkipBytesAfterCmdParameters = parseHexOrDec(skipCmdParams) ?? 0;
	}
	const skipBlockSize = get("WriteCmdSkipBytesAfterBlockSize");
	if (skipBlockSize !== undefined) {
		opts.isExistWriteCmdSkipBytesAfterBlockSize = true;
		opts.writeCmdSkipBytesAfterBlockSize = parseHexOrDec(skipBlockSize) ?? 0;
	}
	const skipDataCS = get("WriteCmdSkipBytesAfterDataWithCheckSum");
	if (skipDataCS !== undefined) {
		opts.isExistWriteCmdSkipBytesAfterDataWithCheckSum = true;
		opts.writeCmdSkipBytesAfterDataWithCheckSum = parseHexOrDec(skipDataCS) ?? 0;
	}
	const skipErase = get("WriteCmdSkipBytesAfterEraseStep");
	if (skipErase !== undefined) {
		opts.isExistWriteCmdSkipBytesAfterEraseStep = true;
		opts.writeCmdSkipBytesAfterEraseStep = parseHexOrDec(skipErase) ?? 0;
	}
	const skipWrite = get("WriteCmdSkipBytesAfterWriteStep");
	if (skipWrite !== undefined) {
		opts.isExistWriteCmdSkipBytesAfterWriteStep = true;
		opts.writeCmdSkipBytesAfterWriteStep = parseHexOrDec(skipWrite) ?? 0;
	}
	const skipWrittenCS = get("WriteCmdSkipBytesAfterWittenCheckSum");
	if (skipWrittenCS !== undefined) {
		opts.isExistWriteCmdSkipBytesAfterWittenCheckSum = true;
		opts.writeCmdSkipBytesAfterWittenCheckSum = parseHexOrDec(skipWrittenCS) ?? 0;
	}

	return opts;
}

function loadBoot(ini: IniFile, bootSection: string): VkdBoot | undefined {
	const name = ini.getString(bootSection, "Name");
	if (!name)
		return undefined;

	const boot: VkdBoot = {
		name,
		data: Buffer.alloc(0),
		answer: undefined,
		noSendLen: !!parseIntAuto(ini.getString(bootSection, "NoSendLen"), 0),
		noSendCheckSum: !!parseIntAuto(ini.getString(bootSection, "NoSendCheckSum"), 0),
		sizeLen: parseIntAuto(ini.getString(bootSection, "SizeLen"), 0),
		baud: parseHexOrDec(ini.getString(bootSection, "PortSpeed") ?? ""),
		delayBefore: parseHexOrDec(ini.getString(bootSection, "DelayBefore") ?? ""),
		delayAfter: parseHexOrDec(ini.getString(bootSection, "DelayAfter") ?? ""),
		answerTimeout: parseIntAuto(ini.getString(bootSection, "AnswerTimeout"), 0),
		useIgnition: !!parseIntAuto(ini.getString(bootSection, "UseIgnition"), 0),
		tryCount: parseIntAuto(ini.getString(bootSection, "TryCount"), 0),
	};

	const data = parseVkdData(ini.getString(bootSection, "Data"));
	if (data !== null && data.length > 0) {
		boot.data = data;
	} else {
		// Concatenated Data01..DataNN
		const chunks: Buffer[] = [];
		for (let i = 1; ; i++) {
			const key = `Data${String(i).padStart(2, "0")}`;
			const part = parseVkdData(ini.getString(bootSection, key));
			if (part === null || part.length == 0)
				break;
			chunks.push(part);
		}
		boot.data = Buffer.concat(chunks);
	}

	const answer = parseVkdData(ini.getString(bootSection, "Answer"));
	if (answer !== null && answer.length > 0)
		boot.answer = answer;

	return boot;
}
// Sequentially builds the phone descriptions the same way as V_KLay does it:
// the [PhoneCommonInfo] state is loaded first, then every [PhoneNN] section
// is merged into it (missing keys inherit values from the previous section).
export function parseVkd(text: string): VkdFile {
	const ini = IniFile.parse(text);
	const boots = new Map<string, VkdBoot>();
	const vkd: VkdFile = {
		name: ini.getString("PhoneCommonInfo", "Name") ?? "",
		comments: ini.getString("PhoneCommonInfo", "Comments") ?? "",
		copyright: ini.getString("PhoneCommonInfo", "Copyright") ?? "",
		phones: [],
		boots,
		getBoot(name: string): VkdBoot | undefined {
			if (boots.has(name))
				return boots.get(name);
			for (const [key, value] of boots) {
				if (key.toLowerCase() == name.toLowerCase())
					return value;
			}
			return undefined;
		},
	};

	for (const section of ini.getSectionNames()) {
		if (/^Boot\d+$/i.test(section)) {
			const boot = loadBoot(ini, section);
			if (boot)
				boots.set(boot.name, boot);
		}
	}

	// Merged state, shared between the phone sections.
	const state = {
		name: "",
		type: "",
		comments: "",
		boots: [] as string[],
		fullflash: undefined as MemArea | undefined,
		memAreas: [] as MemArea[],
		memAreaStart: 0,
		memAreaStartAddrLdr: 0,
		memGeometry: [] as MemGeometry[],
		opts: makeDefaultOptions(),
	};

	const loadSection = (section: string): void => {
		state.name = ini.getString(section, "Name") ?? state.name;
		state.type = ini.getString(section, "Type") ?? state.type;
		state.comments = ini.getString(section, "Comments") ?? state.comments;

		// Memory geometry: a missing key keeps the current value,
		// "0" clears it, a list replaces it.
		const geometryValue = ini.getString(section, "MCUMemGeometry");
		if (geometryValue !== undefined && geometryValue.trim() != "") {
			// parseMemGeometry() returns [] for "0" and for broken values.
			state.memGeometry = parseMemGeometry(geometryValue);
		}

		// Loader options: are replaced (with defaults) when any opt* key exists in the section.
		if (hasOptKeys(ini, section))
			state.opts = loadOptions(ini, section);

		// Memory areas.
		const memFlashBase = parseHexOrDec(ini.getString(section, "MCUMemFlashBase") ?? "");
		const fubuStr = ini.getString(section, "MCUMemFuBu");
		const fubu = fubuStr !== undefined && fubuStr.trim() != "" ? parseMemArea(fubuStr) : undefined;
		if (memFlashBase !== undefined || fubu) {
			state.memAreas = [];
			state.memAreaStart = 0;
			state.memAreaStartAddrLdr = 0;
			state.fullflash = undefined;
			if (fubu) {
				state.fullflash = fubu;
				state.memAreaStart = state.memAreaStartAddrLdr = fubu.addr;
				state.memAreas.push(fubu);
				for (let i = 1; ; i++) {
					const key = `MCUMemArea${String(i).padStart(2, "0")}`;
					const area = parseMemArea(ini.getString(section, key));
					if (!area)
						break;
					state.memAreas.push(area);
				}
				if (memFlashBase !== undefined)
					state.memAreaStartAddrLdr = memFlashBase;
			}
		}

		// Boots.
		const boots = ini.getString(section, "Boots");
		if (boots !== undefined && boots.trim() != "")
			state.boots = boots.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
	};

	loadSection("PhoneCommonInfo");

	let phoneIdx = 0;
	while (true) {
		const section = `Phone${String(phoneIdx + 1).padStart(2, "0")}`;
		if (!ini.getSection(section))
			break;
		phoneIdx++;
		loadSection(section);

		if (!state.fullflash)
			continue;

		vkd.phones.push({
			id: section,
			name: state.name || section,
			type: state.type == "." ? "" : state.type,
			comments: state.comments,
			boots: [...state.boots],
			fullflash: state.fullflash,
			memAreas: state.memAreas.map((a) => ({ ...a })),
			memGeometry: [...state.memGeometry],
			memFlashBase: state.memAreaStartAddrLdr,
			opts: { ...state.opts, baudsCodes: new Map(state.opts.baudsCodes) },
		});
	}

	// Some drivers (e.g. C45) define everything in [PhoneCommonInfo] only.
	if (!vkd.phones.length && state.fullflash) {
		vkd.phones.push({
			id: "PhoneCommonInfo",
			name: state.name || vkd.name || "Phone",
			type: state.type == "." ? "" : state.type,
			comments: state.comments,
			boots: [...state.boots],
			fullflash: state.fullflash,
			memAreas: state.memAreas.map((a) => ({ ...a })),
			memGeometry: [...state.memGeometry],
			memFlashBase: state.memAreaStartAddrLdr,
			opts: { ...state.opts, baudsCodes: new Map(state.opts.baudsCodes) },
		});
	}

	return vkd;
}

function hasOptKeys(ini: IniFile, section: string): boolean {
	const sec = ini.getSection(section);
	if (!sec)
		return false;
	for (const key of sec.keys.keys()) {
		if (key.toLowerCase().startsWith("opt"))
			return true;
	}
	return false;
}

// Formats phone entry for the UI: "S65 (Password boot)"
export function phoneDisplayName(phone: VkdPhone): string {
	const type = phone.type == "." ? "" : phone.type;
	return type ? `${phone.name} (${type})` : phone.name;
}
