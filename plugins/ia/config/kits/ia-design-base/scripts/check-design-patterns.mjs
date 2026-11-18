#!/usr/bin/env node
// inventarch/ia-design-base-kit offline Atomic Design & pattern/recipe checker (declared check: check-design-patterns).
// Pure Node built-in ESM, zero external npm dependencies, and zero network access.
//
// Usage from an IA workspace root (via plugins/ia/scripts/check.mjs):
//   node check-design-patterns.mjs [--ia] <the command words that run ia...>
// Prints { format, revision, ok, counts, findings } on stdout and exits 0 when ok, 1 when findings exist,
// or 2 (with nothing on stdout) when the workspace is missing, refused by ia validate, or unreadable.

import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FORMAT = 'ia.design.pattern-check.v1';
export const STAGE_ORDER = Object.freeze({
  atom: 1,
  molecule: 2,
  organism: 3,
  'page-template': 4,
  page: 5,
});
const MAX_BUFFER = 256 * 1024 * 1024;

const EVIDENCE_RE = /^[0-9a-f]{64}\s+[A-Za-z0-9_-]+#[A-Za-z0-9:_-]+$/;
const ARROW_PAIR_RE = /^([^\s-][^]*?)\s*->\s*([^\s][^]*)$/;
const SLOT_MAP_RE = /^([A-Za-z0-9][A-Za-z0-9_-]*)\s*<-\s*(\S[^]*)$/;
const VARIANT_MAP_RE = /^[^=\s]+=\S[^]*?\s*->\s*[^=\s]+=\S[^]*$/;

const RAW_HEX_OR_FUNC_RE = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|lab|lch)\(/;
const RAW_PALETTE_RE =
  /(?:^|:|-)(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00|950)\b/;
const PRIMITIVE_CLASS_RE = /(?:^|:)(?:bg|text|border|fill|stroke|ring)-(?:primitive|raw|palette)-/;
const ADAPT_SCALE_CLASS_RE =
  /^(?:[a-z0-9-]+:)*(?:-?(?:p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|space-x|space-y|gap|gap-x|gap-y|w|min-w|max-w|h|min-h|max-h|size|inset|top|right|bottom|left)-|(?:flex|inline-flex|grid|inline-grid|block|inline-block|hidden|table|col-span-|row-span-|justify-|items-|content-|self-|place-|order-))/;

const PROTECTED_OUTPUT_PREFIXES = ['.ia/', '.git/', '.github/', 'node_modules/', 'vendor/'];
const PROTECTED_OUTPUT_FILES = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'tsconfig.json',
  'biome.json',
]);

export function isSafeRecipeOutput(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('\\') ||
    /[:\0]/.test(value) ||
    !value.split('/').every(seg => seg.length > 0 && seg !== '.' && seg !== '..')
  ) {
    return false;
  }
  const lower = value.toLowerCase();
  if (PROTECTED_OUTPUT_FILES.has(lower) || PROTECTED_OUTPUT_FILES.has(lower.split('/').at(-1))) return false;
  if (PROTECTED_OUTPUT_PREFIXES.some(prefix => lower.startsWith(prefix))) return false;
  return true;
}

export function inspectTokenClassList(classListText, primitiveClasses = new Set()) {
  const tokens = String(classListText ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return { raw: true, scale: false, reason: 'empty class list' };
  let raw = false;
  let scale = false;
  const reasons = [];
  for (const cls of tokens) {
    if (cls.startsWith('!') || cls.includes(':!')) {
      raw = true;
      reasons.push(`important flag in '${cls}'`);
    }
    if (cls.includes('[') || cls.includes(']')) {
      raw = true;
      reasons.push(`arbitrary value in '${cls}'`);
    }
    if (RAW_HEX_OR_FUNC_RE.test(cls) || RAW_PALETTE_RE.test(cls) || PRIMITIVE_CLASS_RE.test(cls) || primitiveClasses.has(cls)) {
      raw = true;
      reasons.push(`raw or primitive token '${cls}'`);
    }
    if (ADAPT_SCALE_CLASS_RE.test(cls)) {
      scale = true;
    }
  }
  return { raw, scale, reason: reasons.join('; ') };
}

function sectionField(record, path) {
  const [section, key] = path.split('.');
  return record.sections?.find(s => s.name === section)?.fields?.find(f => f.key === key)?.value;
}

function scalarText(value) {
  if (!value) return null;
  if (typeof value.text === 'string') return value.text;
  if (typeof value.value === 'number' || typeof value.value === 'string') return String(value.value);
  return null;
}

function numberValue(value) {
  if (!value) return null;
  if (typeof value.value === 'number') return Number.isFinite(value.value) ? value.value : null;
  if (typeof value.text === 'string' && value.text.trim() !== '') {
    const parsed = Number(value.text);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function listItems(value) {
  return value?.kind === 'list' && Array.isArray(value.items) ? value.items : [];
}

function refKey(value) {
  if (!value) return null;
  if (value.kind === 'identity' && typeof value.identity === 'string') return value.identity;
  if (value.kind === 'ref' && value.discriminator && value.name) {
    return `@${value.discriminator} ${String(value.name).toLowerCase()}`;
  }
  return null;
}

function buildLookup(records) {
  const byIdentity = new Map();
  const byRef = new Map();
  const byShortName = new Map();
  for (const r of records) {
    byIdentity.set(r.identity, r);
    const nameLower = String(r.name ?? '').toLowerCase();
    const key = `@${r.discriminator} ${nameLower}`;
    if (!byRef.has(key) || r.provenance === 'workspace') byRef.set(key, r.identity);
    const shortKey = `${r.discriminator}:${nameLower}`;
    if (!byShortName.has(shortKey) || r.provenance === 'workspace') byShortName.set(shortKey, r.identity);
  }
  const resolveRef = (ref, expectedDiscriminators = null) => {
    if (!ref) return null;
    if (typeof ref === 'string') {
      const trimmed = ref.trim();
      if (byIdentity.has(trimmed)) return trimmed;
      const lower = trimmed.toLowerCase();
      if (byRef.has(lower)) return byRef.get(lower);
      if (expectedDiscriminators) {
        for (const d of expectedDiscriminators) {
          const hit = byShortName.get(`${d}:${lower}`);
          if (hit) return hit;
        }
      }
      return null;
    }
    if (ref.target && byIdentity.has(ref.target)) return ref.target;
    const key = refKey(ref.reference ?? ref);
    if (!key) return null;
    return byIdentity.has(key) ? key : (byRef.get(key) ?? null);
  };
  return { byIdentity, resolveRef };
}

function outgoingEdges(record, predicate, targetDiscriminator, resolveRef, byIdentity) {
  const targets = [];
  for (const edge of record.edges ?? []) {
    if (edge.predicate !== predicate || (edge.direction && edge.direction !== 'out')) continue;
    const resolved = resolveRef(edge);
    if (!resolved) continue;
    const targetRecord = byIdentity.get(resolved);
    if (!targetDiscriminator || targetRecord?.discriminator === targetDiscriminator) targets.push(resolved);
  }
  return [...new Set(targets)];
}

function detectCycles(graph) {
  const active = new Set();
  const visited = new Set();
  const cyclic = new Set();

  function dfs(node, stack) {
    if (active.has(node)) {
      const idx = stack.indexOf(node);
      for (const member of stack.slice(idx >= 0 ? idx : 0)) cyclic.add(member);
      cyclic.add(node);
      return;
    }
    if (visited.has(node)) return;
    active.add(node);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (graph.has(next)) dfs(next, stack);
    }
    stack.pop();
    active.delete(node);
    visited.add(node);
  }

  for (const node of [...graph.keys()].sort()) dfs(node, []);
  return [...cyclic].sort();
}

export function checkDesignPatterns(snapshot) {
  const allRecords = Array.isArray(snapshot?.records) ? snapshot.records : [];
  const { byIdentity, resolveRef } = buildLookup(allRecords);
  const findings = [];

  const report = (code, record, message) => {
    findings.push({
      code,
      severity: 'error',
      discriminator: record.discriminator,
      identity: record.identity,
      name: record.name ?? null,
      file: record.origin?.file ?? null,
      line: record.origin?.line ?? null,
      message,
    });
  };

  const own = allRecords.filter(r => (r.provenance ?? 'workspace') === 'workspace');
  const designTokens = own.filter(r => r.discriminator === 'design-token');
  const levels = own.filter(r => r.discriminator === 'level');
  const parts = own.filter(r => r.discriminator === 'part');
  const slots = own.filter(r => r.discriminator === 'slot');
  const patterns = own.filter(r => r.discriminator === 'pattern');
  const recipes = own.filter(r => r.discriminator === 'recipe');
  const approvals = allRecords.filter(r => r.discriminator === 'approval');
  const approvalRules = own.filter(r => r.discriminator === 'approval-rule');

  // Collect primitive token classes so recipes/parts cannot smuggle primitive tokens via class lists
  const primitiveClasses = new Set();
  const tokenTierById = new Map();
  for (const tok of allRecords.filter(r => r.discriminator === 'design-token')) {
    const tier = scalarText(sectionField(tok, 'token.tier'));
    tokenTierById.set(tok.identity, tier);
    if (tier === 'primitive') {
      for (const item of listItems(sectionField(tok, 'token.classes'))) {
        const cls = scalarText(item);
        if (cls) primitiveClasses.add(cls.trim());
      }
    }
  }

  // 1. @level checks: unique stages and rank ordering consistent with atom < molecule < organism < page-template < page
  const levelInfo = new Map();
  const seenStage = new Map();
  for (const lvl of allRecords.filter(r => r.discriminator === 'level')) {
    const rank = numberValue(sectionField(lvl, 'level.rank'));
    const stage = scalarText(sectionField(lvl, 'level.stage'));
    const stageIdx = stage ? (STAGE_ORDER[stage] ?? null) : null;
    levelInfo.set(lvl.identity, { rank, stage, stageIdx, record: lvl });
    if ((lvl.provenance ?? 'workspace') === 'workspace' && stage) {
      if (seenStage.has(stage)) {
        report('LEVEL_DUPLICATE_STAGE', lvl, `@level ${lvl.name} duplicates stage '${stage}' already declared by ${seenStage.get(stage)}`);
      } else {
        seenStage.set(stage, lvl.name);
      }
    }
  }

  const ownLevels = levels.map(l => levelInfo.get(l.identity)).filter(Boolean);
  for (let i = 0; i < ownLevels.length; i++) {
    for (let j = i + 1; j < ownLevels.length; j++) {
      const a = ownLevels[i];
      const b = ownLevels[j];
      if (a.stageIdx !== null && b.stageIdx !== null && a.rank !== null && b.rank !== null) {
        if ((a.stageIdx < b.stageIdx && a.rank >= b.rank) || (a.stageIdx > b.stageIdx && a.rank <= b.rank)) {
          const offender = a.stageIdx > b.stageIdx ? a.record : b.record;
          report(
            'LEVEL_STAGE_RANK_ORDER',
            offender,
            `@level ${a.record.name} (${a.stage}, rank ${a.rank}) and @level ${b.record.name} (${b.stage}, rank ${b.rank}) invert canonical Atomic Design order`,
          );
        }
      }
    }
  }

  // 2. @slot ownership index & duplicate check
  const slotsByPart = new Map();
  for (const slot of allRecords.filter(r => r.discriminator === 'slot')) {
    const ownerId = resolveRef(sectionField(slot, 'slot.part'), ['part']);
    const slotName = scalarText(sectionField(slot, 'slot.name')) ?? '';
    if (ownerId) {
      if (!slotsByPart.has(ownerId)) slotsByPart.set(ownerId, new Map());
      const map = slotsByPart.get(ownerId);
      if ((slot.provenance ?? 'workspace') === 'workspace' && map.has(slotName)) {
        report('SLOT_DUPLICATE_NAME', slot, `@slot ${slot.name} duplicates slot.name '${slotName}' on ${ownerId}`);
      } else {
        map.set(slotName, slot.identity);
      }
    } else if ((slot.provenance ?? 'workspace') === 'workspace') {
      report('SLOT_OWNER_MISMATCH', slot, `@slot ${slot.name}: slot.part does not resolve to an admitted @part`);
    }
  }

  // 3. @part checks: atomic hierarchy, cycles, token tiers, slot ownership, and unambiguous Figma component-set claims
  const partGraph = new Map();
  const figmaClaimants = new Map();

  for (const part of allRecords.filter(r => r.discriminator === 'part')) {
    const composedRefs = listItems(sectionField(part, 'part.composes'))
      .map(r => resolveRef(r, ['part']))
      .filter(Boolean);
    const reqParts = outgoingEdges(part, 'require', 'part', resolveRef, byIdentity);
    partGraph.set(part.identity, [...new Set([...composedRefs, ...reqParts])]);
  }

  for (const part of parts) {
    const lvlId = resolveRef(sectionField(part, 'part.level'), ['level']);
    const fromLevel = lvlId ? levelInfo.get(lvlId) : null;
    if (!fromLevel) {
      report('PART_LEVEL_UNRESOLVED', part, `@part ${part.name}: part.level does not resolve to an admitted @level`);
    }

    for (const childId of partGraph.get(part.identity) ?? []) {
      const childPart = byIdentity.get(childId);
      if (!childPart) continue;
      const childLvlId = resolveRef(sectionField(childPart, 'part.level'), ['level']);
      const toLevel = childLvlId ? levelInfo.get(childLvlId) : null;
      if (fromLevel && toLevel) {
        const upwardStage = fromLevel.stageIdx !== null && toLevel.stageIdx !== null && toLevel.stageIdx > fromLevel.stageIdx;
        const upwardRank = fromLevel.rank !== null && toLevel.rank !== null && toLevel.rank > fromLevel.rank;
        if (upwardStage || upwardRank) {
          report(
            'PART_ATOMIC_HIERARCHY',
            part,
            `@part ${part.name} (${fromLevel.stage}) cannot compose higher-stage @part ${childPart.name} (${toLevel.stage})`,
          );
        }
      }
      if (
        fromLevel?.stage === 'page' &&
        childPart &&
        toLevel?.stage === 'page' &&
        part.identity !== childId
      ) {
        report('PART_ATOMIC_HIERARCHY', part, `@part ${part.name} (page) should instantiate templates/organisms rather than another page`);
      }
    }

    // Slot references on @part must belong to this @part
    for (const slotItem of listItems(sectionField(part, 'part.slots'))) {
      const slotId = resolveRef(slotItem, ['slot']);
      const slotRec = slotId ? byIdentity.get(slotId) : null;
      const slotOwner = slotRec ? resolveRef(sectionField(slotRec, 'slot.part'), ['part']) : null;
      if (!slotRec || slotOwner !== part.identity) {
        report(
          'SLOT_OWNER_MISMATCH',
          part,
          `@part ${part.name}: part.slots references ${scalarText(slotItem) ?? slotId ?? 'unknown'}, whose slot.part is not ${part.name}`,
        );
      }
    }

    // Tokens on @part must be semantic or component, never primitive
    for (const tokItem of listItems(sectionField(part, 'part.tokens'))) {
      const tokId = resolveRef(tokItem, ['design-token']);
      if (tokId && tokenTierById.get(tokId) === 'primitive') {
        report(
          'PART_PRIMITIVE_TOKEN',
          part,
          `@part ${part.name} references primitive @design-token ${byIdentity.get(tokId)?.name ?? tokId}; parts paint with semantic or component tokens only`,
        );
      }
    }

    // Single-claimant Figma component-set check across proposed/active parts (REQ-PAT-06)
    const standing = scalarText(sectionField(part, 'part.standing')) ?? 'proposed';
    if (standing === 'proposed' || standing === 'active') {
      const explicitNames = listItems(sectionField(part, 'part.figma-names'))
        .map(scalarText)
        .filter(v => typeof v === 'string' && v.length > 0);
      const partName = scalarText(sectionField(part, 'part.name')) ?? part.name;
      const claimedSets = explicitNames.length > 0 ? explicitNames : [partName];
      for (const setName of new Set(claimedSets)) {
        if (!figmaClaimants.has(setName)) figmaClaimants.set(setName, []);
        figmaClaimants.get(setName).push(part);
      }
    }
  }

  for (const [setName, claimants] of figmaClaimants.entries()) {
    if (claimants.length > 1) {
      for (const claimant of claimants) {
        report(
          'PART_FIGMA_SET_AMBIGUOUS',
          claimant,
          `Figma component set '${setName}' is claimed by multiple parts (${claimants.map(c => c.name).join(', ')}); ownership is ambiguous`,
        );
      }
    }
  }

  for (const cyclicId of detectCycles(partGraph)) {
    const part = byIdentity.get(cyclicId);
    if (part && (part.provenance ?? 'workspace') === 'workspace') {
      report('PART_CYCLE', part, `@part ${part.name} participates in a composition cycle`);
    }
  }

  // Seal lookup: sealed record identities (seal.action === 'approve' and matching record digest when available)
  const approvedTargets = new Map();
  for (const app of approvals) {
    const action = scalarText(sectionField(app, 'seal.action'));
    const recId = scalarText(sectionField(app, 'seal.record'));
    const recDigest = scalarText(sectionField(app, 'seal.record-digest'));
    if (action === 'approve' && recId) {
      if (!approvedTargets.has(recId)) approvedTargets.set(recId, []);
      approvedTargets.get(recId).push({ digest: recDigest, identity: app.identity });
    }
  }

  const hasValidSeal = record => {
    const seals = approvedTargets.get(record.identity);
    if (!seals || seals.length === 0) return false;
    if (typeof record.digest === 'string' && record.digest.length === 64) {
      return seals.some(s => s.digest === record.digest);
    }
    return true;
  };

  // Named-words-rule check when @approval-rule records exist alongside @pattern or @recipe (REQ-PAT-04)
  if (approvalRules.length > 0 && (patterns.length > 0 || recipes.length > 0)) {
    const coveredWords = new Set();
    let coversAllDefinitions = false;
    for (const rule of approvalRules) {
      for (const w of listItems(sectionField(rule, 'demand.words')).map(scalarText)) {
        if (w) coveredWords.add(w);
      }
      for (const k of listItems(sectionField(rule, 'demand.kinds')).map(scalarText)) {
        if (k === 'definition') coversAllDefinitions = true;
      }
    }
    if (!coversAllDefinitions && (!coveredWords.has('pattern') || !coveredWords.has('recipe'))) {
      const anchor = patterns[0] ?? recipes[0];
      report(
        'MISSING_NAMED_WORDS_RULE',
        anchor,
        `workspace declares @approval-rule records alongside @pattern/@recipe without covering both 'pattern' and 'recipe'`,
      );
    }
  }

  // 4. @pattern checks
  const patternGraph = new Map();
  for (const pat of allRecords.filter(r => r.discriminator === 'pattern')) {
    patternGraph.set(pat.identity, outgoingEdges(pat, 'supersede', 'pattern', resolveRef, byIdentity));
  }
  for (const pat of patterns) {
    const matches = listItems(sectionField(pat, 'pattern.matches'))
      .map(scalarText)
      .filter(v => typeof v === 'string' && v.trim().length > 0);
    if (matches.length === 0) {
      report('PATTERN_MATCHES_EMPTY', pat, `@pattern ${pat.name}: pattern.matches must hold at least one structural match entry`);
    }

    const yieldsRaw = scalarText(sectionField(pat, 'pattern.yields')) ?? '';
    const yieldedId = resolveRef(yieldsRaw, ['part', 'level']);
    const yieldedRec = yieldedId ? byIdentity.get(yieldedId) : null;
    if (!yieldedRec || !['part', 'level'].includes(yieldedRec.discriminator)) {
      report('PATTERN_YIELDS_UNKNOWN', pat, `@pattern ${pat.name}: pattern.yields '${yieldsRaw}' resolves to no admitted @part or @level`);
    }

    const slotEntries = listItems(sectionField(pat, 'pattern.slots')).map(scalarText);
    for (const entry of slotEntries) {
      const m = SLOT_MAP_RE.exec(entry ?? '');
      if (!m) {
        report('PATTERN_SLOT_UNKNOWN', pat, `@pattern ${pat.name}: pattern.slots entry ${JSON.stringify(entry)} must match '<slot name> <- <node path>'`);
        continue;
      }
      const slotName = m[1];
      if (yieldedRec?.discriminator !== 'part' || !slotsByPart.get(yieldedRec.identity)?.has(slotName)) {
        report(
          'PATTERN_SLOT_UNKNOWN',
          pat,
          `@pattern ${pat.name}: slot '${slotName}' is not a declared @slot of yielded part ${yieldedRec?.name ?? yieldsRaw}`,
        );
      }
    }

    const recipeRaw = scalarText(sectionField(pat, 'pattern.recipe'));
    if (recipeRaw !== null) {
      const recId = resolveRef(recipeRaw, ['recipe']);
      const recObj = recId ? byIdentity.get(recId) : null;
      if (!recObj || recObj.discriminator !== 'recipe') {
        report('PATTERN_RECIPE_UNKNOWN', pat, `@pattern ${pat.name}: pattern.recipe '${recipeRaw}' resolves to no admitted @recipe`);
      } else if (yieldedRec?.discriminator === 'part') {
        const recipePartId = resolveRef(scalarText(sectionField(recObj, 'recipe.part')), ['part']);
        if (recipePartId !== yieldedRec.identity) {
          report(
            'PATTERN_RECIPE_UNKNOWN',
            pat,
            `@pattern ${pat.name}: pattern.recipe ${recObj.name} lowers ${recipePartId ?? 'unknown'}, not yielded part ${yieldedRec.name}`,
          );
        }
      }
    }

    const evidence = listItems(sectionField(pat, 'pattern.evidence')).map(scalarText);
    if (evidence.length === 0 || evidence.some(e => !EVIDENCE_RE.test(e ?? ''))) {
      report(
        'PATTERN_EVIDENCE_INVALID',
        pat,
        `@pattern ${pat.name}: pattern.evidence must contain non-empty '<64-hex digest> <fileKey>#<nodeId>' entries`,
      );
    }

    const standing = scalarText(sectionField(pat, 'pattern.standing'));
    if (standing === 'active' && !hasValidSeal(pat)) {
      report('ACTIVE_PATTERN_UNSEALED', pat, `@pattern ${pat.name} has standing active without a matching @approval seal`);
    }
  }

  for (const cyclicId of detectCycles(patternGraph)) {
    const pat = byIdentity.get(cyclicId);
    if (pat && (pat.provenance ?? 'workspace') === 'workspace') {
      report('PATTERN_CYCLE', pat, `@pattern ${pat.name} participates in a supersede cycle`);
    }
  }

  // 5. @recipe checks
  const recipeGraph = new Map();
  for (const rec of allRecords.filter(r => r.discriminator === 'recipe')) {
    recipeGraph.set(rec.identity, outgoingEdges(rec, 'supersede', 'recipe', resolveRef, byIdentity));
  }

  for (const rec of recipes) {
    const partRaw = scalarText(sectionField(rec, 'recipe.part')) ?? '';
    const partId = resolveRef(partRaw, ['part']);
    const partRec = partId ? byIdentity.get(partId) : null;
    if (!partRec || partRec.discriminator !== 'part') {
      report('RECIPE_PART_UNKNOWN', rec, `@recipe ${rec.name}: recipe.part '${partRaw}' resolves to no admitted @part`);
    }
    const codeExport = partRec ? scalarText(sectionField(partRec, 'part.code-export')) : null;
    const hasCodeExport = typeof codeExport === 'string' && codeExport.trim().length > 0;

    const mode = scalarText(sectionField(rec, 'recipe.mode')) ?? '';
    const template = scalarText(sectionField(rec, 'recipe.template'));
    const props = listItems(sectionField(rec, 'recipe.props')).map(scalarText);
    const variants = listItems(sectionField(rec, 'recipe.variants')).map(scalarText);
    const overridesField = sectionField(rec, 'recipe.overrides');
    const overrides = listItems(overridesField).map(scalarText);
    const gap = scalarText(sectionField(rec, 'recipe.gap'));
    const classesField = sectionField(rec, 'recipe.classes');
    const classes = listItems(classesField).map(scalarText);
    const output = scalarText(sectionField(rec, 'recipe.output'));
    const standing = scalarText(sectionField(rec, 'recipe.standing'));

    for (const p of props) {
      if (!ARROW_PAIR_RE.test(p ?? '')) {
        report('RECIPE_PROP_FORMAT', rec, `@recipe ${rec.name}: recipe.props entry ${JSON.stringify(p)} must match '<figma prop> -> <code prop>'`);
      }
    }
    for (const v of variants) {
      if (!VARIANT_MAP_RE.test(v ?? '')) {
        report(
          'RECIPE_VARIANT_FORMAT',
          rec,
          `@recipe ${rec.name}: recipe.variants entry ${JSON.stringify(v)} must match '<figma prop>=<value> -> <code prop>=<value>'`,
        );
      }
    }

    if (mode === 'use') {
      if (partRec && !hasCodeExport) {
        report('RECIPE_MODE_CONTRACT', rec, `@recipe ${rec.name} (mode use) requires part.code-export on @part ${partRec.name}`);
      }
      if (template !== null || classesField !== undefined || overridesField !== undefined || gap !== null) {
        report(
          'RECIPE_MODE_CONTRACT',
          rec,
          `@recipe ${rec.name} (mode use) must omit recipe.template, recipe.classes, recipe.overrides and recipe.gap`,
        );
      }
    } else if (mode === 'adapt') {
      if (partRec && !hasCodeExport) {
        report('RECIPE_MODE_CONTRACT', rec, `@recipe ${rec.name} (mode adapt) requires part.code-export on @part ${partRec.name}`);
      }
      if (template !== null || classesField !== undefined) {
        report('RECIPE_MODE_CONTRACT', rec, `@recipe ${rec.name} (mode adapt) must omit recipe.template and recipe.classes`);
      }
      if (overrides.length === 0) {
        report('RECIPE_MODE_CONTRACT', rec, `@recipe ${rec.name} (mode adapt) requires a non-empty recipe.overrides list`);
      }
      if (!gap || !gap.trim()) {
        report('RECIPE_MODE_CONTRACT', rec, `@recipe ${rec.name} (mode adapt) requires a non-empty recipe.gap naming the library gap`);
      }
    } else if (mode === 'compose') {
      if (!template || !template.trim() || classes.length === 0) {
        report('RECIPE_MODE_CONTRACT', rec, `@recipe ${rec.name} (mode compose) requires recipe.template and non-empty recipe.classes`);
      }
      if (overridesField !== undefined || gap !== null) {
        report('RECIPE_MODE_CONTRACT', rec, `@recipe ${rec.name} (mode compose) must omit recipe.overrides and recipe.gap`);
      }
    } else if (mode === 'define') {
      if (hasCodeExport) {
        report(
          'RECIPE_DEFINE_OVER_EXPORT',
          rec,
          `@recipe ${rec.name} (mode define) is refused because @part ${partRec.name} already declares part.code-export (${codeExport})`,
        );
      }
      if (!template || !template.trim() || classes.length === 0 || !output || !output.trim()) {
        report(
          'RECIPE_MODE_CONTRACT',
          rec,
          `@recipe ${rec.name} (mode define) requires recipe.template, non-empty recipe.classes and recipe.output`,
        );
      }
      if (overridesField !== undefined || gap !== null) {
        report('RECIPE_MODE_CONTRACT', rec, `@recipe ${rec.name} (mode define) must omit recipe.overrides and recipe.gap`);
      }
    }

    for (const entry of classes) {
      const m = ARROW_PAIR_RE.exec(entry ?? '');
      if (!m) {
        report('RECIPE_RAW_STYLE', rec, `@recipe ${rec.name}: recipe.classes entry ${JSON.stringify(entry)} must match '<node role> -> <class list>'`);
        continue;
      }
      const checked = inspectTokenClassList(m[2], primitiveClasses);
      if (checked.raw) {
        report('RECIPE_RAW_STYLE', rec, `@recipe ${rec.name}: recipe.classes '${entry}' uses disallowed styling (${checked.reason})`);
      }
    }

    for (const entry of overrides) {
      const m = ARROW_PAIR_RE.exec(entry ?? '');
      if (!m) {
        report('RECIPE_RAW_STYLE', rec, `@recipe ${rec.name}: recipe.overrides entry ${JSON.stringify(entry)} must match '<node role> -> <class list>'`);
        continue;
      }
      const checked = inspectTokenClassList(m[2], primitiveClasses);
      if (checked.raw) {
        report('RECIPE_RAW_STYLE', rec, `@recipe ${rec.name}: recipe.overrides '${entry}' uses disallowed styling (${checked.reason})`);
      }
      if (checked.scale) {
        report(
          'RECIPE_ADAPT_SCALE',
          rec,
          `@recipe ${rec.name}: adapt override '${entry}' contains size, spacing or layout classes; report those as a library gap instead`,
        );
      }
    }

    if (output !== null && !isSafeRecipeOutput(output)) {
      report(
        'RECIPE_OUTPUT_UNSAFE',
        rec,
        `@recipe ${rec.name}: recipe.output ${JSON.stringify(output)} must be a canonical repo-relative path outside protected .ia, CI or config files`,
      );
    }

    if (standing === 'active' && !hasValidSeal(rec)) {
      report('ACTIVE_RECIPE_UNSEALED', rec, `@recipe ${rec.name} has standing active without a matching @approval seal`);
    }
  }

  for (const cyclicId of detectCycles(recipeGraph)) {
    const rec = byIdentity.get(cyclicId);
    if (rec && (rec.provenance ?? 'workspace') === 'workspace') {
      report('RECIPE_CYCLE', rec, `@recipe ${rec.name} participates in a supersede cycle`);
    }
  }

  findings.sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  return {
    format: FORMAT,
    revision: snapshot?.revision ?? null,
    ok: findings.length === 0,
    counts: {
      designTokens: designTokens.length,
      levels: levels.length,
      parts: parts.length,
      slots: slots.length,
      patterns: patterns.length,
      recipes: recipes.length,
      findings: findings.length,
    },
    findings,
  };
}

const handoffOff = () => ({ ...process.env, IA_NO_HANDOFF: '1' });

function refusal(ran, reply) {
  if (ran.error) return ran.error.message;
  if (typeof reply?.message === 'string') return reply.code && !reply.message.startsWith(reply.code) ? `${reply.code}: ${reply.message}` : reply.message;
  if (reply?.ok === true) return ran.status !== 0 ? `it answered ok but exited ${ran.status}` : 'its answer holds no records';
  return (ran.stderr || ran.stdout || '').trim() || `exit ${ran.status}`;
}

function readAdmission(command, root) {
  const ran = spawnSync(command[0], [...command.slice(1), 'validate', '--root', root, '--severity', 'error', '--json'], {
    cwd: root,
    env: handoffOff(),
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  });
  let reply;
  try {
    reply = JSON.parse(ran.stdout);
  } catch {
    reply = undefined;
  }
  if (reply?.status === 'admitted') return;
  if (reply?.status === 'refused') {
    const errors = reply.counts?.errors;
    const first = (reply.findings ?? []).find(f => f.severity === 'error');
    const named = first ? `, the first ${first.code}: ${first.message}` : '';
    throw new Error(`ia validate refused the workspace with ${errors} error${errors === 1 ? '' : 's'}${named}; a refused workspace is not judged`);
  }
  throw new Error(`ia validate did not admit the workspace: ${refusal(ran, reply)}`);
}

function readRecords(command, root) {
  const ran = spawnSync(command[0], [...command.slice(1), 'records', '--root', root, '--params', '{}'], {
    cwd: root,
    env: handoffOff(),
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  });
  let reply;
  try {
    reply = JSON.parse(ran.stdout);
  } catch {
    reply = undefined;
  }
  if (!ran.error && ran.status === 0 && reply?.ok === true && Array.isArray(reply.result?.records)) return reply.result;
  throw new Error(`ia records did not return the admitted records: ${refusal(ran, reply)}`);
}

export function runWorkspaceDesignPatternCheck(rawCommand, root = process.cwd()) {
  const command = rawCommand[0] === '--ia' ? rawCommand.slice(1) : rawCommand;
  if (!command.length) {
    throw new Error('usage: node check-design-patterns.mjs <the command words that run ia>, from the workspace root');
  }
  if (!existsSync(join(root, '.ia', 'src'))) {
    throw new Error(`${root} is not an IA workspace root (missing .ia/src)`);
  }
  readAdmission(command, root);
  return checkDesignPatterns(readRecords(command, root));
}

function samePath(a, b) {
  const [x, y] = [realpathSync.native(a), realpathSync.native(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

if (process.argv[1] !== undefined && existsSync(process.argv[1]) && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  try {
    const report = runWorkspaceDesignPatternCheck(process.argv.slice(2), process.cwd());
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`check-design-patterns: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
