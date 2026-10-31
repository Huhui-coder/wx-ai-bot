// A prefix only covers one plain command: anything that can chain, substitute
// or redirect must still be approved, so `npm test; rm -rf ~` never matches `npm test`.
const UNSAFE = /[;&|<>$`(){}\u0000-\u001f]/;

export const plainCommand = command => typeof command === 'string' && !UNSAFE.test(command.trim());
export function commandAllowed(command, prefixes = []) {
  if (!plainCommand(command)) return false;
  const text = command.trim();
  return prefixes.some(prefix => text === prefix || text.startsWith(prefix + ' '));
}
export function commandPrefixes(value) {
  if (!Array.isArray(value) || value.length > 50) throw new Error('命令前缀最多 50 条');
  const result = new Set();
  for (const item of value) {
    const prefix = typeof item === 'string' ? item.trim() : '';
    if (!prefix) continue;
    if (prefix.length > 200 || !plainCommand(prefix)) throw new Error('命令前缀不能包含 ; & | < > $ 反引号或括号：' + String(item).slice(0, 80));
    result.add(prefix);
  }
  return [...result];
}
// "npm test --watch" suggests "npm test"; flags stay exact so "rm -rf x" never widens to "rm".
export function suggestedPrefix(command) {
  if (!plainCommand(command)) return '';
  const words = command.trim().split(/\s+/);
  return words[1]?.startsWith('-') ? words.join(' ') : words.slice(0, 2).join(' ');
}
