import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BoundaryIssue {
  file: string;
  line: number;
  message: string;
}

interface Token {
  kind: 'word' | 'string' | 'punctuation';
  text: string;
  line: number;
}

/** A conservative lexical guard, not a full language parser or security sandbox. */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let offset = 0;
  let line = 1;
  const emit = (kind: Token['kind'], text: string, startLine = line) => {
    tokens.push({ kind, text, line: startLine });
  };
  const advance = () => {
    if (source[offset] === '\n') line += 1;
    offset += 1;
  };

  function scan(templateExpression = false): void {
    let braces = 0;
    while (offset < source.length) {
      const char = source[offset]!;
      if (/\s/.test(char)) { advance(); continue; }
      if (char === '/' && source[offset + 1] === '/') {
        while (offset < source.length && source[offset] !== '\n') advance();
        continue;
      }
      if (char === '/' && source[offset + 1] === '*') {
        advance(); advance();
        while (offset < source.length && !(source[offset] === '*' && source[offset + 1] === '/')) advance();
        if (offset < source.length) { advance(); advance(); }
        continue;
      }
      if (char === '"' || char === "'") {
        const quote = char;
        const startLine = line;
        let text = '';
        advance();
        while (offset < source.length && source[offset] !== quote) {
          if (source[offset] === '\\') {
            text += '\\'; advance();
            if (offset < source.length) { text += source[offset]; advance(); }
          } else { text += source[offset]; advance(); }
        }
        advance();
        emit('string', text, startLine);
        continue;
      }
      if (char === '`') {
        advance();
        while (offset < source.length && source[offset] !== '`') {
          if (source[offset] === '\\') { advance(); advance(); }
          else if (source[offset] === '$' && source[offset + 1] === '{') {
            advance(); advance(); scan(true);
          } else advance();
        }
        advance();
        continue;
      }
      if (/[A-Za-z_$]/.test(char)) {
        const startLine = line;
        let text = '';
        while (offset < source.length && /[A-Za-z0-9_$]/.test(source[offset]!)) {
          text += source[offset]; advance();
        }
        emit('word', text, startLine);
        continue;
      }
      if (char === '{') braces += 1;
      if (char === '}') {
        if (templateExpression && braces === 0) { advance(); return; }
        braces -= 1;
      }
      emit('punctuation', char);
      advance();
    }
  }
  scan();
  return tokens;
}

const forbiddenGlobals = new Set([
  'window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'indexedDB',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'performance', 'Date', 'eval', 'Function',
  'setTimeout', 'setInterval', 'requestAnimationFrame', 'crypto', 'globalThis',
  'process', 'require', 'Phaser',
]);

export function inspectCoreSource(source: string, file: string, root: string): BoundaryIssue[] {
  const tokens = tokenize(source);
  const issues: BoundaryIssue[] = [];
  const add = (token: Token, message: string) => issues.push({ file, line: token.line, message });
  const allowedRoots = [path.resolve(root, 'src/core'), path.resolve(root, 'src/content')];

  function inspectImport(token: Token) {
    if (!token.text.startsWith('.') || token.text.includes('\\')) {
      add(token, `Core import must be a plain relative core/content path: ${token.text}`);
      return;
    }
    const target = path.resolve(path.dirname(file), token.text);
    if (!allowedRoots.some((allowed) => target === allowed || target.startsWith(`${allowed}${path.sep}`))) {
      add(token, `Core cannot depend on this layer: ${token.text}`);
    }
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const next = tokens[index + 1];
    if (token.kind === 'word' && forbiddenGlobals.has(token.text)) {
      add(token, `Platform, clock, or executable global is forbidden in core: ${token.text}`);
    }
    if (token.text === 'Math' && token.kind === 'word') {
      const property = tokens[index + 2];
      if ((next?.text === '.' || next?.text === '[') && property?.text === 'random') {
        add(token, 'Use the serialized deterministic random streams instead of Math.random.');
      }
    }
    if (token.kind === 'word' && token.text === 'import') {
      if (next?.text === '(' || next?.text === '.') add(token, 'Dynamic imports and import.meta are forbidden in core.');
      if (next?.kind === 'string') inspectImport(next);
    }
    if (token.kind === 'word' && token.text === 'from' && next?.kind === 'string') inspectImport(next);
  }
  return issues;
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const groups = await Promise.all(entries.map(async (entry) => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(filename);
    return entry.isFile() && /\.(?:ts|tsx|js|mjs|cjs)$/.test(filename) ? [filename] : [];
  }));
  return groups.flat().sort();
}

export async function checkCoreBoundaries(root: string): Promise<BoundaryIssue[]> {
  const files = await sourceFiles(path.resolve(root, 'src/core'));
  const checks = await Promise.all(files.map(async (file) => inspectCoreSource(await readFile(file, 'utf8'), file, root)));
  return checks.flat();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
  try {
    const issues = await checkCoreBoundaries(root);
    for (const issue of issues) console.error(`${path.relative(root, issue.file)}:${issue.line}: ${issue.message}`);
    if (issues.length > 0) process.exitCode = 1;
    else console.log('Core boundary check passed (direct imports and prohibited platform/random globals).');
  } catch (error) {
    console.error('Core boundary check could not run:', error);
    process.exitCode = 1;
  }
}
