# Terminal icon font

`src/client/fonts/SymbolsNerdFontMono-Regular.woff2` is the monospaced symbols-only
font from [Nerd Fonts v3.5.1](https://github.com/ryanoasis/nerd-fonts/releases/tag/v3.5.1),
converted from TTF to WOFF2 without subsetting. It contains 10,624 mapped symbols and is
about 1.2 MB. The original glyphs, font names, and metadata are preserved.

The upstream release's [license](NERD-FONTS-LICENSE.txt) and
[notices and icon credits](NERD-FONTS-NOTICES.txt) are included. These files
ship in the npm package alongside the built font; the font retains its upstream license.

## Loading

The browser loads the font from ghostty-tab itself under the CSS family name
`Ghostty Tab Symbols`. There is no `local()` source or external font service. Vite emits
a content-hashed asset, and the production server serves it as `font/woff2` with immutable
caching. Normal text uses the existing system font stack; this font supplies missing icons.
The symbols font uses full-em advances, so CSS scales it to 60% to fit the text fonts'
monospaced cells without crowding the next character.

Startup loads the font alongside Ghostty's WASM before opening the terminal. This matters
because the canvas renderer does not automatically redraw existing text after a web font
loads. A failed font request logs a warning and still allows the terminal to start.

## Updating

Download the symbols-only archive from a specific Nerd Fonts release. Review and copy its
`LICENSE` and `README.md` to the notice files above, then convert only the Mono font. For
the current version, run from the repository root:

```sh
font_workdir=$(mktemp -d)
curl -fL https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/NerdFontsSymbolsOnly.tar.xz \
  -o "$font_workdir/NerdFontsSymbolsOnly.tar.xz"
tar -xf "$font_workdir/NerdFontsSymbolsOnly.tar.xz" -C "$font_workdir"
cp "$font_workdir/LICENSE" docs/fonts/NERD-FONTS-LICENSE.txt
cp "$font_workdir/README.md" docs/fonts/NERD-FONTS-NOTICES.txt
uv run --with 'fonttools[woff]==4.60.1' python - "$font_workdir" <<'PY'
import sys
from pathlib import Path
from fontTools.ttLib import TTFont

source = Path(sys.argv[1]) / "SymbolsNerdFontMono-Regular.ttf"
font = TTFont(source, recalcTimestamp=False)
font.flavor = "woff2"
font.save("src/client/fonts/SymbolsNerdFontMono-Regular.woff2")
PY
```

SHA-256 checksums for the current assets:

```text
NerdFontsSymbolsOnly.tar.xz
01172f37db8543edb102e5cb5c64101c9f4686630804d49b419aa07b23a69996
SymbolsNerdFontMono-Regular.ttf
fe471e538392f51910faab985fa8e192a39dd3426125edd15b71b3680df0e749
SymbolsNerdFontMono-Regular.woff2
b6ab446d30bad6f78c7f8fb69b9679eef4c516aa2f4cdbf1a8896791cf209f14
```

Run `bun run check` and inspect the packed npm artifact for both the font and notices.
In a browser, verify the font request completes before the terminal opens, and check
folder (`U+E5FF`), file (`U+F15B`), and supplementary-plane icons (`U+F07C6`), including
bold text. Also verify a failed font request still opens a usable terminal.
