import { forwardRef, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { ProviderHealth } from '../../electron/types';

type Props = {
  onOpenSettings: () => void;
};

// Bottom toast slot constant: 72px from the overlay bottom, centered.
// Future toasts (e.g. action confirmations, undo prompts) should mount
// in the same slot pattern so they don't compete with each other.
const TOAST_BOTTOM_BASE = 72;

const REASON_TEXT: Record<ProviderHealth['reason'], string> = {
  none: '',
  'keychain-unavailable':
    'the OS keychain is unavailable',
  'keychain-denied':
    'the OS keychain refused access',
  'corrupt-ciphertext':
    'the stored key is corrupted',
};

// Passive banner shown when at least one provider has a
// stored key that cannot be decrypted (Windows DPAPI failure, macOS
// keychain revocation, dev-build vs production-build code-signing
// mismatch). Without this banner the user is silently stuck with no
// working provider after restart, with no explanation.
//
// Positioned at top-16 (64px) so it lives BELOW the macOS menubar /
// Windows titlebar and is not visually attached to the systray. The
// banner needs `forwardRef` so App.tsx can hit-test the cursor against
// its bounds and flip overlay interactivity — otherwise the click-
// through overlay would swallow the "Open Settings" click.
export const ProviderHealthBanner = forwardRef<HTMLDivElement, Props>(function ProviderHealthBanner(
  { onOpenSettings },
  ref,
) {
  const [broken, setBroken] = useState<ProviderHealth[]>([]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const list = await window.spirit.getProvidersHealth();
        if (cancelled) return;
        setBroken(list.filter((p) => p.brokenDecrypt));
      } catch {
        /* preload not ready */
      }
    };
    void poll();
    // Re-check every 30s as a heartbeat AND immediately on every
    // providers:health-changed push from main. The push gives instant
    // banner-dismiss the moment the user re-enters a working key in
    // Settings — without it the banner lingered up to 30s after the
    // fix and looked like the save hadn't worked.
    const t = window.setInterval(poll, 30_000);
    const offPush = window.spirit.onProvidersHealthChanged?.(() => {
      void poll();
    });
    return () => {
      cancelled = true;
      window.clearInterval(t);
      offPush?.();
    };
  }, []);

  if (broken.length === 0) return null;
  const first = broken[0];
  const reason = REASON_TEXT[first.reason] || 'decryption failed';
  const providerName = first.provider[0].toUpperCase() + first.provider.slice(1);

  return (
    // OUTER wrapper owns the centering (left:50% + translateX:-50%)
    // because framer-motion writes its own `transform` for the y/opacity
    // animation — if the centering lived on the same element, the
    // animation would clobber the translateX and the toast would drift
    // off to the right.
    <div
      ref={ref}
      className="pointer-events-none absolute left-1/2 z-50 -translate-x-1/2"
      style={{ bottom: TOAST_BOTTOM_BASE }}
      data-spirit-hit="provider-health-banner"
    >
    <AnimatePresence>
      <motion.div
        key="provider-health-banner"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 8 }}
        transition={{ duration: 0.2 }}
        className="pointer-events-auto rounded-xl border px-3 py-2 text-[12px] font-medium shadow-glass backdrop-blur-md"
        style={{
          background: 'rgba(50,18,18,0.86)',
          color: 'rgba(255,200,200,0.96)',
          border: '1px solid rgba(255,120,120,0.45)',
          maxWidth: 560,
        }}
      >
        <div className="flex items-center gap-3">
          <span className="text-[14px]" aria-hidden>⚠</span>
          <span className="flex-1 leading-snug">
            <b>{providerName}</b> API key couldn't be unlocked ({reason}). Open Settings to re-enter it.
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenSettings();
            }}
            className="shrink-0 rounded-md border border-rose-300/40 bg-rose-500/15 px-2 py-1 text-[11px] font-semibold text-rose-100 transition hover:bg-rose-500/30"
          >
            Open Settings
          </button>
        </div>
      </motion.div>
    </AnimatePresence>
    </div>
  );
});
