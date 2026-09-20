# Privacy and data handling

Folio uses the Codex CLI installed on your computer. It does not provide a hosted model gateway, ask for an API key, or copy Codex credentials into plugin settings. Authentication and model routing follow your local Codex configuration and environment.

## What is sent when you submit a comment

- **Markdown:** your question or instruction, the selected text, and context from the current note. Short notes can be included in full; long notes provide nearby context (approximately 24 KB). Linked notes are not automatically included.
- **Review:** after showing a send-scope preview, the current Markdown note in full (up to 60 KB) and your review instruction. No linked notes or web search are included.
- **Follow-up threads:** up to eight recent turns from that thread, bounded to approximately 16 KB. If you explicitly select an AI answer excerpt, that excerpt (up to 2,000 characters) and its round number are also sent as reference, including when the selected round is older than the recent history budget. The excerpt is not treated as note text or an edit target. Starting a new note selection does not include other discussions.
- **HTML:** your instruction, the selected element's HTML, and relevant rendered context/styles. Requests can therefore include text, links and image references present in that content.
- These requests go through Codex to **your configured model provider**. The provider's privacy, retention and billing policies apply. This is not an offline AI feature.

Opening the panel, selecting a paragraph or displaying saved answers does not itself submit a model request. Do not submit notes containing credentials or information you are not allowed to send to your provider.

## Local storage

The plugin stores comments, answers, captures, thread history, review suggestions, batch recovery records and drafts in `state.json` and its previous-state recovery copy under your vault's `.obsidian/plugins/folio-codex/` directory. These can contain note excerpts and context. Saved Markdown discussion records and turns are no longer automatically discarded by count; display paging and the model context budget are separate. Card expansion preferences, reply mode, number-preservation preference and selected AI answer excerpts are also stored locally. Records already discarded by older versions are not automatically recovered. Settings contain only the Codex executable/configuration-directory options. Before changing a document, the plugin keeps local backups in `history/` or `note-history/`.

Exporting a discussion first shows a destination dialog, defaulting to the source note’s folder. You can change the vault folder and filename; only confirmation creates a separate Markdown note, containing that discussion’s saved turns, source excerpts and a link to the source. It does not submit a model request. Excerpts and responses are stored in literal text blocks so opening the export does not execute their code blocks or load embedded images. Exported notes may be included in your normal vault sync or backups.

Imported HTML and its supported images are copied into the vault's `Folio/` directory. Your vault backup or synchronization software may copy these files and plugin state to other devices or services. Removing a visible comment or uninstalling a plugin is not a guarantee that backups have been erased.

## Network and execution

Folio has no developer-operated telemetry or analytics endpoint. Codex may make requests according to its own configuration. Importing HTML that references HTTP(S) images downloads those images from their original hosts; this is separate from AI requests. Folio does not attach Codex credentials to image downloads.

Generated Markdown answers are rendered as content: HTML is escaped, embedded images are not automatically loaded, and Obsidian executable code-block processors are not run for answers. The plugin constrains Codex requests to return suggested edits or answers; modifications require user adoption before saving.

## Sharing diagnostics

Do not post `auth.json`, `config.toml`, `.env`, plugin state files, private notes, full CLI output or unreviewed screenshots in public issues. Share the plugin version, operating system, Codex CLI version and a synthetic reproduction. Report suspected credential exposure privately as described in [SECURITY.md](SECURITY.md).
