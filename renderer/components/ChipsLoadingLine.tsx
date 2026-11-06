import { memo } from 'react';
import { cn } from '../lib/utils';

// Thin accent underline at the bottom edge of the overlay while the action
// chips are being generated. Two chasing dashes sweep left→right continuously
// (CSS keyframes in globals.css — GPU transforms, no React re-renders),
// reading as "the chips are loading". Positioned by the caller via `className`
// (pinned to the overlay's bottom edge, not the prompt box).
export const ChipsLoadingLine = memo(function ChipsLoadingLine({
  visible,
  className,
}: {
  visible: boolean;
  className?: string;
}) {
  if (!visible) return null;
  return (
    <div className={cn('ap-chip-loader-cover', className)} role="progressbar" aria-label="Generating suggestions">
      <div className="ap-chip-loader-track">
        <div className="ap-chip-loader-seg" />
        <div className="ap-chip-loader-seg" />
      </div>
    </div>
  );
});
