import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonPrefix, ToolArgumentStream } from '../src/json-stream.ts';

test('JSON前缀检查允许任意分片、数字、嵌套、转义及未结束的合法前缀', () => {
  const values = [null, true, false, 0, -0.125, 2e-30, {}, [], { text: '中文😀\n"\\', args: [0, 123, -42, 1.25e28, { x: false }] }];
  for (const value of values) for (let size = 1; size < 12; size++) {
    const prefix = new JsonPrefix(), text = JSON.stringify(value);
    for (let i = 0; i < text.length; i += size) prefix.push(text.slice(i, i + size));
    prefix.push(' ');
  }
  for (const text of ['{"x":', '{"x":"\\u12', '[1e-', '[2.', '-']) assert.doesNotThrow(() => new JsonPrefix().push(text));
});

test('未结束字符串内的极端周期重复能提前发现，普通重复与任意分片仍可用', () => {
  const text = '{"text":"' + '  2'.repeat(600);
  const stream = new ToolArgumentStream();
  assert.throws(() => { for (const char of text) stream.push(char); }, /REPETITIVE_JSON_STREAM/);
  const normal = new ToolArgumentStream();
  normal.push(JSON.stringify({ text: '战术说明'.repeat(200), number: 22222222 }));
});

test('重复数字、非法转义、尾随逗号等不能成为任何合法JSON的前缀', () => {
  for (const text of ['{"x":2  2', '[01', '[1.e', '{"x":"\\q', '[1,]', '{"x":true,}', 'true false', '{x', '[+1', '[-01']) {
    assert.throws(() => new JsonPrefix().push(text), /INVALID_JSON_PREFIX/, text);
  }
});
