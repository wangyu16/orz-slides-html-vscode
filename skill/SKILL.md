---
name: skill
description: >
  Guide for creating, editing, repairing, and reasoning about `*.slides.html`
  presentations used by the ORZ Slides VS Code extension. Use this skill whenever
  a user mentions ORZ Slides, `.slides.html`, slide layouts, title or
  acknowledgement slides, NYML slide metadata, per-slide CSS, themes, preview
  behavior, or the interaction between the extension layout parser,
  orz-markdown, and Reveal.js. Also use this skill when modifying the template
  or generated slide markup so you preserve the current ownership boundaries.
compatibility:
  runtime: "VS Code custom editor for `*.slides.html`"
  dependency: "Requires extension `yuwang26.orz-md-preview`"
---

# ORZ Slides

Use this skill for the ORZ Slides extension in this repository. The goal is to
author or modify `.slides.html` files in a way that matches the extension's real
render pipeline instead of hand-authoring HTML that only looks correct by accident.

## What the extension actually does

- Registers a VS Code custom editor for `*.slides.html`.
- Depends on `yuwang26.orz-md-preview` for markdown rendering.
- Shows a split UI with:
	- slide thumbnails
	- a plain text editor for the raw slide source
	- a live Reveal.js preview iframe
- Provides toolbar controls for:
	- previous / next slide
	- add / delete slide
	- theme selection
	- aspect ratio selection
	- preview frame toggle for layout debugging
- Supports the command `ORZ Slides: Open in Browser` via `orz-slides.openInBrowser`.
- Saves fully rendered output back into the `.slides.html` file and inlines the
	selected theme CSS into the saved document.

## File model

Treat a `.slides.html` document as four layers of data:

1. `text/orz-settings` JSON block
2. `text/orz-meta` JSON block
3. repeated `text/orz-slide` source blocks
4. repeated Reveal `<section>` elements containing rendered slide HTML

Critical ownership rule:

- The template / file serializer owns the outer Reveal `<section>`.
- The extension renderers own only the inner HTML inserted into that section.

Practical consequence:

- When authoring slides, edit the `text/orz-slide` source blocks.
- Do not manually maintain rendered `<section>` inner HTML unless you are updating
	the canonical template examples.
- Do not rely on outer `<section class="orz-*">` wrappers for title or section
	slides; the renderer now places `.orz-title-slide` / `.orz-section-slide`
	inside the outer Reveal section.

## Slide kinds

The renderer currently supports three slide categories.

### 1. Title-like slides

Triggered when:

- slide index is `0` and the stripped source contains a `# ` heading, or
- a later `# ` slide explicitly sets `template: centered`, `split`, or `minimal`

Built-in NYML fields used by the title renderer:

- `template`: `centered`, `split`, `minimal`
- `author`
- `affiliation`
- `date`
- `class` / `slideClass`
- `css`

Title data source:

- first `# Heading` -> title text
- next `## Subtitle` -> subtitle
- `author`, `affiliation`, `date` -> combined meta line

Current built-in arrangements:

- `centered`: centered title block
- `split`: left content panel plus right decorative aside panel
- `minimal`: centered title on accent background

Important limit:

- There is no dedicated built-in NYML field today that replaces the split-aside
	inner HTML directly.
- To customize that panel, use `class` / `slideClass`, arbitrary NYML fields,
	and slide-local CSS.

### 2. Section title slides

Triggered when a later slide contains `# ` but is not routed through a title template.

Built-in NYML fields used by the section renderer:

- `template`: `accent-band`, `sidebar`, `minimal`
- `class` / `slideClass`
- `css`

Structure:

- first `# Heading` -> section title
- remaining markdown -> section body

### 3. Content slides

All other slides are content slides.

Behavior:

- leading `## Heading` becomes the slide header (`.orz-header > h2`)
- remaining source is parsed by the layout parser first and then rendered through
	orz-markdown

## Layout syntax actually supported by the extension

The extension layout parser currently supports these `[[...]]` elements:

- `col[ratio]`
- `row[ratio]`
- `center[width]`
- `float[x,y,w]`
- `footer`
- `note`

Parameter forms accepted:

- percentage: `50%`
- fraction: `1/2`
- decimal: `0.5`
- plain number: accepted by the current parser, mainly for wide / loose values

Behavior notes:

- `footer` renders outside `.orz-body`.
- `note` becomes `<aside class="notes">`.
- unknown layout names are ignored silently so in-progress typing does not spam warnings.
- recommended layout depth is `<= 3`.
- sibling `col` or `row` fractions should sum to `<= 1.0`.

Critical layout rule:

- Do not mix raw markdown siblings with `col` or `row` containers in the same parent.
- Once a parent introduces `col` children, every visible sibling at that level
	should be a `col`.
- Once a parent introduces `row` children, every visible sibling at that level
	should be a `row`.

Wrong:

```markdown
Intro text here.

[[col[0.5]
Left
]]
[[col[0.5]
Right
]]
```

Correct:

```markdown
[[row[0.2]
Intro text here.
]]
[[row[0.8]
[[col[0.5]
Left
]]
[[col[0.5]
Right
]]
]]
```

## Markdown layer behavior

After layout parsing, leaf markdown is rendered by `yuwang26.orz-md-preview`.
That means slide content inherits orz-markdown features rather than raw Reveal
Markdown parsing.

Assume these capabilities are available because they are provided by the dependency
and normalized by this extension:

- standard markdown
- raw HTML in markdown
- container syntax like `::: info`, `::: warning`, `::: success`, `::: danger`,
	`::: spoil`, `:::: tabs`, `:::: cols`
- plugins such as `{{mermaid}}`, `{{youtube}}`, `{{qr}}`, `{{smiles}}`,
	`{{span[...]}}`, `{{emoji}}`, `{{toc}}`, `{{attrs[...]}}`, `{{yaml}}`, `{{nyml}}`
- KaTeX math
- highlight.js code blocks

The extension also applies compatibility normalization after markdown render:

- `classname=` / `className=` are rewritten to `class=`
- legacy leading class markers like `{.fragment}` are converted into real classes
	on rendered block elements

Use `.fragment` authoring like this when you want Reveal fragments:

```markdown
- {.fragment} Second point appears later
```

## NYML in ORZ Slides

The extension extracts the slide `{{nyml ...}}` block before handing the rest of
the slide to the markdown renderer. This is necessary because layout routing and
template selection happen before markdown render.

The NYML parser in this extension now mirrors the project expectation for the
orz-markdown NYML plugin closely enough for slide metadata use:

- indentation-sensitive keys
- flat string values
- multiline literal values via `key: |`
- comments beginning with `#`
- quoted keys if needed

Reserved behavior keys:

- `template`
- `author`
- `affiliation`
- `date`
- `css`
- `class`
- `slideClass`

All other NYML keys are exposed on the slide root in two forms:

- `data-orz-your-key="value"`
- `--orz-nyml-your-key: value`

This is the safe way to pass custom slide-local metadata into CSS.

## Slide-local CSS

Slide-local CSS works on any slide type, not only title or acknowledgement slides.

Preferred form:

```markdown
{{nyml
class: spotlight-card
accent_color: #c9a84c
css: |
	:slide {
		border: 1px solid rgba(201, 168, 76, 0.25);
		border-radius: 18px;
	}

	:slide .title-heading {
		color: var(--orz-nyml-accent-color);
	}
}}
```

Compatibility fallback:

```markdown
{{nyml
css: ./slides/thank-you.css
}}
```

Current behavior:

- If `css` is multiline or looks like CSS, the extension treats it as inline slide CSS.
- If `css` is a single-line path, the extension tries to load that file relative
	to the `.slides.html` document.

Required scoping rule:

- Always scope slide-local CSS through `:slide`.
- The extension rewrites `:slide` to a slide-unique selector like
	`[data-orz-slide-scope="slide-27"]`.
- Do not write broad unscoped selectors such as `.reveal h1 { ... }` in slide-local CSS.

Use custom NYML data in slide-local CSS like this:

```markdown
{{nyml
template: split
closing_note: See you next time
hero_image: url("./assets/closing-hero.png")
css: |
	:slide .orz-title-split-aside {
		background-image: var(--orz-nyml-hero-image);
		background-size: cover;
		background-position: center;
	}

	:slide .orz-title-split-aside::after {
		content: attr(data-orz-closing-note);
	}
}}
```

## Preview and output behavior

The editor preview is not a separate authoring model. It is a Reveal iframe built
from the same rendered slide HTML that gets saved.

Important behaviors:

- preview rebuilds when theme or aspect ratio changes
- normal content edits update the current preview slide in place
- preview frame outlines are optional and never persist to saved output
- local assets resolve from the slide document directory in preview and output
- the saved `.slides.html` file gets the active theme CSS inlined

Themes exposed by the editor toolbar:

- `executive`
- `paper`
- `sage`
- `architect`
- `poppy`
- `neon`
- `chalk`

Aspect ratios exposed by the editor toolbar:

- `16:9`
- `4:3`
- `16:10`
- `1:1`

Notes and runtime features:

- `[[note ...]]` becomes Reveal speaker notes
- tabs, QR expansion, mermaid, SMILES, YouTube embeds, and math are supported in
	preview and saved output through the injected runtime

## Safe authoring workflow for agents

When editing a `.slides.html` file for this extension:

1. Edit the raw `text/orz-slide` source blocks, not the rendered slide HTML.
2. Preserve `text/orz-settings` and `text/orz-meta` JSON blocks.
3. Use `#` and `##` headings to trigger title / section / content slide routing.
4. Use `{{nyml ...}}` for template selection, slide-local CSS, extra slide classes,
	 and slide-local metadata.
5. Use `[[...]]` only for the extension's layout layer.
6. Use markdown / orz-markdown features inside layout leaves, not as a replacement
	 for the extension layout syntax.
7. Keep slide-local CSS scoped with `:slide`.
8. Keep container siblings homogeneous at each layout level.

## Things not to assume

Do not assume these features exist unless you implement them first:

- arbitrary Reveal plugins beyond the current runtime bundle
- a dedicated built-in NYML field for replacing split-title aside HTML
- a separate in-editor speaker notes pane
- PDF export workflow
- arbitrary nested NYML data structures beyond what the current parser supports
- extra layout keywords beyond `col`, `row`, `center`, `float`, `footer`, `note`

## Canonical examples

Use `template.slides.html` as the canonical demonstration file.

It currently includes examples for:

- title slides
- section title slides
- content slides
- layout containers
- callout boxes
- tabs and spoilers
- floats and notes
- custom slide classes
- inline `css: |` slide-local CSS
- split acknowledgement slide styling

If you update extension behavior, update the template examples and this skill together.
