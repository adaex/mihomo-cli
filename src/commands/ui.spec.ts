import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CliError } from '../errors.js';
import { resolveUiName } from './ui.js';

describe('resolveUiName', () => {
  it('未传参取默认 zash', () => {
    assert.equal(resolveUiName(['ui']), 'zash');
  });

  it('小写归一：DASH/YACD 与小写等价', () => {
    assert.equal(resolveUiName(['ui', 'DASH']), 'dash');
    assert.equal(resolveUiName(['ui', 'Yacd']), 'yacd');
  });

  it('空串报未知 UI，不静默落到默认值', () => {
    assert.throws(
      () => resolveUiName(['ui', '']),
      e => e instanceof CliError && /未知的 UI/.test(e.message),
    );
  });

  it('未知名称报错', () => {
    assert.throws(
      () => resolveUiName(['ui', 'nope']),
      e => e instanceof CliError && /未知的 UI "nope"/.test(e.message),
    );
  });
});
