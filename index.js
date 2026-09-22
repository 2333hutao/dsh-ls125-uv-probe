/**
 * dsh-ls125-uv-probe — provides the `ls125-uv-probe` skill.
 *
 * The skill body is authoring-time Markdown that lives next to this file in
 * `skill/SKILL.md`, and is the *same* file a filesystem skill root can serve:
 * the plugin only parses its frontmatter and hands the body to the registry,
 * so there is exactly one copy of the text and no drift between the two
 * delivery paths.
 *
 * Everything the skill references (PROTOCOL.md, LESSONS.md, AGENTS.md, the
 * capture/decode toolchain, the F103 firmware) ships inside `skill/`, and
 * `resourceBase` points at that directory so relative references resolve.
 *
 * @module dsh-ls125-uv-probe
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Cordis plugin name. */
const name = 'ls125-uv-probe';

/** This plugin contributes a skill, so it needs the skills service. */
const inject = ['skills'];

const here = dirname(fileURLToPath(import.meta.url));
const skillDir = join(here, 'skill');
const skillFile = join(skillDir, 'SKILL.md');

const FALLBACK_DESCRIPTION =
  'Drive a LinShang LS125 UV irradiance meter UVALED-X3 probe from your own MCU: ' +
  'reverse-engineered 9600 8N1 protocol, CRC-16/MODBUS, poll and clear commands, ' +
  'plus a capture/decode toolchain and verified STM32F103 host firmware.';

/**
 * Parse the leading YAML frontmatter block.
 *
 * Deliberately dependency-free and deliberately narrow: this file only ever
 * parses frontmatter this repository authored, so scalar `key: value` pairs and
 * optional single/double quotes are the whole grammar. Anything richer (nested
 * maps, lists) is left alone rather than half-implemented.
 *
 * @param text - raw Markdown, optionally starting with a `---` block.
 * @returns the scalar metadata and the body with the block removed.
 */
function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(text);
  if (match === null) return { meta: {}, body: text };

  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (pair === null) continue;
    let value = pair[2].trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2);
    if (quoted) value = value.slice(1, -1);
    meta[pair[1]] = value;
  }
  return { meta, body: text.slice(match[0].length) };
}

/**
 * Register the bundled skill with the harness skill registry.
 *
 * @param ctx - Cordis context carrying the `skills` service (`inject`).
 */
function apply(ctx) {
  if (!existsSync(skillFile)) {
    ctx.logger?.warn?.(`${name}: skill body not found at ${skillFile}; nothing registered`);
    return;
  }

  const { meta, body } = parseFrontmatter(readFileSync(skillFile, 'utf8'));

  ctx.skills.register({
    name: meta.name || name,
    description: meta.description || FALLBACK_DESCRIPTION,
    ...(meta.whenToUse ? { whenToUse: meta.whenToUse } : {}),
    content: body.trimStart(),
    source: 'runtime',
    resourceBase: { kind: 'directory', path: skillDir },
    metadata: {
      package: 'dsh-ls125-uv-probe',
      bundled: [
        'PROTOCOL.md',
        'LESSONS.md',
        'AGENTS.md',
        'README.md',
        'tools/',
        'firmware/',
        'captures/',
      ],
    },
  });
}

export { apply, inject, name };
export default { name, inject, apply };
