# XiaoLai SC font (local UI asset)

The UI's **XiaoLai SC** font is downloaded **at build time** from the upstream
GitHub release v3.126. The build verifies the SHA-256 digest and size before
packaging it into the static webpack assets. Browsers request the resulting
font from the Hydro asset origin and no longer contact GitHub for this font.

The binary font is deliberately not committed to Git; the release is ~22 MiB.
The build host must have access to the pinned GitHub release **once** (or have
an already-verified copy at `packages/ui-default/misc/fonts/Xiaolai-Regular.ttf`).
For truly air-gapped builders, copy the exact pinned file to that path before
building; it is checked against the same checksum.

Source: https://github.com/lxgw/kose-font/releases/tag/v3.126
License: SIL Open Font License 1.1. See `OFL.txt`, redistributed with the
bundled static font at `misc/fonts/OFL.txt`.
