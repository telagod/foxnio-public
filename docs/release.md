# Release Checklist

Each release publishes three kinds of artifacts:

- GitHub Packages npm package: `@telagod/foxnio`
- GitHub Release: [telagod/foxnio-public](https://github.com/telagod/foxnio-public)
- Desktop installers (Windows, macOS, Linux), attached to that GitHub Release

**Status:** neither the package nor a GitHub Release exists yet. Everything below that mentions installing or updating applies once the first release is out.

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

## Before the first release

- `bin/omp-web-tray.exe` is a hand-built binary. Its embedded strings (for
  example `omp-web-tray.lnk`) predate the rename to foxnio. Rebuild it on
  Windows from `native/tray` (`dotnet publish`) and commit the result before the
  next release. The workflows do not build it.
- `nix/package.nix` has a pinned `npmDepsHash`. It is stale after any
  `package-lock.json` change and must be recomputed with Nix (set it to
  `lib.fakeHash`, build once, and copy the hash from the error).
- Desktop installers are unsigned. Say so in the release notes: Windows
  SmartScreen shows a warning, and macOS needs right-click **Open** or
  `xattr -dr com.apple.quarantine /Applications/foxnio.app`.
- Users of the former ompweb/omp-web must remove the old services, units and
  scheduled tasks by hand; the README section "Moving from ompweb / omp-web"
  lists the names.

## Publish the first release

The first release candidate is `@telagod/foxnio@0.6.1`, continuing the upstream
`0.6.0` version line. From a clean checkout of the `foxnio` branch, ensure the
changelog and version are ready, then run:

```bash
npm ci
npm run release:check
```

The tag triggers the package and desktop workflows:

```bash
git tag v0.6.1
git push foxnio v0.6.1
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
npm version patch
git push foxnio foxnio --follow-tags
```

Use `npm version minor` or `npm version major` when appropriate. `npm version`
updates `package.json` and `package-lock.json`, creates a commit, and creates a
`v<version>` tag. Review the generated commit before pushing.

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
