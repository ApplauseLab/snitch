import { describe, expect, test } from 'bun:test';

import { SNITCH_SKILL } from './index.ts';

describe('SNITCH_SKILL', () => {
  test('documents direct service playback and rendering APIs', () => {
    expect(SNITCH_SKILL).toContain('POST /v1/narration');
    expect(SNITCH_SKILL).toContain('POST /v1/narration/render');
    expect(SNITCH_SKILL).toContain('outputPath');
    expect(SNITCH_SKILL).toContain('arrayBuffer');
    expect(SNITCH_SKILL).toContain('bf_emma');
  });
});
