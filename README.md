# Inline Edit

Edit list items and tasks right in Obsidian's reading view. Your styled pages stay styled: coloured callout cards, custom fonts and layouts remain exactly as they look, and only the line you click turns into an editable field.

Without this plugin, clicking into a styled callout in Live Preview drops that block back to raw Markdown. Inline Edit keeps the rendered view and edits the note's text behind it.

## Turn it on for a page

A page uses inline editing when its properties contain:

```yaml
---
inline-edit: true
---
```

Three ways to add or remove a page without typing that yourself:

- **Settings > Inline Edit > Add page...** opens a search box for any note. The same screen lists the current pages, each with a **Remove** button.
- **Command palette:** *Inline Edit: Toggle for this page*.
- **File explorer:** right-click a note > *Turn on inline editing* (or *Turn off*).

Turning a page on or off rewrites that note's properties block, so its YAML formatting may change.

## Use it

- Click the text of a bullet, numbered item or task: it becomes an editable field in the same font and colour. **Enter** or clicking away saves, **Esc** cancels.
- Checkboxes, links and fold arrows still work as before.
- A faint **+ add item** row under each list adds an item at the end. Tasks get `[ ]`, numbered lists get the next number.
- Saving an empty item deletes it (refused if it has sub-items).
- While you edit, the line shows its raw Markdown, for example `[[note|label]]`; it renders as a link again after saving. A trailing `^block-id` is kept.

Works on bullets, numbered lists and task lists, including inside callouts. Not covered: paragraphs, headings, tables, embedded notes, and Live Preview (which has its own editing).

## How it works

1. A Markdown post-processor runs for every rendered section of an enabled page and remembers that section's render context.
2. On a click, the plugin finds the section around the clicked list item and asks Obsidian for the section's line range in the file (`getSectionInfo`).
3. It lists the list lines in that range (skipping code fences) and pairs the nth rendered item with the nth list line. It edits only if the counts are equal and the item's text matches the file line; otherwise it refuses and shows a notice.
4. The clicked item's content is swapped for a `contenteditable` field showing the line's raw text.
5. On save, `Vault.process` rewrites just that one line in a single atomic step. If the file line no longer equals what was drawn (for example another device synced a change), nothing is written.
6. The reading view is redrawn so the new text shows.

Nothing is stored outside your notes, apart from one setting (show or hide the add rows).

## Install

Not in the community directory yet. To install by hand, download `main.js`, `manifest.json` and `styles.css` from the latest release into `<vault>/.obsidian/plugins/inline-edit/`, then enable **Inline Edit** under Settings > Community plugins. With [BRAT](https://github.com/TfTHacker/obsidian42-brat) you can add this repository directly.

## Development

No build step: the plugin is plain JavaScript (`main.js`, `styles.css`). Copy the folder into a test vault's `.obsidian/plugins/inline-edit/` and reload the plugin.

A release needs a tag equal to the `version` in `manifest.json` (for example `0.1.0`, no `v`); the workflow in `.github/workflows/release.yml` attaches the three files.

## Known limits

- Reading view only. Live Preview, Source mode and mobile editing gestures are not handled specially.
- Uses two undocumented Obsidian methods (`rebuildView`, `previewMode.rerender`) to redraw after a change; both are called defensively, so if a future Obsidian removes one, the page simply updates the next time you reopen it.
- Only the clicked line is touched, but the page's properties block is rewritten when you add or remove a page.

## License

MIT. See [LICENSE](LICENSE).
