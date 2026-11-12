# Release Checklist

Each release publishes three kinds of artifacts:

- GitHub Packages npm package: `@telagod/foxnio`
- GitHub Release: [telagod/foxnio-public](https://github.com/telagod/foxnio-public)
- Desktop installers (Windows, macOS, Linux), attached to that GitHub Release

**Status:** `v0.6.2` is the first published release. `v0.6.1` was prepared but never published.

The package is published to `https://npm.pkg.github.com` with the repository's
`GITHUB_TOKEN`. It is not published to the public npm registry.

## Configure package access

GitHub Packages requires an access token for every install, whatever the
package visibility. GitHub's documentation states: "You need an access token to
publish, install, and delete private, internal, and public packages." Making the
package **Public** does not remove that requirement.

Every consumer therefore needs a classic personal access token with
`read:packages` and a mapping for the `@telagod` scope in the user-level npm
config:

```bash
npm login --scope=@telagod --auth-type=legacy --registry=https://npm.pkg.github.com
```

`npm login` asks for the GitHub username and takes the token as the password.
It writes both the `@telagod:registry` mapping and the token to `~/.npmrc`.
Writing the two lines by hand is equivalent:

```ini
@telagod:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=<token>
```

With Bun, map the scope and token in `bunfig.toml` (`[install.scopes]`).

The in-app updater needs exactly this configuration. It learns about new
versions from GitHub Releases (`releases/latest`, which works without a token)
but installs from GitHub Packages. Before it stops the server, the update
worker runs `npm view @telagod/foxnio@<version> version` (`bun info` for Bun
installs) with the same configuration. When that fails, the attempt ends with a
message that points at the scope mapping and token, and the running server is
left alone. The updater intentionally does not override the default registry,
so unscoped dependencies continue to resolve from npmjs.

The publish workflow uses the repository's `GITHUB_TOKEN`; confirm Actions are
enabled and `.github/workflows/publish.yml` retains `packages: write`. If a
package was created under another owner or repository, grant this repository
access in the package's GitHub settings.

## Before each release

Never run `npm ci`, `npm run build`, `npm run release:check` or `npm pack`
in a checkout used by a running foxnio instance. These commands replace
dependencies or `.next`, leaving the live process with stale manifests and
missing chunks. Prepare the release in a separate checkout/worktree with its
own dependencies and build output; keep the serving checkout untouched.

- `bin/omp-web-tray.exe` is a committed build of `native/tray`; the workflows
  do not build it. After changing `native/tray`, rebuild it with the .NET 8 SDK
  and commit the result. The project sets `EnableWindowsTargeting`, so a Linux
  host works too:

  ```bash
  docker run --rm -v "$PWD/native/tray:/src" -w /src mcr.microsoft.com/dotnet/sdk:8.0 \
    sh -c "dotnet publish -c Release -r win-x64 -o bin/publish; chown -R $(id -u):$(id -g) bin obj"
  cp native/tray/bin/publish/omp-web-tray.exe bin/omp-web-tray.exe
  ```

- `nix/package.nix` has a pinned `npmDepsHash`. The hash covers
  `package-lock.json` itself, including its `version` field, so it is stale
  after every dependency change and every version bump. Recompute it against
  the nixpkgs that `flake.lock` pins: set it to `lib.fakeHash`, build once, and
  copy the value after `got:` from the `hash mismatch` error. With Nix,
  `nix build .#default`; without it, in a container:

  ```bash
  docker run --rm -v "$PWD:/src:ro" nixos/nix nix --extra-experimental-features 'nix-command flakes' \
    build --impure --no-link -L --expr 'let rev = (builtins.fromJSON (builtins.readFile /src/flake.lock)).nodes.nixpkgs.locked.rev; pkgs = (builtins.getFlake "github:NixOS/nixpkgs/${rev}").legacyPackages.x86_64-linux; in pkgs.callPackage /src/nix/package.nix {}'
  ```

  The source set must list only files git tracks (a checkout has nothing
  else), and `localFontsPatch` rewrites the top of `app/layout.tsx`, so update
  the patch whenever those imports change.
- Desktop installers are unsigned. Say so in the release notes: Windows
  SmartScreen shows a warning, and macOS needs right-click **Open** or
  `xattr -dr com.apple.quarantine /Applications/foxnio.app`.
- Users of the former ompweb/omp-web must remove the old services, units and
  scheduled tasks by hand; the README section "Moving from ompweb / omp-web"
  lists the names.

## Publish the first release

The first published release is `@telagod/foxnio@0.6.2`, continuing the upstream
`0.6.0` version line (`0.6.1` was prepared but never published). From a clean
checkout of the `foxnio` branch, ensure the changelog and version are ready,
then run:

```bash
npm ci
npm run release:check
```

The tag triggers the package and desktop workflows. Push the branch and the tag
by name (see "Release later versions" for why not `--follow-tags`):

```bash
git tag -a v0.6.2 -m v0.6.2
git push foxnio foxnio
git push foxnio v0.6.2
```

Both workflows check that the tag equals `v<package.json version>` and fail
otherwise.

The package workflow (`publish.yml`) installs from the lockfile, runs tests and
the production build, creates a draft GitHub Release if none exists, publishes
to GitHub Packages, and then makes the release public.

The desktop workflow (`desktop.yml`) builds on one runner per platform with a
read-only token and uploads only installers, blockmaps and update metadata as
workflow artifacts (7 days retention). A separate `release` job, the only one
with `contents: write`, runs after all platform builds succeed, creates the
draft release if it does not exist yet, and uploads the files with
`gh release upload --clobber`. Because the release job needs every platform, one
failed build uploads nothing; re-run the failed job and the release job follows.
Branch pushes and manual runs build and keep artifacts but never touch a release.

Windows produces two executables, `foxnio-Setup-<version>-win-x64.exe` and
`foxnio-<version>-win-x64-portable.exe`. macOS publishes DMG and ZIP per
architecture without `latest-mac.yml`, because the arm64 and x64 builds write
the same file name.

### Race between the two workflows

The workflows run independently. Each one creates the draft release when it is
missing (`gh release create`, with a fallback to `gh release view` when the
other won), so the release exists exactly once. Two consequences remain:

- `publish.yml` publishes the release as soon as the package is published. The
  desktop builds usually finish later, so the release can be public for a while
  without installers. They appear when the `release` job finishes.
- If the package publish fails, the release stays a draft that may already hold
  desktop installers. Re-run `publish.yml`; it skips an already-published
  version and publishes the release.

Check the release page after both workflows are green before announcing it.

## Release later versions

Run these from a clean `foxnio` checkout after the release changes are merged
and `CHANGELOG.md` contains an entry for the new version:

```bash
npm ci
npm run release:check
npm version patch --no-git-tag-version
```

The bump changes `package-lock.json`, so update `npmDepsHash` now (see "Before
each release"), then commit, tag and push:

```bash
VERSION="$(node -p 'require("./package.json").version')"
git commit -am "chore(release): $VERSION"
git tag -a "v$VERSION" -m "v$VERSION"
git push foxnio foxnio
git push foxnio "v$VERSION"
```

Push the tag by name, never with `--follow-tags`: this history carries the
upstream ompweb tags (`v0.2.1` to `v0.5.2`), which `--follow-tags` would push
too, and GitHub starts no workflows for a push that creates more than three
tags.

Use `minor` or `major` instead of `patch` when appropriate. With
`--no-git-tag-version`, `npm version` only updates `package.json` and
`package-lock.json`. Review the commit before pushing the tag.

Pushing the tag starts both release workflows. The package workflow skips an
already-published version, so a rerun can safely finish publishing the GitHub
Release after a successful package publish. Discord release notifications are
optional; set `DISCORD_RELEASES_WEBHOOK` only if they are wanted.

## Verify

Authenticate to GitHub Packages (see above), then verify the published version
and metadata with:

```bash
gh run list --repo telagod/foxnio-public --workflow publish.yml --limit 1
gh run list --repo telagod/foxnio-public --workflow desktop.yml --limit 1
npm view @telagod/foxnio@<version> version --registry https://npm.pkg.github.com
npm view @telagod/foxnio@<version> --json --registry https://npm.pkg.github.com
```

Confirm both workflows succeeded, the exact package version resolves from
GitHub Packages, and the GitHub Release contains the expected notes and desktop
assets: the two Windows executables, a DMG and a ZIP for each macOS
architecture, the AppImage and the `.deb`.
