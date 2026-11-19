// The IA home: IA_HOME when absolute, else ~/.ia. A relative value is refused, never resolved against the working directory.
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';

const driveRelative = value => process.platform === 'win32' && /^[A-Za-z]:/.test(value) && value[2] !== '/' && value[2] !== sep;

export function iaHome(env = process.env, home = homedir()) {
  const value = env.IA_HOME;
  if (!value) return join(home, '.ia');
  if (!isAbsolute(value) || driveRelative(value)) throw Object.assign(new Error(`IA_HOME must be an absolute path: ${value}`), { code: 'IA-CORE-HOME-RELATIVE' });
  return resolve(value);
}

export const closureStore = (env = process.env) => env.IA_CORE_CLOSURES_DIR ? resolve(env.IA_CORE_CLOSURES_DIR) : join(iaHome(env), 'method-closures-v1');
