import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = path.resolve(pluginRoot, "..", "..");

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
assert.ok(fs.existsSync(manifestPath), "Codex plugin manifest must exist at plugins/kimi/.codex-plugin/plugin.json");

const manifest = readJson(manifestPath);
assert.equal(manifest.name, "kimi");
assert.equal(manifest.version, "0.1.5");
assert.equal(manifest.skills, "./skills/");
assert.equal(manifest.repository, "https://github.com/Imperix1155/kimi-in-codex");
for (const unsupported of ["hooks", "mcpServers", "apps"]) {
  assert.ok(!(unsupported in manifest), `setup slice must not advertise ${unsupported}`);
}

const marketplace = readJson(path.join(repoRoot, ".agents", "plugins", "marketplace.json"));
assert.equal(marketplace.name, "imperix");
assert.equal(marketplace.plugins.length, 1);
assert.deepEqual(marketplace.plugins[0].source, { source: "local", path: "./plugins/kimi" });

const skillPath = path.join(pluginRoot, "skills", "kimi-setup", "SKILL.md");
assert.ok(fs.existsSync(skillPath), "kimi-setup skill must exist");
const skill = fs.readFileSync(skillPath, "utf8");
const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
assert.deepEqual(
  frontmatter.split("\n").map((line) => line.split(":", 1)[0]),
  ["name", "description"],
  "skill frontmatter must contain only name and description"
);
assert.match(skill, /node "\$\{PLUGIN_ROOT\}\/scripts\/kimi-companion\.mjs" setup --json/);
assert.match(skill, /Ignore `reviewGateEnabled`, `actionsTaken`, `nextSteps`, and `sessionRuntime`/);
assert.doesNotMatch(skill, /Return the complete output/);
assert.doesNotMatch(skill, /\$ARGUMENTS|AskUserQuestion|CLAUDE_PLUGIN_ROOT/);

const metadata = fs.readFileSync(path.join(pluginRoot, "skills", "kimi-setup", "agents", "openai.yaml"), "utf8");
assert.match(metadata, /display_name: "Kimi Setup"/);
assert.match(metadata, /\$kimi-setup/);

const reviewSkillPath = path.join(pluginRoot, "skills", "kimi-review", "SKILL.md");
assert.ok(fs.existsSync(reviewSkillPath), "kimi-review skill must exist");
const reviewSkill = fs.readFileSync(reviewSkillPath, "utf8");
const reviewFrontmatter = reviewSkill.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
assert.deepEqual(
  reviewFrontmatter.split("\n").map((line) => line.split(":", 1)[0]),
  ["name", "description"],
  "review skill frontmatter must contain only name and description"
);
assert.match(
  reviewSkill,
  /node "\$\{PLUGIN_ROOT\}\/scripts\/kimi-companion\.mjs" review --diff-file "\$\{DIFF_FILE\}" --diff-sha256 "\$\{DIFF_SHA256\}" --json/
);
assert.match(reviewSkill, /NOT REVIEWED/);
assert.match(reviewSkill, /Require both/i);
assert.equal(
  reviewSkill.match(/node "\$\{PLUGIN_ROOT\}\/scripts\/kimi-companion\.mjs" review/g)?.length,
  1,
  "review skill must invoke the runtime exactly once"
);
assert.match(reviewSkill, /Do not retry against `git diff`/);
assert.doesNotMatch(reviewSkill, /\$ARGUMENTS|AskUserQuestion|CLAUDE_PLUGIN_ROOT/);

const reviewMetadata = fs.readFileSync(path.join(pluginRoot, "skills", "kimi-review", "agents", "openai.yaml"), "utf8");
assert.match(reviewMetadata, /display_name: "Kimi Review"/);
assert.match(reviewMetadata, /\$kimi-review/);

assert.match(manifest.description, /review/i);
assert.match(manifest.interface.longDescription, /frozen/i);
assert.match(manifest.interface.longDescription, /not included|not yet/i);

console.log("CODEX-PLUGIN-SURFACE-GREEN");
