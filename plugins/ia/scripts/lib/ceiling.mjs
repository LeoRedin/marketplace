// The ceiling report: how deep each task sits above a provisional foundation
// (law method-provisional-foundation-ceiling, contract ia-method REQ-METHOD-01).
//
// A foundation is provisional while a decision the task requires has no
// choice (ia next's rule for a satisfied decision), a spec the task cites is
// not accepted (superseded and withdrawn included, until the task points at
// the successor), or a decision that grounds a cited spec has no choice.
// ia next blocks on a required decision, but not on a cited spec, and it does
// not say how deep a chain of tasks reaches; this report does both.
//
// clear:          the task rests on no provisional foundation.
// first-layer:    it rests on one directly, and on no task that rests on one.
// beyond-ceiling: a task it requires rests on one (layer = the longest chain).
// unknown:        a record it depends on could not be read, so it fails closed.
//
// The input is a graph of records, as `ia inspect` reports them, where a
// record that could not be read is null:
//   { identity: { word, status, choice, requires: [identity], cites: [identity], groundedBy: [identity] } | null }

const SPEC_RATIFIED = 'accepted';

function shortName(identity) {
  return identity.split('/').slice(-2).join('/');
}

const unique = items => [...new Map(items.map(i => [i.identity, i])).values()];

// The provisional foundations a task rests on directly, and the records it
// depends on that could not be read.
function direct(task, graph) {
  const foundations = [];
  const missing = [];
  for (const target of task.requires ?? []) {
    const record = graph[target];
    if (!record) missing.push(target);
    else if (record.word === 'decision' && !record.choice) foundations.push({ identity: target, word: 'decision', reason: 'no choice' });
  }
  for (const target of task.cites ?? []) {
    const spec = graph[target];
    if (!spec) { missing.push(target); continue; }
    if (spec.word !== 'spec') continue;
    if (spec.status !== SPEC_RATIFIED) {
      const replaced = spec.status === 'superseded' || spec.status === 'withdrawn';
      foundations.push({ identity: target, word: 'spec', reason: `status ${spec.status ?? 'missing'}${replaced ? '; point the work at its successor' : ''}` });
    }
    for (const ground of spec.groundedBy ?? []) {
      const decision = graph[ground];
      if (!decision) missing.push(ground);
      else if (decision.word === 'decision' && !decision.choice) foundations.push({ identity: ground, word: 'decision', reason: `grounds ${shortName(target)}; no choice` });
    }
  }
  return { foundations, missing };
}

export function ceilingReport(graph, taskIds) {
  const memo = new Map();
  // A result reached by cutting a requires cycle depends on where the walk
  // entered the cycle, so it is not memoized. ia next refuses cycles anyway.
  const walk = (id, trail = []) => {
    if (memo.has(id)) return memo.get(id);
    if (trail.includes(id)) return { layer: 0, via: [], foundations: [], missing: [], cut: true };
    const task = graph[id];
    if (!task) return { layer: 0, via: [], foundations: [], missing: [id] };
    if (task.word !== 'task') return { layer: 0, via: [], foundations: [], missing: [] };
    const own = direct(task, graph);
    let best = { layer: own.foundations.length ? 1 : 0, via: [] };
    let foundations = [...own.foundations];
    let missing = [...own.missing];
    let cut = false;
    for (const target of task.requires ?? []) {
      if (graph[target] && graph[target].word !== 'task') continue;
      if (!graph[target]) continue; // already counted as missing by direct()
      const below = walk(target, [...trail, id]);
      cut ||= Boolean(below.cut);
      missing = missing.concat(below.missing);
      if (below.layer > 0) {
        foundations = foundations.concat(below.foundations);
        if (below.layer + 1 > best.layer) best = { layer: below.layer + 1, via: [target, ...below.via] };
      }
    }
    const result = { ...best, foundations: unique(foundations), missing: [...new Set(missing)] };
    if (cut) return { ...result, cut };
    memo.set(id, result);
    return result;
  };
  const tasks = taskIds.map(id => {
    const { layer, via, foundations, missing } = walk(id);
    // A longest chain already beyond the ceiling stays beyond it whatever the
    // unread records hold; otherwise an unread record leaves the task unknown.
    const position = layer > 1 ? 'beyond-ceiling' : missing.length ? 'unknown' : layer === 1 ? 'first-layer' : 'clear';
    return { identity: id, position, layer, foundations, via, missing };
  });
  const count = p => tasks.filter(t => t.position === p).length;
  return { tasks, counts: { clear: count('clear'), firstLayer: count('first-layer'), beyondCeiling: count('beyond-ceiling'), unknown: count('unknown') } };
}

export function describe(entry) {
  const name = shortName(entry.identity);
  const on = entry.foundations.map(f => `${shortName(f.identity)} (${f.reason})`).join(', ');
  const unread = entry.missing.length ? `; could not read ${entry.missing.map(shortName).join(', ')}` : '';
  if (entry.position === 'clear') return `${name}: clear`;
  if (entry.position === 'unknown') return `${name}: unknown${on ? ` (rests at least on ${on})` : ''}${unread}: do not treat it as clear`;
  if (entry.position === 'first-layer') return `${name}: first layer on ${on}: design, prototype and test on a branch; no merge or release until ratified`;
  return `${name}: beyond the ceiling (layer ${entry.layer}, through ${entry.via.map(shortName).join(' -> ')}) waiting on ${on}: do not start until ratified${unread}`;
}

// Reduces one `ia inspect <identity> --json` record to the graph node above.
export function nodeFromInspect(record) {
  const field = (section, key) => record.sections?.find(s => s.name === section)?.fields?.find(f => f.key === key)?.value;
  const edges = record.edges ?? [];
  const targets = (predicate, direction) => edges.filter(e => e.direction === direction && e.predicate === predicate && e.target).map(e => e.target);
  return {
    word: record.discriminator,
    status: field('work', 'status')?.text,
    choice: Boolean(field('decision', 'choice')),
    requires: targets('require', 'out'),
    cites: targets('cite', 'out'),
    // A spec spells `grounded-by @decision`; inspect reports it as the
    // decision's ground edge, pointing in.
    groundedBy: targets('ground', 'in'),
  };
}
