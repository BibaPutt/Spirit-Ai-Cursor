import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  STATUS_ADVANCE_MS,
  STATUS_PHRASES,
  NEAR_DONE_AFTER_MS,
  NEAR_DONE_PHRASES,
} from '../lib/statusLines';

// Rotating status line shown while the agent is working. Picks a RANDOM
// phrase on a timer (never the same one twice in a row) so the message
// stays alive instead of marching through a fixed sequence. Near-done
// phrases only enter the pool after NEAR_DONE_AFTER_MS, so "almost done"
// feels earned as the run winds down. Mounts fresh per run (it's
// conditionally rendered), so the status restarts at the first phrase.
export function AgentStatus() {
  const [phrase, setPhrase] = useState(() => STATUS_PHRASES[0]);
  const startedAtRef = useRef(Date.now());
  const lastPhraseRef = useRef<string | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => {
      const elapsed = Date.now() - startedAtRef.current;
      const nearDone = elapsed >= NEAR_DONE_AFTER_MS;
      // Near-done lines are duplicated so they're roughly twice as likely
      // to show once the run has been going for a while.
      const pool = nearDone
        ? [...STATUS_PHRASES, ...NEAR_DONE_PHRASES, ...NEAR_DONE_PHRASES]
        : STATUS_PHRASES;
      let next = pool[Math.floor(Math.random() * pool.length)];
      if (next === lastPhraseRef.current && pool.length > 1) {
        next = pool[Math.floor(Math.random() * pool.length)];
      }
      lastPhraseRef.current = next;
      setPhrase(next);
    }, STATUS_ADVANCE_MS);
    return () => window.clearInterval(id);
  }, []);

  return (
    <AnimatePresence mode="wait">
      <motion.p
        key={phrase}
        initial={{ opacity: 0, filter: 'blur(6px)' }}
        animate={{ opacity: 1, filter: 'blur(0px)' }}
        exit={{ opacity: 0, filter: 'blur(6px)' }}
        transition={{ duration: 0.25, ease: 'easeInOut' }}
        className="py-1.5 text-[13px] italic leading-relaxed text-white/70 dark:text-neutral-600"
      >
        {phrase}
      </motion.p>
    </AnimatePresence>
  );
}