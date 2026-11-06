// Markdown body of the issue the omp tracking workflow opens for a new omp
// release: the compatibility smoke result, then what changed since the omp
// version foxnio is verified against (RPC wire protocol, CLI flags, settings,
// session format, changed files per area, changelog), with every changed item
// foxnio's source mentions marked.
//
// Environment:
//   OMP_SRC       git directory holding the tags v$FROM and v$TO (a shallow blobless fetch is enough)
//   FROM, TO      the verified omp version and the version to report on
//   RELEASE_URL   optional link to the release page
//   SMOKE_STATUS  exit code of the native test run ("" when it did not run)
//   SMOKE_TAP     TAP output of that run
//   FOXNIO_ROOT   foxnio checkout (default: the current directory)
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const { OMP_SRC: ompSrc, FROM: from, TO: to, RELEASE_URL: releaseUrl, SMOKE_STATUS: smokeStatus = "", SMOKE_TAP: smokeTap } = process.env;
const foxnioRoot = process.env.FOXNIO_ROOT || process.cwd();
if (!ompSrc || !from || !to) throw new Error("OMP_SRC, FROM and TO are required");
const fromTag = `v${from}`;
const toTag = `v${to}`;
const OMP_REPO = "https://github.com/can1357/oh-my-pi";
const AGENT = "packages/coding-agent";

const git = (args, stderr = "inherit") => execFileSync("git", ["-C", ompSrc, ...args], {
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
  stdio: ["ignore", "pipe", stderr],
});
/** A file at a tag, or null when the tag does not have it (added or removed in between). */
function show(tag, file) {
  try {
    return git(["show", `${tag}:${file}`], "ignore");
  } catch {
    return null;
  }
}

// ---- where foxnio mentions a name -------------------------------------------

const sources = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "i18n") walk(file);
    } else if (/\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name) && !entry.name.includes(".test.")) {
      sources.push({ file: relative(foxnioRoot, file), text: readFileSync(file, "utf8") });
    }
  }
})(foxnioRoot);
const settingsSource = sources.find((source) => source.file === join("lib", "omp", "settings-config.ts"))?.text ?? "";
const scanned = sources.filter((source) => /^(?:app|bin|components|desktop|hooks|lib)[\\/]/.test(source.file));

// RPC names are sent as `type: "x"` and matched as `case "x"` or `=== "x"`;
// CLI flags and settings keys appear as plain string literals.
function usedBy(name, { setting = false, rpc = false } = {}) {
  const needles = rpc
    ? [`type: "${name}"`, `case "${name}"`, `=== "${name}"`, `!== "${name}"`]
    : [`"${name}"`, `'${name}'`, `\`${name}\``];
  const files = scanned.filter((source) => needles.some((needle) => source.text.includes(needle))).map((source) => source.file);
  // settings-config.ts lists keys per section: `section: ["leaf", ...]`.
  const [section, ...rest] = name.split(".");
  if (setting && rest.length && settingsSource.includes(`${section}:`) && settingsSource.includes(`"${rest.at(-1)}"`)) {
    files.push(join("lib", "omp", "settings-config.ts"));
  }
  return [...new Set(files)];
}
function mark(name, options) {
  const files = usedBy(name, options);
  if (!files.length) return "";
  const shown = files.slice(0, 3).map((file) => `\`${file}\``).join(", ");
  return ` **(used by foxnio: ${shown}${files.length > 3 ? ", …" : ""})**`;
}

// ---- RPC wire protocol ------------------------------------------------------

const WIRE = `${AGENT}/src/modes/rpc/wire/rpc-wire.schema.json`;

function wireModel(tag) {
  const text = show(tag, WIRE);
  if (!text) return null;
  const schema = JSON.parse(text);
  const defs = schema.$defs ?? {};
  const refName = (node) => (node && typeof node.$ref === "string" ? node.$ref.split("/").pop() : null);
  // A definition with its references inlined and its documentation dropped, so
  // only structural changes compare unequal.
  function resolved(node, seen = new Set()) {
    if (Array.isArray(node)) return node.map((item) => resolved(item, seen));
    if (!node || typeof node !== "object") return node;
    const ref = refName(node);
    if (ref) {
      if (seen.has(ref) || !defs[ref]) return { $ref: ref };
      return resolved(defs[ref], new Set([...seen, ref]));
    }
    const out = {};
    for (const key of Object.keys(node).sort()) {
      if (key !== "description") out[key] = resolved(node[key], seen);
    }
    return out;
  }
  const definition = (name) => (typeof name === "string" && defs[name] ? resolved(defs[name], new Set([name])) : null);
  const commands = new Map();
  for (const command of schema["x-rpc"]?.commands ?? []) {
    commands.set(command.name, { params: definition(command.params), result: definition(command.result) });
  }
  function leaves(name, seen = new Set()) {
    if (!name || seen.has(name) || !defs[name]) return [];
    seen.add(name);
    const union = defs[name].anyOf ?? defs[name].oneOf;
    return union ? union.flatMap((member) => leaves(refName(member), seen)) : [name];
  }
  const frames = new Map();
  const xrpc = schema["x-rpc"] ?? {};
  for (const [direction, root] of [["omp → foxnio", xrpc.serverFrame], ["omp → foxnio", xrpc.sessionEvent], ["foxnio → omp", xrpc.inbound]]) {
    for (const name of leaves(root)) {
      const properties = defs[name].properties ?? {};
      const type = properties.type?.const;
      if (typeof type !== "string") continue;
      const method = properties.method?.const;
      frames.set(typeof method === "string" ? `${type} (${method})` : type, { type, direction, shape: definition(name) });
    }
  }
  return { commands, frames };
}

function shapeChange(before, after) {
  if (JSON.stringify(before) === JSON.stringify(after)) return null;
  const props = (shape) => new Set(Object.keys(shape?.properties ?? {}));
  const required = (shape) => new Set(shape?.required ?? []);
  const [beforeProps, afterProps] = [props(before), props(after)];
  const notes = [];
  const added = [...afterProps].filter((key) => !beforeProps.has(key));
  const removed = [...beforeProps].filter((key) => !afterProps.has(key));
  const nowRequired = [...required(after)].filter((key) => !required(before).has(key));
  if (added.length) notes.push(`+${added.map((key) => `\`${key}\``).join(", +")}`);
  if (removed.length) notes.push(`−${removed.map((key) => `\`${key}\``).join(", −")}`);
  if (nowRequired.length) notes.push(`now required: ${nowRequired.map((key) => `\`${key}\``).join(", ")}`);
  const kept = [...afterProps].filter((key) => beforeProps.has(key)
    && JSON.stringify(before.properties[key]) !== JSON.stringify(after.properties[key]));
  if (kept.length) notes.push(`changed: ${kept.map((key) => `\`${key}\``).join(", ")}`);
  return notes.length ? notes.join("; ") : "definition changed";
}

function wireSection() {
  const before = wireModel(fromTag);
  const after = wireModel(toTag);
  if (!before || !after) return [`The wire schema (\`${WIRE}\`) is missing at ${before ? toTag : fromTag}.`];
  const lines = [];
  const list = (title, items) => {
    if (items.length) lines.push(`**${title}**`, "", ...items.map((item) => `- ${item}`), "");
  };
  const names = (map) => [...map.keys()];
  list("Commands removed", names(before.commands).filter((name) => !after.commands.has(name)).map((name) => `\`${name}\`${mark(name, { rpc: true })}`));
  list("Commands added", names(after.commands).filter((name) => !before.commands.has(name)).map((name) => `\`${name}\``));
  list("Commands changed", names(after.commands).filter((name) => before.commands.has(name)).flatMap((name) => {
    const params = shapeChange(before.commands.get(name).params, after.commands.get(name).params);
    const result = shapeChange(before.commands.get(name).result, after.commands.get(name).result);
    if (!params && !result) return [];
    return [`\`${name}\`${params ? ` params: ${params}` : ""}${params && result ? ";" : ""}${result ? ` result: ${result}` : ""}${mark(name, { rpc: true })}`];
  }));
  const frameItem = (key, frame) => `\`${key}\` (${frame.direction})${mark(frame.type, { rpc: true })}`;
  list("Frames removed", names(before.frames).filter((key) => !after.frames.has(key)).map((key) => frameItem(key, before.frames.get(key))));
  list("Frames added", names(after.frames).filter((key) => !before.frames.has(key)).map((key) => frameItem(key, after.frames.get(key))));
  list("Frames changed", names(after.frames).filter((key) => before.frames.has(key)).flatMap((key) => {
    const change = shapeChange(before.frames.get(key).shape, after.frames.get(key).shape);
    return change ? [`${frameItem(key, after.frames.get(key))}: ${change}`] : [];
  }));
  return lines.length ? lines : ["No structural changes."];
}

// ---- CLI flags, settings, session format -------------------------------------

function flags(tag) {
  const found = new Set();
  for (const file of [`${AGENT}/src/cli/flag-tables.ts`, `${AGENT}/src/cli/args.ts`]) {
    for (const match of (show(tag, file) ?? "").matchAll(/"(--[a-z][a-z0-9-]*)"/g)) found.add(match[1]);
  }
  return found;
}

function flagSection() {
  const [before, after] = [flags(fromTag), flags(toTag)];
  const removed = [...before].filter((flag) => !after.has(flag)).sort();
  const added = [...after].filter((flag) => !before.has(flag)).sort();
  const lines = [];
  if (removed.length) lines.push(`- Removed: ${removed.map((flag) => `\`${flag}\`${mark(flag)}`).join(", ")}`);
  if (added.length) lines.push(`- Added: ${added.map((flag) => `\`${flag}\``).join(", ")}`);
  return lines.length ? lines : ["No flags added or removed."];
}

function settingsSection() {
  const changed = git(["diff", "--name-only", fromTag, toTag, "--", `${AGENT}/src/**/settings.ts`, `${AGENT}/src/**/settings-*.ts`])
    .split("\n").filter(Boolean);
  const ids = (tag) => new Set(changed.flatMap((file) => [...(show(tag, file) ?? "").matchAll(/\bid:\s*"([A-Za-z0-9_.-]+)"/g)].map((match) => match[1])));
  const [before, after] = [ids(fromTag), ids(toTag)];
  const removed = [...before].filter((id) => !after.has(id)).sort();
  const added = [...after].filter((id) => !before.has(id)).sort();
  const lines = [];
  if (removed.length) lines.push(`- Removed: ${removed.map((id) => `\`${id}\`${mark(id, { setting: true })}`).join(", ")}`);
  if (added.length) lines.push(`- Added: ${added.map((id) => `\`${id}\``).join(", ")}`);
  if (changed.length) lines.push(`- Setting definitions changed in: ${changed.map((file) => `\`${file.replace(`${AGENT}/src/`, "")}\``).join(", ")}`);
  return lines.length ? lines : ["No setting definitions changed."];
}

function sessionVersion(tag) {
  return /CURRENT_SESSION_VERSION\s*=\s*(\d+)/.exec(show(tag, `${AGENT}/src/session/session-entries.ts`) ?? "")?.[1] ?? "unknown";
}

// The native suites disable every catalog provider (tests/omp-native-env.mjs);
// one the list misses could reach a real service from the tests.
async function isolationLine() {
  const { DISABLED_PROVIDERS } = await import(pathToFileURL(join(foxnioRoot, "tests", "omp-native-env.mjs")).href);
  const catalog = show(toTag, "packages/catalog/src/compat/provider-ids.ts");
  if (!catalog) return "`packages/catalog/src/compat/provider-ids.ts` is missing at this release: find where omp lists its providers and update `DISABLED_PROVIDERS` in `tests/omp-native-env.mjs`.";
  const missing = [...new Set([...catalog.matchAll(/"([a-z0-9.-]+)"/g)].map((match) => match[1]))]
    .filter((id) => !DISABLED_PROVIDERS.includes(id)).sort();
  return missing.length
    ? `Catalog providers missing from \`DISABLED_PROVIDERS\` in \`tests/omp-native-env.mjs\`: ${missing.map((id) => `\`${id}\``).join(", ")}. Add them so the native tests cannot reach those services.`
    : "`DISABLED_PROVIDERS` covers every catalog provider of this release.";
}

const AREAS = [
  ["RPC mode", [`${AGENT}/src/modes/rpc`, "docs/rpc.md"]],
  ["Sessions", [`${AGENT}/src/session`]],
  ["CLI", [`${AGENT}/src/cli`, `${AGENT}/src/main.ts`, `${AGENT}/src/cli.ts`, "docs/cli-reference.md"]],
  ["Export", [`${AGENT}/src/export`]],
  ["Config and models", [`${AGENT}/src/config`, "docs/config-usage.md", "docs/models.md", "docs/environment-variables.md"]],
  ["Extensions", [`${AGENT}/src/extensibility`, "docs/extensions.md", "docs/hooks.md"]],
  ["Skills, plugins, MCP", [`${AGENT}/src/skills`, `${AGENT}/src/plugins`, `${AGENT}/src/mcp`, "docs/mcp-config.md", "docs/marketplace.md"]],
];

function areaTable() {
  const rows = AREAS.map(([area, paths]) => {
    let files = 0;
    let added = 0;
    let removed = 0;
    for (const line of git(["diff", "--numstat", fromTag, toTag, "--", ...paths]).split("\n").filter(Boolean)) {
      const [plus, minus] = line.split("\t");
      files += 1;
      added += Number(plus) || 0;
      removed += Number(minus) || 0;
    }
    return `| ${area} | ${files} | +${added} −${removed} |`;
  });
  return ["| Area | Files | Lines |", "| --- | --- | --- |", ...rows];
}

// ---- changelog -----------------------------------------------------------------

const semver = (version) => version.split(/[.-]/).slice(0, 3).map(Number);
function newer(a, b) {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

function changelogSection(limit) {
  const text = show(toTag, `${AGENT}/CHANGELOG.md`) ?? "";
  const sections = [];
  let current = null;
  for (const line of text.split("\n")) {
    const heading = /^## \[(\d+\.\d+\.\d+[^\]]*)\]/.exec(line);
    if (heading) current = newer(heading[1], from) && !newer(heading[1], to) ? [] : null;
    if (heading && current) sections.push(current);
    if (current) current.push(line.replace(/^## /, "#### "));
  }
  const body = sections.map((section) => section.join("\n").trim()).join("\n\n");
  const link = `${OMP_REPO}/blob/${toTag}/${AGENT}/CHANGELOG.md`;
  if (!body) return [`No changelog section found for ${from} < version ≤ ${to}. Full changelog: ${link}`];
  if (body.length <= limit) return [body, "", `Full changelog: ${link}`];
  return [`${body.slice(0, limit).replace(/\n[^\n]*$/, "")}`, "", `…truncated. Full changelog: ${link}`];
}

// ---- smoke result ------------------------------------------------------------------

function smokeSection() {
  if (smokeStatus === "") return { failed: true, lines: ["The native tests did not run (an earlier step failed). See the workflow run."] };
  const tap = smokeTap && existsSync(smokeTap) ? readFileSync(smokeTap, "utf8").split("\n") : [];
  const summary = Object.fromEntries(tap.map((line) => /^# (tests|pass|fail|skipped|cancelled) (\d+)/.exec(line)).filter(Boolean).map((match) => [match[1], Number(match[2])]));
  const failures = [];
  for (let i = 0; i < tap.length; i++) {
    const result = /^(\s*)not ok \d+ - (.+)$/.exec(tap[i]);
    if (!result) continue;
    let error = "";
    for (let j = i + 1; j < tap.length && !/^\s*(?:not )?ok \d+ - /.test(tap[j]); j++) {
      const inline = /^\s*error: '(.*)'$/.exec(tap[j]);
      if (inline) {
        error = inline[1];
        break;
      }
      if (/^\s*error: \|-?$/.test(tap[j])) {
        error = (tap[j + 1] ?? "").trim();
        break;
      }
    }
    failures.push(`- ${result[2]}${error ? `: ${error.slice(0, 300)}` : ""}`);
  }
  const failed = smokeStatus !== "0";
  const counts = `${summary.pass ?? "?"} passed, ${summary.fail ?? "?"} failed, ${summary.skipped ?? 0} skipped`;
  const lines = [`**${failed ? "Failed" : "Passed"}** (${counts}): \`lib/omp/omp-compat.native.test.mjs\` and \`lib/omp/session-edit.native.test.mjs\` against the released \`omp-linux-x64\`.`];
  if (failures.length) lines.push("", ...failures);
  return { failed, lines };
}

// ---- report ------------------------------------------------------------------------

const smoke = smokeSection();
const head = [
  `omp **v${to}**${releaseUrl ? ` ([release](${releaseUrl}))` : ""} compared with **v${from}**, the version foxnio is verified against (\`.github/omp-version.json\`). [Source diff](${OMP_REPO}/compare/${fromTag}...${toTag})`,
  "",
  "### Compatibility smoke",
  "",
  ...smoke.lines,
  "",
  await isolationLine(),
  "",
  "### RPC wire protocol",
  "",
  ...wireSection(),
  "",
  "### CLI flags",
  "",
  ...flagSection(),
  "",
  "### Settings",
  "",
  ...settingsSection(),
  "",
  "### Session file format",
  "",
  `\`CURRENT_SESSION_VERSION\`: ${sessionVersion(fromTag)} → ${sessionVersion(toTag)}`,
  "",
  "### Changed files by area",
  "",
  ...areaTable(),
  "",
  "### Next step",
  "",
  `Adapt foxnio where needed, then set \`verified\` in \`.github/omp-version.json\` to \`${to}\` in the same change.`,
  "",
  "### Changelog",
  "",
].join("\n");
// GitHub issue bodies are limited to 65536 characters.
process.stdout.write(`${head}${changelogSection(Math.max(2_000, 60_000 - head.length)).join("\n")}\n`);
