# SolarFlow PM — project documentation

Two PDFs, built from this folder:

- `SolarFlow-PM-Project-Documentation.pdf`: the complete write-up of the
  platform. It covers every module, the automations running today, the AI
  features, the work done, the open items, the roadmap, best practice for solar
  operations, CRM and security, and KPIs. Sources are in `src/`.
- `SolarFlow-AI-Automation-Blueprint.pdf`: the new features (stage attachments,
  PandaDoc e-signature and change orders, Ask SolarFlow) and how to switch them
  on, then 48 prioritised AI and automation recommendations, the journey touch by
  touch, the roadmap, cost, risk and your checklist. Sources are in `blueprint/`.

## Rebuilding

The PDF is generated from `src/` and the repository itself — the migration,
screen and API appendices are read from `db/migrations` and `src/app` at build
time, so they cannot drift from the code.

```sh
PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core node docs/project-documentation/build.mjs
DOC=blueprint PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core node docs/project-documentation/build.mjs
```

Needs Chromium (`CHROME=` to override the path) and Python 3 with `pypdf`. The
build renders twice so the table of contents carries real page numbers.

To update the content, edit the numbered chapter files in `src/`; chapters are
`<section class="chapter" data-no=… data-title=…>` and modules are
`<div class="module">` strips, both picked up by the contents automatically.

## Fonts

`fonts/` holds Inter and JetBrains Mono, both under the SIL Open Font License 1.1
(<https://openfontlicense.org>), redistributed unmodified.
