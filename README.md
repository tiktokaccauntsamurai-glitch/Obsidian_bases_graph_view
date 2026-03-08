# Obsidian_bases_graph_view
An Obsidian plugin that adds virtual links to the graph between notes and the files displayed inside Bases. It solves the problem of missing graph connections for embedded bases.
The Problem

Obsidian includes a core plugin called Bases (since v1.9) that lets you create dynamic tables and cards from notes matching certain filters. For example, you can create a .base file with YAML filters that shows all notes from a specific folder. Then you embed that base in a main note using ![[file.base]].

However, Obsidian’s graph does not show connections between the main note and the notes inside the base – this is an architectural limitation, and the Obsidian developers have stated it won’t change. As a result, the graph appears incomplete.
The Solution

The plugin intercepts the link data in Obsidian’s memory and injects virtual links from the parent notes (those that reference a .base file) to every note that matches that base’s filters.

    Files on disk are never modified.

    When you close the graph or disable the plugin, everything returns to normal.

    Works on all platforms: Windows, macOS, Linux, Android, iOS.

Features

    ✅ Support for all filter types from .base files (and/or, file.inFolder, file.ext, file.name contains)

    ✅ Filename flags for fine‑tuning (e.g., f~projects.base, h~todo.base)

    ✅ Global settings to enable/disable functionality

    ✅ Safe – never touches your files

    ✅ Compatible with any sync method (Remotely Save, iCloud, Obsidian Sync, etc.)

Installation
Via BRAT (recommended for iOS)

    Install the BRAT community plugin from Obsidian.

    Open BRAT settings, add the repository: https://github.com/your-username/bases-graph-links

    Enable the plugin in the list of installed plugins.

Manual installation

    Download the latest release from Releases.

    Extract the archive into your vault’s .obsidian/plugins/bases-graph-links/ folder.

    In Obsidian, go to Settings → Community plugins, and enable the plugin.

Usage

After installation and enabling the plugin, it works automatically. For every base that is referenced by a note, the graph will show links to the files that match the base’s filter.
Example

Main.md:
markdown

# My tasks
![[tasks.base]]

tasks.base:
yaml

filters:
  and:
    - file.inFolder("Tasks")
    - file.ext == "md"

All notes inside the Tasks/ folder will now be connected to Main.md in the graph.
Filename flags

You can change the behavior of a specific base by adding Latin letters and a tilde (~) to the beginning of its name.
Format: [letters]~name.base, e.g., f~projects.base, fh~todo.base, h~archive.base.
Flag f – disable indexing

    Virtual links are not created for this base.

    The .base file itself is hidden from the graph (does not appear and is not part of any links).

    Useful for very large bases or utility files.

Flag h – hide the embed UI

    When a base is embedded, Obsidian shows a control bar (Sort, Filter, Properties…). Flag h hides that bar, leaving only the content.

    Works only if the corresponding plugin setting is enabled.

    Note: Flags are processed only if they are allowed in the plugin settings (both are enabled by default).

Settings

The plugin’s settings page offers three toggles:

    Enable virtual links (graphLinksEnabled) – global switch. When off, the plugin adds no links.

    Enable flag f (flagFEnabled) – if off, files with flag f are treated normally (indexed and not hidden).

    Enable flag h (flagHEnabled) – if off, the control bar is not hidden even if flag h is present.

Settings are saved in the plugin’s data.json file.
How it works (briefly)

The plugin intercepts the resolvedLinks property in Obsidian’s metadataCache and merges additional links computed from .base files. It does this by:

    Scanning all .base files in the vault.

    Parsing their YAML filters to determine matching notes.

    Finding parent notes that reference that .base (via ![[...]]).

    Building a “delta” object in memory containing only the added links.

    When the graph is open, merging the delta with the original links via a Proxy, without copying the whole object.

When any file changes, the delta is rebuilt with a 500 ms debounce to avoid unnecessary operations.

To hide the UI for flag h, a MutationObserver and a CSS rule are used. The CSS rule automatically hides the control bar inside any embedded base that has the appropriate data attribute.
Known limitations

    The file.inFolder("path") filter works non‑recursively (only files directly in the folder) – this matches the behavior of Obsidian Bases itself.

    When you rename a base to add flag f (e.g., tasks.base → f~tasks.base), you must manually update any embed links in notes – Obsidian does not automatically change them.

    Flag h depends on Obsidian’s CSS classes (.internal-embed, .bases-embed, .bases-header). If future versions of Obsidian change these classes, the plugin will need an update.

For developers and technically inclined users

Full documentation about the architecture, implementation details, and future plans is available in DOCUMENTATION.md (in English and Russian). It also describes how to build from source.
Acknowledgements

    Thanks to the Obsidian developers for an excellent platform.

    Thanks to the Obsidian community for ideas, testing, and feedback.
