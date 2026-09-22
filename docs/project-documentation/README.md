# SolarFlow PM — project documentation

`SolarFlow-PM-Project-Documentation.pdf` is the complete write-up of the platform:
every module, the automations running today, the AI foundation, the work done,
the open items, the roadmap to zero-touch automation and AI, best practice for
solar operations, CRM and security, and KPIs.

## Rebuilding

The PDF is generated from `src/` and the repository itself — the migration,
screen and API appendices are read from `db/migrations` and `src/app` at build
time, so they cannot drift from the code.

```sh
PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core node docs/project-documentation/build.mjs
```

Needs Chromium (`CHROME=` to override the path) and Python 3 with `pypdf`. The
build renders twice so the table of contents carries real page numbers.

To update the content, edit the numbered chapter files in `src/`; chapters are
`<section class="chapter" data-no=… data-title=…>` and modules are
`<div class="module">` strips, both picked up by the contents automatically.

## Fonts

`fonts/` holds Inter and JetBrains Mono, both under the SIL Open Font License 1.1
(<https://openfontlicense.org>), redistributed unmodified.
