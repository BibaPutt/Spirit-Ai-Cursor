import type { Transition, Variants } from 'framer-motion';

export const haloSpring: Transition = {
  type: 'spring',
  damping: 30,
  stiffness: 400,
  mass: 0.6,
};

export const haloVariants: Variants = {
  hidden: { opacity: 0, scale: 0.55 },
  visible: { opacity: 1, scale: 1 },
};

export const fadeQuick: Transition = {
  duration: 0.15,
  ease: 'easeOut',
};

export const popVariants: Variants = {
  hidden: { opacity: 0, scale: 0.95, y: 4 },
  visible: { opacity: 1, scale: 1, y: 0 },
};

export const popTransition: Transition = {
  type: 'spring',
  damping: 22,
  stiffness: 320,
  mass: 0.7,
};
