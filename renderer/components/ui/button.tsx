import * as React from 'react';
import { cn } from '../../lib/utils';

const buttonVariants = {
  variant: {
    default:
      'bg-white/10 text-white border border-white/10 hover:bg-white/18 dark:bg-neutral-900/10 dark:text-neutral-900 dark:border-neutral-900/10 dark:hover:bg-neutral-900/18',
    secondary:
      'bg-white/6 text-white/75 border border-white/8 hover:bg-white/12 hover:text-white dark:bg-neutral-900/6 dark:text-neutral-900/75 dark:border-neutral-900/8 dark:hover:bg-neutral-900/12 dark:hover:text-neutral-900',
    ghost:
      'bg-transparent text-white/70 border border-transparent hover:bg-white/8 hover:text-white dark:text-neutral-900/70 dark:hover:bg-neutral-900/8 dark:hover:text-neutral-900',
    accent:
      'bg-[rgb(var(--spirit-accent-rgb))]/15 text-[rgb(var(--spirit-accent-rgb))] border border-[rgb(var(--spirit-accent-rgb))]/25 hover:bg-[rgb(var(--spirit-accent-rgb))]/25',
  },
  size: {
    sm: 'h-7 rounded-md px-2.5 text-[11px] gap-1',
    default: 'h-8 rounded-lg px-3 text-[12px] gap-1.5',
    lg: 'h-9 rounded-lg px-4 text-[12.5px] gap-1.5',
    icon: 'h-7 w-7 rounded-md p-0',
  },
} as const;

type Variant = keyof typeof buttonVariants.variant;
type Size = keyof typeof buttonVariants.size;

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'default', ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center whitespace-nowrap font-medium transition-all',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[rgb(var(--spirit-accent-rgb))]/50',
        'disabled:pointer-events-none disabled:opacity-50',
        buttonVariants.variant[variant],
        buttonVariants.size[size],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = 'Button';

export { Button, buttonVariants };
