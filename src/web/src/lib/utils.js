// The one helper every shadcn-svelte component imports (the CLI's own `utils`): join class
// names, letting a later Tailwind utility override an earlier conflicting one, so a call site can
// restyle a component by passing `class`.
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
