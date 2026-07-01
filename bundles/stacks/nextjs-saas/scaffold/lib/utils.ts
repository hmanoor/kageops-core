import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

// shadcn/ui canonical helper — merge Tailwind class strings with cn(...)
// Resolves conflicts (e.g. cn('p-2', 'p-4') === 'p-4') via tailwind-merge.
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
