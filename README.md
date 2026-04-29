# ORZ Slides

ORZ Slides is a VS Code custom editor for `*.slides.html` presentations.
It combines a raw slide-source editor, a live Reveal.js preview, and the
`orz-markdown` rendering pipeline provided by the required dependency
extension `yuwang26.orz-md-preview`.

The extension is designed for authoring browser-openable presentation files
that keep both the editable slide source and the rendered Reveal output in the
same document.

## Current Status

- Installable package available: `orz-slides-1.0.0.vsix`
- GitHub repository: <https://github.com/wangyu16/orz-slides-html-vscode>
- License: MIT
- Marketplace publishing is not part of the current workflow

## What It Does

- Registers a custom editor for `*.slides.html`
- Shows slide thumbnails, raw slide source, and a live Reveal.js preview
- Supports add/delete slide, theme switch, aspect ratio switch, and preview frame toggle
- Renders title slides, section slides, and normal content slides
- Parses `[[...]]` layout containers before markdown rendering
- Uses `yuwang26.orz-md-preview` for markdown, containers, plugins, KaTeX, Mermaid, QR, and SMILES
- Saves fully rendered output back into the same `.slides.html` file
- Inlines the selected presentation theme CSS into saved output files
- Provides the command `ORZ Slides: Open in Browser`

## Installation

This project is meant to be installed locally from the packaged VSIX.

1. Install the dependency extension `yuwang26.orz-md-preview` in VS Code.
2. In VS Code, run `Extensions: Install from VSIX...`.
3. Select `orz-slides-1.0.0.vsix` from the project root.
4. Open a `*.slides.html` file.

If you want a starting point, copy `template.slides.html` and edit the
`text/orz-slide` blocks through the custom editor.

## File Model

Each `*.slides.html` document stores both editable source and rendered output.

- `text/orz-settings`: presentation settings JSON
- `text/orz-meta`: deck metadata JSON
- `text/orz-slide`: raw source for each slide
- Reveal `<section>` blocks: rendered HTML for each slide

Important ownership boundary:

- The template and serializer own the outer Reveal `<section>` wrapper.
- The extension renderers own only the inner HTML inserted into each section.

## Authoring Model

### Slide types

- First `# Heading` slide becomes a title slide
- Later `# Heading` slides become section slides unless NYML routes them to a title template
- Other slides are normal content slides

### Layout syntax

The extension layout parser supports these containers:

- `col[ratio]`
- `row[ratio]`
- `center[width]`
- `float[x,y,w]`
- `footer`
- `note`

Critical rule:

- Do not mix raw markdown siblings with `col` or `row` containers inside the same parent

### NYML metadata

Use a `{{nyml ...}}` block to define slide-local metadata such as:

- `template`
- `author`
- `affiliation`
- `date`
- `class` or `slideClass`
- `css`

Arbitrary NYML fields are exposed on the slide root as `data-orz-*` attributes
and `--orz-nyml-*` CSS variables.

### Slide-local CSS

Slide-local CSS is supported on every slide type through NYML `css: |` blocks.
Use `:slide` to scope rules to the current slide.

Example:

```markdown
{{nyml
class: demo-card
accent: #b33a3a
css: |
  :slide {
    background: linear-gradient(160deg, #fff7f0, #ffe2d2);
  }

  :slide .demo-card {
    border-left: 8px solid var(--orz-nyml-accent);
    padding-left: 1rem;
  }
}}

## Demo

- {.fragment} First point
- {.fragment} Second point

[[row[0.8]
[[col[0.5]
Left column
]]
[[col[0.5]
Right column
]]
]]

[[footer
Source: ORZ Slides README example
]]
```

## orz-markdown Features Available in Slides

Because markdown rendering is delegated to `yuwang26.orz-md-preview`, slide
content can use the orz-markdown feature set, including:

- fenced code blocks with highlight.js
- KaTeX math
- Mermaid diagrams
- QR code and YouTube plugins
- SMILES rendering
- container syntax such as `::: info`, `::: warning`, `::: success`, `::: danger`, `:::: tabs`, and `:::: cols`
- legacy leading class markers such as `{.fragment}`

## Bundled Themes

The repository currently includes these themes:

- `paper`
- `architect`
- `executive`
- `sage`
- `poppy`
- `neon`
- `chalk`

The selected theme is applied in preview and inlined into the saved output.

## Development

### Build

```bash
node esbuild.mjs
```

### Watch

```bash
node esbuild.mjs --watch
```

### Package

```bash
npx @vscode/vsce package
```

### Debug in VS Code

- Press `F5` to launch an Extension Development Host
- Open `template.slides.html` or another `*.slides.html` file in that host

## Repository Notes

- The extension depends on `yuwang26.orz-md-preview`
- The canonical example deck is `template.slides.html`
- The project skill documentation for future agents is in `skill/SKILL.md`
- The current packaged artifact is `orz-slides-1.0.0.vsix`
