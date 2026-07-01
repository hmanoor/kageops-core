import { describe, it, expect } from 'vitest';
import { cn } from '@/lib/utils';

describe('cn() — shadcn class helper', () => {
  it('joins truthy class strings', () => {
    expect(cn('foo', 'bar')).toBe('foo bar');
  });

  it('drops falsy values', () => {
    expect(cn('foo', false, null, undefined, 'bar')).toBe('foo bar');
  });

  it('resolves conflicting tailwind utilities (last wins)', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
  });
});
