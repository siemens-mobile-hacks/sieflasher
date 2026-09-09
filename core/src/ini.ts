// Minimal INI parser compatible with the V_KLay phone driver (.vkd) files.
// Values are kept as raw strings, section/key lookup is case-sensitive first
// with a case-insensitive fallback.

export interface IniSection {
	name: string;
	keys: Map<string, string>;
}

export class IniFile {
	private sections: IniSection[] = [];
	private sectionByName = new Map<string, IniSection>();

	static parse(text: string): IniFile {
		const ini = new IniFile();
		ini.parse(text);
		return ini;
	}

	parse(text: string): void {
		// Drop BOM and normalize newlines.
		text = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
		let current: IniSection | undefined;

		for (let line of text.split("\n")) {
			line = line.trim();
			if (!line || line.startsWith(";") || line.startsWith("#"))
				continue;

			if (line.startsWith("[")) {
				const end = line.indexOf("]");
				if (end == -1)
					continue;
				const name = line.slice(1, end).trim();
				current = this.getOrCreateSection(name);
				continue;
			}

			if (!current)
				continue;

			const eq = line.indexOf("=");
			if (eq == -1)
				current.keys.set(line.trim(), "");
			else
				current.keys.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
		}
	}

	getSectionNames(): string[] {
		return this.sections.map((s) => s.name);
	}

	getSection(name: string): IniSection | undefined {
		return this.sectionByName.get(name.toLowerCase());
	}

	private getOrCreateSection(name: string): IniSection {
		let section = this.sectionByName.get(name.toLowerCase());
		if (!section) {
			section = { name, keys: new Map() };
			this.sections.push(section);
			this.sectionByName.set(name.toLowerCase(), section);
		}
		return section;
	}

	getString(section: string, key: string, def?: string): string | undefined {
		const sec = this.getSection(section);
		if (!sec)
			return def;
		if (sec.keys.has(key))
			return sec.keys.get(key);
		// Case-insensitive fallback
		for (const [k, v] of sec.keys) {
			if (k.toLowerCase() == key.toLowerCase())
				return v;
		}
		return def;
	}
}
