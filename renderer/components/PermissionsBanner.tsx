type Props = {
  message: string;
  hint?: string;
};

export function PermissionsBanner({ message, hint }: Props) {
  return (
    <div className="absolute left-1/2 top-6 -translate-x-1/2 pointer-events-none">
      <div className="rounded-2xl border border-amber-400/40 bg-amber-950/85 px-4 py-2.5 shadow-glass backdrop-blur-2xl">
        <p className="text-sm font-medium text-amber-100">{message}</p>
        {hint && <p className="mt-0.5 text-[11px] text-amber-200/75">{hint}</p>}
      </div>
    </div>
  );
}
