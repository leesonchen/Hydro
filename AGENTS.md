# Repository instructions

## Hydro development releases

- Publish Hydro development builds with the repository root script `./build-and-publish-dev.sh --packages <packages>` only. For a UI-only change, use `./build-and-publish-dev.sh --packages ui-default`.
- This script builds the selected packages, assigns the next `-dev.N` version, and publishes to the private `https://npm.leeson.top/` registry with the `dev` dist-tag. Do not publish these builds to public npm, `latest`, or by calling `build/publish.ts`, `yarn npm publish`, or `npm publish` directly.
- For development-only releases, preserve the package's existing `major.minor.patch` base version; do not bump the stable patch version manually. The release script must choose the next `-dev.N` for that base, even if the `dev` dist-tag currently points to a different base version.
- After publishing, upgrade the target Hydro installation with `./packages/hydrooj/bin/install-dev-from-private-npm.sh update --packages <packages>` and verify the active package version and service health.
- For the local Docker installation, identify the intended target container first: environments may use either `hydro` or `hydro2`. Run the update and service checks against that container. After updating, restart Hydro inside the running target container with `pm2 restart hydrooj`; do not restart the Docker container itself.
- If the private registry is unreachable or the script fails, stop and report the blocker. Do not switch registries or manually copy a package into the Hydro container as a fallback.
