export function LogoMark({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" aria-hidden>
      <defs>
        <linearGradient id="lg-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#FFD66B" /><stop offset="1" stopColor="#FF6B35" /></linearGradient>
        <linearGradient id="lg-b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#241A6B" /><stop offset="1" stopColor="#0B0A14" /></linearGradient>
      </defs>
      <rect x="6" y="6" width="108" height="108" rx="26" fill="url(#lg-b)" />
      <rect x="18" y="18" width="84" height="84" rx="14" fill="none" stroke="#FFB627" strokeWidth="3" strokeOpacity=".55" />
      <path d="M60 22C63 46 68 53 98 60C68 67 63 74 60 98C57 74 52 67 22 60C52 53 57 46 60 22Z" fill="url(#lg-g)" />
      <circle cx="92" cy="28" r="4" fill="#FFD66B" />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="logo">
      <LogoMark />
      <span className="logo-text"><b>NYOTA</b><i>SCANS</i></span>
    </span>
  );
}
