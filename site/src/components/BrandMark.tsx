export default function BrandMark({
  size = 20,
  className = '',
}: {
  size?: number;
  className?: string;
}) {
  return (
    <img
      src="/assets/mark.png"
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={`brand-mark${className ? ` ${className}` : ''}`}
    />
  );
}
