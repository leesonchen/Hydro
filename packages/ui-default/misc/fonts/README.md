# XiaoLai SC (optional local font)

Hydro builds are **offline-safe** by default: they never contact GitHub to
fetch the optional XiaoLai SC font. If the verified font file is not available,
the generated stylesheet omits its `@font-face` rule and browsers use the
locally installed XiaoLai font (if any), or their configured fallback fonts.
This does not interfere with the main UI build.

To bundle the XiaoLai font so **browsers never request it from GitHub**:

1. Download and pre-verify the official `Xiaolai-Regular.ttf` release
   v3.126 into `packages/ui-default/misc/fonts/Xiaolai-Regular.ttf`.
   Alternatively, explicitly opt in for **one build** with
   `HYDRO_FETCH_XIAOLAI_FONT=1 yarn build:ui:production:webpack`.
2. The build validates the SHA-256 checksum and exact size of any local or
   downloaded file. On success Webpack packages it as a local static asset.
3. Subsequent builds use the existing verified local file without network.

This binary (~22 MiB) and `misc/xiaolai-font.generated.styl` are intentionally
gitignored. An invalid local binary causes an error rather than being shipped.
The opt-in download can fail if GitHub is unreachable; normal builds do not
attempt it or need it.

Upstream: https://github.com/lxgw/kose-font/releases/tag/v3.126

License: SIL Open Font License 1.1 (`OFL.txt`). It is copied into
the built assets at `misc/fonts/OFL.txt` when publishing the UI.
