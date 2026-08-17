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
assert.match(reviewSkill, /sandbox_permissions:\s*["`]require_escalated["`]/);
assert.match(reviewSkill, /authenticated local Kimi runtime/i);
assert.match(reviewSkill, /Do not first attempt.*sandbox/i);
assert.match(reviewSkill, /denied.*NOT REVIEWED/i);
assert.match(reviewSkill, /normal user filesystem authority/i);
assert.match(reviewSkill, /not (?:an )?OS sandbox/i);
assert.doesNotMatch(reviewSkill, /\$ARGUMENTS|AskUserQuestion|CLAUDE_PLUGIN_ROOT/);

const reviewMetadata = fs.readFileSync(path.join(pluginRoot, "skills", "kimi-review", "agents", "openai.yaml"), "utf8");
assert.match(reviewMetadata, /display_name: "Kimi Review"/);
assert.match(reviewMetadata, /\$kimi-review/);

const taskSkillPath = path.join(pluginRoot, "skills", "kimi-task", "SKILL.md");
assert.ok(fs.existsSync(taskSkillPath), "kimi-task skill must exist");
const taskSkill = fs.readFileSync(taskSkillPath, "utf8");
const taskFrontmatter = taskSkill.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
assert.deepEqual(
  taskFrontmatter.split("\n").map((line) => line.split(":", 1)[0]),
  ["name", "description"],
  "task skill frontmatter must contain only name and description"
);
assert.match(taskSkill, /task --codex-once --json/);
assert.match(
  taskSkill,
  /SESSION_ARGS=\(--resume-session "\$\{SESSION_ID\}"\)/,
  "task skill must construct --resume-session and its exact ID as separate argv elements"
);
assert.match(
  taskSkill,
  /"\$\{SESSION_ARGS\[@\]\}"/,
  "task skill must expand session arguments without word splitting"
);
assert.doesNotMatch(
  taskSkill,
  /"\$\{SESSION_FLAG\}"/,
  "task skill must not pass a compound resume flag as one argv element"
);
assert.equal(
  taskSkill.match(/node "\$\{PLUGIN_ROOT\}\/scripts\/kimi-companion\.mjs" "\$\{TASK_ARGS\[@\]\}"/g)?.length,
  1,
  "task skill must invoke the constructed argv exactly once"
);
assert.match(taskSkill, /sandbox_permissions:\s*["`]require_escalated["`]/);
assert.match(taskSkill, /default.*read-only/i);
assert.match(taskSkill, /normal user filesystem authority/i);
assert.match(taskSkill, /not (?:an )?OS sandbox/i);
assert.match(taskSkill, /--resume-session/);
assert.match(taskSkill, /background.*not supported|not support.*background/i);
assert.doesNotMatch(taskSkill, /\$kimi-status|\$kimi-result|\$kimi-cancel/);
assert.doesNotMatch(taskSkill, /\$ARGUMENTS|AskUserQuestion|CLAUDE_PLUGIN_ROOT/);

const taskMetadata = fs.readFileSync(path.join(pluginRoot, "skills", "kimi-task", "agents", "openai.yaml"), "utf8");
assert.match(taskMetadata, /display_name: "Kimi Task"/);
assert.match(taskMetadata, /\$kimi-task/);

assert.match(manifest.description, /review/i);
assert.match(manifest.description, /task handoff/i);
assert.match(manifest.interface.defaultPrompt.join(" "), /task handoff/i);
assert.match(manifest.interface.longDescription, /frozen/i);
assert.match(manifest.interface.longDescription, /background.*lifecycle.*not included/i);
assert.ok(manifest.interface.capabilities.includes("Read"));
assert.ok(manifest.interface.capabilities.includes("Write"));

console.log("CODEX-PLUGIN-SURFACE-GREEN");
