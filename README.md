# @atlaxt/favicon

Convert any PNG to a multi-size `favicon.ico` with a single command — no config, no fuss.

## Usage

```bash
npx @atlaxt/favicon <path-to-png>
```

### Example

```bash
# Inside your project's public/ folder
cd public
npx @atlaxt/favicon logo.png
```

Output:

```bash
  Reading  →  logo.png
  Output   →  /your/project/public/favicon.ico

  ✔  favicon.ico ready!
```

`favicon.ico` is saved to **wherever you run the command** (current working directory).

## What it generates

The `.ico` file embeds three sizes that cover all major browsers and devices:

| Size  | Used by |
|-------|---------|
| 16×16 | Browser tab, bookmarks bar  |
| 32×32 | Taskbar shortcut, tab title |
| 48×48 | Windows site icons          |

## Requirements

- Node.js 14+
- Input must be a `.png` file

## License

MIT
