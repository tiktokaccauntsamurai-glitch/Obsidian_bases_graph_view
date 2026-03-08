import { Plugin, TFile, PluginSettingTab, App, Setting } from "obsidian";
import * as yaml from "js-yaml";

// ============================================================
// Типы и интерфейсы
// ============================================================

type Delta = Record<string, Record<string, number>>;

interface BaseFlags {
  flags: Set<string>;
  cleanName: string;
  hasFlags: boolean;
}

interface BaseFileData {
  filters?: {
    and?: string[];
    or?: string[];
    [key: string]: any;
  };
  [key: string]: any;
}

interface BGLSettings {
  graphLinksEnabled: boolean;
  flagFEnabled: boolean;
  flagHEnabled: boolean;
}

const DEFAULT_SETTINGS: BGLSettings = {
  graphLinksEnabled: true,
  flagFEnabled: true,
  flagHEnabled: true,
};

// ============================================================
// Плагин
// ============================================================

export default class BasesGraphLinksPlugin extends Plugin {
  settings: BGLSettings = DEFAULT_SETTINGS;
  private delta: Delta = {};
  private excludedBasePaths: Set<string> = new Set();
  private originalDescriptor: PropertyDescriptor | undefined;
  private isGraphOpen = false;
  private isRefreshing = false;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private embedObserver: MutationObserver | null = null;

  async onload() {
    console.log("[BasesGraphLinks] Загрузка плагина...");

    await this.loadSettings();
    this.addSettingTab(new BGLSettingTab(this.app, this));

    this.originalDescriptor = Object.getOwnPropertyDescriptor(
      this.app.metadataCache,
      "resolvedLinks"
    );

    this.installGetter();

    this.registerEvent(
      this.app.metadataCache.on("resolved", () => {
        if (!this.isRefreshing) this.refreshIfNeeded();
      })
    );

    this.registerEvent(
      this.app.metadataCache.on("changed", (file: TFile) => {
        if (file.extension === "base" || file.extension === "md") {
          this.refreshIfNeeded();
        }
      })
    );

    this.registerEvent(this.app.vault.on("create", () => this.refreshIfNeeded()));
    this.registerEvent(this.app.vault.on("delete", () => this.refreshIfNeeded()));
    this.registerEvent(this.app.vault.on("rename", () => this.refreshIfNeeded()));

    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        const wasOpen = this.isGraphOpen;
        this.isGraphOpen = this.checkGraphOpen();
        if (this.isGraphOpen && !wasOpen) {
          this.isRefreshing = true;
          this.rebuildDelta().then(() => {
            this.triggerGraphRefresh();
            setTimeout(() => { this.isRefreshing = false; }, 200);
          }).catch(() => { this.isRefreshing = false; });
        }
      })
    );

    if (this.settings.flagHEnabled) this.startEmbedObserver();

    console.log("[BasesGraphLinks] Плагин загружен.");
  }

  onunload() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.stopEmbedObserver();
    if (this.originalDescriptor) {
      Object.defineProperty(this.app.metadataCache, "resolvedLinks", this.originalDescriptor);
    }
    this.delta = {};
    this.excludedBasePaths = new Set();
    console.log("[BasesGraphLinks] Плагин выгружен.");
  }

  // ---- Настройки ----

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async applySettingsChange() {
    await this.saveSettings();
    if (this.settings.flagHEnabled) {
      if (!this.embedObserver) this.startEmbedObserver();
    } else {
      this.stopEmbedObserver();
    }
    if (this.checkGraphOpen()) {
      this.isRefreshing = true;
      await this.rebuildDelta();
      this.triggerGraphRefresh();
      setTimeout(() => { this.isRefreshing = false; }, 200);
    }
  }

  // ---- Геттер-перехватчик ----

  private installGetter() {
    const plugin = this;
    const cache = this.app.metadataCache;
    let originalLinks = cache.resolvedLinks;

    Object.defineProperty(cache, "resolvedLinks", {
      get() {
        if (!plugin.isGraphOpen || !plugin.settings.graphLinksEnabled) return originalLinks;
        return plugin.mergeDelta(originalLinks, plugin.delta);
      },
      set(value: any) { originalLinks = value; },
      configurable: true,
      enumerable: true,
    });
  }

  // ---- Слияние дельты ----

  private mergeDelta(
    original: Record<string, Record<string, number>>,
    delta: Delta
  ): Record<string, Record<string, number>> {
    const excluded = this.excludedBasePaths;
    const hasDelta = Object.keys(delta).length > 0;
    const hasExclusions = excluded.size > 0;
    if (!hasDelta && !hasExclusions) return original;

    return new Proxy(original, {
      get(target, prop: string) {
        if (hasExclusions && excluded.has(prop)) return {};
        const orig = target[prop] || {};
        const add = (hasDelta && prop in delta) ? delta[prop] : null;
        if (!add && !hasExclusions) return orig;

        return new Proxy(orig, {
          get(t, p: string) {
            if (hasExclusions && excluded.has(p)) return undefined;
            if (add && p in add) return add[p];
            return t[p];
          },
          has(t, p: string) {
            if (hasExclusions && excluded.has(p)) return false;
            return (add ? p in add : false) || p in t;
          },
          ownKeys(t) {
            const keys = new Set([...Object.keys(t), ...(add ? Object.keys(add) : [])]);
            if (hasExclusions) { for (const ex of excluded) keys.delete(ex); }
            return [...keys];
          },
          getOwnPropertyDescriptor(t, p: string) {
            if (hasExclusions && excluded.has(p)) return undefined;
            if ((add && p in add) || p in t) {
              return { configurable: true, enumerable: true, value: (add && p in add) ? add[p] : t[p], writable: true };
            }
            return undefined;
          },
        });
      },
      has(target, prop: string) {
        if (hasExclusions && excluded.has(prop)) return false;
        return (hasDelta && prop in delta) || prop in target;
      },
      ownKeys(target) {
        const keys = new Set([...Object.keys(target), ...(hasDelta ? Object.keys(delta) : [])]);
        if (hasExclusions) { for (const ex of excluded) keys.delete(ex); }
        return [...keys];
      },
      getOwnPropertyDescriptor(target, prop: string) {
        if (hasExclusions && excluded.has(prop)) return undefined;
        if ((hasDelta && prop in delta) || prop in target) {
          return { configurable: true, enumerable: true, writable: true };
        }
        return undefined;
      },
    });
  }

  // ---- Построение дельты ----

  private async rebuildDelta() {
    const newDelta: Delta = {};
    const newExcluded: Set<string> = new Set();

    if (!this.settings.graphLinksEnabled) {
      this.delta = newDelta;
      this.excludedBasePaths = newExcluded;
      return;
    }

    const baseFiles = this.app.vault.getFiles().filter((f) => f.extension === "base");

    for (const baseFile of baseFiles) {
      try {
        const baseFlags = this.parseBaseFlags(baseFile.basename);

        if (this.settings.flagFEnabled && baseFlags.flags.has("f")) {
          console.log(`[BasesGraphLinks] Пропускаю "${baseFile.name}" (флаг f)`);
          newExcluded.add(baseFile.path);
          continue;
        }

        const content = await this.app.vault.read(baseFile);
        const data = yaml.load(content) as BaseFileData;
        if (!data || !data.filters) continue;

        const matchedFiles = this.evaluateFilters(data.filters);
        const parentMds = this.findParents(baseFile.path);

        for (const parentPath of parentMds) {
          if (!newDelta[parentPath]) newDelta[parentPath] = {};
          for (const matchedFile of matchedFiles) {
            if (matchedFile.path !== parentPath) {
              newDelta[parentPath][matchedFile.path] = 1;
            }
          }
        }
      } catch (e) {
        console.warn(`[BasesGraphLinks] Ошибка: ${baseFile.path}:`, e);
      }
    }

    this.delta = newDelta;
    this.excludedBasePaths = newExcluded;
    console.log(`[BasesGraphLinks] Дельта: ${Object.keys(newDelta).length} родительских, ${newExcluded.size} скрытых`);
  }

  // ---- Парсер фильтров ----

  private evaluateFilters(filters: BaseFileData["filters"]): TFile[] {
    if (!filters) return [];
    const allFiles = this.app.vault.getFiles();
    const conditions: string[] = [];
    let mode: "and" | "or" = "and";

    if (filters.and && Array.isArray(filters.and)) { conditions.push(...filters.and); mode = "and"; }
    else if (filters.or && Array.isArray(filters.or)) { conditions.push(...filters.or); mode = "or"; }
    if (conditions.length === 0) return [];

    const predicates = conditions.map((c) => this.compileCondition(c)).filter((p) => p !== null) as ((f: TFile) => boolean)[];
    if (predicates.length === 0) return [];

    return allFiles.filter((file) =>
      mode === "and" ? predicates.every((p) => p(file)) : predicates.some((p) => p(file))
    );
  }

  private compileCondition(condition: string): ((f: TFile) => boolean) | null {
    const trimmed = condition.trim();

    const folderMatch = trimmed.match(/^file\.inFolder\(["'](.+?)["']\)$/);
    if (folderMatch) {
      const folder = folderMatch[1].replace(/\/$/, "");
      return (f: TFile) => (f.parent?.path || "") === folder;
    }

    const extMatch = trimmed.match(/^file\.ext\s*==\s*["'](.+?)["']$/);
    if (extMatch) { const ext = extMatch[1]; return (f: TFile) => f.extension === ext; }

    const nameContains = trimmed.match(/^file\.name\s+contains\s+["'](.+?)["']$/);
    if (nameContains) { const text = nameContains[1].toLowerCase(); return (f: TFile) => f.basename.toLowerCase().includes(text); }

    console.warn(`[BasesGraphLinks] Неизвестный фильтр: "${trimmed}"`);
    return null;
  }

  // ---- Поиск родительских .md ----

  private findParents(basePath: string): string[] {
    const parents: string[] = [];
    let originalLinks: Record<string, Record<string, number>>;
    try {
      if (this.originalDescriptor && this.originalDescriptor.get) {
        originalLinks = this.originalDescriptor.get.call(this.app.metadataCache);
      } else if (this.originalDescriptor && this.originalDescriptor.value) {
        originalLinks = this.originalDescriptor.value;
      } else { originalLinks = {}; }
    } catch { originalLinks = {}; }

    for (const [sourcePath, links] of Object.entries(originalLinks)) {
      if (links && basePath in links) parents.push(sourcePath);
    }

    if (parents.length === 0) {
      const baseFile = this.app.vault.getAbstractFileByPath(basePath);
      if (baseFile && baseFile instanceof TFile) {
        const baseName = baseFile.basename;
        const baseNameWithExt = baseFile.name;
        for (const sourcePath of Object.keys(originalLinks)) {
          const fileMeta = this.app.metadataCache.getCache(sourcePath);
          if (fileMeta && fileMeta.embeds) {
            for (const embed of fileMeta.embeds) {
              if (embed.link === baseName || embed.link === baseNameWithExt || embed.link === basePath) {
                parents.push(sourcePath);
                break;
              }
            }
          }
        }
      }
    }
    return parents;
  }

  // ---- Система флагов ----

  parseBaseFlags(basename: string): BaseFlags {
    const tildeIndex = basename.indexOf("~");
    if (tildeIndex > 0) {
      const prefix = basename.substring(0, tildeIndex);
      const cleanName = basename.substring(tildeIndex + 1);
      if (/^[a-zA-Z]+$/.test(prefix)) {
        return { flags: new Set(prefix.toLowerCase().split("")), cleanName, hasFlags: true };
      }
    }
    return { flags: new Set(), cleanName: basename, hasFlags: false };
  }

  // ---- Флаг h: embed UI ----

  private startEmbedObserver() {
    if (this.embedObserver) return;
    this.injectHideCSS();
    this.processAllExistingEmbeds();

    this.embedObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (let i = 0; i < mutation.addedNodes.length; i++) {
          const node = mutation.addedNodes[i];
          if (!(node instanceof HTMLElement)) continue;
          if (node.matches?.(".internal-embed.bases-embed")) this.processEmbedElement(node);
          const embeds = node.querySelectorAll?.(".internal-embed.bases-embed");
          if (embeds) embeds.forEach((el) => this.processEmbedElement(el as HTMLElement));
        }
        if (mutation.target instanceof HTMLElement) {
          const parentEmbed = mutation.target.closest?.(".internal-embed.bases-embed");
          if (parentEmbed instanceof HTMLElement) this.processEmbedElement(parentEmbed);
        }
      }
    });

    this.embedObserver.observe(document.body, { childList: true, subtree: true });
    console.log("[BasesGraphLinks] Наблюдатель embed запущен.");
  }

  private stopEmbedObserver() {
    if (this.embedObserver) { this.embedObserver.disconnect(); this.embedObserver = null; }
    this.restoreHiddenHeaders();
    this.removeHideCSS();
  }

  private injectHideCSS() {
    if (document.getElementById("bgl-hide-header-css")) return;
    const s = document.createElement("style");
    s.id = "bgl-hide-header-css";
    s.textContent = `.internal-embed.bases-embed[data-bgl-hide-header="true"] .bases-header { display: none !important; }`;
    document.head.appendChild(s);
  }

  private removeHideCSS() {
    const s = document.getElementById("bgl-hide-header-css");
    if (s) s.remove();
  }

  private processAllExistingEmbeds() {
    document.querySelectorAll(".internal-embed.bases-embed").forEach((el) => this.processEmbedElement(el as HTMLElement));
  }

  private processEmbedElement(embedEl: HTMLElement) {
    if (!this.settings.flagHEnabled) return;
    if (embedEl.dataset.bglHideHeader === "true") return;
    const src = embedEl.getAttribute("src") || "";
    if (!src.endsWith(".base")) return;
    const basename = (src.split("/").pop() || src).replace(/\.base$/, "");
    const flags = this.parseBaseFlags(basename);
    if (!flags.flags.has("h")) return;
    embedEl.dataset.bglHideHeader = "true";
    console.log(`[BasesGraphLinks] Скрыт UI: "${src}" (флаг h)`);
  }

  private restoreHiddenHeaders() {
    document.querySelectorAll('[data-bgl-hide-header="true"]').forEach((el) => {
      if (el instanceof HTMLElement) delete el.dataset.bglHideHeader;
    });
  }

  // ---- Утилиты ----

  private checkGraphOpen(): boolean {
    return this.app.workspace.getLeavesOfType("graph").length > 0;
  }

  private refreshIfNeeded() {
    if (this.isRefreshing) return;
    if (this.checkGraphOpen()) {
      this.isGraphOpen = true;
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => {
        this.isRefreshing = true;
        this.rebuildDelta().then(() => {
          this.triggerGraphRefresh();
          setTimeout(() => { this.isRefreshing = false; }, 200);
        }).catch(() => { this.isRefreshing = false; });
      }, 500);
    }
  }

  private triggerGraphRefresh() {
    for (const leaf of this.app.workspace.getLeavesOfType("graph")) {
      const view = leaf.view as any;
      if (view?.renderer?.onResize) view.renderer.onResize();
      else if (view?.onResize) view.onResize();
    }
    this.app.metadataCache.trigger("resolved");
  }
}

// ============================================================
// Страница настроек
// ============================================================

class BGLSettingTab extends PluginSettingTab {
  plugin: BasesGraphLinksPlugin;

  constructor(app: App, plugin: BasesGraphLinksPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h1", { text: "Bases Graph Links" });

    containerEl.createEl("p", { text: "Плагин создаёт виртуальные связи в графе между родительскими .md заметками и заметками внутри .base баз. Управление поведением — через флаги в имени файла: БУКВЫ~имя.base" });
    containerEl.createEl("p", { text: "This plugin creates virtual graph links between parent .md notes and notes matched by .base databases. Behavior is controlled via flags in the filename: LETTERS~name.base" });

    // ---- Основной тумблер ----
    containerEl.createEl("h2", { text: "🔗 Виртуальные связи / Virtual Links" });

    new Setting(containerEl)
      .setName("Виртуальные связи в графе / Graph virtual links")
      .setDesc(
        "RU: Создаёт связи от .md заметки ко всем заметкам, которые показывает встроенная .base база. " +
        "Выключите чтобы полностью отключить влияние плагина на граф.\n\n" +
        "EN: Creates links from .md note to all notes shown by embedded .base database. " +
        "Turn off to completely disable plugin's effect on the graph."
      )
      .addToggle((t) => t.setValue(this.plugin.settings.graphLinksEnabled).onChange(async (v) => {
        this.plugin.settings.graphLinksEnabled = v;
        await this.plugin.applySettingsChange();
      }));

    // ---- Флаг f ----
    containerEl.createEl("h2", { text: "🚫 Флаг f — скрыть из графа / Flag f — hide from graph" });

    new Setting(containerEl)
      .setName("Разрешить флаг f / Enable flag f")
      .setDesc(
        "RU: Файл f~имя.base полностью скрыт из графа: нет виртуальных связей, нет узла. " +
        "Используйте когда база — виджет в заметке, а не часть структуры знаний.\n\n" +
        "EN: File f~name.base is completely hidden from graph: no virtual links, no node. " +
        "Use when the base is a widget in a note, not part of your knowledge structure."
      )
      .addToggle((t) => t.setValue(this.plugin.settings.flagFEnabled).onChange(async (v) => {
        this.plugin.settings.flagFEnabled = v;
        await this.plugin.applySettingsChange();
      }));

    // ---- Флаг h ----
    containerEl.createEl("h2", { text: "👁 Флаг h — скрыть UI при embed / Flag h — hide embed toolbar" });

    new Setting(containerEl)
      .setName("Разрешить флаг h / Enable flag h")
      .setDesc(
        "RU: Файл h~имя.base — при ![[embed]] панель управления (Sort, Filter, Properties, Search, New) скрыта. " +
        "При открытии базы отдельно — UI на месте. Работает через CSS + MutationObserver.\n\n" +
        "EN: File h~name.base — when embedded via ![[]], the toolbar (Sort, Filter, Properties, Search, New) is hidden. " +
        "When opened directly — UI works normally. Uses CSS + MutationObserver."
      )
      .addToggle((t) => t.setValue(this.plugin.settings.flagHEnabled).onChange(async (v) => {
        this.plugin.settings.flagHEnabled = v;
        await this.plugin.applySettingsChange();
      }));

    // ---- Примеры ----
    containerEl.createEl("h2", { text: "📝 Примеры / Examples" });
    const ex = containerEl.createEl("div");
    ex.createEl("p", { text: "проекты.base → обычная индексация / normal indexing" });
    ex.createEl("p", { text: "f~проекты.base → скрыта из графа / hidden from graph" });
    ex.createEl("p", { text: "h~проекты.base → UI скрыт при embed / toolbar hidden in embed" });
    ex.createEl("p", { text: "fh~проекты.base → оба эффекта / both effects" });
  }
}
