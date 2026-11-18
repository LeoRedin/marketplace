// A declared argument is data in one argv slot, never a command or shell text.
// This first slice admits only a task's locator manifest under the workspace.
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { UsageError } from './workspace.mjs';

function malformed(message) {
  const error = new Error(message);
  error.code = 'IA-CORE-CHECK-MALFORMED';
  throw error;
}

export function checkArguments(spec, options, workspaceRoot) {
  const declarations = spec.arguments === undefined ? {} : spec.arguments;
  if (typeof declarations !== 'object' || declarations === null || Array.isArray(declarations)) malformed('check arguments must be an object');
  for (const [name, type] of Object.entries(declarations)) {
    if (name !== 'manifest' || type !== 'workspace-file') malformed(`unsupported check argument ${name}: ${type}`);
    if (!spec.argv.includes('${ARG:' + name + '}')) malformed(`check argument ${name} has no argv slot`);
  }
  for (const [index, word] of spec.argv.entries()) {
    if (!word.includes('${ARG:')) continue;
    const match = /^\$\{ARG:([a-z-]+)\}$/.exec(word);
    if (!match || index === 0 || !Object.hasOwn(declarations, match[1])) malformed('check arguments need declared, whole argv slots after the executable');
  }
  if (options.manifest !== undefined && !Object.hasOwn(declarations, 'manifest')) throw new UsageError('this check does not declare --manifest');
  const values = {};
  for (const name of Object.keys(declarations)) {
    const value = options[name];
    if (typeof value !== 'string' || !value || isAbsolute(value) || /[:\\\0\r\n]/.test(value) || value.split('/').some(p => !p || p === '.' || p === '..')) {
      throw new UsageError(`--${name} needs a portable workspace-relative file path without traversal`);
    }
    const root = realpathSync(workspaceRoot);
    let path = root;
    try {
      const parts = value.split('/');
      for (const [index, part] of parts.entries()) {
        path = join(path, part);
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) throw new Error('not a regular file through real directories');
      }
      path = realpathSync(path);
      const rel = relative(root, path);
      if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) throw new Error('outside the workspace');
    } catch {
      throw new UsageError(`--${name} must name an existing regular file inside the workspace, without links`);
    }
    values['${ARG:' + name + '}'] = path;
  }
  return values;
}
