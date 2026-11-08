const { FuzzySuggestModal, Notice, Plugin, PluginSettingTab, Setting, TFile } = require("obsidian");

// A page opts in with the property `inline-edit: true`.
const PROP = "inline-edit";
const DEFAULT_SETTINGS = { showAddRow: true };

// "> - [ ] text ^id": quote markers, indent, bullet or number, optional checkbox, content.
const ITEM = /^((?:\s*>)*)(\s*)([-*+]|\d{1,9}[.)])(\s+)(\[[ xX]\]\s+)?(.*)$/;
const FENCE = /^(?:\s*>)*\s*(`{3,}|~{3,})/;
const BLOCK_ID = /^(.*?)(\s+\^[A-Za-z0-9-]+)?$/;
// Children of a rendered <li> that are not its own text.
const OWN_NODES = "input.task-list-item-checkbox, ul, ol, .list-bullet, .list-collapse-indicator, .collapse-indicator, .ie-editor";
const EMBEDS = ".internal-embed, .markdown-embed";
const SKIP_CLICK = `.ie-editor, input, a, button, .list-collapse-indicator, .collapse-indicator, ${EMBEDS}`;

const isOn = (fm) => !!fm && (fm[PROP] === true || fm[PROP] === "true");
const plainFromMd = (s) =>
  s
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const squash = (s) => s.replace(/\s+/g, " ").trim();

// The list lines of a rendered section, in file order. Lines inside code fences are skipped.
function sectionItems(info) {
  const lines = info.text.split("\n");
  const items = [];
  let fence = null;
  for (let i = info.lineStart; i <= info.lineEnd && i < lines.length; i++) {
    const f = FENCE.exec(lines[i]);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0]) fence = null;
      continue;
    }
    if (fence) continue;
    const m = ITEM.exec(lines[i]);
    if (!m) continue;
    const [, content, tail = ""] = BLOCK_ID.exec(m[6]);
    const lead = m[1] + m[2] + m[3] + m[4];
    items.push({
      abs: i,
      line: lines[i],
      indent: m[1] + m[2],
      marker: m[3],
      gap: m[4],
      lead,
      head: lead + (m[5] ?? ""),
      hasBox: !!m[5],
      content,
      tail,
    });
  }
  return items;
}

class PagePicker extends FuzzySuggestModal {
  constructor(app, files, onChoose) {
    super(app);
    this.files = files;
    this.onChoose = onChoose;
    this.setPlaceholder("Add a page to inline editing...");
  }

  getItems() {
    return this.files;
  }

  getItemText(file) {
    return file.path;
  }

  onChooseItem(file) {
    this.onChoose(file);
  }
}

class InlineEditSettings extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Show \"+ add item\" under lists")
      .setDesc("A faint row under each list, visible on hover, that adds an item at the end.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showAddRow).onChange(async (v) => {
          this.plugin.settings.showAddRow = v;
          await this.plugin.saveSettings();
          this.plugin.refreshAll();
        })
      );

    new Setting(containerEl).setName("Pages with inline editing").setHeading();
    const pages = this.plugin.enabledPages();
    if (!pages.length) containerEl.createEl("p", { text: "No pages yet.", cls: "setting-item-description" });
    for (const file of pages) {
      new Setting(containerEl)
        .setName(file.basename)
        .setDesc(file.path)
        .addButton((b) => b.setButtonText("Open").onClick(() => this.app.workspace.getLeaf("tab").openFile(file)))
        .addButton((b) =>
          b.setButtonText("Remove").onClick(async () => {
            await this.plugin.setPage(file, false);
            this.display();
          })
        );
    }

    new Setting(containerEl)
      .setName("Add a page")
      .setDesc("Sets the property inline-edit: true on the note. Its properties block may be reformatted.")
      .addButton((b) =>
        b
          .setButtonText("Add page...")
          .setCta()
          .onClick(() => {
            const off = this.app.vault.getMarkdownFiles().filter((f) => !this.plugin.isPage(f));
            new PagePicker(this.app, off, async (file) => {
              await this.plugin.setPage(file, true);
              this.display();
            }).open();
          })
      );
  }
}

module.exports = class InlineEdit extends Plugin {
  async onload() {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) ?? {}) };
    this.sections = new WeakMap();
    this.addSettingTab(new InlineEditSettings(this.app, this));

    this.addCommand({
      id: "toggle-page",
      name: "Toggle for this page",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!(file instanceof TFile) || file.extension !== "md") return false;
        if (!checking) this.setPage(file, !this.isPage(file));
        return true;
      },
    });
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        const on = this.isPage(file);
        menu.addItem((item) =>
          item
            .setTitle(on ? "Turn off inline editing" : "Turn on inline editing")
            .setIcon("pencil")
            .onClick(() => this.setPage(file, !on))
        );
      })
    );

    this.registerMarkdownPostProcessor((el, ctx) => this.prepare(el, ctx), 200);
    this.registerDomEvent(document, "click", (e) => this.onClick(e));
    this.registerDomEvent(document, "keydown", (e) => {
      const add = e.target instanceof HTMLElement ? e.target.closest(".ie-add") : null;
      if (add && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        this.startAdd(add);
      }
    });
  }

  onunload() {
    for (const n of document.querySelectorAll(".ie-add, .ie-editor, .ie-new")) n.remove();
    for (const n of document.querySelectorAll(".ie-editable")) n.classList.remove("ie-editable");
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ---- Pages ----

  isPage(file) {
    return isOn(this.app.metadataCache.getFileCache(file)?.frontmatter);
  }

  enabledPages() {
    return this.app.vault.getMarkdownFiles().filter((f) => this.isPage(f));
  }

  async setPage(file, on) {
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      if (on) fm[PROP] = true;
      else delete fm[PROP];
    });
    new Notice(`Inline editing ${on ? "on" : "off"}: ${file.basename}`);
    window.setTimeout(() => this.refresh(file.path, true), 400);
  }

  // Redraw reading view now (Obsidian can hold a redraw back in a background window). `hard` rebuilds the view,
  // which re-runs the post-processor; a plain rerender reuses cached sections whose text did not change.
  refresh(path, hard = false) {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (path && leaf.view.file?.path !== path) continue;
      if (hard) leaf.rebuildView?.();
      else leaf.view.previewMode?.rerender?.(true);
    }
  }

  refreshAll() {
    this.refresh(null, true);
  }

  // ---- Rendering hook ----

  // Remembers each rendered section of an enabled page and marks its list items.
  prepare(el, ctx) {
    if (!isOn(ctx.frontmatter)) return;
    this.sections.set(el, ctx);
    for (const li of el.querySelectorAll("li")) {
      if (!li.closest(EMBEDS)) li.classList.add("ie-editable");
    }
    if (!this.settings.showAddRow) return;
    for (const list of el.querySelectorAll("ul, ol")) {
      if (list.closest("li") || list.closest(EMBEDS)) continue;
      if (list.nextElementSibling?.classList.contains("ie-add")) continue;
      list.insertAdjacentElement(
        "afterend",
        createDiv({ cls: "ie-add", text: "+ add item", attr: { role: "button", tabindex: "0" } })
      );
    }
  }

  // The enabled section (element + render context) that holds a node.
  sectionOf(node) {
    const view = node.closest(".markdown-preview-view");
    for (let a = node; a && a !== view; a = a.parentElement) {
      const ctx = this.sections.get(a);
      if (ctx) return { el: a, ctx };
    }
    return null;
  }

  liveItems(sec) {
    return [...sec.el.querySelectorAll("li")].filter((li) => !li.closest(EMBEDS) && !li.classList.contains("ie-new"));
  }

  // File lines of a section, or null when the rendered rows and the file lines do not line up.
  linesOf(sec) {
    const info = sec.ctx.getSectionInfo(sec.el);
    if (!info) return null;
    const items = sectionItems(info);
    const lis = this.liveItems(sec);
    if (items.length !== lis.length) {
      new Notice("Can't edit here: this part of the page doesn't match the note's text. Reopen the page.");
      return null;
    }
    return { items, lis };
  }

  // ---- Clicks ----

  onClick(e) {
    const t = e.target;
    if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    if (!(t instanceof HTMLElement) || !t.closest(".markdown-preview-view")) return;
    if (t.closest(SKIP_CLICK)) return;
    if (window.getSelection()?.toString()) return;
    const add = t.closest(".ie-add");
    if (add) return this.startAdd(add);
    const li = t.closest("li");
    if (!li || li.classList.contains("ie-editing") || li.classList.contains("ie-new")) return;
    const sec = this.sectionOf(li);
    if (!sec) return;
    const found = this.linesOf(sec);
    if (!found) return;
    const item = found.items[found.lis.indexOf(li)];
    const own = li.cloneNode(true);
    own.querySelectorAll(OWN_NODES).forEach((n) => n.remove());
    if (!item || norm(own.textContent) !== norm(plainFromMd(item.content))) {
      new Notice("Can't edit this line: it doesn't match the note's text. Reopen the page.");
      return;
    }
    this.startEdit(li, item, sec.ctx.sourcePath);
  }

  // ---- Saving ----

  // Atomic read-modify-write; fn gets the file's lines and returns false to abort.
  async patchFile(path, fn) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return false;
    let ok = false;
    await this.app.vault.process(file, (data) => {
      const lines = data.split("\n");
      if (!fn(lines)) return data;
      ok = true;
      return lines.join("\n");
    });
    if (!ok) new Notice("The note changed since it was drawn, so nothing was saved. Reopen the page and retry.");
    else this.refresh(file.path);
    return ok;
  }

  // ---- Editing ----

  makeEditor(text, onDone, onCancel) {
    const ed = createSpan({ cls: "ie-editor", text });
    try {
      ed.contentEditable = "plaintext-only";
    } catch (err) {
      ed.contentEditable = "true";
    }
    let finished = false;
    const finish = (fn, arg) => {
      if (finished) return;
      finished = true;
      fn(arg);
    };
    ed.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if (e.key === "Enter") {
        e.preventDefault();
        finish(onDone, ed.textContent);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(onCancel);
      }
    });
    ed.addEventListener("blur", () => finish(onDone, ed.textContent));
    return ed;
  }

  focusEnd(ed) {
    ed.focus();
    const range = document.createRange();
    range.selectNodeContents(ed);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  startEdit(li, item, path) {
    // Move the row's own content into a hidden wrapper; the editor takes its place.
    const kids = [...li.childNodes].filter((n) => n.nodeType === 3 || !n.matches(OWN_NODES));
    const wrap = createSpan({ cls: "ie-line-view" });
    li.insertBefore(wrap, kids[0] ?? li.querySelector(":scope > ul, :scope > ol"));
    kids.forEach((n) => wrap.appendChild(n));
    const restore = () => {
      ed.remove();
      while (wrap.firstChild) li.insertBefore(wrap.firstChild, wrap);
      wrap.remove();
      li.classList.remove("ie-editing");
    };
    const ed = this.makeEditor(
      item.content,
      async (raw) => {
        const value = squash(raw);
        if (value === item.content) return restore();
        if (!value && li.querySelector(":scope > ul, :scope > ol")) {
          new Notice("Move or delete the sub-items first.");
          return restore();
        }
        const ok = await this.patchFile(path, (lines) => {
          if (lines[item.abs] !== item.line) return false;
          if (value) lines[item.abs] = item.head + value + item.tail;
          else lines.splice(item.abs, 1);
          return true;
        });
        if (!ok) restore();
      },
      restore
    );
    li.classList.add("ie-editing");
    li.insertBefore(ed, wrap.nextSibling);
    this.focusEnd(ed);
  }

  // Marker for a new last item: same bullet, or the next number for a numbered list.
  nextMarker(first, listItems) {
    const num = /^(\d+)([.)])$/.exec(first.marker);
    if (!num) return first.marker;
    const top = listItems.filter((i) => i.indent === first.indent && /^\d/.test(i.marker));
    const last = parseInt(top[top.length - 1].marker, 10);
    return `${last + 1}${num[2]}`;
  }

  startAdd(addEl) {
    const list = addEl.previousElementSibling;
    const sec = this.sectionOf(addEl);
    if (!sec || !list || !/^(UL|OL)$/.test(list.tagName)) return;
    const found = this.linesOf(sec);
    if (!found) return;
    const mine = [...list.querySelectorAll("li")].filter((li) => !li.closest(EMBEDS));
    const start = found.lis.indexOf(mine[0]);
    if (!mine.length || start < 0) return;
    const first = found.items[start];
    const anchor = found.items[start + mine.length - 1];
    const marker = this.nextMarker(first, found.items.slice(start, start + mine.length));
    const li = list.createEl("li", { cls: "task-list-item ie-new" });
    if (first.hasBox) li.createEl("input", { cls: "task-list-item-checkbox", type: "checkbox", attr: { disabled: "" } });
    const cleanup = () => li.remove();
    const ed = this.makeEditor(
      "",
      async (raw) => {
        const value = squash(raw);
        if (!value) return cleanup();
        const ok = await this.patchFile(sec.ctx.sourcePath, (lines) => {
          if (lines[anchor.abs] !== anchor.line) return false;
          lines.splice(anchor.abs + 1, 0, first.indent + marker + first.gap + (first.hasBox ? "[ ] " : "") + value);
          return true;
        });
        if (!ok) cleanup();
      },
      cleanup
    );
    li.appendChild(ed);
    this.focusEnd(ed);
  }
};
