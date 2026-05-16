import { answer } from './modules/dep.js';

if (answer !== 42) {
  throw new Error(`expected module answer to be 42, got ${answer}`);
}

console.log('module imports passed');
