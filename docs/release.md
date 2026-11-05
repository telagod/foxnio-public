# Release Checklist

Each release publishes two artifacts:

- GitHub Packages npm package: `@telagod/foxnio`
- GitHub Release: [telagod/foxnio-public](https://github.com/telagod/foxnio-public)

The package is published to `https://npm.pkg.github.com` with the repository's
`GITHUB_TOKEN`. It is not published to the public npm registry. New packages are
private by default; change the package visibility to **Public** in GitHub if
anonymous installs are desired.

## Configure package access

For a private package, authenticate with a GitHub username and a classic
personal access token that has `read:packages`:

```bash
npm login --scope=@telagod --auth-type=legacy --registry=https://npm.pkg.github.com
```

For a public package, no token is needed, but consumers must map the package
scope in their user-level npm config:

```bash
npm config set @telagod:registry https://npm.pkg.github.com
```

Both commands configure the scope used by global installs and the in-app
self-updater. The updater intentionally does not override the default registry,
so unscoped dependencies continue to resolve from npmjs.

The publish workflow uses the repository's `GITHUB_TOKEN`; confirm Actions are
enabled and `.github/workflows/publish.yml` retains `packages: write`. If a
package was created under another owner or repository, grant this repository
access in the package's GitHub settings.

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

The package workflow verifies the tag against `package.json`, installs from the
lockfile, runs tests and the production build, creates a draft GitHub Release,
and publishes to GitHub Packages. It makes the release public only after the
package publish succeeds. The desktop workflow builds and uploads the Windows,
macOS, and Linux installers. Once the package appears in GitHub, set its
visibility to **Public** if unauthenticated installs are intended; otherwise,
keep it private and grant access to consumers.

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

After authenticating to GitHub Packages when the package is private, verify the
published version and metadata with:

```bash
gh run list --repo telagod/foxnio-public --workflow publish.yml --limit 1
npm view @telagod/foxnio@<version> version --registry https://npm.pkg.github.com
npm view @telagod/foxnio@<version> --json --registry https://npm.pkg.github.com
```

Confirm the workflow succeeded, the exact package version resolves from GitHub
Packages, and the GitHub Release contains the expected notes and desktop assets.
